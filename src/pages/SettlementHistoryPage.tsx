/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SETTLEMENT HISTORY PAGE — Historical Settlement Timeline & Trends
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Shows past settlement cycles with trend comparison.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useToast } from '../components/common/Toast';
import { SpadeConsole } from '../components/console/SpadeConsole';
import { useAuthUser } from '../hooks/useAuthUser';

import { useIsMounted } from '../hooks/useIsMounted';
import { reportError } from '../utils/errorReporter';
import { safeErrorMessage } from '../utils/safeErrorMessage';
import FinancialAdminScopeState from '../components/common/FinancialAdminScopeState';
import { clubScoped, useFinancialAdminScope } from '../hooks/useFinancialAdminScope';
import { compactChips } from '../utils/format';
import { parseSettlementHistory, type SettlementHistoryCycle } from '../utils/settlementHistory';
import { titleCase } from '../utils/titleCase';
import styles from './SettlementHistoryPage.module.css';

export default function SettlementHistoryPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuthUser();

  const [storedCycles, setCycles] = useState<SettlementHistoryCycle[]>([]);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /* A FAILED READ IS NOT "THE PERIOD HAD NO SETTLEMENTS" (2026-09-10). The
     settlement_invoices read discarded its error, so a refused or failed
     query rendered zeroed tiles and an empty chart as though nothing had
     been settled. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [visibleRows, setVisibleRows] = useState<Set<number>>(new Set());
  const isMounted = useIsMounted();
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  /* WHOSE HISTORY (2026-09-10). settlement_invoices was filtered only by
     invoice_type, so a union overseer - whose RLS grant covers every club in
     the union - read every club's rake-hold invoices as this club's history,
     summed into the tiles and the chart. The scope names the club. */
  const scope = useFinancialAdminScope();
  const scopeStatus = scope.status;
  const scopeClubId = scope.clubId;
  const scopePlatformWide = scope.platformWide;
  const readScope = `${user?.id ?? 'signed-out'}:${scope.userId ?? 'unverified'}:${scopeStatus}:${scopeClubId ?? 'no-club'}:${scopePlatformWide}`;
  const activeScopeRef = useRef(readScope);
  activeScopeRef.current = readScope;
  const cycles = loadedScope === readScope ? storedCycles : [];

  const requestSequence = useRef(0);

  const loadHistory = useCallback(async () => {
    if (
      scopeStatus !== 'ready' ||
      !user?.id ||
      scope.userId !== user.id ||
      !scopeClubId ||
      scopePlatformWide
    )
      return;
    const requestScope = readScope;
    const request = ++requestSequence.current;
    const current = () =>
      requestSequence.current === request &&
      isMounted.current &&
      activeScopeRef.current === requestScope;
    setLoading(true);
    setLoadError(null);
    setCycles([]);
    setLoadedScope(null);
    setVisibleRows(new Set());
    staggerTimersRef.current.forEach(clearTimeout);
    staggerTimersRef.current = [];
    try {
      // SWEEP #3 (2026-07-23): repointed off the phantom club_settlements table
      // onto settlement_invoices. gross_amount = rake collected in the period;
      // net_amount = the union's hold (union tax); breakdown.club_retained =
      // what the club kept.
      // FIX 2026-08-19: this query had NO invoice_type filter, and the mapper
      // assumes every row is a union rake-hold invoice (reading
      // breakdown.union_hold_amount / breakdown.club_retained). A
      // 'union_club_pnl' row — the new weekly player win/loss settlement — has
      // neither key and gross_amount == net_amount, so it rendered as
      // "Rake: X / Fee: -X / Net: 0", i.e. "the union took 100% of your rake",
      // and it corrupted every summary tile and the chart scale. Scope to the
      // rake-hold invoices this screen is actually about.
      const { data, error } = await clubScoped(
        supabase
          .from('settlement_invoices')
          .select(
            'id, club_id, period_id, invoice_type, gross_amount, net_amount, breakdown, status, created_at'
          )
          .eq('invoice_type', 'union_to_club')
          // invoice_type records transfer direction, so later rakeback and
          // commission documents also use union_to_club. A settlement cycle
          // is the narrower rake-split record with both duplicated split
          // fields. Filter before ordering and limiting so unrelated transfer
          // documents cannot displace valid history or corrupt its totals.
          .not('breakdown->>union_hold_amount', 'is', null)
          .not('breakdown->>club_retained', 'is', null),
        { status: scopeStatus, clubId: scopeClubId, platformWide: scopePlatformWide }
      )
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;

      if (current()) {
        const mapped = parseSettlementHistory(data, scopeClubId);
        if (!mapped) throw new Error('Settlement history response was malformed');
        setCycles(mapped);
        setLoadedScope(requestScope);
        // Clear previous stagger timers before starting new ones
        staggerTimersRef.current.forEach(clearTimeout);
        staggerTimersRef.current = mapped.map((_, i) =>
          setTimeout(() => {
            if (current()) setVisibleRows((prev) => new Set(prev).add(i));
          }, i * 50)
        );
      }
    } catch (err) {
      if (!current()) return;
      reportError(err, 'SettlementHistoryPage.Load_failed');
      setCycles([]);
      setLoadedScope(requestScope);
      setLoadError(
        safeErrorMessage(
          err,
          'The Settlement History Could Not Be Loaded. Nothing Has Been Changed.'
        )
      );
      toast.error('Failed to load settlement history');
    } finally {
      if (current()) setLoading(false);
    }
  }, [
    scopeStatus,
    scopeClubId,
    scopePlatformWide,
    scope.userId,
    user?.id,
    readScope,
    toast,
    isMounted,
  ]);

  useVisibilityRefresh(() => loadHistory());

  useEffect(() => {
    void loadHistory();
    const request = requestSequence.current;
    return () => {
      if (requestSequence.current === request) requestSequence.current = request + 1;
    };
  }, [loadHistory]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    const request = requestSequence.current;
    return () => {
      staggerTimersRef.current.forEach(clearTimeout);
      if (requestSequence.current === request) requestSequence.current = request + 1;
    };
  }, []);

  useEffect(() => {
    // WebSocket: live settlement updates
    if (
      scopeStatus !== 'ready' ||
      !user?.id ||
      scope.userId !== user.id ||
      !scopeClubId ||
      scopePlatformWide
    )
      return;
    const channelKey = `settlement-history-updates:${scopeClubId ?? 'platform'}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          // SWEEP #3 (2026-07-23): club_settlements never existed — the real
          // club settlement record is settlement_invoices (union<->club wires).
          // 2026-08-19: scope to the invoice type this screen renders, so the
          // new weekly player-P&L rows do not trigger a full reload of a list
          // they are not part of.
          event: '*',
          schema: 'public',
          table: 'settlement_invoices',
          filter: 'invoice_type=eq.union_to_club',
        },
        () => loadHistory()
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err)
            reportError(err?.message || err, 'SettlementHistoryPage._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[SettlementHistoryPage] Realtime channel timed out');
        }
      });

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [loadHistory, scopeStatus, scopeClubId, scopePlatformWide, scope.userId, user?.id]);

  const totalRakeAllTime = cycles.reduce((s, c) => s + c.totalRake, 0);
  const totalSettled = cycles.reduce((s, c) => s + c.netSettlement, 0);
  const maxRake = Math.max(...cycles.map((c) => c.totalRake), 1);

  if (scope.status !== 'ready' || scope.userId !== user?.id) {
    return <FinancialAdminScopeState scope={scope} />;
  }

  if (!scopeClubId || scopePlatformWide) {
    return (
      <main className={styles.page}>
        <SpadeConsole
          className={styles.console}
          family="shark"
          crest="flat"
          eyebrow="Club Arena Data"
          title="Settlement History Needs A Club"
          subtitle="Open This Console From A Club Financial Scope"
          pill="Club Required"
          pillInk="gold"
          plates={{ primary: { label: 'Back', onClick: () => navigate(-1) } }}
        >
          <p className="sc-copy sc-copy--center" role="status">
            Platform-Wide Rows Are Never Combined Into One Club Settlement History.
          </p>
        </SpadeConsole>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <SpadeConsole
        className={styles.console}
        family="shark"
        eyebrow="Club Arena"
        title="Settlement History"
        subtitle="Weekly Settlement Cycles And Revenue Trends"
        pill={loading ? 'Loading' : loadError ? 'Unavailable' : `${cycles.length} Cycles`}
        pillInk={loadError ? 'red' : loading ? 'blue' : 'green'}
        plates={{ primary: { label: 'Back', onClick: () => navigate(-1) } }}
      >
        <section className={styles.summary} aria-label="Settlement Summary">
          <div className={styles.fact}>
            <span className="sc-label sc-ink--blue">Total Rake</span>
            <strong className="sc-ink--silver">
              {loadError ? 'Unavailable' : compactChips(totalRakeAllTime)}
            </strong>
          </div>
          <div className={styles.fact}>
            <span className="sc-label sc-ink--blue">Net Settled</span>
            <strong className="sc-ink--green">
              {loadError ? 'Unavailable' : compactChips(totalSettled)}
            </strong>
          </div>
          <div className={styles.fact}>
            <span className="sc-label sc-ink--blue">Cycles</span>
            <strong className="sc-ink--silver">
              {loadError ? 'Unavailable' : compactChips(cycles.length)}
            </strong>
          </div>
        </section>

        {cycles.length > 0 && (
          <section className={styles.timeline} aria-label="Revenue Timeline">
            <div className="sc-label sc-ink--blue">Revenue Timeline</div>
            <div className={styles.bars}>
              {cycles
                .slice(0, 20)
                .reverse()
                .map((cycle) => (
                  <span
                    key={cycle.id}
                    className={styles.bar}
                    data-complete={String(cycle.status === 'completed')}
                    style={{ height: `${Math.max(4, (cycle.totalRake / maxRake) * 60)}px` }}
                    title={`Rake: ${compactChips(cycle.totalRake)}`}
                  />
                ))}
            </div>
            <div className={styles.timelineAxis}>
              <span>Oldest</span>
              <span>Most Recent</span>
            </div>
          </section>
        )}

        <div className={`${styles.sectionLabel} sc-label sc-ink--blue`}>Settlement Cycles</div>
        {loading && cycles.length === 0 && !loadError ? (
          <div className={styles.state} role="status">
            Loading Settlement Cycles...
          </div>
        ) : loadError ? (
          <div className={`${styles.state} sc-ink--red`} role="alert">
            <div>{loadError}</div>
            <button
              type="button"
              onClick={() => void loadHistory()}
              className={`${styles.word} sc-ink--white`}
            >
              Retry
            </button>
          </div>
        ) : cycles.length === 0 ? (
          <div className={`${styles.state} sc-ink--muted`}>No Settlement Cycles Yet</div>
        ) : (
          <ol className={styles.cycles}>
            {cycles.map((cycle, idx) => (
              <li
                key={cycle.id}
                className={styles.cycle}
                data-visible={String(visibleRows.has(idx))}
              >
                <div className={styles.cycleHead}>
                  <div>
                    <strong className="sc-ink--silver">Period: {titleCase(cycle.periodId)}</strong>
                    <time className="sc-ink--muted" dateTime={cycle.createdAt}>
                      {new Date(cycle.createdAt).toLocaleDateString()}
                    </time>
                  </div>
                  <span className={cycle.status === 'completed' ? 'sc-ink--green' : 'sc-ink--gold'}>
                    {titleCase(cycle.status)}
                  </span>
                </div>
                <div className={styles.amounts}>
                  <span>
                    Rake <strong className="sc-ink--silver">{compactChips(cycle.totalRake)}</strong>
                  </span>
                  {cycle.unionTax > 0 && (
                    <span>
                      Fee <strong className="sc-ink--red">-{compactChips(cycle.unionTax)}</strong>
                    </span>
                  )}
                  <span>
                    Net{' '}
                    <strong className="sc-ink--green">{compactChips(cycle.netSettlement)}</strong>
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </SpadeConsole>
    </main>
  );
}
