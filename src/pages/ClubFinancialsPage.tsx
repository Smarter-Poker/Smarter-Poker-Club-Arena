/**
 * CLUB FINANCIALS — what the club earned, and what it paid out
 * ============================================================================
 * PHASE 6 OF THE CLUB OPERATIONS UPGRADE (2026-09-04).
 *
 * Every figure on this page used to be summed in the browser from the OLDEST
 * 5,000 rake_records rows: `.order('created_at', {ascending:true}).limit(5000)`.
 * Measured on Deep Stack Society over its three complete days, that was 5,000
 * of 124,549 cash rake rows - Rake Collected 4.6% of the truth, Total Pot
 * Volume 4.8%, Hands Played a flat 5,000, and Net Revenue inheriting all of
 * it, with no truncation warning anywhere. The rakeback line read
 * chip_transactions directly, whose RLS returns the CALLER's own rows, so an
 * owner saw the rakeback paid to themselves and nobody else. The union-fee
 * line read invoice_type 'union_to_club', which the weekly square-up has never
 * written. The whole page was gated in this component alone.
 *
 * It now makes one call: ca_club_financials, SECURITY DEFINER, gated
 * server-side on ca_can_view_club_finances (owner / co-owner / admin /
 * super agent / platform admin) with ERRCODE 42501, reading the per-day rake
 * rollup the engine maintains from rake_records. The client gate below is
 * cosmetic; the server one is the gate.
 *
 * The figures, from the club's side of the ledger:
 *   Gross Rake        rake_records, attributed the way club_table_daily
 *                     attributes it (a union player's rake goes to their home
 *                     club; anything unattributable stays with the table's)
 *   Bad Beat Drop     the share of that rake that leaves for the jackpot pool
 *   Net Rake          gross - drop, the part the club keeps
 *   Tournament Fees   entry and rebuy fees, per the entrant's club
 *   Rakeback          chip_transactions of type 'rakeback', every player's
 *   Agent Fees        agent_commissions, accrued in the window
 *   Union Fee         union_fee_kept on the weekly square-up statements
 *   Net Revenue       net rake + tournament fees - the three outflows
 *
 * ── #ClubArenaConsole (2026-09-09) ────────────────────────────────────────
 * The page was eight rounded summary tiles in a two-up grid, a gradient
 * "revenue" card, a gradient "net" card, three filled period buttons and two
 * lists of bordered rows. It is now printed on Dan's approved spade master:
 * one console per section - Financials, Revenue Trend, Summary, Top Tables,
 * Recent Rake - with every figure a row on the black glass, label in the
 * master's lit blue on the left and value in engraved silver on the right,
 * separated by the engraved rule the master cuts between its own rows.
 *
 * WHAT DID NOT CHANGE, AND MUST NOT: the single `ca_club_financials` call and
 * its window, the strict club resolve, the `isAuthzError` permission gate, the
 * six masterBus subscriptions and their debounce windows, the scope-aware
 * in-flight guard, the stagger timers on Recent Rake, the CSV export's columns
 * and arithmetic, and every wallet the header opens (club bank, promo, agent,
 * player). This page reads a club's books and opens its cashiers; not one of
 * those paths was touched.
 *
 * Forward-facing chip figures use the shared Club Arena compact contract:
 * whole chips below 1,000 and K/M/B above it, always rounded down. The CSV
 * remains the exact accounting record and never reuses this display formatter.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { withClubContext } from '../utils/clubScopedPath';
import { isClubStaff, type ClubRole } from '../types/clubRoles';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { ClubFinancialDashboard } from '../components/dashboard/ClubFinancialDashboard';
import FinancialChart from '../components/charts/FinancialChart';
import RakeReports from '../components/admin/RakeReports';
import TransactionLedgerView from '../components/common/TransactionLedgerView';
import ChipStatement from '../components/wallet/ChipStatement';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import DynamicWallet from '../components/wallet/DynamicWallet';
import WalletCashierModal from '../components/wallet/WalletCashierModal';
import { DEFAULT_CASHIER_WALLET } from '../components/wallet/cashierModes';
import PlayerWalletModal from '../components/wallet/PlayerWalletModal';
import StandardContentLayout from '../components/layouts/StandardContentLayout';
import { SpadeConsole, type ConsoleInk } from '../components/console/SpadeConsole';
import './ClubFinancialsPage.css';
import { isUUID } from '../utils/clubIdResolver';
import { isAuthzError } from '../utils/clubDashboard';
import { useIsMounted } from '../hooks/useIsMounted';
import { formatDateShort as formatDate, compactChips } from '../utils/format';
import { downloadCsv, toCsv } from '../utils/downloadCsv';
import { reportError } from '../utils/errorReporter';
import { formatPopupText } from '../utils/popupStyle';
import { titleCase } from '../utils/titleCase';
import { parseClubFinancialsPayload, type FinancialsPayload } from '../utils/clubFinancialsPayload';

type Period = 'week' | 'month' | 'all';

interface FinancialSnapshot {
  scope: string;
  resolvedClubId: string;
  requestedStart: string;
  requestedEnd: string;
  data: FinancialsPayload;
}

interface FinancialRequestState {
  scope: string;
  loading: boolean;
  loadError: string | null;
  denied: boolean;
  notFound: boolean;
}

/** The window the operator asked for, as UTC dates the server understands. */
function windowFor(period: Period): { start: string; end: string } {
  const today = new Date();
  const end = today.toISOString().slice(0, 10);
  if (period === 'all') return { start: '2020-01-01', end };
  const from = new Date(today);
  from.setUTCDate(from.getUTCDate() - (period === 'week' ? 6 : 29));
  return { start: from.toISOString().slice(0, 10), end };
}

