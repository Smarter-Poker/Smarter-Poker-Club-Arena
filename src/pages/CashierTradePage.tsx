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
 * ── THE MONEY PATH (Dan 2026-08-25, binding) ────────────────────────────────
 *
 * "IT SHOULD BE REMOVING OR ADDING TO PLAYER WALLET DIRECTLY, AND SENT FROM AND
 *  DEPOSITING INTO AGENT WALLETS. THE CLAWBACK IS ONLY IN EFFECT FOR THE FIRST
 *  10 MINUTES WHEN CHIPS ARE SENT, AND AGENT CAN ONLY REMOVE CHIPS IF REQUESTED
 *  BY THE PLAYER AFTER THAT."
 *
 * So the AGENT WALLET (agents.agent_wallet_balance) is the source and the
 * destination, exactly as the Club Bank Cashier already works:
 *
 *   Send Out   → fn_agent_wallet_send        debits the caller's agent wallet,
 *                                            credits the recipient's player
 *                                            wallet (or an agent's own float),
 *                                            writes one chip_transactions row,
 *                                            idempotent on p_op_id, stamps
 *                                            reversible_until = now() + 10 min
 *   Claim Back → fn_agent_wallet_claim_back  anchored on ONE originating send,
 *                                            refused by the DATABASE's clock
 *                                            once the ten minutes have passed
 *   The list   → fn_agent_wallet_reversible  what is still claimable, with the
 *                                            countdown computed server-side
 *
 * This page used to call fn_cashier_send_chips / fn_cashier_claim_back, which
 * moved club_members.chip_balance ↔ club_members.chip_balance and never touched
 * an agent wallet at all - a second, older money path beside the cashier modal's
 * one. The send carried no idempotency key whatsoever; the claim carried a key
 * in a convention nothing else uses and had no ten minute anchor, so an agent
 * could pull chips off a player days later with no cash out request.
 *
 * AFTER THE WINDOW CLOSES there is exactly one way chips leave a player: the
 * player's own cash out request (fn_cashout_request → approve / deny). The UI
 * says so rather than offering a control the server would refuse.
 *
 * The recipient list is fn_club_cashier_members - the SAME downline edge
 * fn_agent_wallet_send refuses on, so the list and the refusal cannot disagree.
 *
 * The classic cashier (buy-in / cash-out / mint / full history) remains at
 * ./cashier-classic and is linked from the bottom of the Trade tab.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { roleLabel, roleRank, type ClubRole } from '../types/clubRoles';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { resolveClubUUID, isUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import { masterBus } from '../core/MasterBus';
import { useToast } from '../components/common/Toast';
import WalletCashierModal from '../components/wallet/WalletCashierModal';
import { DEFAULT_CASHIER_WALLET } from '../components/wallet/cashierModes';
import { canSeeClubBank, canHoldAgentWallet } from '../components/wallet/walletRows';
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
  /**
   * How many club_members.agent_id hops below the viewer this member sits, as
   * computed by fn_club_cashier_members. 1 is a direct assignee; 0 means the
   * recursion never reached them, which only happens for staff (scope 'all').
   */
  depth: number;
  /** true when this player is assigned DIRECTLY to the person looking. */
  isMine: boolean;
  playerNumber: string | null;
}

/**
 * One agent wallet send still inside its ten minute window, straight off
 * fn_agent_wallet_reversible. `seconds_left` is computed by the DATABASE, so a
 * phone with a skewed clock cannot offer a claim the server will refuse.
 */
interface ReversibleSend {
  transaction_id: string;
  to_user_id: string;
  to_name: string;
  amount: number;
  claimed_back: number;
  remaining: number;
  destination: string;
  created_at: string;
  reversible_until: string;
  seconds_left: number;
}

// A membership row means "in this club". The column carries two words for it:
// everything created before 2026-07-22 says 'approved', everything since says
// 'active', and 1,480 of the 1,499 rows in production are the older word. Every
// other query in this codebase asks for BOTH - this page asked for 'active'
// alone, which is why a 588-member club showed 11 people and an owner's
// assigned horses vanished. Named once here so the next screen copies the set
// rather than one of its halves.
const MEMBER_IN_CLUB = ['active', 'approved'];

/**
 * PostgREST caps a response at 1,000 rows, and `.in('id', [...])` with ten
 * thousand ids is a URL no proxy will carry. The horse flag is the one field
 * fn_club_cashier_members does not return, so it is fetched in slices.
 */
const PROFILE_CHUNK = 300;

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
/**
 * crypto.randomUUID is undefined on http origins and in Safari < 15.4.
 *
 * THE FALLBACK MUST STILL BE A UUID (2026-08-25). It used to be
 * `${Date.now()}-${random}`, which was fine while the only consumer was a text
 * idempotency key. fn_agent_wallet_send takes `p_op_id uuid`, and a non-uuid
 * there is a 22P02 from Postgres on the one call that moves the chips - on
 * exactly the browsers that have no randomUUID.
 */
function newOpId(): string {
  try {
    const c = globalThis.crypto as Crypto | undefined;
    if (c?.randomUUID) return c.randomUUID();
  } catch {
    /* fall through to the shim */
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

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
  /**
   * agents.agent_wallet_balance for the viewer IN THIS CLUB - the account
   * Send Out actually spends. Null while unknown, never 0: a figure we could
   * not read must not disable a send that is in fact funded, nor authorise one
   * that is not. The pre-flight check below only refuses on a KNOWN shortfall.
   */
  const [agentWallet, setAgentWallet] = useState<number | null>(null);
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
  /** Bumped by Retry; the invoice fetch lives inline in an effect. */
  const [invoicesReload, setInvoicesReload] = useState(0);
  const [askOpen, setAskOpen] = useState(false);
  const [askAmount, setAskAmount] = useState('');
  const [askNote, setAskNote] = useState('');
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [amountModal, setAmountModal] = useState<'send' | 'ticket' | null>(null);
  /**
   * CLAIM BACK IS NO LONGER AN AMOUNT AGAINST A SELECTION.
   *
   * It is anchored on ONE send this agent made inside the last ten minutes, so
   * the modal lists those sends rather than asking for a number. Anything older
   * cannot be clawed back at all - the player has to request a cash out - and
   * the empty state says exactly that instead of offering a control the server
   * would refuse.
   */
  const [claimOpen, setClaimOpen] = useState(false);
  const [reversible, setReversible] = useState<ReversibleSend[]>([]);
  const [reversibleLoading, setReversibleLoading] = useState(false);
  const [reversibleError, setReversibleError] = useState<string | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  /** Ticks once a second so each countdown in that list stays honest. */
  const [nowTick, setNowTick] = useState(() => Date.now());
  /**
   * Per-target failures from the last batch, rendered IN the modal. The toast
   * layer sanitises money errors (it strips the player's name off an
   * insufficient-funds refusal) and drops whole error categories, so on a
   * partial failure the user could not tell which recipients missed out.
   * JSX bypasses that sanitiser.
   */
  const [transferFailures, setTransferFailures] = useState<
    Array<{ userId: string; name: string; message: string }>
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
   * The idempotency nonce for the batch currently being submitted.
   *
   * ONE NONCE PER INTENT (Dan 2026-08-25). It used to be minted only when null
   * and cleared only on a fully clean batch, so after ANY partial failure it
   * survived into every later submission indefinitely - and the comment beside
   * it claimed "change the amount or the selection and a fresh id is minted",
   * which was simply not what the code did. Concretely: claim 100 from A and B,
   * A commits, B fails, the id is kept; later you deliberately claim 100 from A
   * again, the server matches the retained key, moves nothing, and reports
   * success. Money you believed you took never moved.
   *
   * It is now cleared whenever the amount or the selection changes (see the
   * effect below), so it is retained ONLY for a retry of the identical
   * unchanged batch - which is exactly what it is for.
   */
  const submissionIdRef = useRef<string | null>(null);
  /**
   * ONE op_id PER TARGET, held for the life of one intent.
   *
   * fn_agent_wallet_send is keyed on a single `p_op_id uuid`, not on a composed
   * text key, so a batch cannot reuse one nonce across recipients - the second
   * recipient would match the first's row and be reported as a replay while
   * receiving nothing. The map is minted lazily per target and CLEARED BY THE
   * SAME EFFECT that clears submissionIdRef, so:
   *
   *   retry the identical batch  → same uuids → committed targets replay
   *   change the amount or the selection → fresh uuids → a genuinely new intent
   *
   * This is `opIdRef` from WalletCashierModal, generalised to a batch.
   */
  const opIdsRef = useRef<Map<string, string>>(new Map());
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
      // isUUID, not truthiness (Dan 2026-08-25). resolveClubUUID is typed
      // Promise<string> and RETURNS THE INPUT UNCHANGED when it cannot resolve,
      // so `if (uuid)` was always true and this whole branch - and the "We
      // Could Not Find That Club" state it drives - was unreachable. What
      // actually happened on a bad slug was a club CODE going into a uuid
      // column filter: 22P02, surfaced as a generic load failure.
      // ClubMembersPage fixed exactly this; the Cashier was left behind.
      if (isUUID(uuid)) {
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
      const [meRes, floatRes] = await Promise.all([
        supabase
          .from('club_members')
          .select('role, chip_balance')
          .eq('club_id', clubUuid)
          .eq('user_id', user.id)
          .maybeSingle(),
        // The account Send Out spends. An owner has one of these too - the
        // Club Bank funds it, and fn_agent_wallet_send refuses every role
        // that has not been funded, staff included.
        supabase
          .from('agents')
          .select('agent_wallet_balance')
          .eq('club_id', clubUuid)
          .eq('user_id', user.id)
          .maybeSingle(),
      ]);
      // Swallowing this error rendered an owner as a `player` with a 0.00
      // balance and silently flipped the downline into agent scope. A failure
      // has to look like a failure.
      if (meRes.error) throw meRes.error;
      const role = meRes.data?.role ? (meRes.data.role as string) : 'player';
      const bal = meRes.data?.chip_balance ? Number(meRes.data.chip_balance) : 0;
      // A row that does not exist is a float of zero. A row we could not READ
      // is unknown, and stays null so the pre-flight check does not refuse a
      // send the server would have allowed.
      const float = floatRes.error
        ? null
        : floatRes.data
          ? Number(floatRes.data.agent_wallet_balance) || 0
          : 0;

      /**
       * WHO THIS PAGE MAY TRANSACT WITH — asked in the database.
       *
       * This used to page club_members by hand and scope it from
       * ca_club_my_downline, in three different ways depending on the role, with
       * a super_agent branch that also swept up every UNASSIGNED member of the
       * club. None of that agreed with the server: fn_agent_wallet_send refuses
       * on fn_club_cashier_can_transact, which walks the recursive
       * club_members.agent_id edge and nothing else. A list that offers someone
       * the RPC will reject is a dead end nobody can diagnose from the screen.
       *
       * fn_club_cashier_members IS that edge: everyone for an owner, co owner or
       * admin; the recursive downline for a super agent, agent or sub agent;
       * nobody for a plain player. It also carries `depth`, so "Assigned To Me"
       * is a direct hop rather than a second query for agent_id.
       */
      const dl: Array<Record<string, unknown>> = [];
      if (role !== 'player') {
        const { data: memberRows, error: dlErr } = await supabase.rpc('fn_club_cashier_members', {
          p_club_id: clubUuid,
        });
        if (dlErr) throw dlErr;
        if (stale()) return;
        dl.push(...((memberRows || []) as Array<Record<string, unknown>>));
      }

      // The horse flag is the ONE field fn_club_cashier_members does not
      // return, and `.in('id', ids)` with a whole club in it is both a URL no
      // proxy will carry and a response PostgREST truncates at 1,000 rows.
      const ids = dl.map((r) => String(r.user_id));
      const horses = new Set<string>();
      for (let i = 0; i < ids.length; i += PROFILE_CHUNK) {
        const slice = ids.slice(i, i + PROFILE_CHUNK);
        const { data: profs, error: profErr } = await supabase
          .from('profiles')
          .select('id, is_horse')
          .in('id', slice);
        if (stale()) return;
        // A horse tag is decoration; losing it must not fail the whole cashier.
        if (profErr) {
          reportError(profErr, 'CashierTradePage.horseFlags');
          break;
        }
        for (const pr of profs || []) if (pr.is_horse) horses.add(pr.id as string);
      }

      const rows: DownlineRow[] = dl.map((r) => {
        const uid = String(r.user_id);
        const depth = Number(r.depth) || 0;
        return {
          userId: uid,
          name: (r.name as string) || 'Player',
          username: (r.username as string) || '',
          avatarUrl: (r.avatar_url as string) || null,
          role: (r.role as string) || 'player',
          chipBalance: Number(r.chip_balance) || 0,
          isHorse: horses.has(uid),
          depth,
          // depth 1 is a DIRECT assignee. Deeper rows belong to an agent
          // beneath this one, and are still transactable - just not "mine".
          isMine: depth === 1,
          playerNumber: (r.player_number as string) || null,
        };
      });

      if (!isMounted.current || stale()) return;
      setMyRole(role);
      setMyBalance(bal);
      setAgentWallet(float);
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
        // The badge's own comment promised this and it was never wired: the
        // only caller was the mount effect, so an owner on the Trade tab saw
        // the count frozen at whatever it was when the page opened - the exact
        // scenario the badge exists for.
        void loadPendingCount();
      })
    );
    return () => unsubs.forEach((u) => u());
  }, [loadClub, clubUuid, loadPendingCount]);

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
    setAgentWallet(null);
    setDownline([]);
    setSelected(new Set());
    setTransferFailures([]);
    // The claimable list belongs to the club it was read from. Leaving it up
    // would offer a claim against a send made in a DIFFERENT club, which the
    // server refuses - after the user has already tapped it.
    setReversible([]);
    setReversibleError(null);
    setClaimOpen(false);
    // Was NOT reset. The checkbox is disabled when mineCount is 0, so switching
    // to a club where you have no assigned players left the filter stuck ON
    // with the only control that clears it greyed out - reload was the way out.
    setMineOnly(false);
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
    // invoicesReload, so Retry has something to change. The button used to call
    // setTab('leaderboard') from inside the leaderboard tab, which is a no-op:
    // deps never changed, no refetch happened, and the error banner sat there
    // with a button that did nothing.
  }, [tab, clubUuid, invoicesReload]);

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
      // ROLE_RANK from types/clubRoles, not a local map. The local one listed
      // super_agent/agent/sub_agent/admin/player and OMITTED owner and
      // co_owner, so both fell to the `?? 9` default and sorted BELOW every
      // player - on the control called "Group By Role". That module exists
      // because there were once three role types and no two agreed.
      rows = [...rows].sort((a, b) => roleRank(b.role as ClubRole) - roleRank(a.role as ClubRole));
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
   * A changed amount or a changed selection is a NEW intent, so the retained
   * nonces must not carry into it. Retry the same batch unchanged and the ids
   * survive; touch either input and the next submission mints fresh ones.
   */
  useEffect(() => {
    submissionIdRef.current = null;
    opIdsRef.current = new Map();
  }, [amount, selected, clubUuid]);

  /** Chips the selected players are holding right now. */
  const pickedHeld = useMemo(
    () => picked.reduce((sum, r) => sum + (Number(r.chipBalance) || 0), 0),
    [picked]
  );

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ── Money actions ──────────────────────────────────────────────────────────
  const runTransfers = async (kind: 'send' | 'ticket') => {
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
    /**
     * GUARD AGAINST THE POT EACH ACTION ACTUALLY SPENDS. These are two
     * different accounts and quoting the wrong one is how a user is told they
     * have money this action cannot reach:
     *
     *   Send Out    → agents.agent_wallet_balance  (fn_agent_wallet_send)
     *   Send Ticket → club_members.chip_balance    (fn_issue_tournament_ticket)
     *
     * `availableChips` is the CLUB BANK for staff and is deliberately not used
     * here: an owner with a large treasury and an unfunded agent wallet sailed
     * past the old check and collected N server refusals instead.
     */
    const total = value * targets.length;
    if (kind === 'send' && agentWallet !== null && total > agentWallet) {
      toast?.error?.(
        `Insufficient Chips: Sending ${fmt(total)} Needs More Than Your Agent Wallet Holds, ${fmt(agentWallet)}`
      );
      return;
    }
    if (kind === 'ticket' && total > myBalance) {
      toast?.error?.(`Insufficient Chips: Sending ${fmt(total)} Needs More Than ${fmt(myBalance)}`);
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
     * when the batch fully succeeds, AND whenever the amount or the selection
     * changes (the effect beside submissionIdRef). Retry the failed batch
     * unchanged and the server matches the key, replays the original outcome
     * and moves nothing; change either input and a fresh id is minted, because
     * that is a genuinely new intent and must be allowed through.
     */
    if (!submissionIdRef.current) {
      submissionIdRef.current = newOpId();
    }
    const submissionId = submissionIdRef.current;
    /** The op_id for one target, minted once and reused by every retry. */
    const opIdFor = (userId: string) => {
      const held = opIdsRef.current.get(userId);
      if (held) return held;
      const fresh = newOpId();
      opIdsRef.current.set(userId, fresh);
      return fresh;
    };
    let ok = 0;
    const failed: Array<{ userId: string; name: string; message: string }> = [];
    try {
      for (const t of targets) {
        try {
          if (kind === 'send') {
            /**
             * THE AGENT WALLET IS THE SOURCE (Dan 2026-08-25).
             *
             * fn_agent_wallet_send debits agents.agent_wallet_balance for
             * auth.uid(), credits the recipient, writes ONE chip_transactions
             * row and stamps reversible_until ten minutes out. It refuses a
             * recipient outside the caller's downline BEFORE any money moves,
             * on the same fn_club_cashier_can_transact the member list is built
             * from.
             *
             * `p_destination` follows the RECIPIENT's role: chips to a player
             * land in the player wallet they buy in with; chips to a sub agent
             * land in the float they distribute from, which is the account
             * their own Send Out spends.
             */
            const { data, error } = await supabase.rpc('fn_agent_wallet_send', {
              p_club_id: clubUuid,
              p_to_user_id: t.userId,
              p_amount: value,
              p_destination: canHoldAgentWallet(t.role) ? 'agent_wallet' : 'player_wallet',
              p_reason: `Cashier Send Out To ${t.name}`,
              p_op_id: opIdFor(t.userId),
            });
            if (error) throw error;
            const res = (Array.isArray(data) ? data[0] : data) as {
              success?: boolean;
              error?: string;
            } | null;
            if (!res?.success) throw new Error(res?.error || 'refused');
          } else {
            // Tournament ticket: the value is ESCROWED off the issuer now and
            // held on the ticket until the player redeems it. This one still
            // spends club_members.chip_balance - a ticket is not agent float.
            const { data, error } = await supabase.rpc('fn_issue_tournament_ticket', {
              p_club_id: clubUuid,
              p_holder_id: t.userId,
              p_value: value,
              p_note: `Cashier ticket for ${t.name}`,
              // A replay must not mint a second ticket, not just avoid a second
              // debit - the ticket row is inside the same guarded block, so it
              // rolls back with the money.
              p_idempotency_key: `ticket:${clubUuid}:${submissionId}:${t.userId}:${value}`,
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
          // below had no branch for "nothing succeeded at all".
          // The user was left not knowing whether ten transfers had happened.
          // Keyed on userId, not name: `name` falls back to 'Player' for anyone
          // with no display name, so two such recipients failing in one batch
          // produced duplicate React keys and one row was dropped - from the
          // list telling you which transfers did not happen.
          failed.push({
            userId: t.userId,
            name: t.name,
            message: (e as Error)?.message || 'Transfer Failed',
          });
        }
      }
    } finally {
      // A throw between here and the end used to leave `busy` true forever,
      // and both Confirm and Cancel are disabled on it - the modal became a
      // trap that only a page reload could escape.
      busyRef.current = false;
      // Retire the nonces ONLY when every target went through. If any one of
      // them failed, keeping them is the whole point: the retry carries the
      // same op_id per target, so whichever targets already committed replay
      // instead of being charged a second time.
      if (ok === targets.length) {
        submissionIdRef.current = null;
        opIdsRef.current = new Map();
      }
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
          ? `Sent ${fmt(value)} To ${who} From Your Agent Wallet`
          : `Issued ${ok} Ticket${ok === 1 ? '' : 's'} Worth ${fmt(value)} Each To ${who}`
      );
      // The bus event is already wired to reload this page, so calling
      // loadClub() as well fired two identical loads at once.
      masterBus.emit('BALANCE_UPDATED', { source: 'cashier_trade', userId: user.id });
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
   * ── CLAIM BACK: THE TEN MINUTE MISTAKE ERASER, AND NOTHING WIDER ──────────
   *
   * Dan 2026-08-25: "THE CLAWBACK IS ONLY IN EFFECT FOR THE FIRST 10 MINUTES
   * WHEN CHIPS ARE SENT, AND AGENT CAN ONLY REMOVE CHIPS IF REQUESTED BY THE
   * PLAYER AFTER THAT."
   *
   * So this is not "type an amount against a selection" any more. It is
   * anchored on ONE send this agent made, and the list of what is still
   * claimable is computed by the database (fn_agent_wallet_reversible) rather
   * than from created_at on the client - a phone with a skewed clock must not
   * offer a claim the server will refuse.
   */
  const loadReversible = useCallback(async () => {
    if (!clubUuid) return;
    setReversibleLoading(true);
    setReversibleError(null);
    const { data, error } = await supabase.rpc('fn_agent_wallet_reversible', {
      p_club_id: clubUuid,
    });
    if (!isMounted.current) return;
    if (error) {
      reportError(error, 'CashierTradePage.loadReversible');
      // "Nothing Is Claimable" is a different statement from "we could not read
      // it", and on a screen about taking money back the difference matters.
      setReversible([]);
      setReversibleError('Could Not Read Your Recent Sends.');
    } else {
      setReversible(((data || []) as ReversibleSend[]).map((r) => ({ ...r })));
    }
    setReversibleLoading(false);
  }, [clubUuid]);

  const claimBack = async (row: ReversibleSend) => {
    if (!clubUuid || claimingId || busyRef.current) return;
    busyRef.current = true;
    setClaimingId(row.transaction_id);
    try {
      const { data, error } = await supabase.rpc('fn_agent_wallet_claim_back', {
        p_club_id: clubUuid,
        p_transaction_id: row.transaction_id,
        p_amount: row.remaining,
        p_reason: 'Claimed Back From The Trade Grid',
        // A fresh op id per attempt, exactly as WalletCashierModal does: the
        // claim is already anchored on one transaction, and the server records
        // what has been taken off it, so a replay cannot double-collect.
        p_op_id: newOpId(),
      });
      if (error) throw error;
      const res = (Array.isArray(data) ? data[0] : data) as {
        success?: boolean;
        error?: string;
        replayed?: boolean;
      } | null;
      if (!res?.success) throw new Error(res?.error || 'Those Chips Could Not Be Claimed Back');
      toast?.success?.(
        res.replayed
          ? `That Claim Had Already Gone Through. ${fmt(row.remaining)} Chips Are Back In Your Agent Wallet`
          : `Claimed ${fmt(row.remaining)} Back From ${row.to_name}`
      );
      masterBus.emit('BALANCE_UPDATED', { source: 'cashier_trade_claim', userId: user?.id || '' });
      void loadReversible();
    } catch (e) {
      reportError(e, 'CashierTradePage.claimBack');
      toast?.error?.((e as Error).message || 'Claim Back Failed');
    } finally {
      busyRef.current = false;
      if (isMounted.current) setClaimingId(null);
    }
  };

  // The claimable list, and a one second tick so each countdown is the truth
  // rather than the value it had when the modal opened.
  useEffect(() => {
    if (!claimOpen || !clubUuid) return;
    void loadReversible();
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [claimOpen, clubUuid, loadReversible]);

  /**
   * Rows whose window has run out WHILE THE MODAL IS OPEN. The server would
   * refuse them, so the button goes and the sentence explaining why takes its
   * place rather than leaving a control that fails on tap.
   */
  const stillClaimable = useMemo(
    () => reversible.filter((r) => new Date(r.reversible_until).getTime() > nowTick),
    [reversible, nowTick]
  );

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
    if (!amountModal && !askOpen && !claimOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (amountModal && !busy) {
        setAmountModal(null);
        setTransferFailures([]);
      }
      if (askOpen && !asking) setAskOpen(false);
      if (claimOpen && !claimingId) setClaimOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [amountModal, askOpen, claimOpen, busy, asking, claimingId]);

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
            {/* THE ACCOUNT THIS PAGE SPENDS (Dan 2026-08-25).
                Send Out debits agents.agent_wallet_balance for every role, so
                this cell shows THAT figure rather than the club treasury - an
                owner with a large bank and an unfunded float could otherwise
                read a number this action cannot reach. The "+" opens the Club
                Bank Cashier, which is where a float is funded from, and only
                for the four roles that may stand at it. */}
            <div className={styles.stripCell}>
              <span className={styles.stripLabel}>Agent Wallet</span>
              <span className={styles.stripValue}>
                {agentWallet === null ? '--' : fmt(agentWallet)}
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
              {/* The count AND what they hold. The total used to live in the
                  balance strip, which now shows the account this page spends;
                  it is the number that decides whether a claim is worth making,
                  so it stays beside the filter that isolates those players. */}
              Assigned To Me ({mineCount.toLocaleString()} &middot; {fmt(mineTotal)})
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
                        {roleLabel(r.role as ClubRole)}
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
            {/* NOT GATED ON THE SELECTION any more. A claim back is anchored on
                a SEND, not on a player, so the modal lists this agent's own
                sends that are still inside their ten minute window - and says
                so plainly when there are none. Gating it on a selection would
                hide the only control that can undo a mistake behind picking the
                player you have just realised you sent to by accident. */}
            <button
              className={styles.footerBtn}
              disabled={busy || claimingId !== null}
              onClick={() => setClaimOpen(true)}
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
                onClick={() => setInvoicesReload((n) => n + 1)}
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
        walletType={activeCashier || DEFAULT_CASHIER_WALLET}
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
              {amountModal === 'send' ? 'Send Out' : 'Send Ticket'} &middot;{' '}
              {picked.length.toLocaleString()} Player{picked.length === 1 ? '' : 's'}
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
                amountModal === 'ticket' ? 'Ticket value per player' : 'Amount per player'
              }
              autoFocus
            />
            {/* WHO, AND WHERE IT LANDS (Dan 2026-08-25).
                The modal named a count and never the people; on a 375px screen
                the selection has scrolled out of view and the user is one tap
                from moving real money to a set they cannot see. The wallet is
                named too, because a send to a sub agent funds the float they
                distribute from rather than a balance they can sit down with. */}
            {picked.length > 0 && (
              <div className={styles.modalTargets}>
                {picked.map((r) => (
                  <div className={styles.modalTargetRow} key={r.userId}>
                    <span>
                      {r.name}
                      {amountModal === 'send' && canHoldAgentWallet(r.role)
                        ? ' (Agent Wallet)'
                        : ''}
                    </span>
                    <span>{fmt(Number(amount) || 0)}</span>
                  </div>
                ))}
              </div>
            )}
            {amountModal === 'ticket' && (
              <div className={styles.modalHint}>
                Tickets Are Paid Now And Held Until The Player Redeems Them. Cancel An Unredeemed
                Ticket To Get The Chips Back.
              </div>
            )}
            <div className={styles.modalHint}>
              Total: {fmt((Number(amount) || 0) * picked.length)} &middot;{' '}
              {/* THE ACCOUNT EACH ACTION SPENDS. Send Out debits the agent
                  wallet; a ticket escrows the caller's own chip balance. They
                  are different accounts and quoting the wrong one tells the
                  user they have money this action cannot reach. */}
              {amountModal === 'send'
                ? `Your Agent Wallet: ${agentWallet === null ? '--' : fmt(agentWallet)}`
                : `Your Chips: ${fmt(myBalance)}`}
            </div>
            {amountModal === 'send' && (
              <div className={styles.modalHint}>
                You Can Claim These Chips Back For Ten Minutes. After That The Player Must Request A
                Cash Out.
              </div>
            )}
            {transferFailures.length > 0 && (
              <div className={styles.modalFailures} role="alert">
                <div className={styles.modalFailuresTitle}>
                  {transferFailures.length} Did Not Go Through
                </div>
                {transferFailures.map((f) => (
                  <div className={styles.modalFailureRow} key={f.userId}>
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

      {/* CLAIM BACK — anchored on a send, bounded by the database's clock.
          Dan 2026-08-25: "THE CLAWBACK IS ONLY IN EFFECT FOR THE FIRST 10
          MINUTES WHEN CHIPS ARE SENT, AND AGENT CAN ONLY REMOVE CHIPS IF
          REQUESTED BY THE PLAYER AFTER THAT." */}
      {claimOpen && (
        <div
          className={styles.modalOverlay}
          onClick={() => {
            if (claimingId) return;
            setClaimOpen(false);
          }}
        >
          <div
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cashier-claim-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalTitle} id="cashier-claim-title">
              Claim Back
            </div>
            <div className={styles.modalHint}>
              You Can Take Back A Send For Ten Minutes. After That The Only Way Chips Leave A Player
              Is Their Own Cash Out Request.
            </div>
            {reversibleLoading && <div className={styles.empty}>Reading Your Recent Sends...</div>}
            {!reversibleLoading && reversibleError && (
              <div className={styles.empty} role="alert">
                {reversibleError}{' '}
                <button
                  type="button"
                  className={styles.retryBtn}
                  onClick={() => void loadReversible()}
                >
                  Retry
                </button>
              </div>
            )}
            {!reversibleLoading && !reversibleError && stillClaimable.length === 0 && (
              <div className={styles.empty}>
                Nothing Is Still Inside Its Ten Minute Window. Ask The Player To Request A Cash Out.
              </div>
            )}
            {stillClaimable.length > 0 && (
              <div className={styles.claimList}>
                {stillClaimable.map((row) => {
                  // The countdown is the DATABASE's deadline, re-read against
                  // the local tick only so the number moves. The decision is
                  // never the phone's: fn_agent_wallet_claim_back re-checks
                  // reversible_until and refuses a late claim outright.
                  const left = Math.max(
                    0,
                    Math.ceil((new Date(row.reversible_until).getTime() - nowTick) / 1000)
                  );
                  const mm = Math.floor(left / 60);
                  const ss = String(left % 60).padStart(2, '0');
                  return (
                    <div className={styles.claimRow} key={row.transaction_id}>
                      <div className={styles.rowInfo}>
                        <span className={styles.rowName}>{row.to_name}</span>
                        <span className={styles.rowSub}>
                          {row.destination === 'agent_wallet' ? 'Agent Wallet' : 'Player Wallet'}{' '}
                          &middot; {mm}:{ss} Left
                        </span>
                      </div>
                      <span className={styles.rowBalance}>{fmt(row.remaining)}</span>
                      <button
                        className={`${styles.reqBtn} ${styles.reqBtnGo}`}
                        disabled={claimingId !== null}
                        onClick={() => void claimBack(row)}
                      >
                        {claimingId === row.transaction_id ? 'Working...' : 'Claim Back'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className={styles.modalActions}>
              <button disabled={claimingId !== null} onClick={() => setClaimOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {clubUuid && <ClubBottomNav clubId={clubUuid} />}
    </div>
  );
}
