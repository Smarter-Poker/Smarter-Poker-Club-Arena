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
import ChipMintModal from '../components/wallet/ChipMintModal';
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
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [askAmount, setAskAmount] = useState('');
  const [askNote, setAskNote] = useState('');
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [amountModal, setAmountModal] = useState<'send' | 'claim' | 'ticket' | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  // AUDIT 2026-08-21: the "+" on Available Chips used to punt to the classic
  // cashier. Chips originate at the mint, so it opens the Chip Mint here.
  const [showMint, setShowMint] = useState(false);
  // Guards a double-submit that beats the re-render `busy` depends on.
  const busyRef = useRef(false);
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
      const role = (meRes.data?.role as string) || 'player';
      const bal = Number(meRes.data?.chip_balance) || 0;
      const panel = ((Array.isArray(panelRes.data) ? panelRes.data[0] : panelRes.data) ??
        {}) as Record<string, unknown>;

      const isStaff = isClubStaff(role);
      const isAgent = role === 'agent' || role === 'super_agent' || role === 'sub_agent';

      // NOTE: no PostgREST embed here - club_members.user_id has no FK to
      // profiles (it references public.users), so `profiles:user_id(...)`
      // 400s and the whole load died (verified live: 0 members, 0.00
      // balances on first deploy). Two-step fetch instead.
      // An agent may only ever SEE their own players, so that stays a server
      // filter. Staff see the whole club and narrow it with the "Assigned to
      // me" toggle below - a filter they can turn off, not a wall.
      let downlineIds: string[] | null = null;
      if (isAgent && !isStaff) {
        const { data: scopeRow } = await supabase.rpc('ca_club_my_downline', {
          p_club_id: clubUuid,
        });
        if (stale()) return;
        const scope = scopeRow as { scoped?: boolean; user_ids?: string[] | null } | null;
        downlineIds = scope?.scoped === false ? null : (scope?.user_ids ?? []);
      }

      const dl: Array<Record<string, unknown>> = [];
      for (let from = 0; from < MAX_MEMBERS; from += PAGE) {
        let q = supabase
          .from('club_members')
          .select('user_id, role, chip_balance, display_name, nickname, agent_id')
          .eq('club_id', clubUuid)
          .in('status', MEMBER_IN_CLUB)
          .neq('user_id', user.id)
          // deterministic order: without one, paging can repeat or skip rows
          .order('joined_at', { ascending: true })
          .order('user_id', { ascending: true })
          .range(from, from + PAGE - 1);
        if (isAgent && !isStaff && downlineIds !== null) {
          // Was .eq('agent_id', user.id) - the caller's DIRECT assignees only.
          // A super agent carries agents, and those agents carry players, so
          // direct assignment hides most of the people they are responsible
          // for. The server walks the whole chain.
          if (downlineIds.length === 0) break;
          q = q.in('user_id', downlineIds);
        }
        const { data: page, error: dlErr } = await q;
        if (dlErr) throw dlErr;
        if (stale()) return;
        dl.push(...((page || []) as Array<Record<string, unknown>>));
        if (!page || page.length < PAGE) break;
      }

      const ids = (dl || []).map((r) => r.user_id as string);
      const profMap = new Map<
        string,
        { username?: string; display_name?: string; avatar_url?: string; is_horse?: boolean }
      >();
      if (ids.length > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, username, display_name, avatar_url:arena_avatar_url, is_horse')
          .in('id', ids);
        for (const pr of profs || []) profMap.set(pr.id as string, pr);
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
    const unsubs = events.map((e) => masterBus.subscribe(e as never, () => loadClub()));
    return () => unsubs.forEach((u) => u());
  }, [loadClub]);

  // ── Trade record tab data ──────────────────────────────────────────────────
  // Cleared on every club change: the previous club's trades used to stay on
  // screen until the new query landed.
  useEffect(() => {
    setRecords([]);
    setRecordsError(null);
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
  const loadRequests = useCallback(async () => {
    if (!user?.id || !clubUuid) return;
    setRequestsLoading(true);
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
      if (!isMounted.current) return;
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
    } finally {
      if (isMounted.current) setRequestsLoading(false);
    }
  }, [user?.id, clubUuid]);

  useEffect(() => {
    if (tab === 'request') loadRequests();
  }, [tab, loadRequests]);

  const respondToRequest = async (id: string, action: 'approve' | 'decline' | 'cancel') => {
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
    }
  };

  const askForChips = async () => {
    const v = Number(askAmount);
    if (!Number.isFinite(v) || v <= 0) {
      toast?.error?.('Enter A Positive Amount');
      return;
    }
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
    }
  };

  // ── Settlement invoices (Leaderboard Record tab) ───────────────────────────
  useEffect(() => {
    if (tab !== 'leaderboard' || !clubUuid) return;
    let live = true;
    setInvoicesLoading(true);
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
        setInvoices([]);
      } else {
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
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      toast?.error?.('Enter A Positive Amount');
      return;
    }
    // `list`, not `downline`: the visible, filtered set. The pruning effect
    // above already keeps these in step; reading the same source the user was
    // looking at means a race can never widen the blast radius of a transfer.
    const targets = list.filter((r) => selected.has(r.userId));
    if (targets.length === 0) return;
    if ((kind === 'send' || kind === 'ticket') && value * targets.length > availableChips) {
      toast?.error?.(
        `Insufficient Chips: Sending ${fmt(value * targets.length)} Needs More Than ${fmt(availableChips)}`
      );
      return;
    }
    if (busyRef.current) return; // a fast double-tap must not send twice
    busyRef.current = true;
    setBusy(true);
    let ok = 0;
    let skipped = 0;
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
              p_note: `Ticket from cashier`,
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
            });
            if (error) throw error;
            const res = data as { success?: boolean; error?: string } | null;
            if (res && res.success === false) throw new Error(res.error || 'refused');
          }
          ok++;
        } catch (e) {
          reportError(e, 'CashierTradePage.' + kind);
          toast?.error?.(`${t.name}: ${(e as Error).message || 'Transfer Failed'}`);
        }
      }
    } finally {
      // A throw between here and the end used to leave `busy` true forever,
      // and both Confirm and Cancel are disabled on it - the modal became a
      // trap that only a page reload could escape.
      busyRef.current = false;
      if (isMounted.current) {
        setBusy(false);
        setAmountModal(null);
        setAmount('');
      }
    }

    if (ok > 0) {
      toast?.success?.(
        kind === 'send'
          ? `Sent ${fmt(value)} To ${ok} Player${ok === 1 ? '' : 's'}`
          : kind === 'ticket'
            ? `Issued ${ok} Ticket${ok === 1 ? '' : 's'} Worth ${fmt(value)} Each`
            : `Claimed Back From ${ok} Player${ok === 1 ? '' : 's'}`
      );
      // The bus event is already wired to reload this page, so calling
      // loadClub() as well fired two identical loads at once.
      masterBus.emit('BALANCE_UPDATED', { source: 'cashier_trade', userId: user.id });
    } else if (skipped > 0) {
      toast?.info?.(
        `Nothing To Claim Back: ${skipped} Player${skipped === 1 ? ' Has' : 's Have'} No Chips`
      );
    }
  };

  const initial = (name: string) => (name || '?').charAt(0).toUpperCase();

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <button className={styles.back} aria-label="Back" onClick={() => navigate(-1)}>
          &#171;
        </button>
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
        ).map(([key, label]) => (
          <button
            key={key}
            className={`${styles.tab} ${tab === key ? styles.tabActive : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
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
            <div className={styles.stripCell}>
              <span className={styles.stripLabel}>Available Chips</span>
              <span className={styles.stripValue}>
                {fmt(availableChips)}
                <button
                  className={styles.plusBtn}
                  aria-label="Mint chips"
                  title="Chip Mint - convert diamonds into chips"
                  onClick={() => setShowMint(true)}
                >
                  +
                </button>
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
            {loading && <div className={styles.empty}>Loading Members...</div>}
            {!loading && loadError && (
              <div className={styles.empty} role="alert">
                {loadError}{' '}
                <button type="button" className={styles.retryBtn} onClick={() => void loadClub()}>
                  Retry
                </button>
              </div>
            )}
            {!loading && !loadError && list.length === 0 && (
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
                      {r.role !== 'player' ? r.role.replace('_', ' ') : r.isHorse ? 'horse' : ''}
                      {r.username ? ` @${r.username}` : ''}
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
                  {r.type.replace(/_/g, ' ')} &middot;{' '}
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
          {!invoicesLoading && invoices.length === 0 && (
            <div className={styles.empty}>
              No Settlement Records Yet. They Appear Here After The First Weekly Close.
            </div>
          )}
          {invoices.map((iv) => (
            <div key={iv.id} className={styles.row}>
              <div className={styles.rowInfo}>
                <span className={styles.rowName}>{iv.type.replace(/_/g, ' ')}</span>
                <span className={styles.rowSub}>
                  {new Date(iv.createdAt).toLocaleDateString([], {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}{' '}
                  &middot; {iv.status}
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
          {!requestsLoading && requests.length === 0 && (
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
                <button className={styles.reqBtn} onClick={() => respondToRequest(r.id, 'cancel')}>
                  Cancel
                </button>
              ) : (
                <>
                  <button
                    className={styles.reqBtn}
                    onClick={() => respondToRequest(r.id, 'decline')}
                  >
                    Decline
                  </button>
                  <button
                    className={`${styles.reqBtn} ${styles.reqBtnGo}`}
                    onClick={() => respondToRequest(r.id, 'approve')}
                  >
                    Approve
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
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalTitle}>Request Chips</div>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              value={askAmount}
              onChange={(e) => setAskAmount(e.target.value)}
              placeholder="How many chips?"
              autoFocus
            />
            <input
              type="text"
              value={askNote}
              onChange={(e) => setAskNote(e.target.value)}
              placeholder="Note (optional)"
              maxLength={120}
            />
            <div className={styles.modalHint}>
              Goes To Your Agent, Or The Club Owner If You Have None.
            </div>
            <div className={styles.modalActions}>
              <button onClick={() => setAskOpen(false)}>Cancel</button>
              <button className={styles.modalConfirm} onClick={askForChips}>
                Send Request
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Chip Mint — chips originate here (diamonds -> chips, 100 = 10,000). */}
      <ChipMintModal
        isOpen={showMint}
        onClose={() => setShowMint(false)}
        clubId={clubUuid || clubParam || ''}
        onMinted={() => loadClub()}
      />

      {/* Amount modal */}
      {amountModal && (
        <div className={styles.modalOverlay} onClick={() => !busy && setAmountModal(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalTitle}>
              {amountModal === 'send'
                ? 'Send Out'
                : amountModal === 'ticket'
                  ? 'Send Ticket'
                  : 'Claim Back'}{' '}
              &middot; {selected.size} Player
              {selected.size === 1 ? '' : 's'}
            </div>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={
                amountModal === 'claim'
                  ? 'Amount per player (max = balance)'
                  : amountModal === 'ticket'
                    ? 'Ticket value per player'
                    : 'Amount per player'
              }
              autoFocus
            />
            {amountModal === 'ticket' && (
              <div className={styles.modalHint}>
                Tickets Are Paid Now And Held Until The Player Redeems Them. Cancel An Unredeemed
                Ticket To Get The Chips Back.
              </div>
            )}
            {(amountModal === 'send' || amountModal === 'ticket') && (
              <div className={styles.modalHint}>
                Total: {fmt((Number(amount) || 0) * selected.size)} &middot; Available:{' '}
                {fmt(availableChips)}
              </div>
            )}
            <div className={styles.modalActions}>
              <button disabled={busy} onClick={() => setAmountModal(null)}>
                Cancel
              </button>
              <button
                className={styles.modalConfirm}
                disabled={busy}
                onClick={() => runTransfers(amountModal)}
              >
                {busy ? 'Working...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