const chips = (n: number | null | undefined) => compactChips(n ?? 0);
/* Counts are whole and can never be a fraction of a chip, so they take the
   platform's compact form: 124,549 raked hands reads "124.5K", rounded down,
   never overstated. */
const count = (n: number | null | undefined) => compactChips(Math.trunc(n ?? 0));

/** "Sep 3", from a UTC date string, without letting the local zone shift it. */
function dayLabel(iso: string): string {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return String(iso);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export default function ClubFinancialsPage() {
  const navigate = useNavigate();
  const { clubId } = useParams();
  const { user } = useAuthUser();

  const [period, setPeriod] = useState<Period>('week');
  const scopeKey = `${user?.id ?? 'signed-out'}:${clubId ?? ''}:${period}`;
  const [snapshot, setSnapshot] = useState<FinancialSnapshot | null>(null);
  const [requestState, setRequestState] = useState<FinancialRequestState>({
    scope: scopeKey,
    loading: true,
    loadError: null,
    denied: false,
    notFound: false,
  });
  const [userRole, setUserRole] = useState<ClubRole | null>(null);
  const [resolvedClubId, setResolvedClubId] = useState<string | null>(
    isUUID(clubId || '') ? (clubId as string) : null
  );
  // Dan 2026-08-23: tapping Club Bank opens the Club Bank Cashier.
  const [activeCashier, setActiveCashier] = useState<
    'club_bank' | 'promo_wallet' | 'agent_wallet' | null
  >(null);
  // Dan 2026-08-24: "PLAYER WALLET NEEDS TO BE FULLY CLICKABLE AND OPEN TO SEE
  // ALL TRANSACTIONS AND OTHER AVAILABLE DATA WHEN CLICKED." The row opens the
  // member's own statement - a read-only view, so it is not an activeCashier.
  const [showPlayerWallet, setShowPlayerWallet] = useState(false);
  const [visibleTransactions, setVisibleTransactions] = useState<Set<string>>(new Set());
  const toast = useToast();

  const isMounted = useIsMounted();
  const loadRef = useRef<() => void>(() => {});
  const requestVersionRef = useRef(0);
  const inFlightRef = useRef<{ scope: string; requestId: number } | null>(null);
  const activeScopeRef = useRef(scopeKey);
  activeScopeRef.current = scopeKey;
  const roleScopeKey = `${user?.id ?? 'signed-out'}:${clubId ?? ''}`;
  const activeRoleScopeRef = useRef(roleScopeKey);
  activeRoleScopeRef.current = roleScopeKey;

  const data = snapshot?.scope === scopeKey ? snapshot.data : null;
  const embeddedWeekSnapshot = useMemo(
    () =>
      period === 'week' && snapshot?.scope === scopeKey
        ? {
            resolvedClubId: snapshot.resolvedClubId,
            requestedStart: snapshot.requestedStart,
            requestedEnd: snapshot.requestedEnd,
            financials: snapshot.data,
          }
        : undefined,
    [period, scopeKey, snapshot]
  );
  const stateForScope: FinancialRequestState =
    requestState.scope === scopeKey
      ? requestState
      : {
          scope: scopeKey,
          loading: true,
          loadError: null,
          denied: false,
          notFound: false,
        };
  const { loading, loadError, denied, notFound } = stateForScope;

  // ── Reset per-club state when navigating between clubs ──
  useEffect(() => {
    setUserRole(null);
    setSnapshot(null);
    setVisibleTransactions(new Set());
    setActiveCashier(null);
    setShowPlayerWallet(false);
    setResolvedClubId(isUUID(clubId || '') ? (clubId as string) : null);
  }, [clubId]);

  // Hydrate userRole so DynamicWallet and the cashier show the right variant.
  // The owner_id outranks the membership row: a club owner with no
  // club_members row is still the owner, and fn_club_bank_role treats them
  // as one.
  useEffect(() => {
    if (!clubId || !user?.id) return;
    let cancelled = false;
    const requestRoleScope = roleScopeKey;
    const isCurrentRole = () =>
      !cancelled && isMounted.current && activeRoleScopeRef.current === requestRoleScope;
    (async () => {
      try {
        const { resolveClubUUIDStrict } = await import('../utils/strictClubIdResolver');
        const resolved = await resolveClubUUIDStrict(clubId);
        if (!isCurrentRole()) return;
        setResolvedClubId(resolved);
        const [membership, club] = await Promise.all([
          supabase
            .from('club_members')
            .select('role')
            .eq('club_id', resolved)
            .eq('user_id', user.id)
            .maybeSingle(),
          supabase.from('clubs').select('owner_id').eq('id', resolved).maybeSingle(),
        ]);
        if (!isCurrentRole()) return;
        if (club.data?.owner_id === user.id) {
          setUserRole('owner');
        } else if (membership.data?.role) {
          setUserRole(membership.data.role as ClubRole);
        } else {
          setUserRole('player');
        }
      } catch (e) {
        if (!isCurrentRole()) return;
        const name = (e as { name?: string } | null)?.name;
        if (name === 'ClubNotFoundError') {
          const currentScope = activeScopeRef.current;
          setRequestState((current) => ({
            ...current,
            scope: currentScope,
            notFound: true,
            loading: false,
          }));
          return;
        }
        reportError(e, 'ClubFinancialsPage.role');
        // The role only styles the wallet rows; the page's own gate is the
        // server's. Leave it null rather than claiming a role we did not read.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clubId, user?.id, isMounted, roleScopeKey]);

  const load = useCallback(async () => {
    if (!clubId) return;
    const requestScope = scopeKey;
    if (inFlightRef.current?.scope === requestScope) return;
    const requestId = ++requestVersionRef.current;
    inFlightRef.current = { scope: requestScope, requestId };
    const isCurrent = () =>
      isMounted.current &&
      activeScopeRef.current === requestScope &&
      requestVersionRef.current === requestId;

    setRequestState({
      scope: requestScope,
      loading: true,
      loadError: null,
      denied: false,
      notFound: false,
    });
    try {
      const { resolveClubUUIDStrict } = await import('../utils/strictClubIdResolver');
      const resolved = await resolveClubUUIDStrict(clubId);
      if (!isCurrent()) return;
      setResolvedClubId(resolved);
      const { start, end } = windowFor(period);
      const { data: payload, error } = await supabase.rpc('ca_club_financials', {
        p_club_id: resolved,
        p_start: start,
        p_end: end,
      });
      if (!isCurrent()) return;
      if (error) {
        if (isAuthzError(error)) {
          setSnapshot(null);
          setRequestState((current) =>
            current.scope === requestScope ? { ...current, denied: true } : current
          );
          return;
        }
        throw error;
      }
      setSnapshot({
        scope: requestScope,
        resolvedClubId: resolved,
        requestedStart: start,
        requestedEnd: end,
        data: parseClubFinancialsPayload(payload, { clubId: resolved, start, end }),
      });
    } catch (error) {
      if (!isCurrent()) return;
      if ((error as { name?: string } | null)?.name === 'ClubNotFoundError') {
        setSnapshot(null);
        setRequestState((current) =>
          current.scope === requestScope ? { ...current, notFound: true } : current
        );
        return;
      }
      reportError(error, 'ClubFinancialsPage.load');
      setRequestState((current) =>
        current.scope === requestScope
          ? {
              ...current,
              loadError: 'The Club Financials Could Not Be Loaded. No Figures Have Been Estimated.',
            }
          : current
      );
    } finally {
      if (inFlightRef.current?.requestId === requestId) inFlightRef.current = null;
      if (isCurrent()) {
        setRequestState((current) =>
          current.scope === requestScope ? { ...current, loading: false } : current
        );
      }
    }
  }, [clubId, isMounted, period, scopeKey]);

  useEffect(() => {
    void load();
  }, [load]);

  useVisibilityRefresh(() => void load());

  // Stagger animation for the recent rows.
  const recent = useMemo(() => data?.recent || [], [data]);
  useEffect(() => {
    if (recent.length === 0) return;
    setVisibleTransactions(new Set());
    const timers = recent.map((tx, index) =>
      setTimeout(() => setVisibleTransactions((prev) => new Set(prev).add(tx.id)), index * 60)
    );
    return () => timers.forEach(clearTimeout);
  }, [recent]);

  // ── Bus listeners: cross-page financial event reactivity ──
  useEffect(() => {
    loadRef.current = () => void load();
  });

  useEffect(() => {
    const refresh = () => loadRef.current();
    const unsubs = [
      masterBus.subscribeDebounced('BALANCE_UPDATED', refresh, 500),
      masterBus.subscribeDebounced('WALLET_REFRESHED', refresh, 500),
      masterBus.subscribeDebounced('CHIPS_ADDED', refresh, 500),
      masterBus.subscribeDebounced('CHIPS_DISTRIBUTED', refresh, 1000),
      masterBus.subscribeDebounced('CLUB_UPDATED', refresh, 1000),
      masterBus.subscribeDebounced('TRANSACTION_LOGGED', refresh, 2000),
    ];
    return () => unsubs.forEach((off) => off());
  }, [clubId]);

  /** Days actually plotted, for the heading when it is fewer than the window. */
  const chartDays = data?.daily?.length ?? 0;

  const chartData = useMemo(
    () =>
      (data?.daily || []).map((d) => ({
        name: dayLabel(d.d),
        rake: d.gross_rake,
        rakeback: d.rakeback_paid,
        commissions: d.agent_commissions,
      })),
    [data]
  );

  const exportCsv = useCallback(() => {
    if (!data) return;
    const rows = data.daily.map((d) => [
      d.d,
      d.raked_hands,
      d.gross_rake,
      d.bbj_drop,
      d.gross_rake - d.bbj_drop,
      d.pot_volume,
      d.tournament_fees,
      d.rakeback_paid,
      d.agent_commissions,
      d.union_fee,
      d.gross_rake -
        d.bbj_drop +
        d.tournament_fees -
        d.rakeback_paid -
        d.agent_commissions -
        d.union_fee,
    ]);
    const ok = downloadCsv(
      `club-financials-${data.range.start}-to-${data.range.end}.csv`,
      toCsv(
        [
          'Day',
          'Raked Hands',
          'Gross Rake',
          'Bad Beat Drop',
          'Net Rake',
          'Pot Volume',
          'Tournament Fees',
          'Rakeback Paid',
          'Agent Fees',
          'Union Fee',
          'Net Revenue',
        ],
        rows
      )
    );
    if (!ok) toast.error('This Browser Could Not Start The Download');
  }, [data, toast]);

  if (notFound) {
    return (
      <StandardContentLayout className="financials-page">
        <SpadeConsole
          className="cf-console"
          family="spade"
          eyebrow="Club Arena"
          title="Club Not Found"
          pill="Missing"
          pillInk="muted"
          foot="foot"
        >
          <p className="sc-copy sc-copy--center">That Club Could Not Be Found.</p>
          <button
            type="button"
            className="cf-word sc-ink--blue"
            onClick={() => navigate('/clubs', { replace: true })}
          >
            Back To Clubs
          </button>
        </SpadeConsole>
      </StandardContentLayout>
    );
  }

  if (denied) {
    return (
      <StandardContentLayout className="financials-page">
        <SpadeConsole
          className="cf-console"
          family="spade"
          eyebrow="Club Arena"
          title="Financials Are Restricted"
          pill="Staff"
          pillInk="red"
          foot="foot"
        >
          <p className="sc-copy sc-copy--center">
            Club Financials Are Available To Club Owners, Admins And Super Agents.
          </p>
          <button
            type="button"
            className="cf-word sc-ink--blue"
            onClick={() => navigate(`/clubs/${clubId}`)}
          >
            Back To Club
          </button>
        </SpadeConsole>
      </StandardContentLayout>
    );
  }

  if (loading && !data) {
    return (
      <StandardContentLayout className="financials-page">
        <SpadeConsole
          className="cf-console"
          family="spade"
          aria-busy
          eyebrow="Club Arena"
          title="Financials"
          pill="Loading"
          pillInk="muted"
          foot="foot"
        >
          <p className="sc-copy sc-copy--center" role="status">
            Reading The Club Ledger...
          </p>
        </SpadeConsole>
      </StandardContentLayout>
    );
  }

  if (loadError && !data) {
    return (
      <StandardContentLayout className="financials-page">
        <SpadeConsole
          className="cf-console"
          family="spade"
          eyebrow="Club Arena"
          title="Financials Unavailable"
          pill="Retry"
          pillInk="red"
          foot="foot"
        >
          <p className="sc-copy sc-copy--center sc-ink--red" role="alert">
            {loadError}
          </p>
          <button type="button" className="cf-word sc-ink--blue" onClick={() => void load()}>
            Retry Financials
          </button>
        </SpadeConsole>
      </StandardContentLayout>
    );
  }

  const totals = data?.totals;
  const rangeNote = data
    ? `${dayLabel(data.range.start)} To ${dayLabel(data.range.end)}${
        period === 'all' && data.range.start > '2020-01-01'
          ? ' - Every Day This Club Has Traded'
          : ''
      }`
    : '';

  /* THE SAME EIGHT FIGURES, IN THE SAME ORDER, WITH THE SAME ARITHMETIC.
     They were a grid of drawn tiles; they are rows on the glass now, and an
     outflow is a red value rather than a repainted box. */
  const summaryRows: { label: string; value: string; ink: ConsoleInk; note?: string }[] = totals
    ? [
        { label: 'Raked Hands', value: count(totals.raked_hands), ink: 'silver' },
        { label: 'Pot Volume', value: chips(totals.pot_volume), ink: 'silver' },
        {
          label: 'Net Rake',
          value: chips(totals.net_rake),
          ink: 'green',
          /* Gross and drop, because the club keeps one and not the other. */
          note: `${chips(totals.gross_rake)} Raked, ${chips(totals.bbj_drop)} To The Jackpot`,
        },
        { label: 'Tournament Fees', value: chips(totals.tournament_fees), ink: 'silver' },
        { label: 'Rakeback', value: `-${chips(totals.rakeback_paid)}`, ink: 'red' },
        { label: 'Agent Fees', value: `-${chips(totals.agent_commissions)}`, ink: 'red' },
        /* The union line is only a line for a club that is in a union. It read
           invoice_type 'union_to_club' - a type the weekly square-up never
           writes - so it contributed a silent zero to Net Revenue for every
           club on the platform. */
        {
          label: data?.union_id ? 'Union Fee' : 'Union Fee (No Union)',
          value: data?.union_id ? `-${chips(totals.union_fee)}` : '-',
          ink: data?.union_id ? 'red' : 'muted',
        },
        {
          label: 'Net Revenue',
          value: `${totals.net_revenue >= 0 ? '+' : ''}${chips(totals.net_revenue)}`,
          ink: totals.net_revenue >= 0 ? 'green' : 'red',
          note: 'Net Rake Plus Tournament Fees, Less Rakeback, Agent Fees And Union Fees',
        },
      ]
    : [];

  return (
    <StandardContentLayout className="financials-page">
      {/* Real-Time Wallet Overview */}
      {clubId && user?.id && (
        <DynamicWallet
          userId={user.id}
          clubId={clubId}
          variant="club"
          // Dan 2026-08-23: role decides the rows. Club Bank, and the cashier
          // behind it, are owner / co-owner / admin / super agent only.
          role={userRole || 'player'}
          onBuyDiamonds={() => navigate(withClubContext('/vip', clubId))}
          onOpenPlayerWallet={() => setShowPlayerWallet(true)}
          onOpenPromoWallet={() => setActiveCashier('promo_wallet')}
          onOpenAgentWallet={() => setActiveCashier('agent_wallet')}
          onOpenClubBank={() => setActiveCashier('club_bank')}
          onOpenBBJ={() => navigate(`/clubs/${clubId}/jackpot`)}
        />
      )}
      {clubId && (
        <>
          <WalletCashierModal
            isOpen={!!activeCashier}
            onClose={() => setActiveCashier(null)}
            clubId={clubId}
            role={userRole || 'player'}
            walletType={activeCashier || DEFAULT_CASHIER_WALLET}
          />
          <PlayerWalletModal
            isOpen={showPlayerWallet}
            onClose={() => setShowPlayerWallet(false)}
            clubId={clubId}
          />
        </>
      )}

      {/* ── The window: three lit words and the export ───────────────── */}
      <SpadeConsole
        className="cf-console"
        family="spade"
        aria-busy={loading || undefined}
        eyebrow="Club Arena"
        title="Financials"
        pill={period === 'week' ? 'Week' : period === 'month' ? 'Month' : 'All Time'}
        pillInk="blue"
        foot="foot"
      >
        {/* The master paints no tab, so nothing here draws one: the three
            windows are lit words cut into the glass. */}
        <div className="cf-rail" role="tablist" aria-label="Reporting Window">
          {(['week', 'month', 'all'] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              className={`cf-rail__word ${period === p ? 'sc-ink--silver' : 'sc-ink--muted'}`}
              aria-selected={period === p}
              onClick={() => setPeriod(p)}
            >
              {p === 'week' ? 'This Week' : p === 'month' ? 'This Month' : 'All Time'}
            </button>
          ))}
        </div>

        {rangeNote && (
          <p className="sc-copy sc-copy--center" aria-live="polite">
            {rangeNote}
            {loading ? ' - Refreshing' : ''}
          </p>
        )}

        <button type="button" className="cf-word sc-ink--blue" onClick={exportCsv} disabled={!data}>
          Export CSV
        </button>

        {loadError && data && (
          <p className="sc-copy sc-copy--center sc-ink--red" role="alert">
            {loadError}
          </p>
        )}
      </SpadeConsole>

      {/* Revenue Chart. ca_club_financials caps the daily series at the
          last 92 days of the window while the totals cover all of it, so on a
          club with a longer history the chart is a SHORTER window than the
          figures below it. Say which, rather than letting the picture imply
          the numbers. */}
      <SpadeConsole
        className="cf-console"
        family="spade"
        eyebrow="Club Arena"
        title="Revenue Trend"
        subtitle={
          data && data.range.series_from > data.range.start
            ? `Last ${chartDays} Days Of This Window`
            : undefined
        }
        foot="foot"
      >
        <FinancialChart data={chartData} height={180} showRakeback={true} showCommissions={true} />
      </SpadeConsole>

      {/* ── Summary: eight figures as rows on the glass ──────────────── */}
      {totals && (
        <SpadeConsole
          className="cf-console"
          family="spade"
          eyebrow={rangeNote || 'Club Arena'}
          title="Summary"
          pill={totals.net_revenue >= 0 ? 'Up' : 'Down'}
          pillInk={totals.net_revenue >= 0 ? 'green' : 'red'}
          foot="foot"
        >
          <dl className="cf-facts">
            {summaryRows.map((row) => (
              <div key={row.label} className="cf-fact">
                <dt className="cf-fact__label sc-label sc-ink--blue">{row.label}</dt>
                <dd className={`cf-fact__value sc-ink--${row.ink}`}>
                  {row.value}
                  {row.note && <span className="cf-fact__note sc-ink--muted">{row.note}</span>}
                </dd>
              </div>
            ))}
          </dl>
          {data?.union_id && totals.union_statements > 0 && (
            <p className="sc-copy">
              {count(totals.union_statements)} Weekly Square-Up
              {totals.union_statements === 1 ? '' : 's'} Issued In This Window,{' '}
              {totals.union_squareup >= 0
                ? `${chips(totals.union_squareup)} Owed To The Union`
                : `${chips(Math.abs(totals.union_squareup))} Owed To This Club`}
              .
            </p>
          )}
        </SpadeConsole>
      )}

      {/* Where the rake came from */}
      {data && data.by_table.length > 0 && (
        <SpadeConsole
          className="cf-console"
          family="spade"
          eyebrow="Club Arena"
          title="Top Tables By Rake"
          pill={count(data.by_table.length)}
          pillInk="blue"
          foot="foot"
        >
          <ol className="cf-list">
            {data.by_table.map((t) => (
              <li key={t.table_id} className="cf-row">
                <span className="cf-row__name sc-ink--silver">{titleCase(t.name)}</span>
                <span className="cf-row__meta sc-ink--muted">
                  {titleCase([t.variant, t.stakes].filter(Boolean).join(' '))} -{' '}
                  {count(t.raked_hands)} Raked Hands
                </span>
                <span className="cf-row__amount sc-ink--green">{chips(t.rake)}</span>
              </li>
            ))}
          </ol>
        </SpadeConsole>
      )}

      {/* Club Financial Dashboard (club staff). Money-changing work stays in
          the maintained Club Bank Cashier and Agent Management surfaces. */}
      {clubId && (isClubStaff(userRole) || userRole === 'super_agent') && (
        /* ClubFinancialDashboard owns its approved painted consoles. This
           embed supplies layout room only, so no frame sits on its frames. */
        <section className="cf-embed">
          <ClubFinancialDashboard
            clubId={clubId}
            canManageAgents={isClubStaff(userRole)}
            initialSnapshot={embeddedWeekSnapshot}
          />
        </section>
      )}

      {/* Rake Analytics Reports */}
      {clubId && (
        <section className="cf-embed">
          <RakeReports clubId={clubId} initialSnapshot={embeddedWeekSnapshot} />
        </section>
      )}

      {/* ── Recent raked hands ───────────────────────────────────────── */}
      <SpadeConsole
        className="cf-console"
        family="spade"
        eyebrow="Club Arena"
        title="Recent Rake"
        pill={recent.length === 0 ? 'Empty' : count(recent.length)}
        pillInk={recent.length === 0 ? 'muted' : 'blue'}
        foot="foot"
      >
        {recent.length === 0 ? (
          <div className="cf-empty">
            <span className="sc-label sc-ink--muted">Nothing Raked</span>
            <p className="sc-copy sc-copy--center">No Rake In This Period.</p>
          </div>
        ) : (
          <ol className="cf-list">
            {recent.map((tx) => (
              /* THE STAGGER STILL PLAYS. Same `visibleTransactions` set, same
                 60ms step, same eight-pixel lift - it just runs on the global
                 `animationsFadeInUp` keyframe instead of a local copy. */
              <li
                key={tx.id}
                className="cf-row"
                style={
                  visibleTransactions.has(tx.id)
                    ? {
                        opacity: 0,
                        transform: 'translateY(8px)',
                        animation: 'animationsFadeInUp 0.4s ease-out forwards',
                      }
                    : { opacity: 0, transform: 'translateY(8px)' }
                }
              >
                <span className="cf-row__name sc-ink--silver">
                  {formatPopupText(
                    tx.kind === 'cash_rake'
                      ? `${chips(tx.rake_amount)} Raked From A ${chips(tx.pot_size)} Pot At ${tx.table_name}`
                      : `${chips(tx.rake_amount)} Tournament Fee`
                  )}
                </span>
                <span className="cf-row__meta sc-ink--muted">
                  {formatDate(tx.created_at)}
                  {tx.bbj_contribution > 0 ? ` - ${chips(tx.bbj_contribution)} To The Jackpot` : ''}
                </span>
                <span className="cf-row__amount sc-ink--green">+{chips(tx.rake_amount)}</span>
              </li>
            ))}
          </ol>
        )}
      </SpadeConsole>

      {/* Chip Ledger - Club Transaction Audit Trail.
          Through the club-scoped RPC: chip_ledger's own RLS returns the
          CALLER's rows, so this panel showed a club owner their personal
          movements under the heading "Club Chip Audit Trail". */}
      {resolvedClubId && (
        <SpadeConsole
          className="cf-console"
          family="spade"
          eyebrow="Club Arena"
          title="Club Chip Audit Trail"
          foot="foot"
        >
          <TransactionLedgerView clubId={resolvedClubId} clubScoped limit={25} />
        </SpadeConsole>
      )}

      {/* Phase 7 (roadmap 9.5): the treasury's own statement - balance now,
          both directions, and the nightly reading it is checked against. Same
          gate as the ledger above (ca_can_view_club_finances). */}
      {resolvedClubId && isUUID(resolvedClubId) && (
        <section className="cf-embed">
          <ChipStatement scope="club_treasury" clubId={resolvedClubId} title="Treasury Statement" />
        </section>
      )}

      {data?.data_updated_at && (
        <p className="cf-footnote sc-ink--muted">
          Rake Updated {formatDate(data.data_updated_at)} - Figures Are From The Club Ledger
        </p>
      )}
    </StandardContentLayout>
  );
}
