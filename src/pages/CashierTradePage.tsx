/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CASHIER — TRADE VIEW (Dan 2026-08-21, PokerBros reference build)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The cashier the way an agent actually works it:
 *
 *   Header    « CASHIER  [CLUB Choose] — entity switcher listing EVERY club wallet
 *             plus unions the viewer owns (never admin-only treasuries), with balances (Dan: "I also own
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
import { useCashoutScope } from '../hooks/useCashoutScope';
import {
  readClubWeeklyStatements,
  formatWeeklyChips,
  CLUB_WEEKLY_STATEMENT_LIMIT,
  type ClubWeeklyStatement,
} from '../services/ClubWeeklyAccountingReader';
import { resolveClubUUID, isUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import { cashierReasonCode, recordCashierOperation } from '../services/CashierOperationsTelemetry';
import {
  cashierReceiptText,
  clearCashierChipRequestOperation,
  clearCashierTransferRecovery,
  copyCashierText,
  readCashierTransferRecovery,
  readCashierTransferRecoveryBySubmission,
  readCashierOnlineState,
  reserveCashierChipRequestOperation,
  writeCashierTransferRecovery,
  type CashierTransferRecovery,
} from '../services/CashierResilience';
import { masterBus } from '../core/MasterBus';
import { useToast } from '../components/common/Toast';
import WalletCashierModal from '../components/wallet/WalletCashierModal';
import { DEFAULT_CASHIER_WALLET, secondsLeftFromServer } from '../components/wallet/cashierModes';
import { canSeeClubBank, canHoldAgentWallet } from '../components/wallet/walletRows';
import { describeChipTransaction, walletRoute } from '../components/wallet/describeChipTransaction';
import styles from './CashierTradePage.module.css';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';
import {
  mapCashierRoster,
  rosterMatchRank,
  rosterRowMatches,
  type CashierRosterRpcRow,
  type DownlineRow,
} from '../lib/cashierRoster';
import { UnionService } from '../services/UnionService';
import { unionRouteRef } from '../utils/unionIdResolver';
import { rememberLastClub } from '../utils/clubQuickLink';
import { SpadeConsole } from '../components/console/SpadeConsole';
import { compactChips } from '../utils/format';
import { titleCase } from '../utils/titleCase';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Membership {
  clubUuid: string;
  clubCode: number | null;
  slug: string | null;
  name: string;
  logoUrl: string | null;
  role: string;
  chipBalance: number;
  entityType: 'club' | 'union';
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
 * thousand ids is a URL no proxy will carry. The v2 roster RPC joins the horse
 * flag server-side so the cashier paints from a single scoped response.
 */

interface TradeRecordRow {
  id: string;
  createdAt: string;
  type: string;
  amount: number;
  /** Relative to the viewer; managed means neither party is the viewer. */
  direction: 'in' | 'out' | 'managed';
  counterparty: string;
  /**
   * Dan 2026-09-02: a ledger line must say which wallet the chips left and
   * which they entered, whatever the role. "Agent Wallet To Player Wallet".
   * Null when the row is not a wallet move (a buy-in, rake, a payout).
   */
  route: string | null;
  /** The full sentence for the receipt: "KINGFISH Sent 500 From ... To ...". */
  narrative: string | null;
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

/**
 * One tournament ticket this viewer can act on (audit 2026-08-26). Tickets
 * were issued into a void: fn_redeem_tournament_ticket and
 * fn_cancel_tournament_ticket existed and NOTHING called them, so the
 * escrowed value left the issuer on Send Ticket and was unreachable forever.
 * The Tickets tab is that missing surface. `held` rows carry Redeem; rows the
 * viewer issued carry Cancel while still unredeemed.
 */
interface TicketRow {
  id: string;
  value: number;
  note: string | null;
  status: string;
  /** wallet_chips tickets are cashable; tournament_entry_only tickets are not. */
  redemptionMode: string;
  createdAt: string;
  holderId: string;
  issuedById: string;
  /** The counterparty: issuer for a held ticket, holder for an issued one. */
  otherName: string;
  held: boolean;
}

type InvoiceRow = ClubWeeklyStatement;

type TabKey = 'trade' | 'record' | 'leaderboard' | 'request' | 'tickets';

/* EXACT LEDGER FIGURES ON THE GLASS (Dan: never decimals on a forward-facing
   page). A whole balance prints whole, 12,500; a balance that really holds
   cents keeps them, 32,482.58, because a money desk never misstates a ledger.
   The painted head zones never print through fmt(); they print compactChips(). */
const fmt = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/**
 * Add batch values in chip cents, not binary floating point. `0.10 * 3` is
 * 0.30000000000000004 in JavaScript, which used to reject a send from a wallet
 * holding exactly 0.30 even though every individual RPC amount was valid.
 */
const batchAmount = (amountPerTarget: number, targetCount: number) =>
  (Math.round(amountPerTarget * 100) * targetCount) / 100;

// ─── Component ───────────────────────────────────────────────────────────────

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
  const [membershipsLoading, setMembershipsLoading] = useState(true);
  const [membershipsError, setMembershipsError] = useState<string | null>(null);
  const [membershipsReload, setMembershipsReload] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tab, setTab] = useState<TabKey>('trade');

  const [myRole, setMyRole] = useState<string>('player');
  const [roleResolved, setRoleResolved] = useState(false);
  const initialTabResolvedRef = useRef(false);
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
  const [rosterLoadingMore, setRosterLoadingMore] = useState(false);
  const [rosterWarning, setRosterWarning] = useState<string | null>(null);
  // isMounted is an UNMOUNT guard, not a request guard. loadClub fires from
  // three places at once - the effect, every balance bus event, and after each
  // transfer - so without a version the response for the club you just left
  // can land last and paint its balances under the club you are now looking
  // at. On a page that moves chips that is not a cosmetic race.
  const loadVersion = useRef(0);
  const pendingCountVersion = useRef(0);
  const heldTicketCountVersion = useRef(0);
  const reqSeqRef = useRef(0);
  const ticketSeqRef = useRef(0);
  const recordSeqRef = useRef(0);
  const invoiceSeqRef = useRef(0);

  const [search, setSearch] = useState('');
  const [groupByRole, setGroupByRole] = useState(false);
  const [sortKey, setSortKey] = useState<'balance' | 'name'>('balance');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(25);

  const [records, setRecords] = useState<TradeRecordRow[]>([]);
  const [recordQuery, setRecordQuery] = useState('');
  const [recordDirection, setRecordDirection] = useState<'all' | 'in' | 'out' | 'managed'>('all');
  const [recordsLimit, setRecordsLimit] = useState(50);
  const [recordsHasMore, setRecordsHasMore] = useState(false);
  const [recordsReload, setRecordsReload] = useState(0);
  const [receipt, setReceipt] = useState<TradeRecordRow | null>(null);
  const [isOnline, setIsOnline] = useState(readCashierOnlineState);
  const [lastVerifiedAt, setLastVerifiedAt] = useState<number | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const reconcilingRef = useRef(false);
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
  const weeklyReadScope = useCashoutScope(user?.id, JSON.stringify([clubParam, clubUuid]));
  const invoiceReadScopeRef = useRef<(() => boolean) | null>(null);
  // The Tickets tab (audit 2026-08-26). See TicketRow for why it exists.
  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [ticketsError, setTicketsError] = useState<string | null>(null);
  /** Which ticket row is mid-RPC. Redeeming or cancelling MOVES CHIPS. */
  const [ticketActingId, setTicketActingId] = useState<string | null>(null);
  const ticketActingRef = useRef(false);
  /** Unredeemed tickets in the viewer's hand. Drives the Tickets tab badge. */
  const [heldTicketCount, setHeldTicketCount] = useState(0);
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
  /**
   * THE COUNTDOWN IS THE SERVER'S, NOT THE PHONE'S (Dan 2026-08-25).
   *
   * `seconds_left` comes off fn_agent_wallet_reversible and was fetched and
   * never read - the countdown here (and the stillClaimable filter beneath it)
   * subtracted `Date.now()` from `reversible_until`, which is the browser wall
   * clock the comment above ReversibleSend promises it is not. A device ten
   * minutes fast showed "Nothing Is Still Inside Its Ten Minute Window" with
   * claimable sends sitting right there; ten minutes slow offered every expired
   * row and each tap collected a refusal from fn_agent_wallet_claim_back.
   *
   * The deadline is anchored ONCE, when the list lands, and only locally
   * measured elapsed time is subtracted from it. performance.now() is
   * monotonic, so a wrong clock, an NTP correction or a DST jump cannot move
   * it. The database still has the final word on every claim.
   */
  const [reversibleAnchor, setReversibleAnchor] = useState<number | null>(null);
  /** Ticks once a second so each countdown in that list re-renders. */
  const [nowTick, setNowTick] = useState(0);
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
  const [transferRecovery, setTransferRecovery] = useState<CashierTransferRecovery | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ processed: number; total: number } | null>(
    null
  );
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
  /** Suppresses the "new intent" reset while a persisted intent is restored. */
  const restoringTransferRecoveryRef = useRef(false);
  /** The exact local-storage scope owned by the retained batch nonce. */
  const transferRecoveryScopeRef = useRef<{
    userId: string;
    clubId: string;
    submissionId: string;
  } | null>(null);
  /** One idempotency key per claim intent, retained across an uncertain retry. */
  const claimOpIdsRef = useRef<Map<string, string>>(new Map());
  /** In-memory mirror of the durable journal entry for this request click. */
  const requestOpIdRef = useRef<string | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const entityButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
  const dialogWasOpenRef = useRef(false);
  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    setIsOnline(readCashierOnlineState());
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!isOnline) setActiveCashier(null);
  }, [isOnline]);

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
    if (!user?.id) {
      setMemberships([]);
      setMembershipsLoading(false);
      setMembershipsError(null);
      return;
    }
    let live = true;
    setMembershipsLoading(true);
    setMembershipsError(null);
    setMemberships([]);
    (async () => {
      try {
        const [membershipResult, ownedUnions] = await Promise.all([
          supabase
            .from('club_members')
            .select(
              'club_id, role, chip_balance, clubs:club_id (name, club_id, slug, logo_url, is_union, owner_id)'
            )
            .eq('user_id', user.id)
            .in('status', MEMBER_IN_CLUB),
          // Union ownership comes from the canonical unions table. An admin
          // membership in a legacy union house-club is not treasury ownership.
          // It is a required half of this directory: a failed ownership read
          // must render the existing retry state, never a successful-looking
          // list that silently omits the user's union treasury.
          UnionService.getOwnedUnions(user.id),
        ]);
        const { data, error } = membershipResult;
        if (error) throw error;
        if (!live) return;
        const clubRows: Membership[] = (data || [])
          .map((r) => {
            const c = (Array.isArray(r.clubs) ? r.clubs[0] : r.clubs) as {
              name?: string;
              club_id?: number;
              slug?: string;
              logo_url?: string;
              is_union?: boolean;
              owner_id?: string;
            } | null;
            return {
              clubUuid: r.club_id as string,
              clubCode: c?.club_id ?? null,
              slug: c?.slug || null,
              name: c?.name || 'Club',
              logoUrl: c?.logo_url || null,
              role: (r.role as string) || 'player',
              chipBalance: Number(r.chip_balance) || 0,
              entityType: c?.is_union === true ? ('union' as const) : ('club' as const),
              isOwnedUnion: c?.is_union === true && c.owner_id === user.id,
            };
          })
          // Never advertise a union treasury because the viewer merely has a
          // membership/admin role in its companion club.
          .filter((row) => row.entityType === 'club' || row.isOwnedUnion)
          .map(({ isOwnedUnion: _isOwnedUnion, ...row }) => row);
        const unionRows: Membership[] = ownedUnions.map((union) => ({
          clubUuid: union.id,
          clubCode: null,
          slug: union.slug || null,
          name: union.name,
          logoUrl: union.avatarUrl || null,
          role: 'owner',
          chipBalance: 0,
          entityType: 'union',
        }));
        const byId = new Map<string, Membership>();
        for (const row of [...clubRows, ...unionRows]) byId.set(row.clubUuid, row);
        const rows = Array.from(byId.values()).sort((a, b) => b.chipBalance - a.chipBalance);
        setMemberships(rows);
      } catch (error) {
        reportError(error, 'CashierTradePage.memberships');
        if (live) {
          setMemberships([]);
          setMembershipsError('Could not load your club cashiers.');
        }
      } finally {
        if (live) setMembershipsLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [user?.id, membershipsReload]);

  const currentClub = useMemo(
    () => memberships.find((m) => m.clubUuid === clubUuid) || null,
    [memberships, clubUuid]
  );

  const requireOnline = useCallback(() => {
    if (isOnline) return true;
    toast?.error?.('Cashier Is Offline. Reconnect Before Moving Chips');
    return false;
  }, [isOnline, toast]);

  // The club switcher is a real popup control: focus enters it, Escape returns
  // to the trigger, and a click elsewhere closes it. Previously it remained
  // open over every tab until the user selected another club.
  useEffect(() => {
    if (!pickerOpen) return;
    const frame = window.requestAnimationFrame(() => {
      const picker = pickerRef.current;
      (picker?.querySelector<HTMLElement>('[role="option"]') || picker)?.focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (pickerRef.current?.contains(target) || entityButtonRef.current?.contains(target)) return;
      setPickerOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setPickerOpen(false);
      entityButtonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [pickerOpen]);

  // ── Load my role/balance + downline for the selected club ─────────────────
  /**
   * A head-only count, so no rows cross the wire. Runs on every club load and
   * on every bus event that already reloads this page, and is superseded by
   * requests.length the moment the tab is actually opened.
   */
  const loadPendingCount = useCallback(async () => {
    if (!clubUuid) {
      setPendingCount(0);
      return false;
    }
    const requestedClub = clubUuid;
    const version = ++pendingCountVersion.current;
    let q = supabase
      .from('chip_requests')
      .select('id', { count: 'exact', head: true })
      .eq('club_id', clubUuid)
      .in('status', ['pending']);
    // Agent tier can only ANSWER requests addressed to them
    // (fn_respond_chip_request refuses the rest), so their badge counts those
    // plus their own. Counting the whole club advertised work the server
    // would refuse them. Staff still see the whole queue.
    if (user?.id && ['super_agent', 'agent', 'sub_agent'].includes(myRole)) {
      q = q.or(`approver_id.eq.${user.id},requester_id.eq.${user.id}`);
    }
    const { count, error } = await q;
    if (!isMounted.current || version !== pendingCountVersion.current || requestedClub !== clubUuid)
      return false;
    // A failed count must not claim zero. Leave the previous value alone.
    if (error) {
      reportError(error, 'CashierTradePage.pendingCount');
      return false;
    }
    setPendingCount(count ?? 0);
    return true;
  }, [clubUuid, myRole, user?.id]);

  /** Unredeemed tickets in this viewer's hand, for the Tickets tab badge. */
  const loadHeldTicketCount = useCallback(async () => {
    if (!clubUuid || !user?.id) {
      setHeldTicketCount(0);
      return false;
    }
    const requestedClub = clubUuid;
    const version = ++heldTicketCountVersion.current;
    const { count, error } = await supabase
      .from('tournament_tickets')
      .select('id', { count: 'exact', head: true })
      .eq('club_id', clubUuid)
      .eq('holder_id', user.id)
      .eq('status', 'issued');
    if (
      !isMounted.current ||
      version !== heldTicketCountVersion.current ||
      requestedClub !== clubUuid
    )
      return false;
    if (error) {
      reportError(error, 'CashierTradePage.heldTicketCount');
      return false;
    }
    setHeldTicketCount(count ?? 0);
    return true;
  }, [clubUuid, user?.id]);

  const loadClub = useCallback(async () => {
    // Bail-before-try left `loading` true forever, because the finally that
    // clears it is inside the try: a signed-out moment or an unresolvable club
    // gave a permanent "Loading members...". Clear it here instead.
    if (!user?.id || !clubUuid) {
      setLoading(false);
      return false;
    }
    const myVersion = ++loadVersion.current;
    const stale = () => loadVersion.current !== myVersion;
    setLoading(true);
    setLoadError(null);
    setRosterWarning(null);
    setRosterLoadingMore(false);
    let complete = true;
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
      if (floatRes.error) {
        complete = false;
        reportError(floatRes.error, 'CashierTradePage.agentWallet');
      }
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
      const dl: CashierRosterRpcRow[] = [];
      if (role !== 'player') {
        // Paint page one instead of holding the whole workspace hostage while
        // a large club downloads. The cursor is deterministic and avoids the
        // repeated OFFSET walk; later pages enrich the same authoritative list.
        const rosterPageSize = 500;
        let afterRoleRank: number | null = null;
        let afterUserId: string | null = null;
        let pageNumber = 0;
        for (;;) {
          const rosterPageStartedAt = Date.now();
          const { data: memberRows, error: dlErr } = await supabase.rpc(
            'fn_club_cashier_members_page_v3',
            {
              p_club_id: clubUuid,
              p_after_role_rank: afterRoleRank,
              p_after_user_id: afterUserId,
              p_limit: rosterPageSize,
            }
          );
          if (dlErr) {
            complete = false;
            recordCashierOperation({
              userId: user.id,
              clubId: clubUuid,
              event: 'roster_page_failed',
              operation: 'roster',
              durationMs: Date.now() - rosterPageStartedAt,
              pageNumber,
              itemCount: dl.length,
              reasonCode: cashierReasonCode(dlErr),
            });
            if (pageNumber === 0) throw dlErr;
            reportError(dlErr, 'CashierTradePage.rosterContinuation');
            if (isMounted.current && !stale()) {
              setRosterWarning(
                `Loaded ${dl.length.toLocaleString()} Members. The Rest Could Not Be Reached.`
              );
            }
            break;
          }
          if (stale()) return false;
          const page = (memberRows || []) as CashierRosterRpcRow[];
          dl.push(...page);
          recordCashierOperation({
            userId: user.id,
            clubId: clubUuid,
            event: 'roster_page_succeeded',
            operation: 'roster',
            durationMs: Date.now() - rosterPageStartedAt,
            pageNumber,
            itemCount: page.length,
          });
          pageNumber++;

          if (isMounted.current && !stale()) {
            if (!initialTabResolvedRef.current) {
              setTab(role === 'player' ? 'record' : 'trade');
              initialTabResolvedRef.current = true;
            }
            setMyRole(role);
            setRoleResolved(true);
            setMyBalance(bal);
            setAgentWallet(float);
            setDownline(mapCashierRoster(dl, user.id));
            setLoading(false);
            setRosterLoadingMore(page.length === rosterPageSize);
          }
          if (page.length < rosterPageSize) break;
          const cursor = page[page.length - 1];
          afterRoleRank = Number(cursor.role_rank);
          afterUserId = String(cursor.user_id);
        }
      }

      if (!isMounted.current || stale()) return false;
      if (!initialTabResolvedRef.current) {
        setTab(role === 'player' ? 'record' : 'trade');
        initialTabResolvedRef.current = true;
      }
      setMyRole(role);
      setRoleResolved(true);
      setMyBalance(bal);
      setAgentWallet(float);
      setDownline(mapCashierRoster(dl, user.id));
      setRosterLoadingMore(false);
      if (complete) setLastVerifiedAt(Date.now());
      return complete;
    } catch (e) {
      reportError(e, 'CashierTradePage.loadClub');
      // An empty list used to be the only symptom of a failed load, so the
      // owner of a 588-member club was told they had no downline.
      if (isMounted.current && !stale()) {
        setDownline([]);
        setRosterLoadingMore(false);
        setLoadError('Could not load this club. Check your connection and try again.');
      }
      return false;
    } finally {
      if (isMounted.current && !stale()) setLoading(false);
    }
  }, [user?.id, clubUuid]);

  // Refresh on any balance event
  useEffect(() => {
    // AUDIT 2026-08-21: BALANCE_UPDATED alone missed mints, distributions and
    // cashier changes, so the strip could sit stale after real money moved.
    const events = [
      'BALANCE_UPDATED',
      'CHIPS_ADDED',
      'CHIPS_DISTRIBUTED',
      'CASHIER_BALANCE_CHANGED',
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
        void loadHeldTicketCount();
      })
    );
    return () => unsubs.forEach((u) => u());
  }, [loadClub, clubUuid, loadPendingCount, loadHeldTicketCount]);

  // ── Trade record tab data ──────────────────────────────────────────────────
  // Cleared BEFORE every club load: the previous club's trades used to stay on
  // screen until the new query landed.
  //
  // This reset used to be a later effect than `loadClub()`. React runs passive
  // effects in source order, so the load took version N and this effect
  // immediately advanced `loadVersion` to N + 1. The successful response and
  // its finally block were both discarded as stale, leaving the first tab on
  // "Loading Members..." forever. Reset and start now form one ordered effect:
  // invalidate the old club, clear every club-scoped view, then give the new
  // request the next version.
  useEffect(() => {
    ++loadVersion.current;
    ++pendingCountVersion.current;
    ++heldTicketCountVersion.current;
    ++reqSeqRef.current;
    ++ticketSeqRef.current;
    ++recordSeqRef.current;
    ++invoiceSeqRef.current;
    setTab('trade');
    initialTabResolvedRef.current = false;
    setRoleResolved(false);
    setRecords([]);
    setRecordsError(null);
    // Chips are PER CLUB. These were left at the previous club's values for the
    // whole load, so club B's header sat above club A's totals with A's members
    // still in the list - on the screen that moves the chips.
    setMyBalance(0);
    setAgentWallet(null);
    setDownline([]);
    setRosterLoadingMore(false);
    setRosterWarning(null);
    setSelected(new Set());
    setVisibleCount(25);
    setAmountModal(null);
    setAmount('');
    setActiveCashier(null);
    setTransferFailures([]);
    setTransferRecovery(null);
    submissionIdRef.current = null;
    opIdsRef.current = new Map();
    transferRecoveryScopeRef.current = null;
    setBatchProgress(null);
    setReceipt(null);
    setLastVerifiedAt(null);
    // The claimable list belongs to the club it was read from. Leaving it up
    // would offer a claim against a send made in a DIFFERENT club, which the
    // server refuses - after the user has already tapped it.
    setReversible([]);
    setReversibleError(null);
    claimOpIdsRef.current = new Map();
    setClaimOpen(false);
    // Was NOT reset. The checkbox is disabled when mineCount is 0, so switching
    // to a club where you have no assigned players left the filter stuck ON
    // with the only control that clears it greyed out - reload was the way out.
    setMineOnly(false);
    setRecordQuery('');
    setRecordDirection('all');
    setRecordsLimit(50);
    setRecordsHasMore(false);
    setRequests([]);
    setRequestsError(null);
    setPendingCount(0);
    setTickets([]);
    setTicketsError(null);
    setHeldTicketCount(0);
    setInvoices([]);
    setInvoicesError(null);
    requestOpIdRef.current = null;
    void loadClub();
  }, [clubUuid, loadClub]);

  const loadRecords = useCallback(async () => {
    if (!user?.id || !clubUuid) return false;
    const seq = ++recordSeqRef.current;
    setRecordsLoading(true);
    setRecordsError(null);
    try {
      // One server-owned role matrix for every viewer. The previous direct
      // table query forced from/to = auth.uid() in the browser, overriding the
      // database contract and hiding the club book from owners/admins and the
      // recursive downline book from agents.
      const { data, error } = await supabase.rpc('fn_club_trade_ledger', {
        p_club_id: clubUuid,
        // Fetch one sentinel row so the UI only offers "Load Older Entries"
        // when another page really exists. Initial wire cost stays at 51 rows.
        p_limit: recordsLimit + 1,
        p_offset: 0,
      });
      if (!isMounted.current || seq !== recordSeqRef.current) return false;
      // A discarded error rendered as "No trades recorded yet", which is a
      // different statement from "we could not read them".
      if (error) throw error;
      const pageRows = (data || []).slice(0, recordsLimit) as Array<{
        id: string;
        created_at: string;
        transaction_type: string | null;
        amount: number | string | null;
        from_user_id: string | null;
        to_user_id: string | null;
        notes: string | null;
        metadata: Record<string, unknown> | null;
        from_name: string | null;
        to_name: string | null;
      }>;
      setRecordsHasMore((data || []).length > recordsLimit);
      setRecords(
        pageRows.map((r) => {
          const out = r.from_user_id === user.id;
          const incoming = r.to_user_id === user.id;
          const managed = !out && !incoming;
          const nameOf = new Map<string, string>();
          if (r.from_user_id && r.from_name) nameOf.set(r.from_user_id, r.from_name);
          if (r.to_user_id && r.to_name) nameOf.set(r.to_user_id, r.to_name);
          const otherName = out ? r.to_name : r.from_name;
          return {
            id: r.id,
            createdAt: r.created_at,
            type: (r.transaction_type as string) || 'transfer',
            amount: Number(r.amount) || 0,
            direction: managed ? ('managed' as const) : out ? ('out' as const) : ('in' as const),
            counterparty: managed
              ? `${r.from_name || 'A Member'} To ${r.to_name || 'A Member'}`
              : otherName || 'Club',
            route: walletRoute(r),
            narrative: describeChipTransaction(r, nameOf, user.id),
          };
        })
      );
      return true;
    } catch (e) {
      reportError(e, 'CashierTradePage.records');
      if (isMounted.current && seq === recordSeqRef.current) {
        setRecords([]);
        setRecordsError('Could not load your trade record.');
      }
      return false;
    } finally {
      if (isMounted.current && seq === recordSeqRef.current) setRecordsLoading(false);
    }
  }, [user?.id, clubUuid, recordsLimit]);

  useEffect(() => {
    if (tab === 'record') void loadRecords();
  }, [tab, loadRecords, recordsReload]);

  // ── Chip requests (Chip Request tab) ───────────────────────────────────────
  /** Open chip requests in this club. Drives the tab badge. */
  const [pendingCount, setPendingCount] = useState(0);

  const loadRequests = useCallback(async () => {
    if (!user?.id || !clubUuid) return false;
    const seq = ++reqSeqRef.current;
    let complete = true;
    setRequestsLoading(true);
    setRequestsError(null);
    try {
      let query = supabase
        .from('chip_requests')
        .select('id, requester_id, approver_id, amount, note, status, created_at')
        .eq('club_id', clubUuid)
        .in('status', ['pending']);
      const agentTier = ['super_agent', 'agent', 'sub_agent'].includes(myRole);
      if (agentTier) query = query.or(`requester_id.eq.${user.id},approver_id.eq.${user.id}`);
      const { data, error } = await query.order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      // NEVER OFFER AN APPROVE THE SERVER WILL REFUSE (audit 2026-08-26).
      // fn_respond_chip_request lets agent-tier roles answer only requests
      // ADDRESSED to them, but this list showed an agent every pending
      // request in the club with live Approve buttons - each tap a
      // guaranteed "this request is not addressed to you". Staff keep the
      // whole queue; agents see their own requests and their own inbox.
      const visible = (data || []).filter(
        (r) => !agentTier || r.requester_id === user.id || r.approver_id === user.id
      );
      const ids = [...new Set(visible.map((r) => r.requester_id as string))];
      const names = new Map<string, string>();
      if (ids.length > 0) {
        const { data: profs, error: profilesError } = await supabase
          .from('profiles')
          .select(`id, ${PLAYER_NAME_COLUMNS}`)
          .in('id', ids);
        if (profilesError) {
          complete = false;
          reportError(profilesError, 'CashierTradePage.requestProfiles');
        }
        for (const pr of profs || []) names.set(pr.id as string, playerDisplayName(pr as any));
      }
      if (!isMounted.current || seq !== reqSeqRef.current) return false;
      setPendingCount(visible.length);
      setRequests(
        visible.map((r) => ({
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
      return complete;
    } catch (e) {
      reportError(e, 'CashierTradePage.loadRequests');
      // Silent before: a pending request the user has to answer was invisible
      // behind "No Open Chip Requests."
      if (isMounted.current && seq === reqSeqRef.current)
        setRequestsError('Could Not Load Chip Requests.');
      return false;
    } finally {
      if (isMounted.current && seq === reqSeqRef.current) setRequestsLoading(false);
    }
  }, [user?.id, clubUuid, myRole]);

  useEffect(() => {
    if (tab === 'request') loadRequests();
  }, [tab, loadRequests]);

  // ── Tickets tab data (audit 2026-08-26) ────────────────────────────────────
  const loadTickets = useCallback(async () => {
    if (!user?.id || !clubUuid) return false;
    const seq = ++ticketSeqRef.current;
    let complete = true;
    setTicketsLoading(true);
    setTicketsError(null);
    try {
      // RLS already scopes reads; this narrows to the rows the viewer can ACT
      // on - tickets in their hand and tickets they issued.
      const { data, error } = await supabase
        .from('tournament_tickets')
        .select('id, holder_id, issued_by, value, note, status, redemption_mode, created_at')
        .eq('club_id', clubUuid)
        .or(`holder_id.eq.${user.id},issued_by.eq.${user.id}`)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      const ids = new Set<string>();
      for (const t of data || []) {
        if (t.holder_id) ids.add(t.holder_id as string);
        if (t.issued_by) ids.add(t.issued_by as string);
      }
      const names = new Map<string, string>();
      if (ids.size > 0) {
        const { data: profs, error: profilesError } = await supabase
          .from('profiles')
          .select(`id, ${PLAYER_NAME_COLUMNS}`)
          .in('id', Array.from(ids));
        if (profilesError) {
          complete = false;
          reportError(profilesError, 'CashierTradePage.ticketProfiles');
        }
        for (const pr of profs || []) names.set(pr.id as string, playerDisplayName(pr as any));
      }
      if (!isMounted.current || seq !== ticketSeqRef.current) return false;
      setTickets(
        (data || []).map((t) => {
          const held = t.holder_id === user.id;
          return {
            id: t.id as string,
            value: Number(t.value) || 0,
            note: (t.note as string) || null,
            status: (t.status as string) || 'issued',
            redemptionMode: (t.redemption_mode as string) || 'wallet_chips',
            createdAt: t.created_at as string,
            holderId: t.holder_id as string,
            issuedById: t.issued_by as string,
            held,
            otherName:
              names.get(held ? (t.issued_by as string) : (t.holder_id as string)) || 'Member',
          };
        })
      );
      // The badge rides on the same read the tab just made.
      setHeldTicketCount(
        (data || []).filter((t) => t.holder_id === user.id && t.status === 'issued').length
      );
      return complete;
    } catch (e) {
      reportError(e, 'CashierTradePage.loadTickets');
      // "No Tickets" is a different statement from "we could not read them".
      if (isMounted.current && seq === ticketSeqRef.current)
        setTicketsError('Could Not Load Your Tickets.');
      return false;
    } finally {
      if (isMounted.current && seq === ticketSeqRef.current) setTicketsLoading(false);
    }
  }, [user?.id, clubUuid]);

  useEffect(() => {
    if (tab === 'tickets') void loadTickets();
  }, [tab, loadTickets]);

  /**
   * Redeem (holder) or cancel (issuer) one ticket. Both RPCs MOVE CHIPS -
   * redeem credits the holder's playing balance, cancel refunds the escrow to
   * the issuer - so this carries the same double-tap guard as every other
   * money action on this page. The server holds every rule either way:
   * fn_redeem refuses a ticket that is not yours or not issued, fn_cancel
   * refuses a non-issuer and (since the 2026-08-26 migration) refuses to
   * burn an escrow whose refund has nowhere to land.
   */
  const actOnTicket = async (row: TicketRow, action: 'redeem' | 'cancel') => {
    // Entry-only tickets remain noncash instruments for their full lifetime.
    // Keep this guard behind the hidden buttons as defense in depth against a
    // stale render or a future caller invoking this handler directly.
    if (row.redemptionMode !== 'wallet_chips') {
      toast?.error?.('Tournament Entry Tickets Can Only Be Used When Registering For An Event.');
      return;
    }
    if (!requireOnline()) return;
    if (ticketActingRef.current) return;
    ticketActingRef.current = true;
    setTicketActingId(row.id);
    try {
      const { data, error } = await supabase.rpc(
        action === 'redeem' ? 'fn_redeem_tournament_ticket' : 'fn_cancel_tournament_ticket',
        { p_ticket_id: row.id }
      );
      if (error) throw error;
      const res = data as { success?: boolean; error?: string } | null;
      if (!res?.success) throw new Error(res?.error || 'The Ticket Could Not Be Updated');
      toast?.success?.(
        action === 'redeem'
          ? `Redeemed A Ticket Worth ${fmt(row.value)} Chips`
          : `Cancelled The Ticket. ${fmt(row.value)} Chips Are Back In Your Balance`
      );
      masterBus.emit('BALANCE_UPDATED', { source: 'tournament_ticket', userId: user?.id || '' });
      void loadTickets();
    } catch (e) {
      reportError(e, 'CashierTradePage.actOnTicket');
      toast?.error?.((e as Error).message || 'The Ticket Could Not Be Updated');
    } finally {
      ticketActingRef.current = false;
      if (isMounted.current) setTicketActingId(null);
    }
  };

  useEffect(() => {
    void loadPendingCount();
  }, [loadPendingCount]);

  useEffect(() => {
    void loadHeldTicketCount();
  }, [loadHeldTicketCount]);

  const respondToRequest = async (id: string, action: 'approve' | 'decline' | 'cancel') => {
    if (!requireOnline()) return;
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
    if (!requireOnline()) return;
    if (!user?.id || !clubUuid) {
      toast?.error?.('Choose A Club Cashier');
      return;
    }
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
      const canonicalNote = askNote.trim() || null;
      const recovery = await reserveCashierChipRequestOperation(
        { userId: user.id, clubId: clubUuid, amount: v, note: canonicalNote },
        newOpId
      );
      if (!recovery) {
        toast?.error?.('Cashier Safety Storage Is Unavailable');
        return;
      }
      requestOpIdRef.current = recovery.operationId;
      const { data, error } = await supabase.rpc('fn_request_chips', {
        p_club_id: clubUuid,
        p_amount: v,
        p_note: canonicalNote,
        p_op_id: requestOpIdRef.current,
      });
      if (error) throw error;
      const res = data as { success?: boolean; error?: string } | null;
      if (!res || typeof res.success !== 'boolean') {
        throw new Error('Request Outcome Needs Verification');
      }
      if (!res.success) {
        clearCashierChipRequestOperation(recovery);
        requestOpIdRef.current = null;
        throw new Error(res.error || 'Refused');
      }
      clearCashierChipRequestOperation(recovery);
      toast?.success?.('Chip Request Sent');
      setAskOpen(false);
      setAskAmount('');
      setAskNote('');
      requestOpIdRef.current = null;
      loadRequests();
    } catch (e) {
      reportError(e, 'CashierTradePage.askForChips');
      toast?.error?.((e as Error).message || 'Could Not Send That Request');
    } finally {
      askingRef.current = false;
      if (isMounted.current) setAsking(false);
    }
  };

  useEffect(() => {
    requestOpIdRef.current = null;
  }, [askAmount, askNote, clubUuid]);

  // ── Settlement invoices: club weekly statements only ───────────────────────
  const loadInvoices = useCallback(async () => {
    if (!clubUuid || !user?.id || isHydrating) return false;
    const seq = ++invoiceSeqRef.current;
    const readCurrent = weeklyReadScope;
    invoiceReadScopeRef.current = readCurrent;
    setInvoices([]);
    setInvoicesLoading(true);
    setInvoicesError(null);
    try {
      const { rows } = await readClubWeeklyStatements({
        clubId: clubUuid,
        userId: user.id,
        limit: CLUB_WEEKLY_STATEMENT_LIMIT,
        isCurrent: readCurrent,
      });
      if (!isMounted.current || seq !== invoiceSeqRef.current) return false;
      if (!readCurrent()) throw new Error('Weekly Statement Account Or Club Changed');
      setInvoices(rows);
      return true;
    } catch (error) {
      reportError(error, 'CashierTradePage.loadInvoices');
      if (isMounted.current && seq === invoiceSeqRef.current) {
        setInvoicesError('Weekly Statements Are Unavailable.');
        setInvoices([]);
      }
      return false;
    } finally {
      if (isMounted.current && seq === invoiceSeqRef.current) setInvoicesLoading(false);
    }
  }, [clubUuid, user?.id, isHydrating, weeklyReadScope]);

  useEffect(() => {
    if (tab === 'leaderboard') void loadInvoices();
    // invoicesReload, so Retry has something to change. The button used to call
    // setTab('leaderboard') from inside the leaderboard tab, which is a no-op:
    // deps never changed, no refetch happened, and the error banner sat there
    // with a button that did nothing.
  }, [tab, loadInvoices, invoicesReload]);
  const visibleInvoices = invoiceReadScopeRef.current?.() === true ? invoices : [];
  const weeklyStatementsUnavailable =
    invoicesError ||
    (!weeklyReadScope() ? 'Weekly Statements Are Unavailable For This Account.' : null);

  // ── Derived list ───────────────────────────────────────────────────────────
  /* Everyone the viewer can SEND to: the roster minus the viewer's own row. */
  const recipients = useMemo(() => downline.filter((r) => !r.isSelf), [downline]);
  const mineCount = useMemo(() => downline.filter((r) => r.isMine).length, [downline]);
  /** What the reader's own assigned players are holding, for the strip. */
  const mineTotal = useMemo(
    () => downline.reduce((sum, r) => (r.isMine ? sum + (Number(r.chipBalance) || 0) : sum), 0),
    [downline]
  );

  const list = useMemo(() => {
    let rows = downline.filter((r) => rosterRowMatches(r, search));
    // "the players assigned to me" - the question an agent actually asks, and
    // one an owner could not ask at all before, because an owner sees the whole
    // club and nothing on the row said which of them were theirs.
    if (mineOnly) rows = rows.filter((r) => r.isMine);
    const bySort = (a: DownlineRow, b: DownlineRow) =>
      sortKey === 'balance' ? b.chipBalance - a.chipBalance : a.name.localeCompare(b.name);
    // A search is a question about a NAME. Answer it by match quality first
    // (rosterMatchRank), and only then by the chosen sort - a balance sort on
    // a search put the owner, at 0.00, twenty-first behind twenty horses
    // whose handles happened to contain the same four letters.
    const q = search.trim();
    rows = q
      ? [...rows].sort((a, b) => rosterMatchRank(b, q) - rosterMatchRank(a, q) || bySort(a, b))
      : [...rows].sort(bySort);
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

  const agencyBalance = useMemo(
    () => recipients.reduce((s, r) => s + r.chipBalance, 0),
    [recipients]
  );

  /** Fast client-side ledger controls over the bounded, newest-first page. */
  const filteredRecords = useMemo(() => {
    const q = recordQuery.trim().toLowerCase();
    return records.filter((row) => {
      if (recordDirection !== 'all' && row.direction !== recordDirection) return false;
      if (!q) return true;
      return (
        row.counterparty.toLowerCase().includes(q) ||
        txLabel(row.type).toLowerCase().includes(q) ||
        (row.route ?? '').toLowerCase().includes(q)
      );
    });
  }, [records, recordDirection, recordQuery]);

  const recordSummary = useMemo(() => {
    const incoming = records.reduce(
      (sum, row) => (row.direction === 'in' ? sum + row.amount : sum),
      0
    );
    const outgoing = records.reduce(
      (sum, row) => (row.direction === 'out' ? sum + row.amount : sum),
      0
    );
    const managed = records.reduce(
      (sum, row) => (row.direction === 'managed' ? sum + row.amount : sum),
      0
    );
    return { incoming, outgoing, managed, net: incoming - outgoing };
  }, [records]);

  const visibleTabs = useMemo<[TabKey, string][]>(() => {
    const all: [TabKey, string][] = [
      ['trade', 'Trade'],
      ['record', 'Trade Record'],
      ['leaderboard', 'Settlement Record'],
      ['request', 'Chip Requests'],
      ['tickets', 'Tickets'],
    ];
    return roleResolved && myRole === 'player'
      ? all.filter(([key]) => key === 'record' || key === 'request' || key === 'tickets')
      : all;
  }, [roleResolved, myRole]);

  /**
   * The active tab must always exist in the resolved role's tablist. This is a
   * generic invariant rather than a player/Trade special case, so a role change
   * or a future role-scoped tab cannot leave an invisible second-tab state.
   * The fallback is deliberately index zero: the default page is always the
   * first tab the current viewer can actually see.
   */
  useEffect(() => {
    if (!roleResolved || visibleTabs.length === 0) return;
    if (!visibleTabs.some(([key]) => key === tab)) setTab(visibleTabs[0][0]);
  }, [roleResolved, tab, visibleTabs]);

  useEffect(() => {
    setVisibleCount(25);
  }, [clubUuid, search, mineOnly, groupByRole, sortKey]);

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
    if (restoringTransferRecoveryRef.current) {
      restoringTransferRecoveryRef.current = false;
      return;
    }
    const recoveryScope = transferRecoveryScopeRef.current;
    submissionIdRef.current = null;
    opIdsRef.current = new Map();
    transferRecoveryScopeRef.current = null;
    if (recoveryScope) {
      clearCashierTransferRecovery(
        recoveryScope.userId,
        recoveryScope.clubId,
        recoveryScope.submissionId
      );
      // Another browser tab may have its own unresolved batch in the same
      // club. Retiring this tab's changed intent must reveal, not erase, it.
      setTransferRecovery(readCashierTransferRecovery(recoveryScope.userId, recoveryScope.clubId));
    } else {
      setTransferRecovery(null);
    }
  }, [amount, selected]);

  useEffect(() => {
    if (!user?.id || !clubUuid) return;
    const saved = readCashierTransferRecovery(user.id, clubUuid);
    if (!saved) return;
    // The club reset above replaces the selection Set. Suppress the resulting
    // intent-change pass so it cannot erase the recovery we just hydrated.
    restoringTransferRecoveryRef.current = true;
    submissionIdRef.current = saved.submissionId;
    opIdsRef.current = new Map(Object.entries(saved.opIds));
    transferRecoveryScopeRef.current = {
      userId: user.id,
      clubId: clubUuid,
      submissionId: saved.submissionId,
    };
    setTransferRecovery(saved);
  }, [user?.id, clubUuid]);

  /** Chips the selected players are holding right now. */
  const pickedHeld = useMemo(
    () => picked.reduce((sum, r) => sum + (Number(r.chipBalance) || 0), 0),
    [picked]
  );

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      // Listed, searchable, never a recipient: the server refuses a send to
      // yourself, so the row does not pretend to offer one.
      if (id === user?.id) return prev;
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ── Money actions ──────────────────────────────────────────────────────────
  const runTransfers = async (kind: 'send' | 'ticket') => {
    if (!user?.id || !clubUuid) return;
    if (!requireOnline()) return;
    if (loading || !roleResolved || loadError) {
      toast?.error?.('Cashier Is Still Synchronizing. Try Again In A Moment');
      return;
    }
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
    const total = batchAmount(value, targets.length);
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
    transferRecoveryScopeRef.current = { userId: user.id, clubId: clubUuid, submissionId };
    /** The op_id for one target, minted once and reused by every retry. */
    const opIdFor = (userId: string) => {
      const held = opIdsRef.current.get(userId);
      if (held) return held;
      const fresh = newOpId();
      opIdsRef.current.set(userId, fresh);
      return fresh;
    };
    // Persist BEFORE the first round trip. A refresh after the server commits
    // but before the response reaches this tab is the exact uncertain outcome
    // idempotency exists to make safe. Mint every send key up front so the
    // reloaded page can replay the identical intent even if this component
    // never reaches its finally block.
    if (kind === 'send') targets.forEach((target) => opIdFor(target.userId));
    const recoveryCreatedAt = transferRecovery?.createdAt ?? Date.now();
    const uncertainRecovery: CashierTransferRecovery = {
      version: 1,
      userId: user.id,
      clubId: clubUuid,
      kind,
      amount: value,
      targetIds: targets.map((target) => target.userId),
      failures: targets.map((target) => ({
        userId: target.userId,
        name: target.name,
        message: 'Outcome Not Yet Confirmed',
      })),
      submissionId,
      opIds: Object.fromEntries(opIdsRef.current),
      createdAt: recoveryCreatedAt,
    };
    if (!writeCashierTransferRecovery(uncertainRecovery)) {
      // Fail closed. If the server commits and the response is lost, only this
      // preflight journal lets a reload replay the SAME operation ids instead
      // of minting a second money movement. Continuing without it turns a
      // storage quota/private-mode failure into a double-send risk.
      reportError(
        new Error('The transfer recovery journal could not be persisted'),
        'CashierTradePage.Transfer_recovery_write_failed'
      );
      toast?.error?.('Cashier Safety Storage Is Unavailable. Free Browser Storage And Try Again');
      return;
    }
    // No await occurs before this point, so the journal and the in-memory lock
    // become visible atomically to a second click in the browser event loop.
    busyRef.current = true;
    setBusy(true);
    setBatchProgress({ processed: 0, total: targets.length });
    let ok = 0;
    const failed: Array<{ userId: string; name: string; message: string }> = [];
    const batchStartedAt = Date.now();
    let batchFailureReason: string | undefined;
    try {
      // The server processes one bounded chunk in one round trip. Every item
      // still owns a retry key, and the response names every recipient, so a
      // partial refusal remains retryable and auditable without six browser
      // lanes fighting for the same club wallet lock.
      const batchSize = 25;
      for (let offset = 0; offset < targets.length; offset += batchSize) {
        const chunk = targets.slice(offset, offset + batchSize);
        try {
          const items = chunk.map((target) => ({
            user_id: target.userId,
            amount: value,
            ...(kind === 'send'
              ? {
                  destination: canHoldAgentWallet(target.role) ? 'agent_wallet' : 'player_wallet',
                  reason: `Cashier Send Out To ${target.name}`,
                  op_id: opIdFor(target.userId),
                }
              : {
                  note: `Cashier ticket for ${target.name}`,
                  idempotency_key: `ticket:${clubUuid}:${submissionId}:${target.userId}:${value}`,
                }),
          }));
          const { data, error } = await supabase.rpc('fn_cashier_batch_transfer', {
            p_club_id: clubUuid,
            p_kind: kind,
            p_items: items,
            p_batch_id: submissionId,
          });
          if (error) throw error;
          const envelope = data as {
            success?: boolean;
            error?: string;
            results?: Array<{ user_id?: string; success?: boolean; error?: string }>;
          } | null;
          if (!envelope?.success || !Array.isArray(envelope.results)) {
            throw new Error(envelope?.error || 'Batch Was Refused');
          }

          const byUser = new Map(envelope.results.map((result) => [result.user_id, result]));
          for (const target of chunk) {
            const result = byUser.get(target.userId);
            if (result?.success) ok++;
            else {
              failed.push({
                userId: target.userId,
                name: target.name,
                message: result?.error || 'Transfer Failed',
              });
            }
          }
        } catch (e) {
          batchFailureReason ||= cashierReasonCode(e);
          for (const target of chunk) {
            failed.push({
              userId: target.userId,
              name: target.name,
              message: (e as Error)?.message || 'Transfer Failed',
            });
          }
        }
        if (isMounted.current) {
          setBatchProgress({
            processed: Math.min(offset + chunk.length, targets.length),
            total: targets.length,
          });
        }
      }
      if (failed.length > 0) {
        batchFailureReason ||= 'item_refused';
        // Diagnostics receive counts and a bounded reason code only. Player
        // UUIDs, names and raw database messages remain in the operator UI and
        // must not be copied into console/error reporting payloads.
        reportError(
          new Error(
            `${kind} batch: ${failed.length}/${targets.length} failed; reason=${batchFailureReason}`
          ),
          `CashierTradePage.${kind}Batch`
        );
      }
    } finally {
      recordCashierOperation({
        userId: user?.id,
        clubId: clubUuid,
        event: failed.length === 0 ? 'batch_succeeded' : ok > 0 ? 'batch_partial' : 'batch_failed',
        operation: kind,
        durationMs: Date.now() - batchStartedAt,
        itemCount: targets.length,
        successCount: ok,
        failureCount: failed.length,
        reasonCode: batchFailureReason,
      });
      // A throw between here and the end used to leave `busy` true forever,
      // and both Confirm and Cancel are disabled on it - the modal became a
      // trap that only a page reload could escape.
      busyRef.current = false;
      // Retire the nonces ONLY when every target went through. If any one of
      // them failed, keeping them is the whole point: the retry carries the
      // same op_id per target, so whichever targets already committed replay
      // instead of being charged a second time.
      if (ok === targets.length) {
        clearCashierTransferRecovery(user.id, clubUuid, submissionId);
        submissionIdRef.current = null;
        opIdsRef.current = new Map();
        setTransferRecovery(null);
      }
      const recovery: CashierTransferRecovery | null =
        failed.length > 0
          ? {
              ...uncertainRecovery,
              failures: failed,
            }
          : null;
      if (recovery) writeCashierTransferRecovery(recovery);
      if (isMounted.current) {
        setBusy(false);
        setBatchProgress(null);
        setTransferFailures(failed);
        if (recovery) setTransferRecovery(recovery);
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
      setReversibleAnchor(null);
      setReversibleError('Could Not Read Your Recent Sends.');
    } else {
      setReversible(((data || []) as ReversibleSend[]).map((r) => ({ ...r })));
      // Anchor the server's countdown against a monotonic local stopwatch.
      setReversibleAnchor(performance.now());
    }
    setReversibleLoading(false);
  }, [clubUuid]);

  const claimBack = async (row: ReversibleSend) => {
    if (!clubUuid || claimingId || busyRef.current) return;
    if (!requireOnline()) return;
    busyRef.current = true;
    setClaimingId(row.transaction_id);
    try {
      const heldOpId = claimOpIdsRef.current.get(row.transaction_id) || newOpId();
      claimOpIdsRef.current.set(row.transaction_id, heldOpId);
      const { data, error } = await supabase.rpc('fn_agent_wallet_claim_back', {
        p_club_id: clubUuid,
        p_transaction_id: row.transaction_id,
        // Ask the database for the maximum whole-cent remainder. Historical
        // rows can contain a sub-cent claimed_back value from the pre-Phase-1
        // RPC; echoing that fractional remainder would now be refused. Null is
        // the explicit "all safely claimable cents" contract.
        p_amount: null,
        p_reason: 'Claimed Back From The Trade Grid',
        // Retain the key when the response is uncertain. If the server committed
        // and the response was lost, retrying replays the receipt instead of
        // turning a successful claim into "already claimed" ambiguity.
        p_op_id: heldOpId,
      });
      if (error) throw error;
      const res = (Array.isArray(data) ? data[0] : data) as {
        success?: boolean;
        error?: string;
        replayed?: boolean;
        amount?: number;
      } | null;
      if (!res?.success) throw new Error(res?.error || 'Those Chips Could Not Be Claimed Back');
      const claimedAmount = Number(res.amount) || 0;
      toast?.success?.(
        res.replayed
          ? `That Claim Had Already Gone Through. ${fmt(claimedAmount)} Chips Are Back In Your Agent Wallet`
          : `Claimed ${fmt(claimedAmount)} Back From ${row.to_name}`
      );
      claimOpIdsRef.current.delete(row.transaction_id);
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
    const t = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [claimOpen, clubUuid, loadReversible]);

  /**
   * Seconds left on one row, from the DATABASE's figure minus locally measured
   * elapsed time. See the reversibleAnchor note above for why not the clock.
   */
  const secondsLeftFor = useCallback(
    (row: ReversibleSend): number =>
      reversibleAnchor === null
        ? 0
        : secondsLeftFromServer(row.seconds_left, performance.now() - reversibleAnchor),
    [reversibleAnchor]
  );

  /**
   * Rows whose window has run out WHILE THE MODAL IS OPEN. The server would
   * refuse them, so the button goes and the sentence explaining why takes its
   * place rather than leaving a control that fails on tap.
   */
  const stillClaimable = useMemo(() => {
    // Read the tick explicitly: its value is irrelevant, but each new value is
    // what asks this memo to re-evaluate the server-anchored countdown.
    void nowTick;
    return reversible.filter((r) => secondsLeftFor(r) > 0);
  }, [reversible, secondsLeftFor, nowTick]);

  const reconcileCashier = useCallback(async () => {
    if (!requireOnline() || reconcilingRef.current) return;
    reconcilingRef.current = true;
    setReconciling(true);
    try {
      const checks = await Promise.all([
        loadClub(),
        loadPendingCount(),
        loadHeldTicketCount(),
        tab === 'record' ? loadRecords() : Promise.resolve(true),
        tab === 'leaderboard' ? loadInvoices() : Promise.resolve(true),
        tab === 'request' ? loadRequests() : Promise.resolve(true),
        tab === 'tickets' ? loadTickets() : Promise.resolve(true),
      ]);
      if (checks.every((complete) => complete === true))
        toast?.success?.('Cashier Balances Reconciled');
      else toast?.error?.('Cashier Reconciliation Needs Attention');
    } catch (error) {
      reportError(error, 'CashierTradePage.reconcileCashier');
      toast?.error?.('Cashier Reconciliation Needs Attention');
    } finally {
      reconcilingRef.current = false;
      if (isMounted.current) setReconciling(false);
    }
  }, [
    loadClub,
    loadHeldTicketCount,
    loadInvoices,
    loadPendingCount,
    loadRecords,
    loadRequests,
    loadTickets,
    requireOnline,
    tab,
    toast,
  ]);

  const reopenTransferRecovery = () => {
    if (!user?.id || !clubUuid || !transferRecovery || transferRecovery.clubId !== clubUuid) return;
    const saved =
      readCashierTransferRecoveryBySubmission(user.id, clubUuid, transferRecovery.submissionId) ||
      transferRecovery;
    const authorized = new Set(downline.map((row) => row.userId));
    if (saved.targetIds.some((targetId) => !authorized.has(targetId))) {
      toast?.error?.('Recipients Changed. Review The Roster Before Starting A New Transfer');
      return;
    }
    restoringTransferRecoveryRef.current = true;
    submissionIdRef.current = saved.submissionId;
    opIdsRef.current = new Map(Object.entries(saved.opIds));
    transferRecoveryScopeRef.current = {
      userId: user.id,
      clubId: clubUuid,
      submissionId: saved.submissionId,
    };
    setSearch('');
    setMineOnly(false);
    setAmount(String(saved.amount));
    setSelected(new Set(saved.targetIds));
    setTransferRecovery(saved);
    // Persisted recovery deliberately omits names and raw server messages.
    // Restore names only from the freshly authorized roster for this club.
    const names = new Map(downline.map((row) => [row.userId, row.name]));
    setTransferFailures(
      saved.failures.map((failure) => ({
        ...failure,
        name: names.get(failure.userId) || 'Cashier Recipient',
      }))
    );
    setAmountModal(saved.kind);
  };

  const copyReceipt = async () => {
    if (!receipt) return;
    const copied = await copyCashierText(
      cashierReceiptText(receipt, currentClub?.name || 'Club Cashier')
    );
    if (copied) toast?.success?.('Receipt Copied');
    else toast?.error?.('Receipt Could Not Be Copied');
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
  const dialogOpen = Boolean(amountModal || askOpen || claimOpen || receipt);

  useEffect(() => {
    if (!dialogOpen) return;
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (dialog && !dialog.contains(document.activeElement)) dialog.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (amountModal && !busy) {
          setAmountModal(null);
          setTransferFailures([]);
        }
        if (askOpen && !asking) setAskOpen(false);
        if (claimOpen && !claimingId) setClaimOpen(false);
        if (receipt) setReceipt(null);
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (!focusable.length) {
        e.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        e.shiftKey &&
        (document.activeElement === first || document.activeElement === dialogRef.current)
      ) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [dialogOpen, amountModal, askOpen, claimOpen, receipt, busy, asking, claimingId]);

  useEffect(() => {
    if (dialogWasOpenRef.current && !dialogOpen) {
      window.requestAnimationFrame(() => dialogTriggerRef.current?.focus());
    }
    dialogWasOpenRef.current = dialogOpen;
  }, [dialogOpen]);

  const cashierNeedsAttention = Boolean(
    !isOnline || loadError || clubResolveFailed || agentWallet === null || transferRecovery
  );
  const cashierSyncMessage = !isOnline
    ? 'Cashier offline; money actions are locked'
    : reconciling
      ? 'Reconciling balances and cashier authority'
      : loading || isHydrating
        ? 'Synchronizing cashier balances'
        : rosterLoadingMore
          ? `Cashier ready; loading the rest of the roster after ${downline.length.toLocaleString()} members`
          : clubResolveFailed
            ? 'Club could not be resolved'
            : loadError
              ? 'Cashier sync requires attention'
              : agentWallet === null
                ? 'Agent wallet could not be verified'
                : 'Balances synchronized';
  const lastVerifiedLabel = lastVerifiedAt
    ? new Date(lastVerifiedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : 'Not Yet Verified';
  const currentClubLabel = membershipsLoading
    ? 'Loading Club'
    : currentClub?.name || 'Club Cashier';

  // ── Render ────────────────────────────────────────────────────────────────
  const cashierAuthorityBlocked = busy || loading || !roleResolved || !!loadError;

  return (
    <div className={styles.page} data-cashier-surface="trade">
      <SpadeConsole
        eyebrow="Secure Cashier"
        title="Cashier"
        pill={isOnline ? 'Live Ledger' : 'Locked'}
        pillInk={isOnline ? 'green' : 'red'}
        foot="foot"
        className={styles.console}
      >
        <div className={styles.glass}>
          <section className={styles.hero} aria-labelledby="cashier-title">
            <div className={styles.header}>
              <button
                ref={entityButtonRef}
                className={styles.entityBtn}
                onClick={() => setPickerOpen((open) => !open)}
                aria-expanded={pickerOpen}
                aria-haspopup="listbox"
                aria-controls="cashier-club-picker"
                aria-label={`Open Another Club Cashier. Current Club: ${currentClubLabel}`}
              >
                {currentClub?.logoUrl ? (
                  <img src={currentClub.logoUrl} alt="" className={styles.entityLogo} />
                ) : null}
                <span className={styles.entityName}>{currentClubLabel}</span>
                <span className={`${styles.entityCaret} sc-label sc-ink--blue`} aria-hidden="true">
                  Choose
                </span>
              </button>
            </div>

            <div className={styles.heroContent}>
              <h1 className={`${styles.heroTitle} sc-ink--silver`} id="cashier-title">
                Every Chip.
                <br />
                Accounted For.
              </h1>
              <p className={`${styles.heroCopy} sc-copy`}>
                Move Chips Through The Correct Wallet, Answer Requests, Redeem Tickets, And Verify
                Every Ledger Entry From One Secure Desk.
              </p>
              <div
                className={`${styles.securityLine} ${cashierNeedsAttention && !loading && !isHydrating ? styles.securityDotWarning : ''}`}
                role="status"
              >
                {cashierSyncMessage}
              </div>
            </div>

            <div className={styles.heroMetrics} aria-label="Current Cashier Balances">
              <div className={styles.heroMetric}>
                <span className={styles.heroMetricLabel}>Club Chips</span>
                <strong className={styles.heroMetricValue}>
                  {loading || isHydrating ? '-' : fmt(myBalance)}
                </strong>
              </div>
              <div className={styles.heroMetric}>
                <span className={styles.heroMetricLabel}>Agent Wallet</span>
                <strong className={styles.heroMetricValue}>
                  {loading || isHydrating || agentWallet === null ? '-' : fmt(agentWallet)}
                </strong>
              </div>
              <div className={styles.heroMetric}>
                <span className={styles.heroMetricLabel}>Access</span>
                <strong className={styles.heroRole}>
                  {loading || isHydrating
                    ? 'Synchronizing'
                    : loadError || clubResolveFailed
                      ? 'Unavailable'
                      : titleCase(roleLabel(myRole as ClubRole))}
                </strong>
              </div>
            </div>
          </section>

          {/* Entity picker */}
          {pickerOpen && (
            <div
              ref={pickerRef}
              id="cashier-club-picker"
              className={styles.picker}
              role="region"
              tabIndex={-1}
              aria-label="Club Cashier Switcher"
              onKeyDown={(event) => {
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                const options = Array.from(
                  pickerRef.current?.querySelectorAll<HTMLElement>('[role="option"]') || []
                );
                if (!options.length) return;
                event.preventDefault();
                const activeIndex = Math.max(
                  0,
                  options.indexOf(document.activeElement as HTMLElement)
                );
                const nextIndex =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? options.length - 1
                      : event.key === 'ArrowDown'
                        ? (activeIndex + 1) % options.length
                        : (activeIndex - 1 + options.length) % options.length;
                options[nextIndex]?.focus();
              }}
            >
              <div className={styles.pickerLabel}>OPEN CASHIER FOR</div>
              {membershipsLoading && (
                <div className={styles.pickerStatus}>Loading Club Cashiers...</div>
              )}
              {!membershipsLoading && membershipsError && (
                <div className={styles.pickerStatus} role="alert">
                  {membershipsError}{' '}
                  <button
                    type="button"
                    className={styles.retryBtn}
                    onClick={() => setMembershipsReload((value) => value + 1)}
                  >
                    Retry
                  </button>
                </div>
              )}
              {!membershipsLoading && !membershipsError && (
                <div role="listbox" aria-label="Club Cashiers">
                  {memberships.map((m) => (
                    <button
                      key={m.clubUuid}
                      className={`${styles.pickerRow} ${m.clubUuid === clubUuid ? styles.pickerRowActive : ''}`}
                      role="option"
                      aria-selected={m.clubUuid === clubUuid}
                      onClick={() => {
                        setPickerOpen(false);
                        rememberLastClub(m.clubUuid);
                        if (m.entityType === 'union') {
                          navigate(
                            `/unions/${m.slug || unionRouteRef(m.clubUuid)}/operations?tab=wallet`
                          );
                        } else if (m.clubUuid !== clubUuid) {
                          navigate(`/clubs/${m.clubCode ?? m.clubUuid}/cashier`);
                        }
                      }}
                    >
                      {m.logoUrl ? (
                        <img src={m.logoUrl} alt="" className={styles.entityLogo} />
                      ) : null}
                      <span className={styles.pickerName}>{m.name}</span>
                      <span className={styles.pickerBalance}>
                        {m.entityType === 'union' ? 'Union Wallets' : `${fmt(m.chipBalance)} Chips`}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Tabs */}
          <nav
            className={styles.tabs}
            role="tablist"
            aria-label="Cashier Actions"
            aria-busy={!roleResolved}
            onKeyDown={(event) => {
              if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')
              );
              const focusedIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const stateIndex = Math.max(
                0,
                visibleTabs.findIndex(([key]) => key === tab)
              );
              const index = focusedIndex >= 0 ? focusedIndex : stateIndex;
              const nextIndex =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? buttons.length - 1
                    : event.key === 'ArrowRight'
                      ? (index + 1) % buttons.length
                      : (index - 1 + buttons.length) % buttons.length;
              const next = visibleTabs[nextIndex]?.[0];
              if (!next) return;
              setTab(next);
              buttons[nextIndex]?.focus();
            }}
          >
            {visibleTabs.map(([key, label]) => (
              <button
                key={key}
                id={`cashier-tab-${key}`}
                role="tab"
                className={`${styles.tab} ${tab === key ? styles.tabActive : ''}`}
                aria-selected={tab === key}
                aria-controls={`cashier-panel-${key}`}
                tabIndex={tab === key ? 0 : -1}
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
                {/* A ticket in hand is chips waiting to be redeemed. Same pull
                  as the request badge: the tab must advertise the work. */}
                {key === 'tickets' && heldTicketCount > 0 ? (
                  <span className={styles.tabBadge}>{heldTicketCount.toLocaleString()}</span>
                ) : null}
              </button>
            ))}
          </nav>

          <section
            className={`${styles.recoveryConsole} ${cashierNeedsAttention ? styles.recoveryConsoleAttention : ''}`}
            aria-labelledby="cashier-recovery-title"
            data-cashier-recovery="true"
          >
            <div className={styles.recoveryHeading}>
              <div>
                <span className={styles.sectionEyebrow}>Operations Integrity</span>
                <h2 className={styles.recoveryTitle} id="cashier-recovery-title">
                  Reconciliation Console
                </h2>
              </div>
              <button
                type="button"
                className={styles.reconcileBtn}
                onClick={() => void reconcileCashier()}
                disabled={!isOnline || reconciling || loading || isHydrating || !clubUuid}
              >
                {reconciling ? 'Reconciling...' : 'Reconcile Now'}
              </button>
            </div>
            <div className={styles.recoveryGrid}>
              <div className={styles.recoveryMetric}>
                <span>Connection</span>
                <strong className={isOnline ? styles.integrityGood : styles.integrityBad}>
                  {isOnline ? 'Online' : 'Offline'}
                </strong>
              </div>
              <div className={styles.recoveryMetric}>
                <span>Balances Verified</span>
                <strong>{lastVerifiedLabel}</strong>
              </div>
              <div className={styles.recoveryMetric}>
                <span>Action Queue</span>
                <strong>{(pendingCount + heldTicketCount).toLocaleString()} Waiting</strong>
              </div>
            </div>
            {transferRecovery && transferRecovery.clubId === clubUuid && (
              <div className={styles.recoveryAlert} role="alert">
                <div>
                  <strong>Transfer Recovery Required</strong>
                  <span>
                    {transferRecovery.failures.length.toLocaleString()} Of{' '}
                    {transferRecovery.targetIds.length.toLocaleString()} Recipients Need Attention.
                    The Original Retry Keys Are Preserved.
                  </span>
                </div>
                <button
                  type="button"
                  onClick={reopenTransferRecovery}
                  disabled={!isOnline || busy || loading}
                >
                  Review And Retry
                </button>
              </div>
            )}
          </section>

          {tab === 'trade' && (
            <section
              id="cashier-panel-trade"
              className={styles.sectionShell}
              role="tabpanel"
              aria-labelledby="cashier-tab-trade"
              tabIndex={0}
            >
              <div className={styles.sectionHeading}>
                <div>
                  <span className={styles.sectionEyebrow}>Distribution Desk</span>
                  <h2 className={styles.sectionTitle} id="trade-workspace-title">
                    Select Recipients
                  </h2>
                </div>
                <span className={styles.sectionMeta}>
                  {recipients.length.toLocaleString()} Available · {selected.size.toLocaleString()}{' '}
                  Selected
                </span>
              </div>
              {/* Balance strip */}
              <div className={styles.strip}>
                <div className={styles.stripCell}>
                  <span className={styles.stripLabel}>Club Chips</span>
                  <span className={styles.stripValue}>{fmt(myBalance)}</span>
                </div>
                <div className={styles.stripCell}>
                  <span className={styles.stripLabel}>Downline Holdings</span>
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
                        disabled={!isOnline}
                        aria-label="Open The Club Bank Cashier"
                        title="Club Bank Cashier - Fund Agent Wallets, Ledger, Chip Mint"
                        onClick={() => setActiveCashier('club_bank')}
                      >
                        Fund
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
                  placeholder="Search Members"
                  aria-label={`Search ${downline.length} Member${downline.length === 1 ? '' : 's'}`}
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
                  Sort By {sortKey === 'balance' ? 'Chip Balance' : 'Name'}
                </button>
              </div>

              {/* Downline list */}
              <div className={styles.list}>
                {/* isHydrating too: before it was read, a hard refresh briefly ran
                the whole not-found / empty-club branch below while auth was
                still settling and `user` was null. */}
                {(loading || isHydrating) && <div className={styles.empty}>Loading Members...</div>}
                {!loading && rosterLoadingMore && (
                  <div className={styles.empty} role="status" aria-live="polite">
                    {downline.length.toLocaleString()} Members Ready. Loading The Rest...
                  </div>
                )}
                {!loading && rosterWarning && (
                  <div className={styles.empty} role="alert">
                    {rosterWarning}{' '}
                    <button
                      type="button"
                      className={styles.retryBtn}
                      onClick={() => void loadClub()}
                    >
                      Retry Full Roster
                    </button>
                  </div>
                )}
                {!loading && !isHydrating && loadError && (
                  <div className={styles.empty} role="alert">
                    {loadError}{' '}
                    <button
                      type="button"
                      className={styles.retryBtn}
                      onClick={() => void loadClub()}
                    >
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
                {!loading &&
                  !isHydrating &&
                  !loadError &&
                  !clubResolveFailed &&
                  list.length === 0 && (
                    <div className={styles.empty}>
                      {mineOnly
                        ? 'No Players Are Assigned To You In This Club.'
                        : search.trim()
                          ? 'No Members Match That Search.'
                          : 'No Members In Your Downline Yet.'}
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
                  list.slice(0, visibleCount).map((r) => (
                    <div
                      key={r.userId}
                      className={`${styles.row} ${r.isSelf ? styles.rowSelf : styles.selectableRow} ${selected.has(r.userId) ? styles.rowSelected : ''}`}
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
                      aria-disabled={r.isSelf || undefined}
                      title={
                        r.isSelf ? 'This Is You. Chips Cannot Be Sent To Yourself.' : undefined
                      }
                      tabIndex={0}
                    >
                      {r.avatarUrl ? (
                        <img src={r.avatarUrl} alt="" className={styles.avatar} />
                      ) : null}
                      <div className={styles.rowInfo}>
                        <span className={styles.rowName}>
                          {r.name}
                          {r.isSelf ? <span className={styles.rowYou}>You</span> : null}
                        </span>
                        <span className={styles.rowSub}>
                          {r.playerNumber ? `ID: ${r.playerNumber} · ` : ''}
                          {titleCase(roleLabel(r.role as ClubRole))}
                          {r.username ? ` · @${r.username}` : ''}
                        </span>
                      </div>
                      <span className={styles.rowBalance}>{fmt(r.chipBalance)}</span>
                      {r.isSelf ? null : (
                        <span
                          className={`${styles.checkbox} ${selected.has(r.userId) ? styles.checkboxOn : ''}`}
                          aria-hidden="true"
                        >
                          {selected.has(r.userId) ? 'Selected' : 'Select'}
                        </span>
                      )}
                    </div>
                  ))}
                {!loading && !loadError && visibleCount < list.length && (
                  <button
                    className={styles.classicLink}
                    style={{ marginBottom: '1rem' }}
                    onClick={() => setVisibleCount((c) => c + 25)}
                  >
                    Load More ({list.length - visibleCount} Hidden)
                  </button>
                )}
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
              <div className={styles.dock}>
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
                    disabled={!isOnline || busy || claimingId !== null}
                    onClick={(event) => {
                      dialogTriggerRef.current = event.currentTarget;
                      setClaimOpen(true);
                    }}
                  >
                    Claim Back
                  </button>
                  <button
                    className={styles.footerBtn}
                    disabled={!isOnline || selected.size === 0 || cashierAuthorityBlocked}
                    onClick={(event) => {
                      dialogTriggerRef.current = event.currentTarget;
                      setAmountModal('ticket');
                    }}
                  >
                    Send Ticket
                  </button>
                  <button
                    className={styles.footerBtn}
                    disabled={!isOnline || selected.size === 0 || cashierAuthorityBlocked}
                    onClick={(event) => {
                      dialogTriggerRef.current = event.currentTarget;
                      setAmountModal('send');
                    }}
                  >
                    Send Out
                  </button>
                </div>
              </div>
            </section>
          )}

          {tab === 'record' && (
            <section
              id="cashier-panel-record"
              className={styles.sectionShell}
              role="tabpanel"
              aria-labelledby="cashier-tab-record"
              aria-busy={recordsLoading}
              tabIndex={0}
            >
              <div className={styles.sectionHeading}>
                <div>
                  <span className={styles.sectionEyebrow}>Auditable History</span>
                  <h2 className={styles.sectionTitle} id="ledger-title">
                    Trade Ledger
                  </h2>
                </div>
                <span className={styles.sectionMeta}>Newest Entries First</span>
              </div>

              <div className={styles.ledgerSummary} aria-label="Loaded Ledger Totals">
                <div className={styles.summaryCell}>
                  <span className={styles.summaryLabel}>In</span>
                  <strong className={`${styles.summaryValue} ${styles.amtIn}`}>
                    +{fmt(recordSummary.incoming)}
                  </strong>
                </div>
                <div className={styles.summaryCell}>
                  <span className={styles.summaryLabel}>Out</span>
                  <strong className={`${styles.summaryValue} ${styles.amtOut}`}>
                    -{fmt(recordSummary.outgoing)}
                  </strong>
                </div>
                <div className={styles.summaryCell}>
                  <span className={styles.summaryLabel}>Managed</span>
                  <strong className={styles.summaryValue}>{fmt(recordSummary.managed)}</strong>
                </div>
                <div className={styles.summaryCell}>
                  <span className={styles.summaryLabel}>Net</span>
                  <strong
                    className={`${styles.summaryValue} ${recordSummary.net >= 0 ? styles.amtIn : styles.amtOut}`}
                  >
                    {recordSummary.net >= 0 ? '+' : '-'}
                    {fmt(Math.abs(recordSummary.net))}
                  </strong>
                </div>
              </div>

              <div className={styles.ledgerToolbar}>
                <input
                  className={styles.ledgerSearch}
                  type="search"
                  value={recordQuery}
                  onChange={(event) => setRecordQuery(event.target.value)}
                  placeholder="Search Person Or Entry Type"
                  aria-label="Search Trade Record"
                />
                <div className={styles.ledgerFilters} aria-label="Filter Trade Direction">
                  {(['all', 'in', 'out', 'managed'] as const).map((direction) => (
                    <button
                      key={direction}
                      type="button"
                      className={`${styles.ledgerFilter} ${recordDirection === direction ? styles.ledgerFilterActive : ''}`}
                      aria-pressed={recordDirection === direction}
                      onClick={() => setRecordDirection(direction)}
                    >
                      {direction === 'all'
                        ? 'All'
                        : direction === 'in'
                          ? 'Incoming'
                          : direction === 'out'
                            ? 'Outgoing'
                            : 'Managed'}
                    </button>
                  ))}
                </div>
              </div>

              <div className={styles.list}>
                {recordsLoading && <div className={styles.empty}>Loading Trades...</div>}
                {!recordsLoading && recordsError && (
                  <div className={styles.empty} role="alert">
                    {recordsError}{' '}
                    <button
                      type="button"
                      className={styles.retryBtn}
                      onClick={() => setRecordsReload((value) => value + 1)}
                    >
                      Retry
                    </button>
                  </div>
                )}
                {!recordsLoading && !recordsError && filteredRecords.length === 0 && (
                  <div className={styles.empty}>
                    {records.length === 0
                      ? 'No Trades Recorded Yet.'
                      : 'No Ledger Entries Match Those Filters.'}
                  </div>
                )}
                {!recordsError &&
                  filteredRecords.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className={`${styles.row} ${styles.receiptRow}`}
                      onClick={(event) => {
                        dialogTriggerRef.current = event.currentTarget;
                        setReceipt(r);
                      }}
                      aria-label={`Open Receipt For ${r.direction === 'managed' ? 'Managed Transfer' : r.direction === 'out' ? 'Payment To' : 'Payment From'} ${r.counterparty}, ${fmt(r.amount)} Chips`}
                    >
                      <div className={styles.rowInfo}>
                        <span className={styles.rowName}>
                          {r.direction === 'managed'
                            ? 'Transfer '
                            : r.direction === 'out'
                              ? 'To '
                              : 'From '}
                          {r.counterparty}
                        </span>
                        <span className={styles.rowSub}>
                          {txLabel(r.type)}
                          {r.route ? <> &middot; {r.route}</> : null} &middot;{' '}
                          {new Date(r.createdAt).toLocaleString([], {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                      <span
                        className={`${styles.rowBalance} ${r.direction === 'in' ? styles.amtIn : r.direction === 'out' ? styles.amtOut : ''}`}
                      >
                        {r.direction === 'in' ? '+' : r.direction === 'out' ? '-' : ''}
                        {fmt(r.amount)}
                      </span>
                      <span className={styles.receiptCue}>Receipt</span>
                    </button>
                  ))}
                {!recordsLoading && recordsHasMore && recordDirection === 'all' && !recordQuery && (
                  <button
                    type="button"
                    className={styles.loadMore}
                    onClick={() => setRecordsLimit((limit) => Math.min(limit + 50, 250))}
                    disabled={recordsLimit >= 250}
                  >
                    {recordsLimit >= 250
                      ? 'Showing The Latest 250 Entries'
                      : 'Load 50 Older Entries'}
                  </button>
                )}
              </div>
            </section>
          )}

          {tab === 'leaderboard' && (
            <section
              id="cashier-panel-leaderboard"
              className={styles.sectionShell}
              role="tabpanel"
              aria-labelledby="cashier-tab-leaderboard"
              aria-busy={invoicesLoading}
              tabIndex={0}
            >
              <div className={styles.sectionHeading}>
                <div>
                  <span className={styles.sectionEyebrow}>Weekly Close</span>
                  <h2 className={styles.sectionTitle} id="settlement-title">
                    Settlement Record
                  </h2>
                </div>
                <span className={styles.sectionMeta}>
                  Latest Up To {CLUB_WEEKLY_STATEMENT_LIMIT} Weekly Statements
                </span>
              </div>
              <div className={styles.list}>
                {invoicesLoading && (
                  <div className={styles.empty}>Loading Settlement Records...</div>
                )}
                {!invoicesLoading && weeklyStatementsUnavailable && (
                  <div className={styles.empty} role="alert">
                    {weeklyStatementsUnavailable}{' '}
                    <button
                      type="button"
                      className={styles.retryBtn}
                      onClick={() => setInvoicesReload((n) => n + 1)}
                    >
                      Retry
                    </button>
                  </div>
                )}
                {!invoicesLoading &&
                  !weeklyStatementsUnavailable &&
                  visibleInvoices.length === 0 && (
                    <div className={styles.empty}>
                      No Settlement Records Yet. They Appear Here After The First Weekly Close.
                    </div>
                  )}
                {!invoicesLoading &&
                  !weeklyStatementsUnavailable &&
                  visibleInvoices.map((iv) => (
                    <div key={iv.id} className={styles.row}>
                      <div className={styles.rowInfo}>
                        <span className={styles.rowName}>Club Weekly Accounting</span>
                        <span className={styles.rowSub}>
                          {new Date(iv.createdAt).toLocaleDateString([], {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          })}{' '}
                          &middot; Weekly Summary
                        </span>
                      </div>
                      <span className={styles.rowSub}>
                        Rake Funding {formatWeeklyChips(iv.rakeFunding)}
                        <br />
                        Paid By Club {formatWeeklyChips(iv.paidByClub)}
                      </span>
                      <span className={styles.rowBalance}>
                        Retained {formatWeeklyChips(iv.retainedByClub)}
                      </span>
                    </div>
                  ))}
              </div>
            </section>
          )}

          {tab === 'request' && (
            <section
              id="cashier-panel-request"
              className={styles.sectionShell}
              role="tabpanel"
              aria-labelledby="cashier-tab-request"
              aria-busy={requestsLoading}
              tabIndex={0}
            >
              <div className={styles.sectionHeading}>
                <div>
                  <span className={styles.sectionEyebrow}>Funding Queue</span>
                  <h2 className={styles.sectionTitle} id="requests-title">
                    Chip Requests
                  </h2>
                </div>
                <span className={styles.sectionMeta}>{pendingCount.toLocaleString()} Waiting</span>
              </div>
              <div className={styles.list}>
                <button
                  className={styles.classicLink}
                  disabled={!isOnline}
                  onClick={(event) => {
                    dialogTriggerRef.current = event.currentTarget;
                    setAskOpen(true);
                  }}
                >
                  Request Chips From Your Agent
                </button>
                {requestsLoading && <div className={styles.empty}>Loading Requests...</div>}
                {!requestsLoading && requestsError && (
                  <div className={styles.empty} role="alert">
                    {requestsError}{' '}
                    <button
                      type="button"
                      className={styles.retryBtn}
                      onClick={() => void loadRequests()}
                    >
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
                        disabled={!isOnline || respondingId !== null}
                        onClick={() => respondToRequest(r.id, 'cancel')}
                      >
                        {respondingId === r.id ? 'Working...' : 'Cancel'}
                      </button>
                    ) : (
                      <>
                        <button
                          className={styles.reqBtn}
                          disabled={!isOnline || respondingId !== null}
                          onClick={() => respondToRequest(r.id, 'decline')}
                        >
                          {respondingId === r.id ? 'Working...' : 'Decline'}
                        </button>
                        <button
                          className={`${styles.reqBtn} ${styles.reqBtnGo}`}
                          disabled={!isOnline || respondingId !== null}
                          onClick={() => respondToRequest(r.id, 'approve')}
                        >
                          {respondingId === r.id ? 'Working...' : 'Approve'}
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {tab === 'tickets' && (
            <section
              id="cashier-panel-tickets"
              className={styles.sectionShell}
              role="tabpanel"
              aria-labelledby="cashier-tab-tickets"
              aria-busy={ticketsLoading}
              tabIndex={0}
            >
              <div className={styles.sectionHeading}>
                <div>
                  <span className={styles.sectionEyebrow}>Tournament Value</span>
                  <h2 className={styles.sectionTitle} id="tickets-title">
                    Ticket Vault
                  </h2>
                </div>
                <span className={styles.sectionMeta}>{heldTicketCount.toLocaleString()} Ready</span>
              </div>
              <div className={styles.list}>
                {ticketsLoading && <div className={styles.empty}>Loading Tickets...</div>}
                {!ticketsLoading && ticketsError && (
                  <div className={styles.empty} role="alert">
                    {ticketsError}{' '}
                    <button
                      type="button"
                      className={styles.retryBtn}
                      onClick={() => void loadTickets()}
                    >
                      Retry
                    </button>
                  </div>
                )}
                {!ticketsLoading && !ticketsError && tickets.length === 0 && (
                  <div className={styles.empty}>
                    No Tickets Yet. Tickets Sent To You Appear Here, Ready To Use.
                  </div>
                )}
                {!ticketsLoading &&
                  !ticketsError &&
                  tickets.map((t) => (
                    <div key={t.id} className={styles.row}>
                      <div className={styles.rowInfo}>
                        <span className={styles.rowName}>
                          {t.redemptionMode === 'tournament_entry_only'
                            ? `Tournament Entry Ticket · ${t.held ? 'From' : 'To'} ${t.otherName}`
                            : t.held
                              ? `From ${t.otherName}`
                              : `To ${t.otherName}`}
                        </span>
                        <span className={styles.rowSub}>
                          {t.redemptionMode === 'tournament_entry_only' && (
                            <>Entry Only &middot; </>
                          )}
                          {txLabel(t.status)} &middot;{' '}
                          {new Date(t.createdAt).toLocaleString([], {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                          {t.note ? ` · ${t.note}` : ''}
                        </span>
                      </div>
                      <span className={styles.rowBalance}>{fmt(t.value)}</span>
                      {/* Only wallet-chip tickets expose cash actions. Entry-only
                    tickets are consumed by tournament registration and can
                    never be redeemed or cancelled into a wallet. */}
                      {t.redemptionMode === 'wallet_chips' && t.status === 'issued' && t.held && (
                        <button
                          className={`${styles.reqBtn} ${styles.reqBtnGo}`}
                          disabled={!isOnline || ticketActingId !== null}
                          onClick={() => void actOnTicket(t, 'redeem')}
                        >
                          {ticketActingId === t.id ? 'Working...' : 'Redeem'}
                        </button>
                      )}
                      {t.redemptionMode === 'wallet_chips' && t.status === 'issued' && !t.held && (
                        <button
                          className={styles.reqBtn}
                          disabled={!isOnline || ticketActingId !== null}
                          onClick={() => void actOnTicket(t, 'cancel')}
                        >
                          {ticketActingId === t.id ? 'Working...' : 'Cancel'}
                        </button>
                      )}
                    </div>
                  ))}
              </div>
            </section>
          )}
        </div>
      </SpadeConsole>

      {receipt && (
        <div className={styles.modalOverlay} onClick={() => setReceipt(null)}>
          <div
            ref={dialogRef}
            className={styles.consoleDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cashier-receipt-title"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <SpadeConsole
              eyebrow="Immutable Ledger Entry"
              title="Transaction Receipt"
              titleId="cashier-receipt-title"
              pill="Recorded"
              pillInk="green"
              foot="plates"
              plates={{
                secondary: { label: 'Close', onClick: () => setReceipt(null) },
                primary: { label: 'Copy Receipt', ink: 'blue', onClick: () => void copyReceipt() },
              }}
              className={styles.console}
            >
              <div className={styles.glass}>
                <div className={styles.receiptAmount}>
                  <span className="sc-label sc-ink--blue">
                    {receipt.direction === 'managed'
                      ? 'Managed Transfer'
                      : receipt.direction === 'in'
                        ? 'Incoming'
                        : 'Outgoing'}
                  </span>
                  <strong
                    className={
                      receipt.direction === 'in'
                        ? styles.amtIn
                        : receipt.direction === 'out'
                          ? styles.amtOut
                          : 'sc-ink--silver'
                    }
                  >
                    {receipt.direction === 'in' ? '+' : receipt.direction === 'out' ? '-' : ''}
                    {fmt(receipt.amount)}
                  </strong>
                  <small className="sc-label sc-ink--muted">Chips</small>
                </div>
                <dl className={styles.receiptFacts}>
                  <div>
                    <dt className="sc-label sc-ink--blue">Status</dt>
                    <dd className={styles.integrityGood}>Recorded In Ledger</dd>
                  </div>
                  <div>
                    <dt className="sc-label sc-ink--blue">
                      {receipt.direction === 'managed'
                        ? 'Transfer'
                        : receipt.direction === 'in'
                          ? 'From'
                          : 'To'}
                    </dt>
                    <dd className="sc-ink--silver">{receipt.counterparty}</dd>
                  </div>
                  <div>
                    <dt className="sc-label sc-ink--blue">Entry</dt>
                    <dd className="sc-ink--silver">{txLabel(receipt.type)}</dd>
                  </div>
                  {receipt.route ? (
                    <div>
                      <dt className="sc-label sc-ink--blue">Wallets</dt>
                      <dd className="sc-ink--silver">{receipt.route}</dd>
                    </div>
                  ) : null}
                  {receipt.narrative ? (
                    <div>
                      <dt className="sc-label sc-ink--blue">Summary</dt>
                      <dd className="sc-ink--silver">{receipt.narrative}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt className="sc-label sc-ink--blue">Recorded</dt>
                    <dd className="sc-ink--silver">
                      {new Date(receipt.createdAt).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </dd>
                  </div>
                  <div className={styles.receiptReference}>
                    <dt className="sc-label sc-ink--blue">Reference</dt>
                    <dd className="sc-ink--silver">{receipt.id}</dd>
                  </div>
                </dl>
              </div>
            </SpadeConsole>
          </div>
        </div>
      )}

      {/* Ask-for-chips modal */}
      {askOpen && (
        /* Guarded on `asking`, like the other two overlays. Escape already
           refused to close mid-request; a backdrop tap did not, so the request
           carried on invisibly and its toast arrived over a closed modal. */
        <div
          className={styles.modalOverlay}
          onClick={() => {
            if (asking) return;
            setAskOpen(false);
          }}
        >
          <div
            ref={dialogRef}
            className={styles.consoleDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cashier-ask-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <SpadeConsole
              eyebrow="Funding Request"
              title="Request Chips"
              titleId="cashier-ask-title"
              pill={asking ? 'Sending' : 'Ready'}
              pillInk={asking ? 'gold' : 'green'}
              foot="plates"
              className={styles.console}
              plates={{
                secondary: {
                  label: 'Cancel',
                  disabled: asking,
                  onClick: () => setAskOpen(false),
                },
                primary: {
                  label: asking ? 'Sending' : 'Send Request',
                  ink: 'blue',
                  disabled: !isOnline || asking,
                  onClick: askForChips,
                },
              }}
            >
              <div className={styles.glass}>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={askAmount}
                  step="1"
                  aria-label="Chips Requested"
                  onChange={(e) => setAskAmount(e.target.value)}
                  placeholder="How Many Chips?"
                  autoFocus
                />
                <input
                  type="text"
                  value={askNote}
                  aria-label="Note"
                  onChange={(e) => setAskNote(e.target.value)}
                  placeholder="Note (Optional)"
                  maxLength={120}
                />
                <div className={styles.modalHint}>
                  Goes To Your Agent, Or The Club Owner If You Have None.
                </div>
              </div>
            </SpadeConsole>
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
            ref={dialogRef}
            className={styles.consoleDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cashier-amount-title"
            aria-busy={busy}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <SpadeConsole
              eyebrow={`${compactChips(picked.length)} Player${picked.length === 1 ? '' : 's'}`}
              title={amountModal === 'send' ? 'Send Out' : 'Send Ticket'}
              titleId="cashier-amount-title"
              pill={busy ? 'Working' : 'Ready'}
              pillInk={busy ? 'gold' : 'green'}
              foot="plates"
              className={styles.console}
              plates={{
                secondary: {
                  label: 'Cancel',
                  disabled: busy,
                  onClick: () => {
                    setAmountModal(null);
                    setTransferFailures([]);
                  },
                },
                primary: {
                  label:
                    busy && batchProgress
                      ? `${batchProgress.processed}/${batchProgress.total}`
                      : 'Confirm',
                  ink: 'blue',
                  disabled: !isOnline || picked.length === 0 || cashierAuthorityBlocked,
                  onClick: () => runTransfers(amountModal),
                },
              }}
            >
              <div className={styles.glass}>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step="1"
                  aria-label="Amount Per Player"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    if (transferFailures.length) setTransferFailures([]);
                  }}
                  placeholder={
                    amountModal === 'ticket' ? 'Ticket Value Per Player' : 'Amount Per Player'
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
                    Tickets Are Paid Now And Held Until The Player Redeems Them. Cancel An
                    Unredeemed Ticket To Get The Chips Back.
                  </div>
                )}
                <div className={styles.modalHint}>
                  Total: {fmt(batchAmount(Number(amount) || 0, picked.length))} &middot;{' '}
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
                    You Can Claim These Chips Back For Ten Minutes. After That The Player Must
                    Request A Cash Out.
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
                {busy && batchProgress && (
                  <div className={styles.modalHint} role="status" aria-live="polite">
                    Processing {batchProgress.processed.toLocaleString()} Of{' '}
                    {batchProgress.total.toLocaleString()} Recipients
                  </div>
                )}
              </div>
            </SpadeConsole>
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
            ref={dialogRef}
            className={styles.consoleDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cashier-claim-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <SpadeConsole
              eyebrow="Ten Minute Reversal"
              title="Claim Back"
              titleId="cashier-claim-title"
              pill={claimingId ? 'Working' : 'Limited'}
              pillInk={claimingId ? 'gold' : 'red'}
              foot="foot"
              className={styles.console}
            >
              <div className={styles.glass}>
                <div className={styles.modalHint}>
                  You Can Take Back A Send For Ten Minutes. After That The Only Way Chips Leave A
                  Player Is Their Own Cash Out Request.
                </div>
                {reversibleLoading && (
                  <div className={styles.empty}>Reading Your Recent Sends...</div>
                )}
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
                    {
                      'Nothing Is Still Inside Its Ten Minute Window. Ask The Player To Request A Cash Out.'
                    }
                  </div>
                )}
                {stillClaimable.length > 0 && (
                  <div className={styles.claimList}>
                    {stillClaimable.map((row) => {
                      // The countdown is the DATABASE's own seconds_left, counted
                      // down by a monotonic stopwatch rather than by the phone's
                      // clock. The decision is never the phone's either:
                      // fn_agent_wallet_claim_back re-checks reversible_until and
                      // refuses a late claim outright.
                      const left = secondsLeftFor(row);
                      const mm = Math.floor(left / 60);
                      // padStart on a CLOCK, not on an amount - "9:05 Left", not
                      // "9:5". Chip figures on this page all go through fmt().
                      const ss = String(left % 60).padStart(2, '0');
                      return (
                        <div className={styles.claimRow} key={row.transaction_id}>
                          <div className={styles.rowInfo}>
                            <span className={styles.rowName}>{row.to_name}</span>
                            <span className={styles.rowSub}>
                              {row.destination === 'agent_wallet'
                                ? 'Agent Wallet'
                                : 'Player Wallet'}{' '}
                              &middot; {mm}:{ss} Left
                            </span>
                          </div>
                          <span className={styles.rowBalance}>{fmt(row.remaining)}</span>
                          <button
                            className={`${styles.reqBtn} ${styles.reqBtnGo}`}
                            disabled={!isOnline || claimingId !== null}
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
                  <button
                    type="button"
                    className={styles.closeBtn}
                    disabled={claimingId !== null}
                    onClick={() => setClaimOpen(false)}
                  >
                    Close
                  </button>
                </div>
              </div>
            </SpadeConsole>
          </div>
        </div>
      )}
    </div>
  );
}
