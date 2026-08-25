/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CASHIER — TRADE VIEW (Dan 2026-08-21, PokerBros reference build)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The cashier the way an agent actually works it:
 *
 *   Header    « CASHIER  [CLUB ▾] — entity switcher listing EVERY club and
 *             union the viewer belongs to, with balances (Dan: "I also own
 *             the midway union... show wallets for all the clubs, unions a
 *             user is a part of").
 *   Tabs      Trade | Trade Record | Leaderboard Record | Chip Request
 *   Strip     Your Chip Balance · Agency Players Balance · Available Chips (+)
 *   List      the viewer's DOWNLINE (whole club for owners/admins, assigned
 *             players for agents) with live balances, search, group-by-role,
 *             sort, and multi-select.
 *   Footer    Claim Back | Send Ticket | Send Out — pinned to the bottom.
 *
 * Money moves on the CLUB ledger (club_members.chip_balance):
 *   Send Out   → fn_transfer_chips(club, me → player)   [atomic + chip_transactions log]
 *   Claim Back → fn_admin_remove_player_chips           [SECURITY DEFINER, authz inside]
 *
 * The classic cashier (buy-in / cash-out / mint / full history) remains at
 * ./cashier-classic and is linked from the bottom of the Trade tab.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { isClubStaff } from '../types/clubRoles';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import { masterBus } from '../core/MasterBus';
import { useToast } from '../components/common/Toast';
import WalletCashierModal from '../components/wallet/WalletCashierModal';
import { canSeeClubBank } from '../components/wallet/walletRows';
import ClubBottomNav from '../components/club/ClubBottomNav';
import styles from './CashierTradePage.module.css';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Membership {
  clubUuid: string;
  clubCode: number | null;
  name: string;
  logoUrl: string | null;
  role: string;
  chipBalance: number;
}

interface DownlineRow {
  userId: string;
  name: string;
  username: string;
  avatarUrl: string | null;
  role: string;
  chipBalance: number;
  isHorse: boolean;
  /** club_members.agent_id - the USER id of the agent this player sits under. */
  agentId: string | null;
  /** true when this player is assigned to the person looking at the screen */
  isMine: boolean;
  playerNumber: string | null;
}

// A membership row means "in this club". The column carries two words for it:
// everything created before 2026-07-22 says 'approved', everything since says
// 'active', and 1,480 of the 1,499 rows in production are the older word. Every
// other query in this codebase asks for BOTH - this page asked for 'active'
// alone, which is why a 588-member club showed 11 people and an owner's
// assigned horses vanished. Named once here so the next screen copies the set
// rather than one of its halves.
const MEMBER_IN_CLUB = ['active', 'approved'];

// PostgREST caps a response at 1,000 rows. A club with more members than that
// would silently lose the tail, which on a page that MOVES CHIPS is not an
// acceptable failure mode, so the fetch pages until it has everything.
const PAGE = 1000;
const MAX_MEMBERS = 10000;

interface TradeRecordRow {
  id: string;
  createdAt: string;
  type: string;
  amount: number;
  direction: 'in' | 'out';
  counterparty: string;
}

interface ChipRequestRow {
  id: string;
  requesterId: string;
  requesterName: string;
  amount: number;
  note: string | null;
  status: string;
  createdAt: string;
  mine: boolean;
}

interface InvoiceRow {
  id: string;
  createdAt: string;
  type: string;
  gross: number;
  net: number;
  status: string;
}

type TabKey = 'trade' | 'record' | 'leaderboard' | 'request';

const fmt = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * Raw Postgres enums were rendered straight at the user: "peer_transfer",
 * "awaiting_payment". Title Case them, the way ROLE_LABEL does for roles.
 */
