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
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import { masterBus } from '../core/MasterBus';
import { useToast } from '../components/common/Toast';
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

type TabKey = 'trade' | 'record' | 'leaderboard' | 'request';

const fmt = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ─── Component ───────────────────────────────────────────────────────────────

export default function CashierTradePage() {
  const { clubId: clubParam } = useParams<{ clubId: string }>();
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();

  const [clubUuid, setClubUuid] = useState<string | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tab, setTab] = useState<TabKey>('trade');

  const [myRole, setMyRole] = useState<string>('player');
  const [myBalance, setMyBalance] = useState(0);
  const [availableChips, setAvailableChips] = useState(0);
  const [downline, setDownline] = useState<DownlineRow[]>([]);
  const [mineOnly, setMineOnly] = useState(false);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [groupByRole, setGroupByRole] = useState(false);
  const [sortKey, setSortKey] = useState<'balance' | 'name'>('balance');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [records, setRecords] = useState<TradeRecordRow[]>([]);
  const [amountModal, setAmountModal] = useState<'send' | 'claim' | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
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
      const uuid = (await resolveClubUUID(clubParam)) || clubParam;
      if (live) setClubUuid(uuid);
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
    if (!user?.id || !clubUuid) return;
    setLoading(true);
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
      const role = (meRes.data?.role as string) || 'player';
      const bal = Number(meRes.data?.chip_balance) || 0;
      const panel = ((Array.isArray(panelRes.data) ? panelRes.data[0] : panelRes.data) ??
        {}) as Record<string, unknown>;

      const isStaff = role === 'owner' || role === 'admin';
      const isAgent = role === 'agent' || role === 'super_agent' || role === 'sub_agent';

      // NOTE: no PostgREST embed here - club_members.user_id has no FK to
      // profiles (it references public.users), so `profiles:user_id(...)`
      // 400s and the whole load died (verified live: 0 members, 0.00
      // balances on first deploy). Two-step fetch instead.
      // An agent may only ever SEE their own players, so that stays a server
      // filter. Staff see the whole club and narrow it with the "Assigned to
      // me" toggle below - a filter they can turn off, not a wall.
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
        if (isAgent && !isStaff) q = q.eq('agent_id', user.id);
        const { data: page, error: dlErr } = await q;
        if (dlErr) throw dlErr;
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
          .select('id, username, display_name, avatar_url, is_horse')
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

      if (!isMounted.current) return;
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
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [user?.id, clubUuid]);

  useEffect(() => {
    loadClub();
  }, [loadClub]);

  // Refresh on any balance event
  useEffect(() => {
    const unsub = masterBus.subscribe('BALANCE_UPDATED', () => loadClub());
    return () => unsub();
  }, [loadClub]);

  // ── Trade record tab data ──────────────────────────────────────────────────
  useEffect(() => {
    if (tab !== 'record' || !user?.id || !clubUuid) return;
    let live = true;
    (async () => {
      const { data, error } = await supabase
        .from('chip_transactions')
        .select('id, created_at, transaction_type, amount, from_user_id, to_user_id, notes')
        .eq('club_id', clubUuid)
        .or(`from_user_id.eq.${user.id},to_user_id.eq.${user.id}`)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error || !live) return;
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
    })();
    return () => {
      live = false;
    };
  }, [tab, user?.id, clubUuid]);

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

  const agencyBalance = useMemo(
    () => downline.reduce((s, r) => s + r.chipBalance, 0),
    [downline]
  );

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ── Money actions ──────────────────────────────────────────────────────────
  const runTransfers = async (kind: 'send' | 'claim') => {
    if (!user?.id || !clubUuid) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      toast?.error?.('Enter A Positive Amount');
      return;
    }
    const targets = downline.filter((r) => selected.has(r.userId));
    if (targets.length === 0) return;
    if (kind === 'send' && value * targets.length > myBalance) {
      toast?.error?.(`Insufficient Chips: Sending ${fmt(value * targets.length)} Needs More Than ${fmt(myBalance)}`);
      return;
    }
    setBusy(true);
    let ok = 0;
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
        } else {
          const claim = Math.min(value, t.chipBalance);
          if (claim <= 0) continue;
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
    setBusy(false);
    setAmountModal(null);
    setAmount('');
    if (ok > 0) {
      toast?.success?.(
        kind === 'send'
          ? `Sent ${fmt(value)} To ${ok} Player${ok === 1 ? '' : 's'}`
          : `Claimed Back From ${ok} Player${ok === 1 ? '' : 's'}`
      );
      masterBus.emit('BALANCE_UPDATED', { source: 'cashier_trade', userId: user.id });
      loadClub();
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
              <span className={styles.pickerBalance}>{fmt(m.chipBalance)} chips</span>
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
                  aria-label="Get more chips"
                  onClick={() => navigate(`/clubs/${clubParam}/cashier-classic`)}
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
              placeholder={`${downline.length} member${downline.length === 1 ? '' : 's'}`}
              aria-label="Search members"
            />
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
              Group by Role
            </label>
            <button
              className={styles.sortBtn}
              onClick={() => setSortKey((k) => (k === 'balance' ? 'name' : 'balance'))}
            >
              Sort by {sortKey === 'balance' ? 'Chip Balance' : 'Name'} &#9662;
            </button>
          </div>

          {/* Downline list */}
          <div className={styles.list}>
            {loading && <div className={styles.empty}>Loading members...</div>}
            {!loading && list.length === 0 && (
              <div className={styles.empty}>
                {mineOnly
                  ? 'No players are assigned to you in this club.'
                  : search.trim()
                    ? 'No members match that search.'
                    : 'No members in your downline yet.'}
              </div>
            )}
            {list.map((r) => (
              <div
                key={r.userId}
                className={`${styles.row} ${selected.has(r.userId) ? styles.rowSelected : ''}`}
                onClick={() => toggleSelect(r.userId)}
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
              onClick={() => toast?.info?.('Tournament Tickets Are Coming Soon')}
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
          {records.length === 0 && <div className={styles.empty}>No trades recorded yet.</div>}
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
        <div className={styles.empty}>
          Leaderboard settlement records are coming soon. Weekly results live on the Data tab for
          now.
        </div>
      )}

      {tab === 'request' && (
        <div className={styles.empty}>
          Chip requests are coming soon. Players can request chips from you here; for now use the
          Advanced Cashier.
        </div>
      )}

      {/* Amount modal */}
      {amountModal && (
        <div className={styles.modalOverlay} onClick={() => !busy && setAmountModal(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalTitle}>
              {amountModal === 'send' ? 'Send Out' : 'Claim Back'} &middot; {selected.size} player
              {selected.size === 1 ? '' : 's'}
            </div>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={
                amountModal === 'send' ? 'Amount per player' : 'Amount per player (max = balance)'
              }
              autoFocus
            />
            {amountModal === 'send' && (
              <div className={styles.modalHint}>
                Total: {fmt((Number(amount) || 0) * selected.size)} &middot; Your balance:{' '}
                {fmt(myBalance)}
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