function txLabel(value: string | null | undefined): string {
  return String(value || '')
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export default function CashierTradePage() {
  const { clubId: clubParam } = useParams<{ clubId: string }>();
  const navigate = useNavigate();
  const { user, isHydrating } = useAuthUser();
  const toast = useToast();

  const [clubUuid, setClubUuid] = useState<string | null>(null);
  const [clubResolveFailed, setClubResolveFailed] = useState(false);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tab, setTab] = useState<TabKey>('trade');

  const [myRole, setMyRole] = useState<string>('player');
  const [myBalance, setMyBalance] = useState(0);
  const [availableChips, setAvailableChips] = useState(0);
  const [downline, setDownline] = useState<DownlineRow[]>([]);
  const [mineOnly, setMineOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // isMounted is an UNMOUNT guard, not a request guard. loadClub fires from
  // three places at once - the effect, every balance bus event, and after each
  // transfer - so without a version the response for the club you just left
  // can land last and paint its balances under the club you are now looking
  // at. On a page that moves chips that is not a cosmetic race.
  const loadVersion = useRef(0);

  const [search, setSearch] = useState('');
  const [groupByRole, setGroupByRole] = useState(false);
  const [sortKey, setSortKey] = useState<'balance' | 'name'>('balance');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [records, setRecords] = useState<TradeRecordRow[]>([]);
  // Dan 2026-08-21: the three tabs/buttons that used to say "coming soon" are
  // real features now (chip_requests + tournament_tickets, migration 20260821).
  const [requests, setRequests] = useState<ChipRequestRow[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [requestsError, setRequestsError] = useState<string | null>(null);
  /** Which request row is mid-RPC. Approving one MOVES CHIPS. */
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const respondingRef = useRef(false);
  const [asking, setAsking] = useState(false);
  const askingRef = useRef(false);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [askAmount, setAskAmount] = useState('');
  const [askNote, setAskNote] = useState('');
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [amountModal, setAmountModal] = useState<'send' | 'claim' | 'ticket' | null>(null);
  /**
   * Per-target failures from the last batch, rendered IN the modal. The toast
   * layer sanitises money errors (it strips the player's name off an
   * insufficient-funds refusal) and drops whole error categories, so on a
   * partial failure the user could not tell which recipients missed out.
   * JSX bypasses that sanitiser.
   */
  const [transferFailures, setTransferFailures] = useState<
    Array<{ name: string; message: string }>
  >([]);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  // AUDIT 2026-08-21: the "+" on Available Chips used to punt to the classic
  // cashier, then opened the Chip Mint directly.
  // Dan 2026-08-23: it opens the CLUB BANK CASHIER now. The mint lives inside
  // that, for standalone clubs only - a club in a union has no mint at all.
  const [activeCashier, setActiveCashier] = useState<
    'club_bank' | 'promo_wallet' | 'agent_wallet' | null
  >(null);
  // Guards a double-submit that beats the re-render `busy` depends on.
  const busyRef = useRef(false);
  /**
   * Identifies ONE claim submission across retries, so a request that already
   * committed cannot be charged twice by the retry that follows a lost
   * response. Held across failures on purpose and cleared only on full
   * success - see runTransfers.
   */
  const submissionIdRef = useRef<string | null>(null);
  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  // ── Resolve club uuid from the route param ─────────────────────────────────
  useEffect(() => {
    let live = true;
    (async () => {
      if (!clubParam) return;
      setClubResolveFailed(false);
      // Falling back to the raw param put a club CODE into a uuid column
      // filter, so every later query matched nothing and the cashier looked
      // simply empty. A club we cannot identify is an error, not a filter.
      const uuid = await resolveClubUUID(clubParam);
      if (!live) return;
      if (uuid) {
        setClubUuid(uuid);
      } else {
        setClubUuid(null);
        setClubResolveFailed(true);
        setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [clubParam]);

  // ── Load every membership (the entity switcher) ────────────────────────────
  useEffect(() => {
    if (!user?.id) return;
    let live = true;
    (async () => {
      const { data, error } = await supabase
        .from('club_members')
        .select('club_id, role, chip_balance, clubs:club_id (name, club_id, logo_url)')
        .eq('user_id', user.id)
        .in('status', MEMBER_IN_CLUB);
      if (error) {
        reportError(error, 'CashierTradePage.memberships');
        return;
      }
      if (!live) return;
      const rows: Membership[] = (data || [])
        .map((r) => {
          const c = (Array.isArray(r.clubs) ? r.clubs[0] : r.clubs) as {
            name?: string;
            club_id?: number;
            logo_url?: string;
          } | null;
          return {
            clubUuid: r.club_id as string,
            clubCode: c?.club_id ?? null,
            name: c?.name || 'Club',
            logoUrl: c?.logo_url || null,
            role: (r.role as string) || 'player',
            chipBalance: Number(r.chip_balance) || 0,
          };
        })
        .sort((a, b) => b.chipBalance - a.chipBalance);
      setMemberships(rows);
    })();
    return () => {
      live = false;
    };
  }, [user?.id]);

  const currentClub = useMemo(
    () => memberships.find((m) => m.clubUuid === clubUuid) || null,
    [memberships, clubUuid]
  );

  // ── Load my role/balance + downline for the selected club ─────────────────
  const loadClub = useCallback(async () => {
    // Bail-before-try left `loading` true forever, because the finally that
    // clears it is inside the try: a signed-out moment or an unresolvable club
    // gave a permanent "Loading members...". Clear it here instead.
    if (!user?.id || !clubUuid) {
      setLoading(false);
      return;
    }
    const myVersion = ++loadVersion.current;
    const stale = () => loadVersion.current !== myVersion;
    setLoading(true);
    setLoadError(null);
    try {
      const [meRes, panelRes] = await Promise.all([
        supabase
          .from('club_members')
          .select('role, chip_balance')
          .eq('club_id', clubUuid)
          .eq('user_id', user.id)
          .maybeSingle(),
        supabase.rpc('fn_club_money_panel', { p_club_id: clubUuid }),
      ]);
      // Swallowing this error rendered an owner as a `player` with a 0.00
      // balance and silently flipped the downline into agent scope. A failure
      // has to look like a failure.
      if (meRes.error) throw meRes.error;
      const role = meRes.data?.role ? (meRes.data.role as string) : 'player';
      const bal = meRes.data?.chip_balance ? Number(meRes.data.chip_balance) : 0;
      const panel = ((Array.isArray(panelRes.data) ? panelRes.data[0] : panelRes.data) ??
        {}) as Record<string, unknown>;

      const isStaff = isClubStaff(role);
      const isAgent = role === 'agent' || role === 'super_agent' || role === 'sub_agent';

      let downlineIds: string[] | null = null;
      if (isAgent && !isStaff) {
        /**
         * TWO SHAPES, ONE FUNCTION (Dan 2026-08-25).
         *
         * ca_club_my_downline exists in the repo twice: a jsonb variant
         * returning {scoped, user_ids}, and a later TABLE variant returning one
         * row per downline agent. The TABLE one is what is deployed, so
         * supabase-js hands back an ARRAY - `scope.scoped` was undefined,
         * `scope.user_ids` was undefined, and downlineIds collapsed to [].
         * An agent then queried `.in('user_id', [self])` and saw a cashier
         * containing only themselves; a super_agent saw the club's unassigned
         * members, which is not their downline in either direction.
         *
         * The dropped error made a genuine RPC failure indistinguishable from
         * "you have nobody", which is why it read as a data problem for so long.
         */
        const { data: scopeRow, error: scopeErr } = await supabase.rpc('ca_club_my_downline', {
          p_club_id: clubUuid,
        });
        if (stale()) return;
        if (scopeErr) throw scopeErr;
        if (Array.isArray(scopeRow)) {
          const ids = scopeRow
            .map((r: Record<string, unknown>) => r?.agent_id ?? r?.user_id)
            .filter((v: unknown): v is string => typeof v === 'string' && v.length > 0);
          downlineIds = ids;
        } else {
          const scope = scopeRow as { scoped?: boolean; user_ids?: string[] | null } | null;
          downlineIds = scope?.scoped === false ? null : (scope?.user_ids ?? []);
        }
      }

      const dl: Array<Record<string, unknown>> = [];
      if (role !== 'player') {
        for (let from = 0; from < MAX_MEMBERS; from += PAGE) {
          let q = supabase
            .from('club_members')
            .select('user_id, role, chip_balance, display_name, nickname, agent_id')
            .eq('club_id', clubUuid)
            .in('status', MEMBER_IN_CLUB)
            .order('joined_at', { ascending: true })
            .order('user_id', { ascending: true })
            .range(from, from + PAGE - 1);

          if (!isStaff) {
            const effectiveDownline =
              downlineIds !== null
                ? downlineIds.includes(user.id)
                  ? downlineIds
                  : [...downlineIds, user.id]
                : null;
            if (role === 'super_agent' && effectiveDownline !== null) {
              if (effectiveDownline.length > 0) {
                q = q.or(`agent_id.is.null,user_id.in.(${effectiveDownline.join(',')})`);
              } else {
                q = q.is('agent_id', null);
              }
            } else if (isAgent && effectiveDownline !== null) {
              if (effectiveDownline.length === 0) break;
              q = q.in('user_id', effectiveDownline);
            }
          }

          const { data: page, error: dlErr } = await q;
          if (dlErr) throw dlErr;
          if (stale()) return;
          dl.push(...((page || []) as Array<Record<string, unknown>>));
          if (!page || page.length < PAGE) break;
        }
      }

      const ids = (dl || []).map((r) => r.user_id as string);
      const profMap = new Map<
        string,
        {
          username?: string;
          display_name?: string;
          avatar_url?: string;
          is_horse?: boolean;
          player_number?: number;
        }
      >();
      if (ids.length > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select(
            'id, username, display_name, avatar_url:arena_avatar_url, player_number, is_horse'
          )
          .in('id', ids);
        for (const pr of profs || []) {
          profMap.set(pr.id as string, {
            username: pr.username,
            display_name: pr.display_name,
            avatar_url: pr.avatar_url,
            is_horse: pr.is_horse,
            player_number: pr.player_number,
          });
        }
      }

      const rows: DownlineRow[] = (dl || []).map((r) => {
        const p = profMap.get(r.user_id as string) || null;
        const agentId = (r.agent_id as string | null) ?? null;
        return {
          userId: r.user_id as string,
          name:
            (r.display_name as string) ||
            (r.nickname as string) ||
            p?.display_name ||
            p?.username ||
            'Player',
          username: p?.username || '',
          avatarUrl: p?.avatar_url || null,
          role: (r.role as string) || 'player',
          chipBalance: Number(r.chip_balance) || 0,
          isHorse: Boolean(p?.is_horse),
          agentId,
          isMine: agentId === user.id,
          playerNumber: p?.player_number ? String(p.player_number) : null,
        };
      });

      if (!isMounted.current || stale()) return;
      setMyRole(role);
      setMyBalance(bal);
      // "Available Chips": for owners the club bank (mintable/distributable
      // pool); for agents their own sendable balance is the constraint, so
      // show the same number the strip's first box shows for clarity.
      setAvailableChips(isStaff ? Number(panel.club_treasury) || 0 : bal);
      setDownline(rows);
      setSelected(new Set());
    } catch (e) {
      reportError(e, 'CashierTradePage.loadClub');
      // An empty list used to be the only symptom of a failed load, so the
      // owner of a 588-member club was told they had no downline.
      if (isMounted.current && !stale()) {
        setDownline([]);
        setSelected(new Set());
        setLoadError('Could not load this club. Check your connection and try again.');
      }
    } finally {
      if (isMounted.current && !stale()) setLoading(false);
    }
  }, [user?.id, clubUuid]);

  useEffect(() => {
    loadClub();
  }, [loadClub]);

  // Refresh on any balance event
  useEffect(() => {
    // AUDIT 2026-08-21: BALANCE_UPDATED alone missed mints, distributions and
    // settlement credits, so the strip could sit stale after real money moved.
    const events = [
      'BALANCE_UPDATED',
      'CHIPS_ADDED',
      'CHIPS_WITHDRAWN',
      'CHIPS_DISTRIBUTED',
      'CASHIER_BALANCE_CHANGED',
      'SETTLEMENT_COMPLETED',
    ] as const;
    // Only OUR club. CHIPS_DISTRIBUTED and CASHIER_BALANCE_CHANGED both carry a
    // clubId that was thrown away, so a chip event anywhere on the platform
    // triggered a full reload here - up to ten paged queries on a large club,
    // and each one wiped the selection out from under an open amount modal.
    const unsubs = events.map((e) =>
      masterBus.subscribe(e as never, (payload: unknown) => {
        const pid = (payload as { clubId?: string } | null)?.clubId;
        if (pid && clubUuid && pid !== clubUuid) return;
        loadClub();
      })
    );
    return () => unsubs.forEach((u) => u());
  }, [loadClub, clubUuid]);

  /**
   * Players have no Trade tab. This lived inside loadClub, which is recreated
   * only on user/club change and therefore captured whatever `tab` was THEN -
   * 'trade' for a player who had since moved to Chip Request. Every one of the
   * six bus events re-ran it, saw the stale value and snatched them back out
   * of the tab they were typing in.
   */
  useEffect(() => {
    if (myRole === 'player' && tab === 'trade') setTab('record');
  }, [myRole, tab]);

  // ── Trade record tab data ──────────────────────────────────────────────────
  // Cleared on every club change: the previous club's trades used to stay on
  // screen until the new query landed.
  useEffect(() => {
    setRecords([]);
    setRecordsError(null);
    // Chips are PER CLUB. These were left at the previous club's values for the
    // whole load, so club B's header sat above club A's totals with A's members
    // still in the list - on the screen that moves the chips.
    setMyBalance(0);
    setAvailableChips(0);
    setDownline([]);
    setSelected(new Set());
    setTransferFailures([]);
  }, [clubUuid]);

  useEffect(() => {
    if (tab !== 'record' || !user?.id || !clubUuid) return;
    let live = true;
    setRecordsLoading(true);
    setRecordsError(null);
    (async () => {
      try {
        const { data, error } = await supabase
          .from('chip_transactions')
          .select('id, created_at, transaction_type, amount, from_user_id, to_user_id, notes')
          .eq('club_id', clubUuid)
          .or(`from_user_id.eq.${user.id},to_user_id.eq.${user.id}`)
          .order('created_at', { ascending: false })
          .limit(50);
        if (!live) return;
        // A discarded error rendered as "No trades recorded yet", which is a
        // different statement from "we could not read them".
        if (error) throw error;
        const ids = new Set<string>();
        for (const r of data || []) {
          if (r.from_user_id) ids.add(r.from_user_id);
          if (r.to_user_id) ids.add(r.to_user_id);
        }
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, display_name, username')
          .in('id', Array.from(ids));
        const nameOf = new Map((profs || []).map((p) => [p.id, p.display_name || p.username]));
        if (!live) return;
        setRecords(
          (data || []).map((r) => {
            const out = r.from_user_id === user.id;
            const other = out ? r.to_user_id : r.from_user_id;
            return {
              id: r.id,
              createdAt: r.created_at,
              type: (r.transaction_type as string) || 'transfer',
              amount: Number(r.amount) || 0,
              direction: out ? ('out' as const) : ('in' as const),
              counterparty: (other && nameOf.get(other)) || 'Club',
            };
          })
        );
      } catch (e) {
        reportError(e, 'CashierTradePage.records');
        if (live) {
          setRecords([]);
          setRecordsError('Could not load your trade record.');
        }
      } finally {
        if (live) setRecordsLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [tab, user?.id, clubUuid]);

  // ── Chip requests (Chip Request tab) ───────────────────────────────────────
  const reqSeqRef = useRef(0);
  /** Open chip requests in this club. Drives the tab badge. */
  const [pendingCount, setPendingCount] = useState(0);

  /**
   * A head-only count, so no rows cross the wire. Runs on every club load and
   * on every bus event that already reloads this page, and is superseded by
   * requests.length the moment the tab is actually opened.
   */
  const loadPendingCount = useCallback(async () => {
    if (!clubUuid) {
      setPendingCount(0);
      return;
    }
    const { count, error } = await supabase
      .from('chip_requests')
      .select('id', { count: 'exact', head: true })
      .eq('club_id', clubUuid)
      .in('status', ['pending']);
    if (!isMounted.current) return;
    // A failed count must not claim zero. Leave the previous value alone.
    if (!error) setPendingCount(count ?? 0);
  }, [clubUuid]);
  const loadRequests = useCallback(async () => {
    if (!user?.id || !clubUuid) return;
    const seq = ++reqSeqRef.current;
    setRequestsLoading(true);
    setRequestsError(null);
    try {
      const { data, error } = await supabase
        .from('chip_requests')
        .select('id, requester_id, amount, note, status, created_at')
        .eq('club_id', clubUuid)
        .in('status', ['pending'])
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      const ids = [...new Set((data || []).map((r) => r.requester_id as string))];
      const names = new Map<string, string>();
      if (ids.length > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, display_name, username')
          .in('id', ids);
        for (const pr of profs || [])
          names.set(
            pr.id as string,
            (pr.display_name as string) || (pr.username as string) || 'Player'
          );
      }
      if (!isMounted.current || seq !== reqSeqRef.current) return;
      setPendingCount((data || []).length);
      setRequests(
        (data || []).map((r) => ({
          id: r.id as string,
          requesterId: r.requester_id as string,
          requesterName: names.get(r.requester_id as string) || 'Player',
          amount: Number(r.amount) || 0,
          note: (r.note as string) || null,
          status: (r.status as string) || 'pending',
          createdAt: r.created_at as string,
          mine: r.requester_id === user.id,
        }))
      );
    } catch (e) {
      reportError(e, 'CashierTradePage.loadRequests');
      // Silent before: a pending request the user has to answer was invisible
      // behind "No Open Chip Requests."
      if (isMounted.current && seq === reqSeqRef.current)
        setRequestsError('Could Not Load Chip Requests.');
    } finally {
      if (isMounted.current && seq === reqSeqRef.current) setRequestsLoading(false);
    }
  }, [user?.id, clubUuid]);

  useEffect(() => {
    if (tab === 'request') loadRequests();
  }, [tab, loadRequests]);

  useEffect(() => {
    void loadPendingCount();
  }, [loadPendingCount]);

  const respondToRequest = async (id: string, action: 'approve' | 'decline' | 'cancel') => {
    // Approving a chip request performs the same conserved ledger move as a
    // Send Out. The row's three buttons were never disabled and there was no
    // busy state, so a double-tap fired two RPCs and the second's refusal
    // surfaced as a sanitised toast - or was dropped entirely.
    if (respondingRef.current) return;
    respondingRef.current = true;
    setRespondingId(id);
    try {
      const { data, error } = await supabase.rpc('fn_respond_chip_request', {
        p_request_id: id,
        p_action: action,
      });
      if (error) throw error;
      const res = data as { success?: boolean; error?: string } | null;
      if (!res?.success) throw new Error(res?.error || 'Refused');
      toast?.success?.(
        action === 'approve'
          ? 'Request Approved'
          : action === 'decline'
            ? 'Request Declined'
            : 'Request Cancelled'
      );
      masterBus.emit('BALANCE_UPDATED', { source: 'chip_request', userId: user?.id || '' });
      loadRequests();
      loadClub();
    } catch (e) {
      reportError(e, 'CashierTradePage.respondToRequest');
      toast?.error?.((e as Error).message || 'Could Not Answer That Request');
    } finally {
      respondingRef.current = false;
      if (isMounted.current) setRespondingId(null);
    }
  };

  const askForChips = async () => {
    const raw = Number(askAmount);
    if (!Number.isFinite(raw) || raw <= 0) {
      toast?.error?.('Enter A Positive Amount');
      return;
    }
    const v = Math.round(raw * 100) / 100;
    if (v !== raw) {
      toast?.error?.('Chips Go To Two Decimal Places');
      return;
    }
    if (askingRef.current) return;
    askingRef.current = true;
    setAsking(true);
    try {
      const { data, error } = await supabase.rpc('fn_request_chips', {
        p_club_id: clubUuid,
        p_amount: v,
        p_note: askNote || null,
      });
      if (error) throw error;
      const res = data as { success?: boolean; error?: string } | null;
      if (!res?.success) throw new Error(res?.error || 'Refused');
      toast?.success?.('Chip Request Sent');
      setAskOpen(false);
      setAskAmount('');
      setAskNote('');
      loadRequests();
    } catch (e) {
      reportError(e, 'CashierTradePage.askForChips');
      toast?.error?.((e as Error).message || 'Could Not Send That Request');
    } finally {
      askingRef.current = false;
      if (isMounted.current) setAsking(false);
    }
  };

  // ── Settlement invoices (Leaderboard Record tab) ───────────────────────────
  useEffect(() => {
    if (tab !== 'leaderboard' || !clubUuid) return;
    let live = true;
    setInvoicesLoading(true);
    setInvoicesError(null);
    (async () => {
      const { data, error } = await supabase
        .from('settlement_invoices')
        .select('id, created_at, invoice_type, gross_amount, net_amount, status')
        .eq('club_id', clubUuid)
        .order('created_at', { ascending: false })
        .limit(50);
      if (!live) return;
      if (error) {
        reportError(error, 'CashierTradePage.loadInvoices');
        // "No Settlement Records Yet" is a different statement from "we could
        // not read them", and this page already makes that distinction on the
        // trades tab. Make it here too.
        setInvoicesError('Could Not Load Settlement Records.');
        setInvoices([]);
      } else {
        setInvoicesError(null);
        setInvoices(
          (data || []).map((r) => ({
            id: r.id as string,
            createdAt: r.created_at as string,
            type: (r.invoice_type as string) || 'settlement',
            gross: Number(r.gross_amount) || 0,
            net: Number(r.net_amount) || 0,
            status: (r.status as string) || 'pending',
          }))
        );
      }
      setInvoicesLoading(false);
    })();
    return () => {
      live = false;
    };
  }, [tab, clubUuid]);

  // ── Derived list ───────────────────────────────────────────────────────────
  const mineCount = useMemo(() => downline.filter((r) => r.isMine).length, [downline]);
  /** What the reader's own assigned players are holding, for the strip. */
  const mineTotal = useMemo(
    () => downline.reduce((sum, r) => (r.isMine ? sum + (Number(r.chipBalance) || 0) : sum), 0),
    [downline]
  );

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = downline.filter(
      (r) => !q || r.name.toLowerCase().includes(q) || r.username.toLowerCase().includes(q)
    );
    // "the players assigned to me" - the question an agent actually asks, and
    // one an owner could not ask at all before, because an owner sees the whole
    // club and nothing on the row said which of them were theirs.
    if (mineOnly) rows = rows.filter((r) => r.isMine);
    rows =
      sortKey === 'balance'
        ? [...rows].sort((a, b) => b.chipBalance - a.chipBalance)
        : [...rows].sort((a, b) => a.name.localeCompare(b.name));
    if (groupByRole) {
      const rank: Record<string, number> = {
        super_agent: 0,
        agent: 1,
        sub_agent: 2,
        admin: 3,
        player: 4,
      };
      rows = [...rows].sort((a, b) => (rank[a.role] ?? 9) - (rank[b.role] ?? 9));
    }
    return rows;
  }, [downline, search, sortKey, groupByRole, mineOnly]);

  const agencyBalance = useMemo(() => downline.reduce((s, r) => s + r.chipBalance, 0), [downline]);

  // A selection had no relationship to what was on screen. Select three
  // players, type a search, select a fourth, press Send Out - and chips went
  // to all four, three of whom the sender could not see. Selection is now
  // pruned to the visible list whenever that list changes, so what you send to
  // is always what you can see.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(list.map((r) => r.userId));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visible.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [list]);

  /**
   * The selected rows, memoised. This was `list.filter(...)` inlined at four
   * render sites, so every keystroke in the amount input re-ran it four times
   * over a list that can be ten thousand rows - forty thousand predicate calls
   * per character, on a phone, inside a modal.
   */
  const picked = useMemo(() => list.filter((r) => selected.has(r.userId)), [list, selected]);

  /**
   * What Claim Back would ACTUALLY collect. runTransfers clamps per player
   * (`Math.min(value, t.chipBalance)`), so typing 500 against someone holding
   * 40 collects 40 - and the receipt said "Claimed 500.00 Back". The page holds
   * every balance it needs to show the truth BEFORE the tap.
   */
  /** Chips the selected players are holding right now. */
  const pickedHeld = useMemo(
    () => picked.reduce((sum, r) => sum + (Number(r.chipBalance) || 0), 0),
    [picked]
  );

  const claimableTotal = useMemo(
    () => picked.reduce((sum, r) => sum + Math.min(Number(amount) || 0, r.chipBalance), 0),
    [picked, amount]
  );

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ── Money actions ──────────────────────────────────────────────────────────
  const runTransfers = async (kind: 'send' | 'claim' | 'ticket') => {
    if (!user?.id || !clubUuid) return;
    const raw = Number(amount);
    if (!Number.isFinite(raw) || raw <= 0) {
      toast?.error?.('Enter A Positive Amount');
      return;
    }
    // QUANTIZE. NaN, negative and zero were covered; 10.005 was not. It passed
    // straight through to club_members.chip_balance while fmt() rendered it as
    // "10.01" in the modal total AND in the receipt, and `value * targets`
    // compounded the drift across a batch. Chips go to two decimals: refuse
    // anything finer rather than silently rounding the user's money.
    const value = Math.round(raw * 100) / 100;
    if (value !== raw) {
      toast?.error?.('Chips Go To Two Decimal Places');
      return;
    }
    if (value > 1e9) {
      toast?.error?.('That Amount Is Too Large');
      return;
    }
    // `list`, not `downline`: the visible, filtered set. The pruning effect
    // above already keeps these in step; reading the same source the user was
    // looking at means a race can never widen the blast radius of a transfer.
    const targets = picked;
    if (targets.length === 0) {
      // loadClub() clears `selected` unconditionally and six bus events fire
      // it, so a balance event landing while this modal was open emptied the
      // selection without closing it. Confirm then did NOTHING - no toast, no
      // close, no error - on a modal still titled "Send Out".
      toast?.error?.('Selection Changed. Pick The Players Again');
      setAmountModal(null);
      return;
    }
    // GUARD AGAINST THE POT THIS ACTUALLY SPENDS. fn_cashier_send_chips debits
    // club_members.chip_balance of auth.uid() for EVERY role - it never touches
    // clubs.chip_treasury. `availableChips` is the club bank for staff, so an
    // owner with a large treasury and a small personal balance sailed past this
    // check and collected N server refusals instead.
    if ((kind === 'send' || kind === 'ticket') && value * targets.length > myBalance) {
      toast?.error?.(
        `Insufficient Chips: Sending ${fmt(value * targets.length)} Needs More Than ${fmt(myBalance)}`
      );
      return;
    }
    if (busyRef.current) return; // a fast double-tap must not send twice
    busyRef.current = true;
    setBusy(true);
    /**
     * IDEMPOTENCY (2026-08-24). busyRef stops a double-TAP, but it cannot stop
     * a double-CHARGE. The dangerous shape is a claim that COMMITTED on the
     * server and then failed on the way back - a dropped connection, a proxy
     * timeout. To this code that is indistinguishable from a claim that never
     * ran: it reports an error, and the natural next step, retrying, takes the
     * chips a second time.
     *
     * So the retry has to be recognisable as the SAME intent. This id is minted
     * once per submission and deliberately SURVIVES a failure - it is cleared
     * only when the batch fully succeeds. Retry the failed batch and the server
     * matches the key, replays the original outcome and moves nothing; change
     * the amount or the selection and a fresh id is minted, because that is a
     * genuinely new claim and must be allowed through.
     */
    if (!submissionIdRef.current) {
      submissionIdRef.current =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    const submissionId = submissionIdRef.current;
    let ok = 0;
    let skipped = 0;
    const failed: Array<{ name: string; message: string }> = [];
    try {
      for (const t of targets) {
        try {
          if (kind === 'send') {
            // fn_cashier_send_chips (migration 20260821): sender is always
            // auth.uid() server-side; owner/admin -> anyone, agents -> their
            // own downline only. Moves club_members.chip_balance — the ledger
            // that buys into games.
            const { data, error } = await supabase.rpc('fn_cashier_send_chips', {
              p_club_id: clubUuid,
              p_to_user_id: t.userId,
              p_amount: value,
              p_reason: `Cashier send out to ${t.name}`,
            });
            if (error) throw error;
            const res = data as { success?: boolean; error?: string } | null;
            if (res && res.success === false) throw new Error(res.error || 'refused');
          } else if (kind === 'ticket') {
            // Tournament ticket: the value is ESCROWED off the issuer now and
            // held on the ticket until the player redeems it.
            const { data, error } = await supabase.rpc('fn_issue_tournament_ticket', {
              p_club_id: clubUuid,
              p_holder_id: t.userId,
              p_value: value,
              p_note: `Cashier ticket for ${t.name}`,
            });
            if (error) throw error;
            const res = data as { success?: boolean; error?: string } | null;
            if (res && res.success === false) throw new Error(res.error || 'refused');
          } else {
            const claim = Math.min(value, t.chipBalance);
            // Nothing to take back. Counted, so the summary can say so instead
            // of closing the modal in silence and leaving the user guessing.
            if (claim <= 0) {
              skipped++;
              continue;
            }
            // fn_cashier_claim_back (migration 20260821): conserved player ->
            // caller move on the club ledger. NOT fn_admin_remove_player_chips,
            // which refuses agents and strands the chips in clubs.chip_pool.
            const { data, error } = await supabase.rpc('fn_cashier_claim_back', {
              p_club_id: clubUuid,
              p_from_user_id: t.userId,
              p_amount: claim,
              p_reason: 'Cashier claim back',
              // Per target AND per amount: retrying this batch replays, while
              // claiming a different amount from the same player is a new
              // intent and must go through. See submissionIdRef above.
              p_idempotency_key: `claim:${submissionId}:${t.userId}:${claim}`,
            });
            if (error) throw error;
            const res = data as { success?: boolean; error?: string } | null;
            if (res && res.success === false) throw new Error(res.error || 'refused');
          }
          ok++;
        } catch (e) {
          reportError(e, 'CashierTradePage.' + kind);
          // Collected, not just toasted. showToast drops the network/timeout/
          // rateLimit/server categories entirely, and rewrites a funds refusal
          // to a generic sentence that loses the player's NAME - so on a
          // dropped connection every per-target toast vanished and the summary
          // below had no branch for "nothing succeeded and nothing skipped".
          // The user was left not knowing whether ten transfers had happened.
          failed.push({ name: t.name, message: (e as Error)?.message || 'Transfer Failed' });
        }
      }
    } finally {
      // A throw between here and the end used to leave `busy` true forever,
      // and both Confirm and Cancel are disabled on it - the modal became a
      // trap that only a page reload could escape.
      busyRef.current = false;
      // Retire the submission id ONLY when every target went through. If any
      // one of them failed, keeping it is the whole point: the retry carries
      // the same key, so whichever targets already committed replay instead of
      // being charged a second time.
      if (skipped + ok === targets.length) submissionIdRef.current = null;
      if (isMounted.current) {
        setBusy(false);
        setTransferFailures(failed);
        // Only close on a clean batch. Closing on failure wiped the amount and
        // the selection, which is the worst possible moment to lose them.
        if (failed.length === 0) {
          setAmountModal(null);
          setAmount('');
        }
      }
    }

    if (ok > 0) {
      // Name the counterparty on a single-target move. The Toast layer bars an
      // identical type+text for 60s, so "Sent 100.00 To 1 Player" twice in a
      // minute confirmed only the FIRST real chip movement - a receipt must
      // never be the thing that dedupes.
      const who = targets.length === 1 ? targets[0].name : `${ok} Player${ok === 1 ? '' : 's'}`;
      toast?.success?.(
        kind === 'send'
          ? `Sent ${fmt(value)} To ${who}`
          : kind === 'ticket'
            ? `Issued ${ok} Ticket${ok === 1 ? '' : 's'} Worth ${fmt(value)} Each To ${who}`
            : `Claimed ${fmt(value)} Back From ${who}`
      );
      // The bus event is already wired to reload this page, so calling
      // loadClub() as well fired two identical loads at once.
      masterBus.emit('BALANCE_UPDATED', { source: 'cashier_trade', userId: user.id });
    } else if (skipped > 0 && failed.length === 0) {
      toast?.info?.(
        `Nothing To Claim Back: ${skipped} Player${skipped === 1 ? ' Has' : 's Have'} No Chips`
      );
    }
    if (failed.length > 0) {
      // The one branch that did not exist. A batch where every target failed
      // produced no summary at all.
      toast?.error?.(
        ok > 0
          ? `${failed.length} Of ${targets.length} Did Not Go Through`
          : `Nothing Was Sent. ${failed.length} Failed`
      );
    }
  };

  /**
   * MODAL KEYBOARD AND SCROLL (Dan 2026-08-25).
   *
   * Both modals were plain divs: no role, no aria-modal, and no Escape, so a
   * keyboard user who opened Send Out could tab straight past it into the list
   * behind and had no way to dismiss it except to find Cancel. Body scroll was
   * not locked either, so on iOS the page scrolled underneath the overlay.
   *
   * The busy guards mirror the overlay-click guards exactly - Escape must never
   * be an escape hatch out of an in-flight batch.
   */
  useEffect(() => {
    if (!amountModal && !askOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (amountModal && !busy) {
        setAmountModal(null);
        setTransferFailures([]);
      }
      if (askOpen && !asking) setAskOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [amountModal, askOpen, busy, asking]);

  const initial = (name: string) => (name || '?').charAt(0).toUpperCase();

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <span className={styles.title}>CASHIER</span>
        <button
          className={styles.entityBtn}
          onClick={() => setPickerOpen((o) => !o)}
          aria-expanded={pickerOpen}
        >
          {currentClub?.logoUrl ? (
            <img src={currentClub.logoUrl} alt="" className={styles.entityLogo} />
          ) : (
            <span className={styles.entityInitial}>{initial(currentClub?.name || 'C')}</span>
          )}
          <span className={styles.entityName}>{currentClub?.name || '...'}</span>
          <span className={styles.entityCaret}>&#9662;</span>
        </button>
      </div>

      {/* Entity picker */}
      {pickerOpen && (
        <div className={styles.picker}>
          <div className={styles.pickerLabel}>OPEN CASHIER FOR</div>
          {memberships.map((m) => (
            <button
              key={m.clubUuid}
              className={`${styles.pickerRow} ${m.clubUuid === clubUuid ? styles.pickerRowActive : ''}`}
              onClick={() => {
                setPickerOpen(false);
                if (m.clubUuid !== clubUuid) {
                  navigate(`/clubs/${m.clubCode ?? m.clubUuid}/cashier`);
                }
              }}
            >
              {m.logoUrl ? (
                <img src={m.logoUrl} alt="" className={styles.entityLogo} />
              ) : (
                <span className={styles.entityInitial}>{initial(m.name)}</span>
              )}
              <span className={styles.pickerName}>{m.name}</span>
              <span className={styles.pickerBalance}>{fmt(m.chipBalance)} Chips</span>
            </button>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className={styles.tabs}>
        {(
          [
            ['trade', 'Trade'],
            ['record', 'Trade Record'],
            ['leaderboard', 'Leaderboard Record'],
            ['request', 'Chip Request'],
          ] as [TabKey, string][]
        )
          .filter(([key]) => {
            if (myRole === 'player') {
              // Players only see their transaction history and chip requests
              return key === 'record' || key === 'request';
            }
            return true;
          })
          .map(([key, label]) => (
            <button
              key={key}
              className={`${styles.tab} ${tab === key ? styles.tabActive : ''}`}
              aria-pressed={tab === key}
              onClick={() => setTab(key)}
            >
              {label}
              {/* A player who has asked their agent for chips is a player who is
                  not at a table. loadRequests only runs when this tab is opened,
                  so an owner sitting on Trade had no indication that anyone was
                  waiting. One head-only count turns a tab nobody opens into a
                  queue that pulls itself. Dan 2026-08-25. */}
              {key === 'request' && pendingCount > 0 ? (
                <span className={styles.tabBadge}>{pendingCount.toLocaleString()}</span>
              ) : null}
            </button>
          ))}
      </div>

      {tab === 'trade' && (
        <>
          {/* Balance strip */}
          <div className={styles.strip}>
            <div className={styles.stripCell}>
              <span className={styles.stripLabel}>Your Chip Balance</span>
              <span className={styles.stripValue}>{fmt(myBalance)}</span>
            </div>
            <div className={styles.stripCell}>
              <span className={styles.stripLabel}>Agency Players Balance</span>
              <span className={styles.stripValue}>{fmt(agencyBalance)}</span>
            </div>
            {/* For a non-staff role `availableChips` IS `myBalance` (see loadClub),
                so an agent read the same figure twice under two labels, with no
                "+" on the second, which looks like a rendering fault. Give them
                the number they cannot get anywhere else instead: what their own
                players are holding. Dan 2026-08-25. */}
            <div className={styles.stripCell}>
              <span className={styles.stripLabel}>
                {isClubStaff(myRole) ? 'Available Chips' : 'Assigned To Me'}
              </span>
              <span className={styles.stripValue}>
                {isClubStaff(myRole)
                  ? fmt(availableChips)
                  : `${mineCount.toLocaleString()} - ${fmt(mineTotal)}`}
                {/* Dan 2026-08-23: this used to open the Chip Mint directly.
                    Minting is a CLUB BANK action now - it exists only for a
                    standalone club and only inside the cashier that holds the
                    account it credits. So the "+" opens the Club Bank Cashier,
                    and only for the four roles that may stand at it. An agent
                    or a sub agent sees no "+" at all. */}
                {canSeeClubBank(myRole) && (
                  <button
                    className={styles.plusBtn}
                    aria-label="Open the Club Bank Cashier"
                    title="Club Bank Cashier - fund agent wallets, ledger, chip mint"
                    onClick={() => setActiveCashier('club_bank')}
                  >
                    +
                  </button>
                )}
              </span>
            </div>
          </div>

          {/* Search + filters */}
          <div className={styles.searchRow}>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search members"
              aria-label={`Search ${downline.length} member${downline.length === 1 ? '' : 's'}`}
            />
            <span className={styles.memberCount} aria-hidden="true">
              {downline.length}
            </span>
          </div>
          <div className={styles.filterRow}>
            <label className={styles.groupToggle}>
              <input
                type="checkbox"
                checked={mineOnly}
                onChange={(e) => setMineOnly(e.target.checked)}
                disabled={mineCount === 0}
              />
              Assigned To Me ({mineCount})
            </label>
            <label className={styles.groupToggle}>
              <input
                type="checkbox"
                checked={groupByRole}
                onChange={(e) => setGroupByRole(e.target.checked)}
              />
              Group By Role
            </label>
            <button
              className={styles.sortBtn}
              onClick={() => setSortKey((k) => (k === 'balance' ? 'name' : 'balance'))}
            >
              Sort By {sortKey === 'balance' ? 'Chip Balance' : 'Name'} &#9662;
            </button>
          </div>

          {/* Downline list */}
          <div className={styles.list}>
            {/* isHydrating too: before it was read, a hard refresh briefly ran
                the whole not-found / empty-club branch below while auth was
                still settling and `user` was null. */}
            {(loading || isHydrating) && <div className={styles.empty}>Loading Members...</div>}
            {!loading && !isHydrating && loadError && (
              <div className={styles.empty} role="alert">
                {loadError}{' '}
                <button type="button" className={styles.retryBtn} onClick={() => void loadClub()}>
                  Retry
                </button>
              </div>
            )}
            {/* A club id that resolves to nothing is NOT an empty club. This
                flag was set in two places and read in none, so a bad slug or a
                deleted club rendered "No members in your downline yet." - the
                exact confusion the flag was added to end. */}
            {!loading && !isHydrating && clubResolveFailed && (
              <div className={styles.empty} role="alert">
                We Could Not Find That Club.{' '}
                <button
                  type="button"
                  className={styles.retryBtn}
                  onClick={() => navigate('/clubs')}
                >
                  Back To Clubs
                </button>
              </div>
            )}
            {!loading && !isHydrating && !loadError && !clubResolveFailed && list.length === 0 && (
              <div className={styles.empty}>
                {mineOnly
                  ? 'No players are assigned to you in this club.'
                  : search.trim()
                    ? 'No members match that search.'
                    : 'No members in your downline yet.'}
              </div>
            )}
            {/*
              Gated on !loading. These rows used to stay on screen, clickable,
              with the footer buttons live, while a different club was loading -
              so a player could be selected from the club you just left and the
              transfer submitted against the club you had switched to.
            */}
            {!loading &&
              !loadError &&
              list.map((r) => (
                <div
                  key={r.userId}
                  className={`${styles.row} ${selected.has(r.userId) ? styles.rowSelected : ''}`}
                  onClick={() => toggleSelect(r.userId)}
                  onKeyDown={(e) => {
                    // role="checkbox" + tabIndex advertises a control. Without
                    // this, every row was reachable by keyboard and none of them
                    // could be selected.
                    if (e.key === ' ' || e.key === 'Enter') {
                      e.preventDefault();
                      toggleSelect(r.userId);
                    }
                  }}
                  role="checkbox"
                  aria-checked={selected.has(r.userId)}
                  tabIndex={0}
                >
                  {r.avatarUrl ? (
                    <img src={r.avatarUrl} alt="" className={styles.avatar} />
                  ) : (
                    <span className={styles.avatarFallback}>{initial(r.name)}</span>
                  )}
                  <div className={styles.rowInfo}>
                    <span className={styles.rowName}>{r.name}</span>
                    <span className={styles.rowSub}>
                      {r.playerNumber ? `ID: ${r.playerNumber} · ` : ''}
                      <span style={{ textTransform: 'capitalize' }}>
                        {r.role.replace('_', ' ')}
                        {r.isHorse ? ' (horse)' : ''}
                      </span>
                      {r.username ? ` · @${r.username}` : ''}
                    </span>
                  </div>
                  <span className={styles.rowBalance}>{fmt(r.chipBalance)}</span>
                  <span
                    className={`${styles.checkbox} ${selected.has(r.userId) ? styles.checkboxOn : ''}`}
                    aria-hidden="true"
                  />
                </div>
              ))}
            <button
              className={styles.classicLink}
              onClick={() => navigate(`/clubs/${clubParam}/cashier-classic`)}
            >
              Advanced Cashier (Buy-In, Cash-Out, Mint, Full History)
            </button>
          </div>

          {/* THE SELECTION, VISIBLE AND REVERSIBLE (Dan 2026-08-25).
              Three things a user could not do. There was no undo for a
              selection - to deselect twelve players you tapped twelve rows,
              scrolling to find each. The count existed only inside the amount
              modal, so while scrolling a 588-row list you could not tell what
              you had picked up. And the total held by the selection is what
              decides whether a Claim Back is worth making. All three live in
              the thumb zone, which at 375px is where the hand already is. */}
          {selected.size > 0 && (
            <div className={styles.selBar} role="status">
              <span>
                {selected.size.toLocaleString()} Selected &middot; {fmt(pickedHeld)} Held
              </span>
              <button
                type="button"
                className={styles.selClear}
                onClick={() => setSelected(new Set())}
              >
                Clear
              </button>
            </div>
          )}

          {/* Footer actions — pinned */}
          <div className={styles.footer}>
            <button
              className={styles.footerBtn}
              disabled={selected.size === 0 || busy}
              onClick={() => setAmountModal('claim')}
            >
              Claim Back
            </button>
            <button
              className={styles.footerBtn}
              disabled={selected.size === 0 || busy}
              onClick={() => setAmountModal('ticket')}
            >
              Send Ticket
            </button>
            <button
              className={styles.footerBtn}
              disabled={selected.size === 0 || busy}
              onClick={() => setAmountModal('send')}
            >
              Send Out
            </button>
          </div>
        </>
      )}

      {tab === 'record' && (
        <div className={styles.list}>
          {recordsLoading && <div className={styles.empty}>Loading Trades...</div>}
          {!recordsLoading && recordsError && (
            <div className={styles.empty} role="alert">
              {recordsError}
            </div>
          )}
          {!recordsLoading && !recordsError && records.length === 0 && (
            <div className={styles.empty}>No Trades Recorded Yet.</div>
          )}
          {records.map((r) => (
            <div key={r.id} className={styles.row}>
              <div className={styles.rowInfo}>
                <span className={styles.rowName}>
                  {r.direction === 'out' ? 'To ' : 'From '}
                  {r.counterparty}
                </span>
                <span className={styles.rowSub}>
                  {txLabel(r.type)} &middot;{' '}
                  {new Date(r.createdAt).toLocaleString([], {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              <span
                className={`${styles.rowBalance} ${r.direction === 'in' ? styles.amtIn : styles.amtOut}`}
              >
                {r.direction === 'in' ? '+' : '-'}
                {fmt(r.amount)}
              </span>
            </div>
          ))}
        </div>
      )}

      {tab === 'leaderboard' && (
        <div className={styles.list}>
          {invoicesLoading && <div className={styles.empty}>Loading Settlement Records...</div>}
          {!invoicesLoading && invoicesError && (
            <div className={styles.empty} role="alert">
              {invoicesError}{' '}
              <button
                type="button"
                className={styles.retryBtn}
                onClick={() => setTab('leaderboard')}
              >
                Retry
              </button>
            </div>
          )}
          {!invoicesLoading && !invoicesError && invoices.length === 0 && (
            <div className={styles.empty}>
              No Settlement Records Yet. They Appear Here After The First Weekly Close.
            </div>
          )}
          {invoices.map((iv) => (
            <div key={iv.id} className={styles.row}>
              <div className={styles.rowInfo}>
                <span className={styles.rowName}>{txLabel(iv.type)}</span>
                <span className={styles.rowSub}>
                  {new Date(iv.createdAt).toLocaleDateString([], {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}{' '}
                  &middot; {txLabel(iv.status)}
                </span>
              </div>
              <span className={styles.rowSub}>Gross {fmt(iv.gross)}</span>
              <span
                className={`${styles.rowBalance} ${iv.net >= 0 ? styles.amtIn : styles.amtOut}`}
              >
                {iv.net >= 0 ? '+' : ''}
                {fmt(iv.net)}
              </span>
            </div>
          ))}
        </div>
      )}

      {tab === 'request' && (
        <div className={styles.list}>
          <button className={styles.classicLink} onClick={() => setAskOpen(true)}>
            Request Chips From Your Agent
          </button>
          {requestsLoading && <div className={styles.empty}>Loading Requests...</div>}
          {!requestsLoading && requestsError && (
            <div className={styles.empty} role="alert">
              {requestsError}{' '}
              <button type="button" className={styles.retryBtn} onClick={() => void loadRequests()}>
                Retry
              </button>
            </div>
          )}
          {!requestsLoading && !requestsError && requests.length === 0 && (
            <div className={styles.empty}>No Open Chip Requests.</div>
          )}
          {requests.map((r) => (
            <div key={r.id} className={styles.row}>
              <div className={styles.rowInfo}>
                <span className={styles.rowName}>{r.mine ? 'You' : r.requesterName}</span>
                <span className={styles.rowSub}>
                  {new Date(r.createdAt).toLocaleString([], {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {r.note ? ` · ${r.note}` : ''}
                </span>
              </div>
              <span className={styles.rowBalance}>{fmt(r.amount)}</span>
              {r.mine ? (
                <button
                  className={styles.reqBtn}
                  disabled={respondingId !== null}
                  onClick={() => respondToRequest(r.id, 'cancel')}
                >
                  {respondingId === r.id ? 'Working...' : 'Cancel'}
                </button>
              ) : (
                <>
                  <button
                    className={styles.reqBtn}
                    disabled={respondingId !== null}
                    onClick={() => respondToRequest(r.id, 'decline')}
                  >
                    {respondingId === r.id ? 'Working...' : 'Decline'}
                  </button>
                  <button
                    className={`${styles.reqBtn} ${styles.reqBtnGo}`}
                    disabled={respondingId !== null}
                    onClick={() => respondToRequest(r.id, 'approve')}
                  >
                    {respondingId === r.id ? 'Working...' : 'Approve'}
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Ask-for-chips modal */}
      {askOpen && (
        <div className={styles.modalOverlay} onClick={() => setAskOpen(false)}>
          <div
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cashier-ask-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalTitle} id="cashier-ask-title">
              Request Chips
            </div>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              value={askAmount}
              step="0.01"
              aria-label="Chips Requested"
              onChange={(e) => setAskAmount(e.target.value)}
              placeholder="How many chips?"
              autoFocus
            />
            <input
              type="text"
              value={askNote}
              aria-label="Note"
              onChange={(e) => setAskNote(e.target.value)}
              placeholder="Note (optional)"
              maxLength={120}
            />
            <div className={styles.modalHint}>
              Goes To Your Agent, Or The Club Owner If You Have None.
            </div>
            <div className={styles.modalActions}>
              <button disabled={asking} onClick={() => setAskOpen(false)}>
                Cancel
              </button>
              <button className={styles.modalConfirm} disabled={asking} onClick={askForChips}>
                {asking ? 'Sending...' : 'Send Request'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Club Bank Cashier — fund agent wallets, the full chip ledger, and
          (standalone clubs only) the Chip Mint. */}
      <WalletCashierModal
        isOpen={!!activeCashier}
        onClose={() => {
          setActiveCashier(null);
          loadClub();
        }}
        clubId={clubUuid || clubParam || ''}
        role={myRole}
        walletType={activeCashier || 'club_bank'}
      />

      {/* Amount modal */}
      {amountModal && (
        <div
          className={styles.modalOverlay}
          onClick={() => {
            if (busy) return;
            setAmountModal(null);
            setTransferFailures([]);
          }}
        >
          <div
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cashier-amount-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalTitle} id="cashier-amount-title">
              {amountModal === 'send'
                ? 'Send Out'
                : amountModal === 'ticket'
                  ? 'Send Ticket'
                  : 'Claim Back'}{' '}
              &middot; {picked.length.toLocaleString()} Player{picked.length === 1 ? '' : 's'}
            </div>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              aria-label="Amount Per Player"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                if (transferFailures.length) setTransferFailures([]);
              }}
              placeholder={
                amountModal === 'claim'
                  ? 'Amount per player (max = balance)'
                  : amountModal === 'ticket'
                    ? 'Ticket value per player'
                    : 'Amount per player'
              }
              autoFocus
            />
            {/* WHO, AND HOW MUCH EACH (Dan 2026-08-25).
                The modal said "Claim Back - 3 Players" and never named them; on
                a 375px screen the selection has scrolled out of view and the
                user is one tap from moving real money to a set they cannot see.
                And Claim Back CLAMPS per player, so typing 500 against someone
                holding 40 collects 40 - which the old receipt then reported as
                "Claimed 500.00 Back". Every number here is already on the
                client; this is a preview of the actual outcome. */}
            {picked.length > 0 && (
              <div className={styles.modalTargets}>
                {picked.map((r) => (
                  <div className={styles.modalTargetRow} key={r.userId}>
                    <span>{r.name}</span>
                    <span>
                      {amountModal === 'claim'
                        ? fmt(Math.min(Number(amount) || 0, r.chipBalance))
                        : fmt(Number(amount) || 0)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {amountModal === 'claim' && picked.length > 0 && (
              <div className={styles.modalHint}>
                Total To Collect: {fmt(claimableTotal)}
                {claimableTotal < (Number(amount) || 0) * picked.length
                  ? ' - Capped By What Each Player Actually Holds'
                  : ''}
              </div>
            )}
            {amountModal === 'ticket' && (
              <div className={styles.modalHint}>
                Tickets Are Paid Now And Held Until The Player Redeems Them. Cancel An Unredeemed
                Ticket To Get The Chips Back.
              </div>
            )}
            {(amountModal === 'send' || amountModal === 'ticket') && (
              <div className={styles.modalHint}>
                Total: {fmt((Number(amount) || 0) * picked.length)}{' '}
                {/* YOUR balance, not the club bank. Send Out debits
                    club_members.chip_balance of the caller for every role, so
                    quoting the treasury here told an owner they could spend
                    money this action cannot reach. */}
                &middot; Your Chips: {fmt(myBalance)}
              </div>
            )}
            {transferFailures.length > 0 && (
              <div className={styles.modalFailures} role="alert">
                <div className={styles.modalFailuresTitle}>
                  {transferFailures.length} Did Not Go Through
                </div>
                {transferFailures.map((f) => (
                  <div className={styles.modalFailureRow} key={f.name}>
                    <span>{f.name}</span>
                    <span>{f.message}</span>
                  </div>
                ))}
              </div>
            )}
            <div className={styles.modalActions}>
              <button
                disabled={busy}
                onClick={() => {
                  setAmountModal(null);
                  setTransferFailures([]);
                }}
              >
                Cancel
              </button>
              <button
                className={styles.modalConfirm}
                disabled={busy || picked.length === 0}
                onClick={() => runTransfers(amountModal)}
              >
                {busy ? 'Working...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {clubUuid && <ClubBottomNav clubId={clubUuid} />}
    </div>
  );
}
