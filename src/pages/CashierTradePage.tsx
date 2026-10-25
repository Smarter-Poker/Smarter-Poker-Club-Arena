import {
  SEND_SOURCE_LABELS,
  SEND_DESTINATION_LABELS,
  recipientSendWallets,
  type SendSource,
  type SendDestination,
} from '../utils/cashierSendWallets';
import { useMasterBusChannel } from '../hooks/useMasterBusChannel';
import CashierConservationReport from '../components/wallet/CashierConservationReport';
import CashierPendingOperations from '../components/wallet/CashierPendingOperations';
import {
  reserveCashierWalletOperation,
  clearCashierWalletOperation,
} from '../services/CashierWalletRecovery';
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
 *   Tabs      Trade | Transaction History | Leaderboard Record | Chip Request
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

import { useRecentRecipients } from '../hooks/useRecentRecipients';
import CashoutRequestModal from '../components/wallet/CashoutRequestModal';
import AgentCashoutPanel from '../components/agent/AgentCashoutPanel';
import { useClubPendingCashouts } from '../hooks/useClubPendingCashouts';
import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react';
import { roleLabel, roleRank, type ClubRole } from '../types/clubRoles';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { useCashoutScope, useCashoutScopeKey } from '../hooks/useCashoutScope';
import {
  readClubWeeklyStatements,
  formatWeeklyChipsForDisplay,
  CLUB_WEEKLY_STATEMENT_LIMIT,
  type ClubWeeklyStatement,
} from '../services/ClubWeeklyAccountingReader';
import { resolveClubUUID, isUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import { cashierReasonCode, recordCashierOperation } from '../services/CashierOperationsTelemetry';
import {
  cashierReceiptText,
  clearCashierChipRequestOperation,
  copyCashierText,
  readCashierTransferRecovery,
  readCashierTransferRecoveryBySubmission,
  readCashierOnlineState,
  reserveCashierChipRequestOperation,
  reserveDurableCashierTransfer,
  restoreDurableCashierTransfers,
  updateDurableCashierTransfer,
  clearDurableCashierTransfer,
  type CashierTransferRecovery,
} from '../services/CashierResilience';
import { masterBus } from '../core/MasterBus';
import { useToast } from '../components/common/Toast';
import WalletCashierModal from '../components/wallet/WalletCashierModal';
import { CashierFrameBalance } from '../components/wallet/CashierFrameBalance';
import DiamondWalletTransfer from '../components/wallet/DiamondWalletTransfer';
import { DEFAULT_CASHIER_WALLET, secondsLeftFromServer } from '../components/wallet/cashierModes';
import {
  canSeeClubBank,
  canHoldAgentWallet,
  holdsPlayerWallet,
} from '../components/wallet/walletRows';
import {
  cashoutRowTitle,
  describeChipTransaction,
  ledgerDirection,
  presentChipTransaction,
  thirdPartySender,
  walletRoute,
} from '../components/wallet/describeChipTransaction';
import { downloadCsv, toCsv } from '../utils/downloadCsv';
import { cashoutStatusLabel, waitingFor } from '../utils/cashoutStatus';
import styles from './CashierTradePage.module.css';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';
import {
  mapCashierRoster,
  sortCashierRosterMatches,
  type CashierRosterRpcRow,
  type DownlineRow,
} from '../lib/cashierRoster';
import { UnionService } from '../services/UnionService';
import { unionRouteRef } from '../utils/unionIdResolver';
import { rememberLastClub } from '../utils/clubQuickLink';
import { CashierWorkspace } from '../components/wallet/CashierWorkspace';
import { useFitText } from '../components/lobby/game-cards/useFitText';
import { SpadeConsole } from '../components/console/SpadeConsole';
import { compactChips, formatWalletChips } from '../utils/format';
import {
  exactChipFigure,
  parseTradeAmount,
  sumChips,
  formatCashierAmountInput,
  cashierAmountInputValue,
} from '../utils/cashierAmount';
import { titleCase } from '../utils/titleCase';
import { generateAvatarSvg } from '../utils/avatarGenerator';
import { creditHeadroomOf, readCashierBalances } from '../services/cashierBalanceRead';
import {
  buildTournamentTicketItem,
  listTicketableTournaments,
  tournamentTicketIdempotencyKey,
  type TicketableTournament,
} from '../services/CashierTournamentTickets';
import {
  cashierBatchAmounts,
  cashierBatchAcknowledgement,
  cashierBatchReceiptText,
  mergeCashierBatchReceiptRows,
  type CashierBatchReceiptRow,
} from '../utils/cashierBatch';
import { chipKindWord } from '../utils/chipKindWord';
import { isPlatformFrozenError, PLATFORM_FROZEN_MESSAGE } from '../utils/platformFrozen';
import { useMaintenanceBreak } from '../hooks/useMaintenanceBreak';

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
  /** Both a sender and a recipient member: only then is it a member-to-member transfer. */
  twoSided?: boolean;
  /**
   * Dan 2026-09-02: a ledger line must say which wallet the chips left and
   * which they entered, whatever the role. "Agent Wallet To Player Wallet".
   * Null when the row is not a wallet move (a buy-in, rake, a payout).
   */
  route: string | null;
  /** The full sentence for the receipt: "KINGFISH Sent 500 From ... To ...". */
  narrative: string | null;
  /**
   * The row's line when it is a cash-out leg ("You Accepted Golddigger's
   * Cash-Out"), so a request never reads as a transfer to the agent it was
   * sent to. Null for every other kind.
   */
  title?: string | null;
  /** A cash-out leg's request status: pending while it waits for a decision. */
  requestStatus?: string | null;
  requestCreatedAt?: string | null;
  /** The cash-out invoice this leg is documented by (CA-YYYY-NNNNNNNN). */
  invoiceNumber?: string | null;
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

/* Transaction amounts and aggregates retain the console reading. Wallet
   balances use formatWalletChips explicitly: exact cents at every magnitude. */
const fmt = compactChips;

/**
 * The ledger note on every Send Out row (regression review 2026-10-10, G-07).
 * It was `Cashier Send Out ${submissionId}`, which printed a UUID into the
 * recipient's ledger, CSV "Note" column and player statement. The replay
 * fingerprint only needs a reason that is the same on a retry; a constant is.
 * The op_id stays the identity of each send.
 */
const CASHIER_SEND_OUT_REASON = 'Cashier Send Out';

// ─── The money dialogs' painted parts (Dan 2026-10-15) ─────────────────────
//
// "IT SHOULD SHOW THE PLAYER NAME LARGER, IT SHOULD HAVE A PROFILE IMAGE OR
//  CLUB ARENA AVATAR, THEIR CURRENT BALANCE SHOULD BE LARGER ... A VERY SIMPLE
//  SCREEN WITH NAME, PLAYER ID, AND AN ACTUAL ENTRY FIELD ... AND SHOULD ALWAYS
//  SHOW THE SENDERS BALANCE". Send Out, Claim Back and Send Ticket share these
//  three rows, printed into zones measured on approved shells:
//    the player   action-primary-shell.png  1280 x 315, portrait ring + plate
//    a wallet     wallet-row-shell.png      1280 x 274, square slot + plate
//    the entry    wallet-row-shell.png      the same shell, the field in the plate

/** The player a dialog acts on: portrait in the ring, name, number and wallet. */
function CashierPlayerCard({
  row,
  balanceLabel,
  walletControl,
  walletBalance,
}: {
  row: Pick<DownlineRow, 'userId' | 'name' | 'playerNumber' | 'avatarUrl' | 'chipBalance'>;
  balanceLabel: string;
  walletControl?: React.ReactNode;
  walletBalance?: number | null;
}) {
  const nameRef = useFitText<HTMLElement>(row.name, 1, 0.1);
  return (
    <section className={styles.playerCard} aria-label="Selected Player">
      <img
        className={styles.playerCardAvatar}
        src={row.avatarUrl || generateAvatarSvg(row.userId, row.name || '?')}
        alt=""
        onError={(event) => {
          const image = event.currentTarget;
          image.onerror = null;
          image.src = generateAvatarSvg(row.userId, row.name || '?');
        }}
      />
      <span className={styles.playerCardPlate}>
        <span className={styles.playerCardIdentity}>
          <strong ref={nameRef} className={styles.playerCardName}>
            {row.name}
          </strong>
          <span className={styles.playerCardId}>
            {row.playerNumber ? `ID: ${row.playerNumber}` : 'ID Unavailable'}
          </span>
        </span>
        <span className={styles.playerCardBalance}>
          <span>{balanceLabel}</span>
          {walletControl && (
            <svg className={styles.entityChevron} viewBox="0 0 12 8" aria-hidden="true">
              <path d="M1 1.5 6 6.5 11 1.5" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          )}
          <CashierFrameBalance
            text={
              walletBalance === null
                ? 'Unavailable'
                : formatWalletChips(walletBalance ?? row.chipBalance)
            }
          />
        </span>
      </span>
      {walletControl}
    </section>
  );
}

/** A wallet the dialog spends from or fills, with its live balance. */
function CashierWalletRow({
  label,
  balance,
  children,
}: {
  label: string;
  balance: number | null;
  children?: React.ReactNode;
}) {
  return (
    <section className={styles.walletRow} aria-label={label}>
      <span className={styles.walletRowSlot} aria-hidden="true">
        <img
          src={`${import.meta.env.BASE_URL}assets/club-buttons/wallets/wallet-mark-v1.svg`}
          alt=""
        />
      </span>
      <span className={styles.walletRowPlate}>
        <span className={styles.walletRowLabel}>{label}</span>
        {children && (
          <svg className={styles.entityChevron} viewBox="0 0 12 8" aria-hidden="true">
            <path d="M1 1.5 6 6.5 11 1.5" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
        )}
        <CashierFrameBalance text={balance === null ? '-' : formatWalletChips(balance)} />
      </span>
      {children}
    </section>
  );
}

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
/**
 * The retry key a saved ticket batch used for one recipient: a ticket into a
 * tournament is keyed to that tournament (CashierTournamentTickets), a plain
 * ticket to its value. Recovery must ask the server for the SAME key.
 */
function savedTicketKey(saved: CashierTransferRecovery, userId: string): string {
  return saved.tournamentId
    ? tournamentTicketIdempotencyKey(saved.clubId, saved.submissionId, userId, saved.tournamentId)
    : `ticket:${saved.clubId}:${saved.submissionId}:${userId}:${saved.targetAmounts?.[userId] ?? saved.amount}`;
}

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
/* The kinds read the statement's words (2026-10-17): the Trade Record printed
   "Cashout" and "Tournament Buyin" where the statement reads "Cash-Out" and
   "Tournament Buy-In". */
function txLabel(value: string | null | undefined): string {
  return value ? chipKindWord(value) : '';
}

/** The three roles that may read every transaction in the club. */
function isClubStaffRole(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'co_owner' || role === 'admin';
}

/** The agent ranks, who may read their downline's transactions too. */
function isAgentRole(role: string | null | undefined): boolean {
  return role === 'super_agent' || role === 'agent' || role === 'sub_agent';
}

type HistoryBook = 'club' | 'mine' | 'downline';
type HistoryKind = 'all' | 'cashout' | 'transfer' | 'game';
type HistoryRange = 'all' | 'today' | '7d' | '30d';

const HISTORY_KINDS: ReadonlyArray<readonly [HistoryKind, string]> = [
  ['all', 'All'],
  ['cashout', 'Cash-Outs'],
  ['transfer', 'Transfers'],
  ['game', 'Games'],
];
const HISTORY_RANGES: ReadonlyArray<readonly [HistoryRange, string]> = [
  ['all', 'All Time'],
  ['today', 'Today'],
  ['7d', '7 Days'],
  ['30d', '30 Days'],
];

/** The start of a date range chip, read at the moment of the request. */
function historyRangeStart(range: HistoryRange, now: Date = new Date()): string | null {
  if (range === 'all') return null;
  if (range === 'today') {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return midnight.toISOString();
  }
  const days = range === '7d' ? 7 : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** The most rows one Download writes: twenty server pages. */
const HISTORY_EXPORT_CAP = 5000;

/** One Transaction History page; older pages are read by cursor, not offset. */
const HISTORY_PAGE = 50;

/** A row of fn_cashier_history_feed. */
interface HistoryFeedRow {
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
  request_status?: string | null;
  request_created_at?: string | null;
  invoice_number?: string | null;
}

/**
 * The totals strip. One wallet (the viewer, or the player picked inside a
 * downline), a downline as one group, or the whole club.
 */
type HistorySummary = { filterKey: string } & (
  | { mode: 'wallet' | 'group'; incoming: number; outgoing: number; net: number }
  | { mode: 'club'; entries: number; volume: number; cashoutsPaid: number; complete: boolean }
);

/** A missing financial figure is unavailable, never a verified zero. */
function historyTotalNumber(value: unknown): number {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && value.trim() === '')
  )
    throw new Error('Invalid history total');
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('Invalid history total');
  return number;
}

// Retire dialogs and read/write refs immediately when the account or route changes.
// Pending durable requests keep their original account, club and request identity.
export default function CashierTradePage() {
  const { clubId } = useParams<{ clubId: string }>();
  const { user } = useAuthUser();
  const key = useCashoutScopeKey(user?.id, clubId || '');
  return <CashierTradeWorkspace key={key} />;
}

function CashierTradeWorkspace() {
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
  const [advanced, setAdvanced] = useState(false);

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
  /** What a credit agent may send beyond the float; 0 for everyone else. */
  const [agentCredit, setAgentCredit] = useState(0);
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
  const transferAuthorityEpoch = useRef(0);
  const memberAuthoritySnapshot = useRef<{ clubId: string; role: string; status: string } | null>(
    null
  );
  const pendingCountVersion = useRef(0);
  const heldTicketCountVersion = useRef(0);
  const reqSeqRef = useRef(0);
  const ticketSeqRef = useRef(0);
  const recordSeqRef = useRef(0);
  const recordFilterEpochRef = useRef(0);
  const invoiceSeqRef = useRef(0);
  /** Claim Back list guard (launch audit 2026-10-09, P-03): bumped with the rest. */
  const reversibleSeqRef = useRef(0);

  const [search, setSearch] = useState('');
  const rosterSearchRef = useRef<HTMLInputElement>(null);
  const [roleFilter, setRoleFilter] = useState('all');
  const [groupByRole, setGroupByRole] = useState(false);
  const [sortKey, setSortKey] = useState<'recent' | 'balance' | 'name'>('recent');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(25);

  const [records, setRecords] = useState<TradeRecordRow[]>([]);
  const [recordQuery, setRecordQuery] = useState('');
  const [recordDirection, setRecordDirection] = useState<'all' | 'in' | 'out' | 'managed'>('all');
  const [recordsHasMore, setRecordsHasMore] = useState(false);
  const [recordsLoadingMore, setRecordsLoadingMore] = useState(false);
  /** The search the server runs: a name or an invoice number, debounced. */
  const [historySearch, setHistorySearch] = useState('');
  /** One player inside an agent's downline, or null for the whole book. */
  const [historyPerson, setHistoryPerson] = useState<string | null>(null);
  const [recordsReload, setRecordsReload] = useState(0);
  /* TRANSACTION HISTORY (Dan 2026-10-24): owners, co-owners and admins choose
     between every transaction in the club and their own; every other role
     reads only its own. The server enforces the same rule
     (fn_cashier_history_page), so this is a choice, never a grant. */
  const [historyScope, setHistoryScope] = useState<HistoryBook>('club');
  const [historyKind, setHistoryKind] = useState<HistoryKind>('all');
  const [historyRange, setHistoryRange] = useState<HistoryRange>('all');
  const [historyTotals, setHistoryTotals] = useState<HistorySummary | null>(null);
  const [historyTotalsState, setHistoryTotalsState] = useState<'loading' | 'ready' | 'unavailable'>(
    'loading'
  );
  const [historyExporting, setHistoryExporting] = useState(false);
  const [receipt, setReceipt] = useState<TradeRecordRow | null>(null);
  const [isOnline, setIsOnline] = useState(readCashierOnlineState);
  /* THE BREAK IS NOT A FAILURE (2026-10-16). Dan pressed Confirm three times
     inside the :55 break, Postgres refused each send, and the page called it
     "Transfer Failed". While the platform is frozen the money controls wait
     and say why; the database stays the authority either way. */
  const { maintenanceBreak } = useMaintenanceBreak();
  const breakFrozen =
    maintenanceBreak.active &&
    ['counting_down', 'finalizing', 'resuming'].includes(maintenanceBreak.phase);
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
  const [diamondSending, setDiamondSending] = useState(false);
  const [claimRecipient, setClaimRecipient] = useState<string | null>(null);
  const [amountModal, setAmountModal] = useState<'send' | 'ticket' | 'diamonds' | null>(null);
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
  /* SEND TICKET INTO ONE TOURNAMENT (Dan 2026-10-15): the ticket is bound to
     a future or running tournament the cashier picks, priced by the SERVER
     from that tournament and paid from the sender's player wallet. */
  const [ticketTournaments, setTicketTournaments] = useState<TicketableTournament[] | null>(null);
  const [ticketTournamentsError, setTicketTournamentsError] = useState<string | null>(null);
  const [ticketTournamentId, setTicketTournamentId] = useState<string>('');
  /* The Club Bank figure, read when a dialog spends or fills it: a self send
     (owner, co owner) and a management claim back (Dan 2026-10-15). */
  const [bankBalance, setBankBalance] = useState<number | null>(null);
  const [mgmtClaimAmount, setMgmtClaimAmount] = useState('');
  const [mgmtClaiming, setMgmtClaiming] = useState(false);
  /** Double tap on a roster row opens Player Management (Dan 2026-10-15). */
  const lastRowTapRef = useRef<{ userId: string; at: number } | null>(null);
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
  /** The retained journal, readable from async callbacks without a stale closure. */
  const transferRecoveryRef = useRef<CashierTransferRecovery | null>(null);
  transferRecoveryRef.current = transferRecovery;
  const [amount, setAmount] = useState('');
  const [sendSource, setSendSource] = useState<SendSource>('agent_wallet');
  const [promoBalances, setPromoBalances] = useState<{ own: number | null; club: number | null }>({
    own: null,
    club: null,
  });
  const [targetBalances, setTargetBalances] = useState<
    Record<string, Partial<Record<SendDestination, number>>>
  >({});
  const [walletBalancesError, setWalletBalancesError] = useState<string | null>(null);
  const [recipientWallets, setRecipientWallets] = useState<Record<string, SendDestination>>({});
  const [recipientAmounts, setRecipientAmounts] = useState<Record<string, string>>({});
  const [batchReceipt, setBatchReceipt] = useState<{
    batchId: string;
    rows: CashierBatchReceiptRow[];
  } | null>(null);
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
  /**
   * THE OWNER FUNDS THEIR OWN PLAYER WALLET (Dan 2026-10-11: "CLUB OWNERS CAN
   * PLAY AND HAVE CHIPS SENT TO THEIR PLAYER WALLETS. THEY CURRENTLY AREN'T
   * SELECTABLE TO RECEIVE CHIPS").
   *
   * Send Out spends the caller's agent wallet through fn_agent_wallet_send,
   * which refuses a self-send and pays a staff recipient into their float, so
   * the owner's own row cannot be a Send Out target. The Club Bank can pay
   * it: fn_club_bank_send has no self guard and credits the player wallet of
   * an owner or co-owner as asked. So the owner's own row opens the Club Bank
   * cashier on their own player wallet - the same audited path, one
   * chip_transactions row, one retry key - rather than a new money route.
   */
  const [cashierPreset, setCashierPreset] = useState<{
    recipientId: string;
    destination: 'player_wallet';
  } | null>(null);
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
  const restoringTransferRecoveryRef = useRef<string | null>(null);
  const transferIntentSignature = JSON.stringify([
    user?.id,
    clubUuid,
    amount,
    sendSource,
    Object.entries(recipientWallets).sort(([left], [right]) => left.localeCompare(right)),
    Object.entries(recipientAmounts).sort(([left], [right]) => left.localeCompare(right)),
    [...selected].sort(),
    // A different tournament is a different ticket intent: it must never
    // inherit the retained batch, or the retry would issue into the old one.
    ticketTournamentId,
  ]);
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
  const transferViewKey = JSON.stringify([user?.id, clubParam, clubUuid]);
  const transferView = useRef({ key: transferViewKey });
  if (transferView.current.key !== transferViewKey) transferView.current = { key: transferViewKey };
  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);
  useEffect(() => {
    document.title = 'Cashier | Smarter Poker';
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
    if (!isOnline) setCashierPreset(null);
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

  const loadClub = useCallback(
    async (silent = false) => {
      // Bail-before-try left `loading` true forever, because the finally that
      // clears it is inside the try: a signed-out moment or an unresolvable club
      // gave a permanent "Loading members...". Clear it here instead.
      if (!user?.id || !clubUuid) {
        setLoading(false);
        return false;
      }
      const myVersion = ++loadVersion.current;
      const stale = () => loadVersion.current !== myVersion;
      if (!silent) setLoading(true);
      setLoadError(null);
      setRosterWarning(null);
      setRosterLoadingMore(false);
      let complete = true;
      try {
        const [meRes, floatRes] = await Promise.all([
          supabase
            .from('club_members')
            .select('role, chip_balance, status')
            .eq('club_id', clubUuid)
            .eq('user_id', user.id)
            .maybeSingle(),
          // The account Send Out spends. An owner has one of these too - the
          // Club Bank funds it, and fn_agent_wallet_send refuses every role
          // that has not been funded, staff included.
          supabase
            .from('agents')
            .select('agent_wallet_balance, status, is_prepaid, credit_limit, credit_used')
            .eq('club_id', clubUuid)
            .eq('user_id', user.id)
            .maybeSingle(),
        ]);
        if (!isMounted.current || stale()) return false;
        // Swallowing this error rendered an owner as a `player` with a 0.00
        // balance and silently flipped the downline into agent scope. A failure
        // has to look like a failure.
        if (meRes.error) throw meRes.error;
        if (floatRes.error) {
          complete = false;
          reportError(floatRes.error, 'CashierTradePage.agentWallet');
        }
        memberAuthoritySnapshot.current = {
          clubId: clubUuid,
          role: String(meRes.data?.role || 'player'),
          status: meRes.data?.status || 'active',
        };
        let role =
          meRes.data && (!meRes.data.status || MEMBER_IN_CLUB.includes(meRes.data.status))
            ? String(meRes.data.role || 'player')
            : 'player';
        if (
          ['super_agent', 'agent', 'sub_agent'].includes(role) &&
          floatRes.data?.status !== undefined &&
          floatRes.data.status !== 'active'
        )
          role = 'player';
        const bal = meRes.data?.chip_balance ? Number(meRes.data.chip_balance) : 0;
        // A row that does not exist is a float of zero. A row we could not READ
        // is unknown, and stays null so the pre-flight check does not refuse a
        // send the server would have allowed.
        const float = floatRes.error
          ? null
          : floatRes.data
            ? Number(floatRes.data.agent_wallet_balance) || 0
            : 0;
        // A credit agent may send past the float, drawn against the line the
        // server allows (credit_limit - credit_used). Prepaid agents have none.
        const credit = floatRes.error ? 0 : creditHeadroomOf(floatRes.data);

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
                // Initial role resolution must preserve a tab already chosen by the viewer.
                setTab((current) =>
                  role === 'player' && current === 'trade' ? 'record' : current
                );
                initialTabResolvedRef.current = true;
              }
              setMyRole(role);
              setRoleResolved(true);
              setMyBalance(bal);
              setAgentWallet(float);
              setAgentCredit(credit);
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
          // Initial role resolution must preserve a tab already chosen by the viewer.
          setTab((current) => (role === 'player' && current === 'trade' ? 'record' : current));
          initialTabResolvedRef.current = true;
        }
        setMyRole(role);
        setRoleResolved(true);
        setMyBalance(bal);
        setAgentWallet(float);
        setAgentCredit(credit);
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
          setLoadError('Could Not Load This Club. Check Your Connection And Try Again.');
        }
        return false;
      } finally {
        if (isMounted.current && !stale()) setLoading(false);
      }
    },
    [user?.id, clubUuid]
  );

  // Keep the working page stable. Mutations still validate authority in the
  // server transaction; explicit role changes invalidate controls immediately.
  useEffect(() => {
    const events = ['MEMBER_ROLE_CHANGED', 'MEMBER_UPDATED', 'AGENT_UPDATED'] as const;
    const unsubs = events.map((event) =>
      masterBus.subscribe(event, (payload: unknown) => {
        const changed = payload as { clubId?: string; userId?: string } | null;
        if (changed?.clubId && changed.clubId !== clubUuid) return;
        if (changed?.userId !== user?.id) return;
        ++loadVersion.current;
        transferAuthorityEpoch.current++;
        setLoading(false);
        setRosterLoadingMore(false);
        setLoadError('Cashier Access Changed. Refresh To Verify Your Current Access.');
        setRoleResolved(false);
        setDownline([]);
        setSelected(new Set());
        setAmountModal(null);
        const role = (payload as { newRole?: string } | null)?.newRole;
        if (role) setMyRole(role);
      })
    );
    return () => unsubs.forEach((unsubscribe) => unsubscribe());
  }, [clubUuid, user?.id]);

  const refreshAuthority = (payload: {
    eventType?: string;
    new?: { club_id?: string; role?: string; status?: string | null };
    old?: { club_id?: string };
  }) => {
    const changedClub = payload.new?.club_id || payload.old?.club_id;
    if (changedClub && changedClub !== clubUuid) return;
    const prior = memberAuthoritySnapshot.current;
    if (
      payload.eventType === 'UPDATE' &&
      prior?.clubId === clubUuid &&
      payload.new?.role === prior.role &&
      (payload.new.status || 'active') === prior.status
    )
      return;
    ++loadVersion.current;
    transferAuthorityEpoch.current++;
    setLoading(false);
    setRosterLoadingMore(false);
    setLoadError('Cashier Access Changed. Refresh To Verify Your Current Access.');
    setRoleResolved(false);
    // Revoked access retires protected rows and any open intent immediately.
    // This is authority invalidation, never a background directory reload.
    setDownline([]);
    setSelected(new Set());
    setAmountModal(null);
    if (payload.new?.role) setMyRole(payload.new.role);
  };
  useMasterBusChannel({
    channelName: user?.id && clubUuid ? `cashier-member-authority:${user.id}:${clubUuid}` : null,
    table: 'club_members',
    filter: user?.id ? `user_id=eq.${user.id}` : null,
    event: '*',
    enabled: !!user?.id && !!clubUuid,
    onPayload: refreshAuthority,
    onSubscriptionStatus: (status) => {
      if (status !== 'SUBSCRIBED' || !clubUuid || !user?.id) return;
      // Read just the authority after subscribing. Starting a second roster
      // load here invalidated page one while its continuation was pending.
      const owningView = transferView.current;
      void (async () => {
        const { data, error } = await supabase
          .from('club_members')
          .select('role, status')
          .eq('club_id', clubUuid)
          .eq('user_id', user.id)
          .maybeSingle();
        if (error) {
          reportError(error, 'CashierTradePage.subscribedAuthority');
          if (isMounted.current && transferView.current === owningView) {
            transferAuthorityEpoch.current++;
            setRoleResolved(false);
          }
          return;
        }
        if (!isMounted.current || transferView.current !== owningView) return;
        const prior = memberAuthoritySnapshot.current;
        if (
          prior?.clubId === clubUuid &&
          (String(data?.role || 'player') !== prior.role ||
            (data?.status || 'active') !== prior.status)
        )
          refreshAuthority({
            eventType: 'UPDATE',
            new: {
              club_id: clubUuid,
              role: String(data?.role || 'player'),
              status: data?.status,
            },
          });
      })();
    },
  });
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
    ++reversibleSeqRef.current;
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
    setBankBalance(null);
    setPromoBalances({ own: null, club: null });
    setTargetBalances({});
    setSendSource('agent_wallet');
    setDownline([]);
    setRosterLoadingMore(false);
    setRosterWarning(null);
    setSelected(new Set());
    setClaimRecipient(null);
    setVisibleCount(25);
    setAmountModal(null);
    setAmount('');
    setActiveCashier(null);
    setShowCashoutRequest(false);
    setCashierPreset(null);
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
    setRoleFilter('all');
    setRecordQuery('');
    setRecordDirection('all');
    setHistorySearch('');
    setHistoryPerson(null);
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

  /**
   * The book the Transaction History reads: the whole club for staff who chose
   * it, an agent's downline when he chose it, otherwise the viewer's own. The
   * server applies the same rule, so this is a choice, never a grant.
   */
  const historyBook: HistoryBook = !roleResolved
    ? 'mine'
    : isClubStaffRole(myRole) && historyScope === 'club'
      ? 'club'
      : isAgentRole(myRole) && historyScope === 'downline'
        ? 'downline'
        : 'mine';

  /** A feed row as the Transaction History shows it, read from the viewer's side. */
  const toTradeRecord = useCallback((raw: HistoryFeedRow, viewer: string): TradeRecordRow => {
    // A HORSE IS NEVER NAMED (cashier launch round 3, contract 2). A
    // treasury-funded seat is presented as the Club Bank send it is
    // BEFORE anything reads its kind, note or metadata, so its label,
    // route, sentence, receipt, search and copied text are a human
    // send's. Never dropped: its amount counts in every total.
    const r = presentChipTransaction(raw);
    // Read by the wallet that moved, not by the row's two sides: a
    // cash-out lands in the agent wallet of WHOEVER ACCEPTED it, and the
    // request itself never paid the agent it was sent to.
    const direction = ledgerDirection(r, viewer);
    const out = direction === 'out';
    const managed = direction === 'managed';
    const nameOf = new Map<string, string>();
    if (r.from_user_id && r.from_name) nameOf.set(r.from_user_id, r.from_name);
    if (r.to_user_id && r.to_name) nameOf.set(r.to_user_id, r.to_name);
    const otherName = out ? r.to_name : r.from_name;
    return {
      id: r.id,
      createdAt: r.created_at,
      type: (r.transaction_type as string) || 'transfer',
      amount: Number(r.amount) || 0,
      direction,
      // A third party reads a Club Bank send by the pot that paid,
      // never its operator: a send nobody pressed reads the same.
      // An entry with no recipient (a tournament buy-in) is not a
      // transfer to a member: it reads as what it is instead of
      // "Transfer X To A Member". A send whose sender is the Club Bank
      // still reads as the pot that paid.
      counterparty: managed
        ? r.to_user_id
          ? `${thirdPartySender(r, r.from_name)} To ${r.to_name || 'A Member'}`
          : `${txLabel(r.transaction_type)} By ${thirdPartySender(r, r.from_name)}`
        : otherName || 'Club',
      twoSided: Boolean(r.to_user_id),
      route: walletRoute(r),
      title: cashoutRowTitle(r, r.from_name, r.to_name, viewer),
      // The receipt's summary prints the receipt's own exact figure, so
      // the sentence and the headline above it never disagree (C1-14).
      narrative: describeChipTransaction(r, nameOf, viewer, (figure) =>
        exactChipFigure(Number(figure) || 0)
      ),
      requestStatus: r.request_status ?? null,
      requestCreatedAt: r.request_created_at ?? null,
      invoiceNumber: r.invoice_number ?? null,
    };
  }, []);

  /** The filters a page was read under; a refresh keeps older pages only when they match. */
  const historyFilterKey = `${clubUuid}|${historyBook}|${historyKind}|${historyRange}|${historyPerson ?? ''}|${historySearch}`;
  const recordsKeyRef = useRef<string | null>(null);

  // Retire the prior book before paint, including its in-flight older page.
  // The new filter must never label the old book's rows or receipt as its own.
  useLayoutEffect(() => {
    ++recordSeqRef.current;
    ++recordFilterEpochRef.current;
    recordsKeyRef.current = null;
    setRecords([]);
    setRecordsHasMore(false);
    setRecordsLoading(true);
    setRecordsLoadingMore(false);
    setRecordsError(null);
    setReceipt(null);
    return () => {
      ++recordSeqRef.current;
      ++recordFilterEpochRef.current;
    };
  }, [historyFilterKey]);

  const loadRecords = useCallback(async () => {
    if (!user?.id || !clubUuid || !roleResolved) return false;
    const seq = ++recordSeqRef.current;
    const viewer = user.id;
    const key = historyFilterKey;
    setRecordsLoading(true);
    setRecordsError(null);
    try {
      // One server-owned door for every viewer. The browser never filters
      // chip_transactions itself; it asks for a book, a type, a date range, a
      // player and a search, and the server answers with the club's rows only
      // to an owner, co-owner or admin, a downline's only to its agent, and
      // otherwise the viewer's own.
      const { data, error } = await supabase.rpc('fn_cashier_history_feed', {
        p_club_id: clubUuid,
        p_scope: historyBook,
        p_kind: historyKind,
        p_from: historyRangeStart(historyRange),
        p_to: null,
        p_person: historyPerson,
        p_search: historySearch || null,
        p_before_at: null,
        p_before_id: null,
        // One sentinel row says whether an older page exists.
        p_limit: HISTORY_PAGE + 1,
      });
      if (!isMounted.current || seq !== recordSeqRef.current) return false;
      // A discarded error rendered as "No trades recorded yet", which is a
      // different statement from "we could not read them".
      if (error) throw error;
      const rows = (data || []) as HistoryFeedRow[];
      const firstPage = rows.slice(0, HISTORY_PAGE).map((raw) => toTradeRecord(raw, viewer));
      const sameFilters = recordsKeyRef.current === key;
      recordsKeyRef.current = key;
      setRecords((previous) => {
        // A refresh under the same filters keeps the older pages already read
        // below the newest one; a new filter starts again.
        if (!sameFilters || firstPage.length < HISTORY_PAGE) return firstPage;
        const last = firstPage[firstPage.length - 1];
        const seen = new Set(firstPage.map((row) => row.id));
        const older = previous.filter(
          (row) =>
            !seen.has(row.id) &&
            (row.createdAt < last.createdAt ||
              (row.createdAt === last.createdAt && row.id < last.id))
        );
        return [...firstPage, ...older];
      });
      if (!sameFilters || rows.length <= HISTORY_PAGE)
        setRecordsHasMore(rows.length > HISTORY_PAGE);
      return true;
    } catch (e) {
      reportError(e, 'CashierTradePage.records');
      if (isMounted.current && seq === recordSeqRef.current) {
        setRecords([]);
        setRecordsError('Could not load your transaction history.');
      }
      return false;
    } finally {
      if (isMounted.current && seq === recordSeqRef.current) setRecordsLoading(false);
    }
  }, [
    user?.id,
    clubUuid,
    roleResolved,
    historyBook,
    historyKind,
    historyRange,
    historyPerson,
    historySearch,
    historyFilterKey,
    toTradeRecord,
  ]);

  /** The next older page, read from the last row on screen (an index range, never an offset). */
  const loadOlderRecords = useCallback(async () => {
    if (!user?.id || !clubUuid || !roleResolved || recordsLoadingMore) return;
    const last = records[records.length - 1];
    if (!last) return;
    // A head refresh keeps the same immutable older book. Only changing the
    // filters or leaving this view retires its pending older-page request.
    const filterEpoch = recordFilterEpochRef.current;
    const viewer = user.id;
    setRecordsLoadingMore(true);
    try {
      const { data, error } = await supabase.rpc('fn_cashier_history_feed', {
        p_club_id: clubUuid,
        p_scope: historyBook,
        p_kind: historyKind,
        p_from: historyRangeStart(historyRange),
        p_to: null,
        p_person: historyPerson,
        p_search: historySearch || null,
        p_before_at: last.createdAt,
        p_before_id: last.id,
        p_limit: HISTORY_PAGE + 1,
      });
      if (!isMounted.current || filterEpoch !== recordFilterEpochRef.current) return;
      if (error) throw error;
      const rows = (data || []) as HistoryFeedRow[];
      const page = rows.slice(0, HISTORY_PAGE).map((raw) => toTradeRecord(raw, viewer));
      setRecords((previous) => {
        const seen = new Set(previous.map((row) => row.id));
        return [...previous, ...page.filter((row) => !seen.has(row.id))];
      });
      setRecordsHasMore(rows.length > HISTORY_PAGE);
    } catch (e) {
      reportError(e, 'CashierTradePage.recordsOlder');
      if (isMounted.current && filterEpoch === recordFilterEpochRef.current)
        toast?.error?.('Older Transactions Could Not Be Loaded');
    } finally {
      if (isMounted.current && filterEpoch === recordFilterEpochRef.current)
        setRecordsLoadingMore(false);
    }
  }, [
    user?.id,
    clubUuid,
    roleResolved,
    recordsLoadingMore,
    records,
    historyBook,
    historyKind,
    historyRange,
    historyPerson,
    historySearch,
    toTradeRecord,
    toast,
  ]);

  useEffect(() => {
    if (tab === 'record') void loadRecords();
  }, [tab, loadRecords, recordsReload]);

  /* SERVER SEARCH (Dan 2026-10-24): a name or an invoice number searches the
     whole history, not only the rows already on screen. Debounced so a typed
     name is one request. */
  useEffect(() => {
    const typed = recordQuery.trim();
    const timer = setTimeout(() => setHistorySearch(typed.length >= 2 ? typed : ''), 350);
    return () => clearTimeout(timer);
  }, [recordQuery]);

  /* TRUE TOTALS (Dan 2026-10-24). From the server over the WHOLE filtered
     book, never the sum of the rows on screen: one wallet's In, Out and Net
     (the viewer's, or the player picked inside a downline), a downline's as
     one group, or the whole club's entries, chips moved and cash-outs paid.
     Read after the rows, on its own sequence, so a slow total never holds the
     list back and an older filter's total never lands beside newer rows. A
     total that could not be read says so; it is never shown as 0. Club
     totals count each closed day once; while days are still being counted
     the answer says so and is asked again. */
  const totalsSeqRef = useRef(0);
  const historySummaryKey = JSON.stringify([
    clubUuid,
    historyBook,
    historyKind,
    historyRange,
    historyPerson,
  ]);
  useEffect(() => {
    if (tab !== 'record' || !user?.id || !clubUuid || !roleResolved) return;
    const seq = ++totalsSeqRef.current;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setHistoryTotalsState('loading');
    const ask = async (attempt: number) => {
      try {
        const { data, error } = await supabase.rpc('fn_cashier_history_summary', {
          p_club_id: clubUuid,
          p_scope: historyBook,
          p_kind: historyKind,
          p_from: historyRangeStart(historyRange),
          p_to: null,
          p_person: historyPerson,
        });
        if (!active || !isMounted.current || seq !== totalsSeqRef.current) return;
        if (error) throw error;
        const t = (data ?? null) as Record<string, unknown> | null;
        if (!t || !['club', 'wallet', 'group'].includes(String(t.mode)))
          throw new Error('Invalid history summary');
        if (t?.mode === 'club') {
          const entries = historyTotalNumber(t.entries);
          const volume = historyTotalNumber(t.volume);
          const cashoutsPaid = historyTotalNumber(t.cashouts_paid);
          if (typeof t.complete !== 'boolean') throw new Error('Invalid history summary');
          const complete = t.complete === true;
          setHistoryTotals({
            filterKey: historySummaryKey,
            mode: 'club',
            entries,
            volume,
            cashoutsPaid,
            complete,
          });
          setHistoryTotalsState('ready');
          if (!complete && attempt < 40) timer = setTimeout(() => void ask(attempt + 1), 1200);
          return;
        }
        const incoming = historyTotalNumber(t.incoming);
        const outgoing = historyTotalNumber(t.outgoing);
        const net = historyTotalNumber(t.net);
        setHistoryTotals({
          filterKey: historySummaryKey,
          mode: t?.mode === 'group' ? 'group' : 'wallet',
          incoming,
          outgoing,
          net,
        });
        setHistoryTotalsState('ready');
      } catch (e) {
        if (!active || !isMounted.current || seq !== totalsSeqRef.current) return;
        reportError(e, 'CashierTradePage.historyTotals');
        setHistoryTotals(null);
        setHistoryTotalsState('unavailable');
      }
    };
    void ask(0);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [
    tab,
    user?.id,
    clubUuid,
    roleResolved,
    historyBook,
    historyKind,
    historyRange,
    historyPerson,
    historySummaryKey,
    recordsReload,
  ]);

  /** Download the filtered book as a CSV, every page the server will give. */
  const exportHistory = useCallback(async () => {
    if (!user?.id || !clubUuid || historyExporting) return;
    const viewer = user.id;
    const club = clubUuid;
    setHistoryExporting(true);
    try {
      const pageSize = 250;
      const from = historyRangeStart(historyRange);
      const rows: unknown[][] = [];
      let truncated = false;
      let before: { at: string; id: string } | null = null;
      while (rows.length < HISTORY_EXPORT_CAP) {
        const { data, error } = await supabase.rpc('fn_cashier_history_feed', {
          p_club_id: club,
          p_scope: historyBook,
          p_kind: historyKind,
          p_from: from,
          p_to: null,
          p_person: historyPerson,
          p_search: historySearch || null,
          p_before_at: before?.at ?? null,
          p_before_id: before?.id ?? null,
          p_limit: pageSize + 1,
        });
        if (error) throw error;
        const page = (data || []) as HistoryFeedRow[];
        for (const raw of page.slice(0, pageSize)) {
          const r = presentChipTransaction(raw);
          const direction = ledgerDirection(r, viewer);
          rows.push([
            new Date(r.created_at).toISOString(),
            txLabel(r.transaction_type),
            direction === 'in' ? 'In' : direction === 'out' ? 'Out' : 'Managed',
            r.from_name || (r.from_user_id ? 'A Member' : 'Club'),
            r.to_name || (r.to_user_id ? 'A Member' : ''),
            (Math.round((Number(r.amount) || 0) * 100) / 100).toFixed(2),
            walletRoute(r) ?? '',
            cashoutRowTitle(r, r.from_name, r.to_name, viewer) ?? r.notes ?? '',
            r.invoice_number ?? '',
            cashoutStatusLabel(r.request_status) ?? '',
            r.id,
          ]);
        }
        if (page.length <= pageSize) break;
        const last = page[pageSize - 1];
        before = { at: last.created_at, id: last.id };
        if (rows.length >= HISTORY_EXPORT_CAP) truncated = true;
      }
      if (!isMounted.current) return;
      const csv = toCsv(
        [
          'Date',
          'Type',
          'Direction',
          'From',
          'To',
          'Chips',
          'Route',
          'Detail',
          'Invoice',
          'Cash-Out Status',
          'Entry',
        ],
        rows
      );
      const stamp = new Date().toISOString().slice(0, 10);
      const book =
        historyBook === 'club' ? 'club' : historyBook === 'downline' ? 'downline' : 'mine';
      const saved = await downloadCsv(
        `transaction-history-${book}-${historyKind}-${historyRange}-${stamp}.csv`,
        csv,
        () => isMounted.current
      );
      if (!saved) toast?.error?.('This Device Could Not Save The File');
      else if (truncated)
        toast?.success?.(`Downloaded The Newest ${HISTORY_EXPORT_CAP.toLocaleString()} Entries`);
      else toast?.success?.(`Downloaded ${rows.length.toLocaleString()} Entries`);
    } catch (e) {
      reportError(e, 'CashierTradePage.historyExport');
      if (isMounted.current) toast?.error?.('The Transaction History Could Not Be Downloaded');
    } finally {
      if (isMounted.current) setHistoryExporting(false);
    }
  }, [
    user?.id,
    clubUuid,
    historyExporting,
    historyBook,
    historyKind,
    historyRange,
    historyPerson,
    historySearch,
    toast,
  ]);

  /* A cash-out accepted (or a send made) while the Transaction History is open
     lands in it without a manual refresh: the accept writes the row the
     history reads, and the bus says a balance moved. A burst collapses into
     one read, exactly as useClubPendingCashouts does. */
  useEffect(() => {
    if (tab !== 'record') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setRecordsReload((value) => value + 1), 500);
    };
    const offBalance = masterBus.subscribe('BALANCE_UPDATED', soon);
    const offMutation = masterBus.subscribe('DATA_MUTATED', soon);
    return () => {
      if (timer) clearTimeout(timer);
      offBalance?.();
      offMutation?.();
    };
  }, [tab]);

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
      // The head count is exact; this page is capped at 100. A full page says
      // "at least 100", so it may only RAISE the badge; a short page is the
      // whole queue and is the truth (launch audit 2026-10-09, P-17).
      const pageComplete = (data || []).length < 100;
      setPendingCount((held) => (pageComplete ? visible.length : Math.max(held, visible.length)));
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
      // The bus event is already wired to reload this page (and its badges), so
      // calling loadClub() here as well fired two identical paged loads at
      // once (launch audit 2026-10-09, P-18).
      masterBus.emit('BALANCE_UPDATED', { source: 'chip_request', userId: user?.id || '' });
      loadRequests();
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
    const parsedAsk = parseTradeAmount(askAmount);
    if (!parsedAsk.ok) {
      toast?.error?.(parsedAsk.error);
      return;
    }
    const raw = parsedAsk.value;
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
    () => sumChips(downline.filter((r) => r.isMine).map((r) => r.chipBalance)),
    [downline]
  );

  const { recentIds, addRecipient } = useRecentRecipients(user?.id, clubUuid, 'cashier');
  const [showCashoutRequest, setShowCashoutRequest] = useState(false);

  const rosterById = useMemo(() => new Map(downline.map((row) => [row.userId, row])), [downline]);

  const list = useMemo(() => {
    let rows = downline;
    // "the players assigned to me" - the question an agent actually asks, and
    // one an owner could not ask at all before, because an owner sees the whole
    // club and nothing on the row said which of them were theirs.
    if (mineOnly) rows = rows.filter((r) => r.isMine);
    if (roleFilter !== 'all') rows = rows.filter((r) => r.role === roleFilter);
    const bySort = (a: DownlineRow, b: DownlineRow) =>
      sortKey === 'recent'
        ? (recentIds.includes(a.userId) ? recentIds.indexOf(a.userId) : Infinity) -
            (recentIds.includes(b.userId) ? recentIds.indexOf(b.userId) : Infinity) ||
          b.chipBalance - a.chipBalance ||
          a.name.localeCompare(b.name)
        : sortKey === 'balance'
          ? b.chipBalance - a.chipBalance
          : a.name.localeCompare(b.name);
    // A search is a question about a NAME. Answer it by match quality first
    // (rosterMatchRank), and only then by the chosen sort - a balance sort on
    // a search put the owner, at 0.00, twenty-first behind twenty horses
    // whose handles happened to contain the same four letters.
    const q = search.trim();
    rows = sortCashierRosterMatches(rows, search, bySort);
    if (groupByRole && !q) {
      // ROLE_RANK from types/clubRoles, not a local map. The local one listed
      // super_agent/agent/sub_agent/admin/player and OMITTED owner and
      // co_owner, so both fell to the `?? 9` default and sorted BELOW every
      // player - on the control called "Group By Role". That module exists
      // because there were once three role types and no two agreed.
      rows = [...rows].sort((a, b) => roleRank(b.role as ClubRole) - roleRank(a.role as ClubRole));
    }
    return rows;
  }, [downline, search, sortKey, groupByRole, mineOnly, roleFilter, recentIds]);

  const [rosterWalletBalances, setRosterWalletBalances] = useState<
    Record<string, Partial<Record<SendDestination, number>>>
  >({});
  const visibleWalletIds = JSON.stringify(list.slice(0, visibleCount).map((row) => row.userId));
  useEffect(() => {
    if (!clubUuid || !roleResolved || myRole === 'player') return;
    let live = true;
    setRosterWalletBalances({});
    void (async () => {
      const ids = JSON.parse(visibleWalletIds) as string[];
      const balances: Record<string, Partial<Record<SendDestination, number>>> = {};
      try {
        for (let offset = 0; offset < ids.length; offset += 25) {
          const { data, error } = await supabase.rpc('fn_cashier_recipient_wallet_balances', {
            p_club_id: clubUuid,
            p_user_ids: ids.slice(offset, offset + 25),
          });
          if (error) throw error;
          if (!Array.isArray(data)) throw new Error('Recipient Balance Response Missing');
          for (const row of data) {
            balances[row.user_id] = {};
            for (const wallet of ['player_wallet', 'agent_wallet'] as const) {
              if (row[wallet] != null && Number.isFinite(Number(row[wallet])))
                balances[row.user_id][wallet] = Number(row[wallet]);
            }
          }
        }
        if (live) setRosterWalletBalances(balances);
      } catch (error) {
        reportError(error, 'CashierTradePage.rosterWalletBalances');
      }
    })();
    return () => {
      live = false;
    };
  }, [clubUuid, roleResolved, myRole, visibleWalletIds, downline]);

  const agencyBalance = useMemo(() => sumChips(recipients.map((r) => r.chipBalance)), [recipients]);

  /* The search runs on the server over the whole history; the direction
     chips narrow the rows already read. */
  const filteredRecords = useMemo(
    () => records.filter((row) => recordDirection === 'all' || row.direction === recordDirection),
    [records, recordDirection]
  );

  /** The players an agent may pick inside his downline (never anyone outside it). */
  const downlinePeople = useMemo(
    () =>
      downline
        .filter((row) => row.depth >= 1 && row.userId !== user?.id)
        .map((row) => ({ id: row.userId, name: row.name || row.username || 'A Member' }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [downline, user?.id]
  );
  const historyPersonName =
    historyPerson != null
      ? (downlinePeople.find((p) => p.id === historyPerson)?.name ?? 'This Player')
      : null;

  const visibleTabs = useMemo<[TabKey, string][]>(() => {
    const all: [TabKey, string][] = [
      ['trade', 'Trade'],
      ['record', 'Transaction History'],
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
  }, [clubUuid, search, mineOnly, groupByRole, sortKey, roleFilter]);

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
    // Equivalent rerenders (including roster refreshes) keep the restored
    // operation identity. Only an actual change to its inputs starts a new one.
    if (restoringTransferRecoveryRef.current === transferIntentSignature) return;
    restoringTransferRecoveryRef.current = null;
    submissionIdRef.current = null;
    opIdsRef.current = new Map();
    transferRecoveryScopeRef.current = null;
    // Editing the form retires its in-memory nonce, never an unresolved
    // remote outcome. Keep that journal available for explicit recovery.
    if (user?.id && clubUuid) {
      setTransferRecovery(readCashierTransferRecovery(user.id, clubUuid));
    } else {
      setTransferRecovery(null);
    }
  }, [transferIntentSignature, user?.id, clubUuid]);

  useEffect(() => {
    setRecipientAmounts({});
    setRecipientWallets({});
    setBatchReceipt(null);
  }, [user?.id, clubUuid]);

  useEffect(() => {
    if (!user?.id || !clubUuid) return;
    let live = true;
    const view = transferView.current;
    setTransferRecovery(readCashierTransferRecovery(user.id, clubUuid));
    void restoreDurableCashierTransfers(user.id, clubUuid)
      .then((rows) => {
        if (live && isMounted.current && transferView.current === view)
          setTransferRecovery(rows[0] ?? null);
      })
      .catch((error) => reportError(error, 'CashierTradePage.Recovery_read'));
    return () => {
      live = false;
    };
  }, [user?.id, clubUuid]);

  /** Chips the selected players are holding right now. */
  const pickedHeld = useMemo(() => sumChips(picked.map((r) => r.chipBalance)), [picked]);
  /** The tournament a Send Ticket is bound to; its price is every ticket's value. */
  /* A retained ticket batch names its tournament even after that tournament
     stops taking entries. The retry must go to the SAME tournament with the
     same keys, so the server can replay what committed (or refuse it plainly);
     it is offered as its own locked choice rather than silently dropped. */
  const retainedTicketTournament = useMemo<TicketableTournament | null>(() => {
    const saved = transferRecovery;
    if (!saved || saved.kind !== 'ticket' || !saved.tournamentId) return null;
    if (ticketTournaments?.some((row) => row.tournamentId === saved.tournamentId)) return null;
    return {
      tournamentId: saved.tournamentId,
      name: 'Original Tournament (Retry Only)',
      startTime: null,
      status: 'RETAINED',
      lateRegistration: false,
      price: Number(saved.amount),
      entryPrize: 0,
      entryBounty: 0,
      entryFee: 0,
      isUnionEvent: false,
      currentPlayers: null,
      maxPlayers: null,
    } as TicketableTournament;
  }, [transferRecovery, ticketTournaments]);
  const ticketTournament = useMemo(
    () =>
      ticketTournaments?.find((row) => row.tournamentId === ticketTournamentId) ??
      (retainedTicketTournament?.tournamentId === ticketTournamentId
        ? retainedTicketTournament
        : null),
    [ticketTournaments, ticketTournamentId, retainedTicketTournament]
  );
  const batchPlan = useMemo(() => {
    if (amountModal === 'ticket') {
      // A ticket is the tournament's entry: the price is the server's, never
      // typed, and the same for every recipient.
      if (!ticketTournament) {
        return {
          ok: false as const,
          userId: picked[0]?.userId ?? '',
          error: 'Choose A Tournament',
        };
      }
      const amounts = Object.fromEntries(
        picked.map((row) => [row.userId, ticketTournament.price])
      ) as Record<string, number>;
      return {
        ok: true as const,
        amounts,
        total: sumChips(Object.values(amounts)),
      };
    }
    return cashierBatchAmounts(
      picked.map((row) => row.userId),
      amount,
      recipientAmounts
    );
  }, [picked, amount, recipientAmounts, amountModal, ticketTournament]);
  const previewTotal = batchPlan.ok ? batchPlan.total : 0;
  const uniformAmountValue =
    picked.length === 1 ? (recipientAmounts[picked[0].userId] ?? amount) : amount;
  const uniformAmountInvalid =
    uniformAmountValue.trim() !== '' &&
    !batchPlan.ok &&
    (picked.length === 1 || recipientAmounts[batchPlan.userId] === undefined);

  useEffect(() => {
    if (amountModal === null && !transferRecovery) {
      setSendSource('agent_wallet');
      setRecipientWallets({});
    }
  }, [amountModal, transferRecovery]);

  const pickedWalletKey = JSON.stringify(picked.map((row) => row.userId).sort());
  useEffect(() => {
    if (amountModal !== 'send' || !clubUuid || !user?.id) return;
    let live = true;
    setTargetBalances({});
    setWalletBalancesError(null);
    const ids = [...new Set([...(JSON.parse(pickedWalletKey) as string[]), user.id])];
    void (async () => {
      const result: Record<string, Partial<Record<SendDestination, number>>> = {};
      try {
        for (let offset = 0; offset < ids.length; offset += 25) {
          const chunk = ids.slice(offset, offset + 25);
          const { data, error } = await supabase.rpc('fn_cashier_recipient_wallet_balances', {
            p_club_id: clubUuid,
            p_user_ids: chunk,
          });
          if (error) throw error;
          if (!Array.isArray(data)) throw new Error('Recipient Balance Response Missing');
          for (const row of data) {
            result[row.user_id] = {};
            for (const wallet of ['player_wallet', 'agent_wallet', 'promo_wallet'] as const) {
              if (
                row[wallet] !== null &&
                row[wallet] !== undefined &&
                Number.isFinite(Number(row[wallet]))
              )
                result[row.user_id][wallet] = Number(row[wallet]);
            }
          }
        }
        if (live) {
          setTargetBalances(result);
          if (result[user.id]?.player_wallet !== undefined)
            setMyBalance(result[user.id].player_wallet!);
        }
      } catch (error) {
        reportError(error, 'CashierTradePage.recipientWalletBalances');
        if (live) setWalletBalancesError('Recipient Balances Could Not Be Verified');
      }
    })();
    return () => {
      live = false;
    };
  }, [amountModal, clubUuid, user?.id, pickedWalletKey]);

  const availableSendSources: SendSource[] = [
    ...(canSeeClubBank(myRole)
      ? (['agent_wallet', 'club_bank', 'promo_wallet', 'club_promo_wallet'] as const)
      : (['agent_wallet', 'promo_wallet'] as const)),
    ...(holdsPlayerWallet(myRole) ? (['player_wallet'] as const) : []),
  ];
  const sourceBalanceFor = (source: SendSource): number | null =>
    source === 'player_wallet'
      ? myBalance
      : source === 'agent_wallet'
        ? agentWallet
        : source === 'club_bank'
          ? bankBalance
          : source === 'promo_wallet'
            ? promoBalances.own
            : promoBalances.club;
  const selectedSourceBalance = sourceBalanceFor(sendSource);
  const recipientWalletControl = (target: DownlineRow) => (
    <select
      className={styles.walletSelect}
      aria-label={`Recipient Wallet For ${target.name}`}
      value={transferDestination(target)}
      disabled={busy || Boolean(transferRecovery)}
      onChange={(event) => {
        setRecipientWallets((previous) => ({
          ...previous,
          [target.userId]: event.target.value as SendDestination,
        }));
        setTransferFailures([]);
      }}
    >
      {recipientSendWallets(target.role)
        .filter(
          (wallet) =>
            !(target.isSelf && sendSource === 'agent_wallet') || wallet === 'player_wallet'
        )
        .map((wallet) => (
          <option key={wallet} value={wallet}>
            {SEND_DESTINATION_LABELS[wallet]}:{' '}
            {targetBalances[target.userId]?.[wallet] === undefined
              ? 'Unavailable'
              : formatWalletChips(targetBalances[target.userId][wallet]!)}
          </option>
        ))}
    </select>
  );

  const transferDestination = (target: DownlineRow): SendDestination =>
    target.isSelf && sendSource === 'agent_wallet'
      ? 'player_wallet'
      : (transferRecovery?.submissionId === submissionIdRef.current
          ? transferRecovery.destinations?.[target.userId]
          : undefined) ||
        recipientWallets[target.userId] ||
        (canHoldAgentWallet(target.role) ? 'agent_wallet' : 'player_wallet');

  // ── Money actions ──────────────────────────────────────────────────────────
  const runTransfers = async (kind: 'send' | 'ticket') => {
    if (!user?.id || !clubUuid) return;
    if (!requireOnline()) return;
    if (loading || !roleResolved || loadError) {
      toast?.error?.('Cashier Is Still Synchronizing. Try Again In A Moment');
      return;
    }
    if (picked.length === 0) {
      toast?.error?.('Selection Changed. Pick The Players Again');
      setAmountModal(null);
      return;
    }
    const parsedAmount = batchPlan;
    if (!parsedAmount.ok) {
      toast?.error?.(parsedAmount.error);
      return;
    }
    const raw = parsedAmount.amounts[picked[0]?.userId];
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
    const selfTargeted = targets.some((target) => target.isSelf || target.userId === user.id);
    if (
      selfTargeted &&
      (kind !== 'send' ||
        !['club_promo_wallet', 'player_wallet', 'agent_wallet'].includes(sendSource))
    ) {
      /* SENDING TO YOURSELF (Dan 2026-10-15: "INCLUDING OWNERS, I CURRENTLY
         CAN'T SEND CHIPS TO MYSELF"). An agent wallet now funds its holder's player
         wallet directly. When the chosen source is Club Bank, the owner's
         own player wallet is funded from the Club Bank, the account that
         already pays them through Fund Me. On its own, so a batch never
         mixes two funding accounts. */
      if (
        kind === 'send' &&
        targets.length === 1 &&
        selfCanFundPlayerWallet &&
        sendSource === 'club_bank'
      ) {
        await sendToSelf();
        return;
      }
      toast?.error?.(
        kind === 'send' && selfCanFundPlayerWallet
          ? 'Send To Yourself On Its Own, Then Send To The Others'
          : 'Choose Another Active Member'
      );
      return;
    }
    if (kind === 'ticket' && !ticketTournament) {
      toast?.error?.('Choose A Tournament For The Ticket');
      return;
    }
    if (!canHoldAgentWallet(myRole)) {
      toast?.error?.('Your Cashier Authority Is No Longer Active');
      return;
    }
    if (kind === 'send' && !availableSendSources.includes(sendSource)) {
      toast?.error?.('Your Cashier Authority Is No Longer Active');
      return;
    }
    if (kind === 'send' && selectedSourceBalance === null) {
      toast?.error?.('Selected Wallet Could Not Be Verified');
      return;
    }
    const total = parsedAmount.total;
    if (
      kind === 'send' &&
      selectedSourceBalance !== null &&
      total > selectedSourceBalance + (sendSource === 'agent_wallet' ? agentCredit : 0)
    ) {
      toast?.error?.(
        sendSource === 'agent_wallet' && agentCredit > 0
          ? `Insufficient Chips: Sending ${exactChipFigure(total)} Needs More Than Your Agent Wallet And Credit Line Allow, ${exactChipFigure((agentWallet ?? 0) + agentCredit)}`
          : `Insufficient Chips: Sending ${exactChipFigure(total)} Needs More Than ${SEND_SOURCE_LABELS[sendSource]} Holds, ${exactChipFigure(selectedSourceBalance)}`
      );
      return;
    }
    if (kind === 'ticket' && total > myBalance) {
      toast?.error?.(
        `Insufficient Chips: Sending ${exactChipFigure(total)} Needs More Than ${exactChipFigure(myBalance)}`
      );
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
    // A different action is a new intent even when its amount and players
    // match. Retain the unresolved original journal, but never reuse a Send
    // Out submission identity for a ticket (or the reverse).
    const retainedIntent = submissionIdRef.current
      ? readCashierTransferRecoveryBySubmission(user.id, clubUuid, submissionIdRef.current)
      : null;
    if (retainedIntent && retainedIntent.kind !== kind) {
      submissionIdRef.current = null;
      opIdsRef.current = new Map();
      transferRecoveryScopeRef.current = null;
    }
    if (!submissionIdRef.current) {
      submissionIdRef.current = newOpId();
    }
    let submissionId = submissionIdRef.current;
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
    const recoveryCreatedAt =
      transferRecovery?.submissionId === submissionId ? transferRecovery.createdAt : Date.now();
    let uncertainRecovery: CashierTransferRecovery = {
      version: 1,
      userId: user.id,
      clubId: clubUuid,
      kind,
      amount: transferRecovery?.submissionId === submissionId ? transferRecovery.amount : value,
      targetAmounts:
        transferRecovery?.submissionId === submissionId
          ? transferRecovery.targetAmounts
          : parsedAmount.amounts,
      targetIds:
        transferRecovery?.submissionId === submissionId
          ? transferRecovery.targetIds
          : targets.map((target) => target.userId),
      failures: targets.map((target) => ({
        userId: target.userId,
        name: target.name,
        message: 'Outcome Not Yet Confirmed',
      })),
      submissionId,
      opIds: Object.fromEntries(opIdsRef.current),
      ticketNote:
        transferRecovery?.submissionId === submissionId
          ? transferRecovery.ticketNote
          : 'Cashier Ticket',
      ...(kind === 'ticket' && ticketTournament
        ? {
            tournamentId:
              transferRecovery?.submissionId === submissionId && transferRecovery.tournamentId
                ? transferRecovery.tournamentId
                : ticketTournament.tournamentId,
          }
        : {}),
      source:
        transferRecovery?.submissionId === submissionId ? transferRecovery.source : sendSource,
      destinations:
        transferRecovery?.submissionId === submissionId
          ? transferRecovery.destinations
          : Object.fromEntries(
              targets.map((target) => [target.userId, transferDestination(target)])
            ),
      createdAt: recoveryCreatedAt,
    };
    // Own the click before the durable reservation awaits. Another tab receives
    // the original envelope; it never allocates a second set of money keys.
    busyRef.current = true;
    setBusy(true);
    const reservationView = transferView.current;
    const reservationEpoch = transferAuthorityEpoch.current;
    try {
      uncertainRecovery = await reserveDurableCashierTransfer(uncertainRecovery);
      if (
        !isMounted.current ||
        transferView.current !== reservationView ||
        transferAuthorityEpoch.current !== reservationEpoch
      ) {
        busyRef.current = false;
        if (isMounted.current) setBusy(false);
        return;
      }
      submissionId = uncertainRecovery.submissionId;
      submissionIdRef.current = submissionId;
      opIdsRef.current = new Map(Object.entries(uncertainRecovery.opIds));
      transferRecoveryScopeRef.current = { userId: user.id, clubId: clubUuid, submissionId };
    } catch (error) {
      busyRef.current = false;
      if (isMounted.current) setBusy(false);
      reportError(error, 'CashierTradePage.Transfer_recovery_reserve_failed');
      if (isMounted.current && transferView.current === reservationView)
        toast?.error?.('Cashier Recovery Is Unavailable. Try Again');
      return;
    }
    setBatchProgress({ processed: 0, total: targets.length });
    let ok = 0;
    const receiptRows: CashierBatchReceiptRow[] = targets.map((target) => ({
      userId: target.userId,
      name: target.name,
      amount: parsedAmount.amounts[target.userId],
      destination:
        kind === 'ticket'
          ? 'Tournament Ticket'
          : SEND_DESTINATION_LABELS[
              uncertainRecovery.destinations?.[target.userId] ?? 'player_wallet'
            ],
      outcome: 'Not Submitted',
      reference:
        kind === 'send'
          ? opIdFor(target.userId)
          : uncertainRecovery.tournamentId
            ? tournamentTicketIdempotencyKey(
                clubUuid,
                submissionId,
                target.userId,
                uncertainRecovery.tournamentId
              )
            : `ticket:${clubUuid}:${submissionId}:${target.userId}:${parsedAmount.amounts[target.userId]}`,
    }));
    const boundTournamentId = uncertainRecovery.tournamentId ?? null;
    const receiptById = new Map(receiptRows.map((row) => [row.userId, row]));
    const failed: Array<{ userId: string; name: string; message: string }> = [];
    const uncertain: Array<{ userId: string; name: string; message: string }> = [];
    const owningView = transferView.current;
    const owningAuthorityEpoch = transferAuthorityEpoch.current;
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
        if (
          !isMounted.current ||
          transferView.current !== owningView ||
          transferAuthorityEpoch.current !== owningAuthorityEpoch
        ) {
          failed.push(
            ...targets.slice(offset).map((target) => ({
              userId: target.userId,
              name: target.name,
              message: 'Not Submitted After Cashier Access Or View Changed',
            }))
          );
          break;
        }
        try {
          for (const target of chunk)
            receiptById.get(target.userId)!.outcome = 'Outcome Needs Verification';
          const items = chunk.map((target) =>
            kind === 'ticket' && boundTournamentId
              ? // The tournament item carries its own user_id and amount (the
                // price the cashier saw); spreading it under them would name
                // both twice.
                buildTournamentTicketItem({
                  clubId: clubUuid,
                  submissionId,
                  userId: target.userId,
                  tournament: {
                    tournamentId: boundTournamentId,
                    price: parsedAmount.amounts[target.userId],
                  },
                  note: uncertainRecovery.ticketNote,
                })
              : {
                  user_id: target.userId,
                  amount: parsedAmount.amounts[target.userId],
                  ...(kind === 'send'
                    ? {
                        source: uncertainRecovery.source ?? 'agent_wallet',
                        destination:
                          uncertainRecovery.destinations?.[target.userId] ||
                          (canHoldAgentWallet(target.role) ? 'agent_wallet' : 'player_wallet'),
                        // The server's replay fingerprint includes the reason, so it
                        // cannot change between an uncertain send and its retry -
                        // never a display name (S-06). A constant is stable; op_id
                        // is the identity (regression review G-07).
                        reason: CASHIER_SEND_OUT_REASON,
                        op_id: opIdFor(target.userId),
                      }
                    : {
                        note: uncertainRecovery.ticketNote || `Cashier ticket for ${target.name}`,
                        idempotency_key: `ticket:${clubUuid}:${submissionId}:${target.userId}:${parsedAmount.amounts[target.userId]}`,
                      }),
                }
          );
          const { data, error } = await supabase.rpc('fn_cashier_batch_transfer', {
            p_club_id: clubUuid,
            p_kind: kind,
            p_items: items,
            p_batch_id: submissionId,
          });
          if (error) throw error;
          const envelope = data as {
            success?: boolean;
            batch_id?: string;
            error?: string;
            results?: Array<{ user_id?: string; success?: boolean; error?: string }>;
          } | null;
          if (
            envelope?.success !== true ||
            !Array.isArray(envelope.results) ||
            (envelope.batch_id !== undefined && envelope.batch_id !== submissionId)
          ) {
            throw new Error(envelope?.error || 'Batch Was Refused');
          }

          for (const target of chunk) {
            const result = cashierBatchAcknowledgement(envelope.results, target.userId);
            if (result.outcome === 'Refused' && result.message === 'Transfer Failed') {
              // The batch rolled this item back. The photographed refusal was
              // inside the recorded maintenance freeze; name that authoritative
              // state instead of treating a definite refusal as a lost outcome.
              const { data: frozen, error: freezeError } = await supabase.rpc('fn_platform_frozen');
              if (freezeError) reportError(freezeError, 'CashierTradePage.refusalMaintenanceState');
              else if (frozen === true)
                result.message =
                  'Paused For Maintenance. No Chips Were Moved. Try Again When Play Resumes';
            }
            const receiptRow = receiptById.get(target.userId)!;
            receiptRow.outcome = result.outcome;
            if (result.reference) receiptRow.reference = result.reference;
            if (result.outcome === 'Confirmed') ok++;
            else {
              const failure = {
                userId: target.userId,
                name: target.name,
                message: result.message || 'Outcome Needs Verification',
              };
              failed.push(failure);
              // A refusal is definitive: the item rolled back and moved nothing,
              // so only an unknown outcome is kept for verification.
              if (result.outcome !== 'Refused') uncertain.push(failure);
            }
          }
        } catch (e) {
          batchFailureReason ||= cashierReasonCode(e);
          if (isPlatformFrozenError(e)) {
            /* The maintenance break, not a lost connection (2026-10-16). The
               retry keys are kept all the same: a repeat after the break can
               only replay or run fresh. */
            for (const target of chunk) {
              const failure = {
                userId: target.userId,
                name: target.name,
                message: PLATFORM_FROZEN_MESSAGE,
              };
              failed.push(failure);
              uncertain.push(failure);
            }
            continue;
          }
          for (const target of chunk) {
            const failure = {
              userId: target.userId,
              name: target.name,
              // A raw transport message ("Failed to fetch", "JWT expired") is
              // not shown: the request may have committed, so say exactly that.
              message: 'Connection Lost. Outcome Needs Verification',
            };
            failed.push(failure);
            uncertain.push(failure);
          }
        }
        if (isMounted.current && transferView.current === owningView) {
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
      // Retire the nonces ONLY when every target went through. If any one of
      // them failed, keeping them is the whole point: the retry carries the
      // same op_id per target, so whichever targets already committed replay
      // instead of being charged a second time.
      if (ok === targets.length) {
        await clearDurableCashierTransfer(uncertainRecovery);
        if (transferView.current === owningView) {
          submissionIdRef.current = null;
          opIdsRef.current = new Map();
          if (isMounted.current)
            setTransferRecovery(readCashierTransferRecovery(user.id, clubUuid));
        }
      }
      const recovery: CashierTransferRecovery | null =
        uncertain.length > 0
          ? {
              ...uncertainRecovery,
              failures: uncertain,
            }
          : null;
      if (recovery) await updateDurableCashierTransfer(recovery);
      else if (ok !== targets.length) {
        // Every item that did not go through was refused outright. Nothing is
        // left to verify, so the journal closes instead of offering a retry
        // that can only be refused again (and eventually filling storage).
        await clearDurableCashierTransfer(uncertainRecovery);
        if (isMounted.current && transferView.current === owningView)
          setTransferRecovery(readCashierTransferRecovery(user.id, clubUuid));
      }
      busyRef.current = false;
      if (isMounted.current) {
        setBusy(false);
        setBatchProgress(null);
      }
      if (isMounted.current && transferView.current === owningView) {
        setBatchReceipt((previous) => ({
          batchId: submissionId,
          rows:
            previous?.batchId === submissionId
              ? mergeCashierBatchReceiptRows(previous.rows, receiptRows)
              : receiptRows,
        }));
        setTransferFailures(failed);
        if (recovery) setTransferRecovery(recovery);
        // Only close on a clean batch. Closing on failure wiped the amount and
        // the selection, which is the worst possible moment to lose them.
        if (failed.length === 0) {
          setAmountModal(null);
          setAmount('');
          setRecipientAmounts({});
        }
      }
    }

    if (!isMounted.current || transferView.current !== owningView) return;
    if (ok > 0) {
      for (const row of receiptRows) if (row.outcome === 'Confirmed') addRecipient(row.userId);
      // Name the counterparty on a single-target move. The Toast layer bars an
      // identical type+text for 60s, so "Sent 100.00 To 1 Player" twice in a
      // minute confirmed only the FIRST real chip movement - a receipt must
      // never be the thing that dedupes.
      const who = targets.length === 1 ? targets[0].name : `${ok} Player${ok === 1 ? '' : 's'}`;
      toast?.success?.(
        kind === 'send'
          ? `Sent ${exactChipFigure(sumChips(receiptRows.filter((row) => row.outcome === 'Confirmed').map((row) => row.amount)))} Total To ${who} From ${SEND_SOURCE_LABELS[sendSource]}`
          : `Issued ${ok} Ticket${ok === 1 ? '' : 's'} To ${who}. Review The Exact Values In Your Batch Receipt`,
        undefined,
        undefined,
        `${submissionId}:${receiptRows
          .filter((row) => row.outcome === 'Confirmed')
          .map((row) => row.reference)
          .sort()
          .join(',')}`
      );
      // Read back this completed command without a loading reset. Background
      // balance events never reload the working directory.
      void loadClub(true);
      masterBus.emit('BALANCE_UPDATED', { source: 'cashier_trade', userId: user.id });
    }
    if (failed.length > 0) {
      // The one branch that did not exist. A batch where every target failed
      // produced no summary at all.
      if (failed.some((failure) => failure.message === PLATFORM_FROZEN_MESSAGE))
        toast?.error?.(PLATFORM_FROZEN_MESSAGE);
      else
        toast?.error?.(
          uncertain.length > 0
            ? `Transfer Outcomes Need Verification For ${uncertain.length} Recipients`
            : `${failed.length} Transfers Were Refused. No Chips Were Moved For Those Recipients`
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
    // Every other loader on this page drops a stale response by sequence; this
    // one checked only the unmount guard, so club A's slow list could land
    // over club B's and offer A's sends against B's club id (P-03).
    const seq = ++reversibleSeqRef.current;
    const requestedClub = clubUuid;
    setReversibleLoading(true);
    setReversibleError(null);
    try {
      const { data, error } = await supabase.rpc('fn_agent_wallet_reversible', {
        p_club_id: requestedClub,
      });
      if (!isMounted.current || seq !== reversibleSeqRef.current) return;
      if (error) throw error;
      setReversible(((data || []) as ReversibleSend[]).map((r) => ({ ...r })));
      // Anchor the server's countdown against a monotonic local stopwatch.
      setReversibleAnchor(performance.now());
    } catch (error) {
      if (!isMounted.current || seq !== reversibleSeqRef.current) return;
      reportError(error, 'CashierTradePage.loadReversible');
      // An unreadable result is not an empty list of claimable sends.
      setReversible([]);
      setReversibleAnchor(null);
      setReversibleError('Could Not Read Your Recent Sends.');
    } finally {
      if (isMounted.current && seq === reversibleSeqRef.current) setReversibleLoading(false);
    }
  }, [clubUuid]);

  const claimBack = async (row: ReversibleSend) => {
    if (!clubUuid || claimingId || busyRef.current) return;
    if (!requireOnline()) return;
    const owningView = transferView.current;
    const owningAuthority = transferAuthorityEpoch.current;
    const current = () =>
      isMounted.current &&
      transferView.current === owningView &&
      transferAuthorityEpoch.current === owningAuthority;
    busyRef.current = true;
    setClaimingId(row.transaction_id);
    try {
      const operation = await reserveCashierWalletOperation(
        user?.id || '',
        clubUuid,
        'fn_agent_wallet_claim_back',
        {
          p_club_id: clubUuid,
          p_transaction_id: row.transaction_id,
          p_amount: null,
          p_reason: 'Claimed Back From The Trade Grid',
        }
      );
      if (!operation) throw new Error('Cashier Safety Storage Is Unavailable. Try Again');
      if (!current()) return;
      const heldOpId = operation.operationId;
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
      if (res && res.success === false) {
        // A definitive refusal moved nothing, so its journal entry is closed.
        await clearCashierWalletOperation(operation);
        claimOpIdsRef.current.delete(row.transaction_id);
      }
      if (!res?.success) throw new Error(res?.error || 'Those Chips Could Not Be Claimed Back');
      await clearCashierWalletOperation(operation);
      if (!current()) return;
      addRecipient(row.to_user_id);
      void loadClub(true);
      const claimedAmount = Number(res.amount) || 0;
      toast?.success?.(
        res.replayed
          ? `That Claim Had Already Gone Through. ${fmt(claimedAmount)} Chips Are Back In Your Agent Wallet`
          : `Claimed ${fmt(claimedAmount)} Back From ${row.to_name}`,
        undefined,
        undefined,
        operation.operationId
      );
      claimOpIdsRef.current.delete(row.transaction_id);
      masterBus.emit('BALANCE_UPDATED', { source: 'cashier_trade_claim', userId: user?.id || '' });
      void loadReversible();
      // A confirmed claim toasts and closes its sheet (Dan, 2026-10-22).
      setClaimOpen(false);
    } catch (e) {
      if (!current()) return;
      reportError(e, 'CashierTradePage.claimBack');
      toast?.error?.((e as Error).message || 'Claim Back Failed');
    } finally {
      busyRef.current = false;
      if (isMounted.current) setClaimingId(null);
    }
  };

  /**
   * ── CLUB BANK MOVES FROM THIS PAGE (Dan 2026-10-15) ──────────────────────
   *
   * Two moves the Trade grid could not make, both on the Club Bank's own
   * audited RPCs (the same ones the Club Bank cashier and Fund Me use):
   *
   *   Send Out to yourself  -> fn_club_bank_send      bank -> own player wallet
   *   Claim Back, any time  -> fn_club_bank_claim_back player wallet -> bank
   *
   * "OWNERS, CO OWNERS AND ADMIN'S HAVE THE ABILITY TO CLAIM BACK CHIPS AT
   * ANY POINT". Every other role keeps the ten minute reversal anchored on
   * one of its own sends. Both are keyed by a reserved operation id, so a
   * retry after a lost response replays rather than moving chips twice.
   */
  const managementClaims = myRole === 'owner' || myRole === 'co_owner' || myRole === 'admin';
  /* CASH OUT REQUESTS FOR MANAGEMENT (Dan 2026-10-23): "OWNERS, CO OWNERS OR
     ADMINS SHOULD BE ABLE TO SEE ALL CASH OUT REQUESTS AND PULL THOSE CHIPS
     ... THERE SHOULD BE AN ICON ON THE CASHIER THAT MANAGEMENT AND OWNERS CAN
     SEE, BELOW THE CURRENT 'REQUEST CASH OUT'". The queue is fn_cashout_queue's
     scope (every request in a club this viewer runs); pulling the chips is
     AgentCashoutPanel's approval, which moves the verified hold into the
     approver's agent wallet. No notification is involved: the request's
     message goes to the player's own agent only. */
  const pendingCashouts = useClubPendingCashouts(clubUuid, roleResolved && managementClaims);
  const [showCashoutQueue, setShowCashoutQueue] = useState(false);
  /** The one player a management claim acts on: the dialog's, else the single selection. */
  const managementClaimTarget: DownlineRow | null = !managementClaims
    ? null
    : claimRecipient
      ? (rosterById.get(claimRecipient) ?? null)
      : picked.length === 1
        ? picked[0]
        : null;

  const loadBankBalance = useCallback(async () => {
    if (!clubUuid || !user?.id) return;
    const requestedClub = clubUuid;
    const owningView = transferView.current;
    const controller = new AbortController();
    try {
      const snapshot = await readCashierBalances(
        requestedClub,
        user.id,
        'agent_wallet',
        controller.signal
      );
      if (!isMounted.current || transferView.current !== owningView) return;
      setAgentWallet(snapshot.bank);
      setAgentCredit(snapshot.credit);
      setPromoBalances({ own: snapshot.promoFloat, club: snapshot.promoPot });
      // The agent snapshot also carries the authorized club panel's treasury.
      setBankBalance(snapshot.clubBank);
    } catch (error) {
      reportError(error, 'CashierTradePage.loadBankBalance');
      // An unread bank is unknown, never zero.
      if (isMounted.current && transferView.current === owningView) {
        setBankBalance(null);
        setPromoBalances({ own: null, club: null });
      }
    }
  }, [clubUuid, user?.id]);

  const sendToSelf = async () => {
    if (!clubUuid || !user?.id || busyRef.current) return;
    if (!requireOnline()) return;
    const plan = batchPlan;
    if (!plan.ok) {
      toast?.error?.(plan.error);
      return;
    }
    const value = plan.amounts[user.id];
    if (!(value > 0)) {
      toast?.error?.('Enter An Amount');
      return;
    }
    if (bankBalance !== null && value > bankBalance) {
      toast?.error?.(`Insufficient Chips: The Club Bank Holds ${exactChipFigure(bankBalance)}`);
      return;
    }
    const owningView = transferView.current;
    const owningAuthority = transferAuthorityEpoch.current;
    const current = () =>
      isMounted.current &&
      transferView.current === owningView &&
      transferAuthorityEpoch.current === owningAuthority;
    busyRef.current = true;
    setBusy(true);
    try {
      const operation = await reserveCashierWalletOperation(
        user.id,
        clubUuid,
        'fn_club_bank_send',
        {
          p_club_id: clubUuid,
          p_to_user_id: user.id,
          p_destination: transferDestination(picked[0]),
          p_amount: value,
          p_reason: 'Cashier Send To Self',
        }
      );
      if (!operation) throw new Error('Cashier Safety Storage Is Unavailable. Try Again');
      if (!current()) return;
      const { data, error } = await supabase.rpc('fn_club_bank_send', {
        p_club_id: clubUuid,
        p_to_user_id: user.id,
        p_amount: value,
        p_destination: transferDestination(picked[0]),
        p_reason: 'Cashier Send To Self',
        p_op_id: operation.operationId,
      });
      if (error) throw error;
      const res = (Array.isArray(data) ? data[0] : data) as {
        success?: boolean;
        error?: string;
        replayed?: boolean;
      } | null;
      // A definitive refusal moved nothing, so its journal entry is closed.
      if (res && res.success === false) await clearCashierWalletOperation(operation);
      if (!res?.success) throw new Error(res?.error || 'The Club Bank Refused That Send');
      await clearCashierWalletOperation(operation);
      if (!current()) return;
      toast?.success?.(
        res.replayed
          ? `That Send Had Already Gone Through. ${exactChipFigure(value)} Chips Are In Your ${SEND_DESTINATION_LABELS[transferDestination(picked[0])].replace(' Wallet', '')} Wallet`
          : `Sent ${exactChipFigure(value)} From The Club Bank To Your ${SEND_DESTINATION_LABELS[transferDestination(picked[0])].replace(' Wallet', '')} Wallet`,
        undefined,
        undefined,
        operation.operationId
      );
      setAmountModal(null);
      setAmount('');
      setRecipientAmounts({});
      void loadClub(true);
      void loadBankBalance();
      masterBus.emit('BALANCE_UPDATED', { source: 'cashier_trade_self', userId: user.id });
    } catch (e) {
      if (!current()) return;
      reportError(e, 'CashierTradePage.sendToSelf');
      toast?.error?.((e as Error).message || 'Send Failed');
    } finally {
      busyRef.current = false;
      if (isMounted.current) setBusy(false);
    }
  };

  const claimToBank = async (target: DownlineRow) => {
    if (!clubUuid || !user?.id || busyRef.current || mgmtClaiming) return;
    if (!requireOnline()) return;
    const parsed = parseTradeAmount(mgmtClaimAmount);
    if (!parsed.ok) {
      toast?.error?.(parsed.error);
      return;
    }
    if (parsed.value > target.chipBalance) {
      toast?.error?.(`${titleCase(target.name)} Only Holds ${exactChipFigure(target.chipBalance)}`);
      return;
    }
    const owningView = transferView.current;
    const owningAuthority = transferAuthorityEpoch.current;
    const current = () =>
      isMounted.current &&
      transferView.current === owningView &&
      transferAuthorityEpoch.current === owningAuthority;
    busyRef.current = true;
    setMgmtClaiming(true);
    try {
      const operation = await reserveCashierWalletOperation(
        user.id,
        clubUuid,
        'fn_club_bank_claim_back',
        {
          p_club_id: clubUuid,
          p_from_user_id: target.userId,
          p_source: 'player_wallet',
          p_amount: parsed.value,
          p_reason: 'Cashier Claim Back',
        }
      );
      if (!operation) throw new Error('Cashier Safety Storage Is Unavailable. Try Again');
      if (!current()) return;
      const { data, error } = await supabase.rpc('fn_club_bank_claim_back', {
        p_club_id: clubUuid,
        p_from_user_id: target.userId,
        p_amount: parsed.value,
        p_source: 'player_wallet',
        p_reason: 'Cashier Claim Back',
        p_op_id: operation.operationId,
      });
      if (error) throw error;
      const res = (Array.isArray(data) ? data[0] : data) as {
        success?: boolean;
        error?: string;
        replayed?: boolean;
      } | null;
      // A definitive refusal moved nothing, so its journal entry is closed.
      if (res && res.success === false) await clearCashierWalletOperation(operation);
      if (!res?.success) throw new Error(res?.error || 'Those Chips Could Not Be Claimed Back');
      await clearCashierWalletOperation(operation);
      if (!current()) return;
      toast?.success?.(
        res.replayed
          ? `That Claim Had Already Gone Through. ${exactChipFigure(parsed.value)} Chips Are In The Club Bank`
          : `Claimed ${exactChipFigure(parsed.value)} From ${titleCase(target.name)} Into The Club Bank`,
        undefined,
        undefined,
        operation.operationId
      );
      addRecipient(target.userId);
      void loadClub(true);
      void loadBankBalance();
      setMgmtClaimAmount('');
      setClaimOpen(false);
      masterBus.emit('BALANCE_UPDATED', { source: 'cashier_trade_bank_claim', userId: user.id });
    } catch (e) {
      if (!current()) return;
      reportError(e, 'CashierTradePage.claimToBank');
      toast?.error?.((e as Error).message || 'Claim Back Failed');
    } finally {
      busyRef.current = false;
      if (isMounted.current) setMgmtClaiming(false);
    }
  };

  // The tournaments a ticket can be sent into, read whenever Send Ticket opens.
  useEffect(() => {
    if (amountModal !== 'ticket' || !clubUuid) return;
    let live = true;
    setTicketTournamentsError(null);
    listTicketableTournaments(clubUuid)
      .then((rows) => {
        if (!live) return;
        setTicketTournaments(rows);
        setTicketTournamentId((current) =>
          rows.some((row) => row.tournamentId === current) ||
          (current !== '' && current === transferRecoveryRef.current?.tournamentId)
            ? current
            : ''
        );
      })
      .catch((error: Error) => {
        if (!live) return;
        reportError(error, 'CashierTradePage.listTicketableTournaments');
        setTicketTournaments(null);
        setTicketTournamentsError(error.message || 'Could Not Load Tournaments');
      });
    return () => {
      live = false;
    };
  }, [amountModal, clubUuid]);

  // The bank figure each Club Bank dialog spends or fills.
  useEffect(() => {
    if (amountModal === 'send' || claimOpen) void loadBankBalance();
  }, [amountModal, claimOpen, loadBankBalance]);

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
    if (!requireOnline() || reconcilingRef.current) return false;
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
      if (checks.every((complete) => complete === true)) return true;
      toast?.error?.('Cashier Reconciliation Needs Attention');
      return false;
    } catch (error) {
      reportError(error, 'CashierTradePage.reconcileCashier');
      toast?.error?.('Cashier Reconciliation Needs Attention');
      return false;
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

  const reopenTransferRecovery = async () => {
    if (!user?.id || !clubUuid || !transferRecovery || transferRecovery.clubId !== clubUuid) return;
    const saved =
      readCashierTransferRecoveryBySubmission(user.id, clubUuid, transferRecovery.submissionId) ||
      transferRecovery;
    // Check committed outcomes before testing today's roster or wallet balance.
    // A demoted operator can read their own receipt without authorizing a new send.
    const recoveryView = transferView.current;
    const confirmedTargets = new Set<string>();
    try {
      for (let offset = 0; offset < saved.targetIds.length; offset += 25) {
        const chunk = saved.targetIds.slice(offset, offset + 25);
        const { data, error } = await supabase.rpc('fn_cashier_recovery_receipts', {
          p_club_id: saved.clubId,
          p_operation_ids: saved.kind === 'send' ? chunk.map((id) => saved.opIds[id]) : [],
          p_ticket_keys:
            saved.kind === 'ticket' ? chunk.map((id) => savedTicketKey(saved, id)) : [],
        });
        if (!isMounted.current || transferView.current !== recoveryView) return;
        if (error) throw error;
        if (!data || !Array.isArray(data.operations) || !Array.isArray(data.tickets))
          throw new Error('Receipt Response Missing');
        chunk
          .filter((id) =>
            saved.kind === 'send'
              ? data.operations.some(
                  (row: { operation_id?: string; receipt?: { success?: boolean } }) =>
                    row.operation_id === saved.opIds[id] && row.receipt?.success === true
                )
              : data.tickets.some(
                  (row: { ticket_key?: string; receipt?: { success?: boolean } }) =>
                    row.ticket_key === savedTicketKey(saved, id) && row.receipt?.success === true
                )
          )
          .forEach((id) => confirmedTargets.add(id));
      }
      if (confirmedTargets.size === saved.targetIds.length) {
        setBatchReceipt({
          batchId: saved.submissionId,
          rows: saved.targetIds.map((id) => ({
            userId: id,
            name: rosterById.get(id)?.name || 'Cashier Recipient',
            amount: saved.targetAmounts?.[id] ?? saved.amount,
            destination:
              saved.kind === 'ticket'
                ? 'Tournament Ticket'
                : SEND_DESTINATION_LABELS[saved.destinations?.[id] ?? 'player_wallet'],
            outcome: 'Confirmed',
            reference: saved.kind === 'send' ? saved.opIds[id] : savedTicketKey(saved, id),
          })),
        });
        await clearDurableCashierTransfer(saved);
        setTransferRecovery(readCashierTransferRecovery(saved.userId, saved.clubId));
        toast?.success?.('Original Transfer Receipts Confirmed. No New Transfer Was Submitted');
        return;
      }
    } catch (error) {
      reportError(error, 'CashierTradePage.Recovery_receipts');
      toast?.error?.('Could Not Verify Original Receipts. Retry Keys Are Preserved');
      return;
    }
    const pendingTargets = saved.targetIds.filter((id) => !confirmedTargets.has(id));
    setBatchReceipt({
      batchId: saved.submissionId,
      rows: saved.targetIds.map((id) => ({
        userId: id,
        name: rosterById.get(id)?.name || 'Cashier Recipient',
        amount: saved.targetAmounts?.[id] ?? saved.amount,
        destination:
          saved.kind === 'ticket'
            ? 'Tournament Ticket'
            : SEND_DESTINATION_LABELS[saved.destinations?.[id] ?? 'player_wallet'],
        outcome: confirmedTargets.has(id) ? 'Confirmed' : 'Outcome Needs Verification',
        reference: saved.kind === 'send' ? saved.opIds[id] : savedTicketKey(saved, id),
      })),
    });
    const authorized = new Set(downline.map((row) => row.userId));
    if (pendingTargets.some((targetId) => !authorized.has(targetId))) {
      toast?.error?.('Recipients Changed. Review The Roster Before Starting A New Transfer');
      return;
    }
    restoringTransferRecoveryRef.current = JSON.stringify([
      user.id,
      clubUuid,
      String(saved.amount),
      saved.source ?? 'agent_wallet',
      Object.entries(saved.destinations ?? {}).sort(([left], [right]) => left.localeCompare(right)),
      Object.entries(saved.targetAmounts ?? {})
        .map(([id, value]) => [id, String(value)] as [string, string])
        .sort(([left], [right]) => left.localeCompare(right)),
      [...pendingTargets].sort(),
      saved.tournamentId ?? ticketTournamentId,
    ]);
    setSendSource(saved.source ?? 'agent_wallet');
    setRecipientWallets(saved.destinations ?? {});
    submissionIdRef.current = saved.submissionId;
    opIdsRef.current = new Map(Object.entries(saved.opIds));
    transferRecoveryScopeRef.current = {
      userId: user.id,
      clubId: clubUuid,
      submissionId: saved.submissionId,
    };
    setSearch('');
    setMineOnly(false);
    setRoleFilter('all');
    setAmount(String(saved.amount));
    setRecipientAmounts(
      saved.targetAmounts
        ? Object.fromEntries(
            Object.entries(saved.targetAmounts).map(([id, value]) => [id, String(value)])
          )
        : {}
    );
    setSelected(new Set(pendingTargets));
    if (saved.tournamentId) setTicketTournamentId(saved.tournamentId);
    setTransferRecovery(saved);
    // Persisted recovery deliberately omits names and raw server messages.
    // Restore names only from the freshly authorized roster for this club.
    const names = new Map(downline.map((row) => [row.userId, row.name]));
    setTransferFailures(
      saved.failures
        .filter((failure) => !confirmedTargets.has(failure.userId))
        .map((failure) => ({
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
        if (amountModal && !busy && !diamondSending) {
          setAmountModal(null);
          setTransferFailures([]);
        }
        if (askOpen && !asking) setAskOpen(false);
        if (claimOpen && !claimingId && !mgmtClaiming) setClaimOpen(false);
        if (receipt) setReceipt(null);
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled):not([tabindex="-1"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
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
  }, [
    dialogOpen,
    amountModal,
    askOpen,
    claimOpen,
    receipt,
    busy,
    diamondSending,
    asking,
    claimingId,
    mgmtClaiming,
  ]);

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
    ? 'Cashier Offline; Money Actions Are Locked'
    : reconciling
      ? 'Reconciling Balances And Cashier Authority'
      : loading || isHydrating
        ? 'Synchronizing Cashier Balances'
        : rosterLoadingMore
          ? `Cashier Ready; Loading The Rest Of The Roster After ${downline.length.toLocaleString()} Members`
          : clubResolveFailed
            ? 'Club Could Not Be Resolved'
            : loadError
              ? 'Cashier Sync Requires Attention'
              : agentWallet === null
                ? 'Agent Wallet Could Not Be Verified'
                : 'Balances Synchronized';
  const lastVerifiedLabel = lastVerifiedAt
    ? new Date(lastVerifiedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : 'Not Yet Refreshed';
  const currentClubLabel = membershipsLoading
    ? 'Loading Club'
    : titleCase(currentClub?.name || 'Club Cashier');

  // ── Render ────────────────────────────────────────────────────────────────
  const cashierAuthorityBlocked = busy || loading || !roleResolved || !!loadError;
  /** Whether the viewer's own row offers "Fund Me" (see cashierPreset). */
  // Only a club cashier may spend its own bank; recipient eligibility is
  // determined separately for the selected player or agent wallet.
  const selfCanFundPlayerWallet = currentClub?.entityType === 'club' && canSeeClubBank(myRole);

  const modeToggle = (
    <button
      type="button"
      className={styles.modeToggle}
      aria-pressed={advanced}
      onClick={() => {
        if (advanced) {
          setTab('trade');
          setRoleFilter('all');
          setMineOnly(false);
          setGroupByRole(false);
        }
        setAdvanced((value) => !value);
      }}
    >
      {advanced ? 'Simple' : 'Advanced'}
      {!advanced && pendingCount + heldTicketCount > 0
        ? ` (${(pendingCount + heldTicketCount).toLocaleString()})`
        : ''}
    </button>
  );

  return (
    <div
      className={`${styles.page} ${!advanced ? styles.simple : ''}`}
      data-cashier-surface="trade"
      data-cashier-mode={advanced ? 'advanced' : 'simple'}
    >
      <CashierWorkspace
        compact={!advanced}
        title="Cashier"
        summary="Move Chips Between Your Club Wallets, Answer Chip Requests, Redeem Tickets And Check Every Ledger Entry."
        // Dan 2026-10-16: no "Live Ledger" pill. A locked cashier still says so.
        pill={isOnline ? undefined : 'Locked'}
        pillTone="danger"
        className={styles.console}
      >
        <div className={styles.glass}>
          {/* Dan 2026-10-16: the Simple view carries no "Simple Cashier" caption
          and no toolbar row; its Advanced switch sits beside the club so the
          club leads the glass. Advanced keeps its labelled toolbar. */}
          {advanced && (
            <div className={styles.modeToolbar}>
              <span>Advanced Cashier</span>
              {modeToggle}
            </div>
          )}
          <section
            className={styles.hero}
            aria-label={advanced ? 'Wallet Command' : 'Club Cashier'}
          >
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
                <span className={styles.entityText}>
                  <span className={styles.entityName}>{currentClubLabel}</span>
                  <span
                    className={`${styles.entityCaret} ${pickerOpen ? styles.entityCaretOpen : ''} sc-label`}
                    aria-hidden="true"
                  >
                    Choose
                    <svg className={styles.entityChevron} viewBox="0 0 12 8" focusable="false">
                      <path
                        d="M1 1.5 6 6.5 11 1.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      />
                    </svg>
                  </span>
                </span>
              </button>
              {!advanced && modeToggle}
            </div>

            {holdsPlayerWallet(myRole) && roleResolved && (
              // Dan 2026-10-16: the button carries the viewer's own player
              // balance in this club, the same figure the cashout sheet checks.
              <button
                type="button"
                className={styles.cashoutButton}
                aria-label="Request Cash Out"
                aria-describedby="cashier-cashout-balance"
                onClick={() => setShowCashoutRequest(true)}
              >
                <span className={styles.cashoutLabel}>Request Cash Out</span>
                <span id="cashier-cashout-balance" className={styles.cashoutBalance}>
                  {loading || isHydrating
                    ? 'Loading Balance'
                    : `${formatWalletChips(myBalance)} Chips`}
                </span>
              </button>
            )}
            {managementClaims && roleResolved && (
              <button
                type="button"
                className={`${styles.cashoutQueueButton} ${pendingCashouts.requests.length > 0 ? styles.cashoutQueueLive : ''}`}
                aria-label={`Cash Out Requests. ${pendingCashouts.requests.length.toLocaleString()} Pending`}
                aria-describedby="cashier-cashout-queue-count"
                onClick={() => setShowCashoutQueue(true)}
              >
                <span className={styles.cashoutLabel}>Cash Out Requests</span>
                <span id="cashier-cashout-queue-count" className={styles.cashoutQueueCount}>
                  {!pendingCashouts.loaded
                    ? 'Loading'
                    : pendingCashouts.requests.length > 0
                      ? `${pendingCashouts.requests.length.toLocaleString()} Pending`
                      : 'None Pending'}
                </span>
              </button>
            )}
            {!advanced && (
              // Dan 2026-10-16: a healthy cashier prints no "Balances Synchronized"
              // line. The status stays announced to assistive technology, and any
              // other state (offline, reconciling, an error) is still shown.
              <div
                className={
                  cashierSyncMessage === 'Balances Synchronized' ? 'sr-only' : styles.simpleStatus
                }
                role="status"
              >
                {cashierSyncMessage}
              </div>
            )}
            {advanced && (
              <div className={styles.heroContent}>
                <div
                  className={`${styles.securityLine} ${cashierNeedsAttention && !loading && !isHydrating ? styles.securityDotWarning : ''}`}
                  role="status"
                >
                  {cashierSyncMessage}
                </div>
              </div>
            )}
            <div className={styles.heroMetrics} aria-label="Current Cashier Balances">
              <div className={styles.heroMetric}>
                <span className={styles.heroMetricLabel}>Club Chips</span>
                <strong className={styles.heroMetricValue}>
                  {loading || isHydrating ? '-' : formatWalletChips(myBalance)}
                </strong>
              </div>
              <div className={styles.heroMetric}>
                <span className={styles.heroMetricLabel}>Agent Wallet</span>
                <strong className={styles.heroMetricValue}>
                  {loading || isHydrating || agentWallet === null
                    ? '-'
                    : formatWalletChips(agentWallet)}
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
              id="cashier-club-picker-region"
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
              <div className={styles.pickerLabel}>Open Cashier For</div>
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
                <div id="cashier-club-picker" role="listbox" aria-label="Club Cashiers">
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
                      <span className={styles.pickerName}>{titleCase(m.name)}</span>
                      <span className={styles.pickerBalance}>
                        {m.entityType === 'union'
                          ? 'Union Wallets'
                          : `${formatWalletChips(m.chipBalance)} Chips`}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Tabs */}
          <nav
            hidden={!advanced}
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

          <CashierPendingOperations
            actionClassName={styles.footerBtn}
            key={`${user?.id}:${clubUuid}`}
            userId={user?.id}
            clubId={clubUuid}
          />

          {batchReceipt && (
            <section
              className={styles.sectionShell}
              aria-label="Batch Transfer Receipt"
              aria-live="polite"
            >
              <h2>Batch Transfer Receipt</h2>
              <p>
                Confirmed Total:{' '}
                {exactChipFigure(
                  sumChips(
                    batchReceipt.rows
                      .filter((row) => row.outcome === 'Confirmed')
                      .map((row) => row.amount)
                  )
                )}{' '}
                Chips
              </p>
              <div className={styles.batchReceiptList}>
                {batchReceipt.rows.map((row) => (
                  <div className={styles.batchReceiptRow} key={row.userId}>
                    <strong>{row.name}</strong>
                    <span>
                      {exactChipFigure(row.amount)} Chips · {row.destination}
                    </span>
                    <span>{row.outcome}</span>
                    <span>Reference: {row.reference}</span>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className={styles.footerBtn}
                onClick={async () => {
                  const copied = await copyCashierText(
                    cashierBatchReceiptText(
                      batchReceipt.rows,
                      batchReceipt.batchId,
                      currentClub?.name || 'Club Cashier'
                    )
                  );
                  if (copied) toast?.success?.('Batch Receipt Copied');
                  else toast?.error?.('Batch Receipt Could Not Be Copied');
                }}
              >
                Copy Batch Receipt
              </button>
              <p>Unconfirmed Outcomes Must Be Verified Before Starting A New Transfer.</p>
            </section>
          )}

          {tab === 'trade' && (
            <section
              id="cashier-panel-trade"
              className={styles.sectionShell}
              role={advanced ? 'tabpanel' : 'region'}
              aria-labelledby={advanced ? 'cashier-tab-trade' : 'trade-workspace-title'}
              tabIndex={0}
            >
              <div className={styles.sectionHeading}>
                <div>
                  <span className={styles.sectionEyebrow}>Distribution Desk</span>
                  <h2 className={styles.sectionTitle} id="trade-workspace-title">
                    {advanced ? 'Select Recipients' : 'Players'}
                  </h2>
                </div>
                {/* Dan 2026-10-24: "INSTEAD OF IT SAYING 575 AVAILABLE - 0
                SELECTED. THAT SHOULD BE THE 'TRANSACTION HISTORY'". The
                selection count still lives in the dock below. */}
                <button
                  type="button"
                  className={styles.historyLink}
                  onClick={() => setTab('record')}
                >
                  Transaction History
                </button>
              </div>
              {/* Balance strip */}
              <div className={styles.strip}>
                <div className={styles.stripCell}>
                  <span className={styles.stripLabel}>Club Chips</span>
                  <span className={styles.stripValue}>{formatWalletChips(myBalance)}</span>
                </div>
                <div className={styles.stripCell}>
                  <span className={styles.stripLabel}>Downline Holdings</span>
                  <span className={styles.stripValue}>{formatWalletChips(agencyBalance)}</span>
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
                    {agentWallet === null ? '--' : formatWalletChips(agentWallet)}
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
                <label className={styles.searchLabel} htmlFor="cashier-member-search">
                  Search The Roster
                </label>
                <input
                  id="cashier-member-search"
                  ref={rosterSearchRef}
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search Name Or ID Number"
                  aria-label={`Search ${downline.length} Member${downline.length === 1 ? '' : 's'}`}
                />
                {search && (
                  <button
                    type="button"
                    className={styles.searchClear}
                    onClick={() => {
                      setSearch('');
                      rosterSearchRef.current?.focus();
                    }}
                  >
                    Clear Search
                  </button>
                )}
              </div>
              <span className={styles.memberCount} role="status" aria-live="polite">
                {list.length.toLocaleString()} Results
              </span>
              <div className={styles.filterRow}>
                <label className={styles.roleFilter}>
                  Role
                  <select
                    aria-label="Filter Roster By Role"
                    value={roleFilter}
                    onChange={(event) => setRoleFilter(event.target.value)}
                  >
                    <option value="all">All Roles</option>
                    {Array.from(new Set(downline.map((row) => row.role)))
                      .sort((a, b) => roleRank(b as ClubRole) - roleRank(a as ClubRole))
                      .map((role) => (
                        <option key={role} value={role}>
                          {titleCase(roleLabel(role as ClubRole))}
                        </option>
                      ))}
                  </select>
                </label>
                {(search || mineOnly || roleFilter !== 'all') && (
                  <button
                    type="button"
                    className={styles.searchClear}
                    onClick={() => {
                      setSearch('');
                      setMineOnly(false);
                      setRoleFilter('all');
                      rosterSearchRef.current?.focus();
                    }}
                  >
                    Clear Filters
                  </button>
                )}
                <label className={styles.groupToggle}>
                  <input
                    type="checkbox"
                    checked={mineOnly}
                    className="sc-check__box"
                    onChange={(e) => setMineOnly(e.target.checked)}
                    disabled={mineCount === 0}
                  />
                  {/* The count AND what they hold. The total used to live in the
                  balance strip, which now shows the account this page spends;
                  it is the number that decides whether a claim is worth making,
                  so it stays beside the filter that isolates those players. */}
                  Assigned To Me ({mineCount.toLocaleString()} &middot;{' '}
                  {formatWalletChips(mineTotal)})
                </label>
                <label className={styles.groupToggle}>
                  <input
                    type="checkbox"
                    checked={groupByRole}
                    className="sc-check__box"
                    onChange={(e) => setGroupByRole(e.target.checked)}
                  />
                  Group By Role
                </label>
                <button
                  className={styles.sortBtn}
                  onClick={() =>
                    setSortKey((k) =>
                      k === 'recent' ? 'balance' : k === 'balance' ? 'name' : 'recent'
                    )
                  }
                >
                  Sort By{' '}
                  {sortKey === 'recent'
                    ? 'Most Recent'
                    : sortKey === 'balance'
                      ? 'Chip Balance'
                      : 'Name'}
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
                      {roleFilter !== 'all'
                        ? 'No Members Match These Filters.'
                        : mineOnly
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
                  list.slice(0, visibleCount).map((r) => {
                    /* ONE TAP SELECTS, TWO TAPS OPEN (Dan 2026-10-15): "ONE
                       CLICK ANYWHERE PLACES A CHECK MARK ON THE PLAYER
                       (INCLUDING OWNERS) ... DOUBLE CLICK OR DOUBLE TAP OPENS
                       THE PLAYER MANAGEMENT PAGE". A second tap on the same
                       row inside 350 ms undoes the first tap's toggle and
                       opens the record, so a double tap never leaves a stray
                       check behind. Measured by our own clock, because a
                       touch double tap does not reliably fire dblclick. Your
                       own row is selectable when the Club Bank can pay you. */
                    const selectable =
                      !r.isSelf || selfCanFundPlayerWallet || canHoldAgentWallet(myRole);
                    const isSelected = selected.has(r.userId);
                    const toggle = () =>
                      setSelected((previous) => {
                        const next = new Set(previous);
                        if (next.has(r.userId)) next.delete(r.userId);
                        else next.add(r.userId);
                        return next;
                      });
                    const openRecord = () => navigate(`/clubs/${clubParam}/members/${r.userId}`);
                    const onRowTap = () => {
                      const now = performance.now();
                      const last = lastRowTapRef.current;
                      if (last && last.userId === r.userId && now - last.at < 350) {
                        lastRowTapRef.current = null;
                        if (selectable && !busy) toggle();
                        openRecord();
                        return;
                      }
                      lastRowTapRef.current = { userId: r.userId, at: now };
                      if (selectable && !busy) toggle();
                    };
                    return (
                      <div
                        key={r.userId}
                        className={`${styles.row} ${r.isSelf ? styles.rowSelf : ''} ${selectable ? styles.selectableRow : ''} ${isSelected ? styles.rowSelected : ''}`}
                        onClick={onRowTap}
                        title={
                          r.isSelf && !selfCanFundPlayerWallet && !canHoldAgentWallet(myRole)
                            ? 'This Is You. Chips Cannot Be Sent To Yourself.'
                            : undefined
                        }
                      >
                        <label
                          className={styles.recipientPicker}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            className={styles.batchPicker}
                            aria-label={`Include ${r.name}`}
                            checked={isSelected}
                            disabled={!selectable || busy}
                            onClick={(event) => event.stopPropagation()}
                            onChange={() => {
                              if (selectable) toggle();
                            }}
                          />
                        </label>
                        <span className={styles.rosterPortrait}>
                          <img
                            src={r.avatarUrl || generateAvatarSvg(r.userId, r.name || '?')}
                            alt=""
                            className={styles.avatar}
                            onError={(event) => {
                              const image = event.currentTarget;
                              image.onerror = null;
                              image.src = generateAvatarSvg(r.userId, r.name || '?');
                            }}
                          />
                          <span className={`${styles.rowSub} ${styles.simpleId}`}>
                            {r.playerNumber ? `ID: ${r.playerNumber}` : 'ID Unavailable'}
                          </span>
                        </span>
                        {/* The record stays a real link for the keyboard and
                            for assistive technology (Enter opens it). A tap is
                            the row's: one selects, two open. */}
                        <Link
                          className={styles.rowInfo}
                          to={`/clubs/${clubParam}/members/${r.userId}`}
                          aria-label={`Manage ${r.name}`}
                          onClick={(event) => {
                            if (event.detail === 0) {
                              // A keyboard activation: open the record.
                              event.stopPropagation();
                              return;
                            }
                            event.preventDefault();
                          }}
                        >
                          <span className={styles.rowName}>
                            {r.name}
                            {r.isSelf ? <span className={styles.rowYou}>You</span> : null}
                          </span>
                          {pendingCashouts.playerIds.has(r.userId) && (
                            <span className={styles.rowCashoutRequested}>Cash Out Requested</span>
                          )}
                          {advanced && (
                            <span className={styles.rowSub}>
                              {titleCase(roleLabel(r.role as ClubRole))}
                              {r.username ? ` · @${r.username}` : ''}
                            </span>
                          )}
                        </Link>
                        <span className={styles.rosterWallet}>
                          {canHoldAgentWallet(r.role) && (
                            <span className={styles.rosterBalanceLine}>
                              <span className={styles.rowSub}>Agent Wallet</span>
                              <strong className={styles.rowBalance}>
                                {rosterWalletBalances[r.userId]?.agent_wallet === undefined
                                  ? 'Unavailable'
                                  : formatWalletChips(rosterWalletBalances[r.userId].agent_wallet!)}
                              </strong>
                            </span>
                          )}
                          {holdsPlayerWallet(r.role) && (
                            <span className={styles.rosterBalanceLine}>
                              <span className={styles.rowSub}>Player Wallet</span>
                              <strong className={styles.rowBalance}>
                                {formatWalletChips(r.chipBalance)}
                              </strong>
                            </span>
                          )}
                        </span>
                      </div>
                    );
                  })}
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
                  hidden={!advanced}
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
                {/* ONE FRAME (Dan 2026-10-15: "THE ENTIRE SELECTED BOX AND THE
                CLAIM BACK SEND TICKET SEND OUT SHOULD BE ONE FRAME"). The
                selection line prints into the top of the same painted frame
                as the three actions, so there is no generic box behind it. */}
                {/* Footer actions — pinned */}
                <div className={`${styles.footer} ${styles.actionBar}`}>
                  <div className={styles.selBar} role="status">
                    <span>
                      {selected.size > 0
                        ? `${selected.size.toLocaleString()} Selected \u00b7 ${formatWalletChips(pickedHeld)} Held`
                        : 'Tap A Player To Select'}
                    </span>
                    {selected.size > 0 ? (
                      <button
                        type="button"
                        className={styles.selClear}
                        onClick={() => setSelected(new Set())}
                      >
                        Clear
                      </button>
                    ) : null}
                  </div>
                  <div className={styles.actionButtons}>
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
                        setClaimRecipient(picked.length === 1 ? picked[0].userId : null);
                        setMgmtClaimAmount('');
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
                  <span className={styles.sectionEyebrow}>
                    {historyBook === 'club' ? 'All Club Transactions' : 'My Transactions'}
                  </span>
                  <h2 className={styles.sectionTitle} id="ledger-title">
                    Transaction History
                  </h2>
                </div>
                {/* The Simple view has no tab strip, so the way in (the
                heading of Players) is also the way back. A player has no
                Players desk to return to. */}
                {!advanced && myRole !== 'player' ? (
                  <button
                    type="button"
                    className={styles.historyLink}
                    onClick={() => setTab('trade')}
                  >
                    Players
                  </button>
                ) : (
                  <span className={styles.sectionMeta}>Newest Entries First</span>
                )}
              </div>

              {(() => {
                // Which books this viewer may choose between. A player has one.
                const books: ReadonlyArray<readonly [HistoryBook, string]> = !roleResolved
                  ? []
                  : isClubStaffRole(myRole)
                    ? [
                        ['club', 'All Club Transactions'],
                        ['mine', 'My Transactions'],
                      ]
                    : isAgentRole(myRole)
                      ? [
                          ['mine', 'My Transactions'],
                          ['downline', 'My Downline'],
                        ]
                      : [];
                return books.length > 0 ? (
                  <div
                    className={styles.ledgerFilters}
                    role="group"
                    aria-label="Choose Which Transactions To Show"
                  >
                    {books.map(([scope, label]) => (
                      <button
                        key={scope}
                        type="button"
                        className={`${styles.ledgerFilter} ${historyBook === scope ? styles.ledgerFilterActive : ''}`}
                        aria-pressed={historyBook === scope}
                        onClick={() => {
                          if (scope === historyBook) return;
                          setHistoryPerson(null);
                          setHistoryScope(scope);
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                ) : null;
              })()}

              <div className={styles.ledgerFilters} role="group" aria-label="Filter By Type">
                {HISTORY_KINDS.map(([kind, label]) => (
                  <button
                    key={kind}
                    type="button"
                    className={`${styles.ledgerFilter} ${historyKind === kind ? styles.ledgerFilterActive : ''}`}
                    aria-pressed={historyKind === kind}
                    onClick={() => {
                      if (kind === historyKind) return;
                      setHistoryKind(kind);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className={styles.ledgerFilters} role="group" aria-label="Filter By Date">
                {HISTORY_RANGES.map(([range, label]) => (
                  <button
                    key={range}
                    type="button"
                    className={`${styles.ledgerFilter} ${historyRange === range ? styles.ledgerFilterActive : ''}`}
                    aria-pressed={historyRange === range}
                    onClick={() => {
                      if (range === historyRange) return;
                      setHistoryRange(range);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* ONE PLAYER INSIDE MY DOWNLINE (Dan 2026-10-24): an agent can
              narrow his downline book to one of his players, with that
              player's own totals. The server refuses anyone outside it. */}
              {historyBook === 'downline' && downlinePeople.length > 0 ? (
                <label className={styles.historyPerson}>
                  <span className="sc-label sc-ink--blue">Player</span>
                  <select
                    className={styles.historyPersonSelect}
                    value={historyPerson ?? ''}
                    onChange={(event) => setHistoryPerson(event.target.value || null)}
                    aria-label="Show One Player In My Downline"
                  >
                    <option value="">Whole Downline</option>
                    {downlinePeople.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {/* TRUE TOTALS from the server over the whole filtered book: one
              wallet, a downline as one group, or the whole club. Never the rows
              on screen, never a 0 that could not be read. */}
              {(() => {
                const ready =
                  historyTotalsState === 'ready' &&
                  historyTotals?.filterKey === historySummaryKey &&
                  historyTotals;
                if (historyBook === 'club') {
                  const club = ready && historyTotals.mode === 'club' ? historyTotals : null;
                  return (
                    <div
                      className={styles.ledgerSummary}
                      aria-label="Club Totals For These Filters"
                    >
                      <div className={styles.summaryCell}>
                        <span className={styles.summaryLabel}>Entries</span>
                        <strong className={styles.summaryValue}>
                          {club ? club.entries.toLocaleString() : '--'}
                        </strong>
                      </div>
                      <div className={styles.summaryCell}>
                        <span className={styles.summaryLabel}>Chips Moved</span>
                        <strong className={styles.summaryValue}>
                          {club ? fmt(club.volume) : '--'}
                        </strong>
                      </div>
                      <div className={styles.summaryCell}>
                        <span className={styles.summaryLabel}>Cash-Outs Paid</span>
                        <strong className={`${styles.summaryValue} ${styles.amtOut}`}>
                          {club ? fmt(club.cashoutsPaid) : '--'}
                        </strong>
                      </div>
                      {club && !club.complete ? (
                        <span className={styles.summaryNote} role="status">
                          Adding Up Earlier Days...
                        </span>
                      ) : null}
                    </div>
                  );
                }
                const wallet = ready && historyTotals.mode !== 'club' ? historyTotals : null;
                const who = historyPersonName
                  ? 'Player'
                  : historyBook === 'downline'
                    ? 'Downline'
                    : 'My';
                return (
                  <div
                    className={styles.ledgerSummary}
                    aria-label={
                      historyPersonName
                        ? `${historyPersonName} Totals For These Filters`
                        : historyBook === 'downline'
                          ? 'My Downline Totals For These Filters'
                          : 'My Wallet Totals For These Filters'
                    }
                  >
                    <div className={styles.summaryCell}>
                      <span className={styles.summaryLabel}>{who} In</span>
                      <strong className={`${styles.summaryValue} ${styles.amtIn}`}>
                        {wallet ? `+${fmt(wallet.incoming)}` : '--'}
                      </strong>
                    </div>
                    <div className={styles.summaryCell}>
                      <span className={styles.summaryLabel}>{who} Out</span>
                      <strong className={`${styles.summaryValue} ${styles.amtOut}`}>
                        {wallet
                          ? wallet.outgoing > 0
                            ? `-${fmt(wallet.outgoing)}`
                            : fmt(0)
                          : '--'}
                      </strong>
                    </div>
                    <div className={styles.summaryCell}>
                      <span className={styles.summaryLabel}>{who} Net</span>
                      <strong
                        className={`${styles.summaryValue} ${
                          wallet ? (wallet.net >= 0 ? styles.amtIn : styles.amtOut) : ''
                        }`}
                      >
                        {wallet
                          ? `${wallet.net >= 0 ? '+' : '-'}${fmt(Math.abs(wallet.net))}`
                          : '--'}
                      </strong>
                    </div>
                  </div>
                );
              })()}
              {historyTotalsState === 'unavailable' ? (
                <div className={styles.empty} role="status">
                  Totals Could Not Be Read.{' '}
                  <button
                    type="button"
                    className={styles.retryBtn}
                    onClick={() => setRecordsReload((value) => value + 1)}
                  >
                    Retry
                  </button>
                </div>
              ) : null}

              <div className={styles.ledgerToolbar}>
                <input
                  className={styles.ledgerSearch}
                  type="search"
                  value={recordQuery}
                  onChange={(event) => setRecordQuery(event.target.value)}
                  placeholder="Search A Name Or Invoice Number"
                  aria-label="Search Transaction History"
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
                {recordsLoading && <div className={styles.empty}>Loading Transactions...</div>}
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
                      ? historySearch
                        ? 'Nothing Matches That Name Or Invoice Number.'
                        : historyKind === 'all' && historyRange === 'all' && !historyPerson
                          ? 'No Transactions Recorded Yet.'
                          : 'No Transactions Match These Filters.'
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
                      aria-label={`Open Receipt For ${r.title ? r.title : `${r.direction === 'managed' ? 'Managed Transfer' : r.direction === 'out' ? 'Payment To' : 'Payment From'} ${r.counterparty}`}, ${fmt(r.amount)} Chips`}
                    >
                      <div className={styles.rowInfo}>
                        <span className={styles.rowName}>
                          {r.title ? (
                            r.title
                          ) : (
                            <>
                              {r.direction === 'managed'
                                ? r.twoSided
                                  ? 'Transfer '
                                  : ''
                                : r.direction === 'out'
                                  ? 'To '
                                  : 'From '}
                              {r.counterparty}
                            </>
                          )}
                        </span>
                        <span className={styles.rowSub}>
                          {r.type === 'cashout_request_escrow' &&
                          cashoutStatusLabel(r.requestStatus) === 'Waiting' ? (
                            <>
                              <span className={styles.waitTag}>
                                {waitingFor(r.requestCreatedAt ?? r.createdAt)}
                              </span>{' '}
                              &middot;{' '}
                            </>
                          ) : null}
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
                {!recordsLoading && !recordsError && recordsHasMore && (
                  <button
                    type="button"
                    className={styles.loadMore}
                    onClick={() => void loadOlderRecords()}
                    disabled={recordsLoadingMore}
                    aria-busy={recordsLoadingMore}
                  >
                    {recordsLoadingMore ? 'Loading Older Entries...' : 'Load 50 Older Entries'}
                  </button>
                )}
                <button
                  type="button"
                  className={styles.classicLink}
                  onClick={() => navigate(`/clubs/${clubParam}/cashier/statements`)}
                >
                  Full Statement
                </button>
                <button
                  type="button"
                  className={styles.classicLink}
                  disabled={historyExporting || !isOnline}
                  aria-busy={historyExporting}
                  onClick={() => void exportHistory()}
                >
                  {historyExporting ? 'Preparing Download...' : 'Download These Transactions'}
                </button>
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
                        Rake Funding {formatWeeklyChipsForDisplay(iv.rakeFunding)}
                        <br />
                        Paid By Club {formatWeeklyChipsForDisplay(iv.paidByClub)}
                      </span>
                      <span className={styles.rowBalance}>
                        Retained {formatWeeklyChipsForDisplay(iv.retainedByClub)}
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
            </div>
            <CashierConservationReport
              key={`${user?.id}:${clubUuid}:${myRole}`}
              userId={user?.id}
              clubId={clubUuid}
              role={myRole}
              ready={roleResolved && !loadError && !isHydrating}
              online={isOnline}
              getAuthorityEpoch={() => transferAuthorityEpoch.current}
              onRefresh={reconcileCashier}
              actionClassName={styles.reconcileBtn}
            />
            <div className={styles.recoveryGrid}>
              <div className={styles.recoveryMetric}>
                <span>Connection</span>
                <strong className={isOnline ? styles.integrityGood : styles.integrityBad}>
                  {isOnline ? 'Online' : 'Offline'}
                </strong>
              </div>
              <div className={styles.recoveryMetric}>
                <span>Balances Refreshed</span>
                <strong>{lastVerifiedLabel}</strong>
              </div>
              <div className={styles.recoveryMetric}>
                <span>Action Queue</span>
                <strong>{(pendingCount + heldTicketCount).toLocaleString()} Waiting</strong>
              </div>
            </div>
          </section>
        </div>
      </CashierWorkspace>

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
              onClose={() => setReceipt(null)}
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
                    {exactChipFigure(receipt.amount)}
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
                  {cashoutStatusLabel(receipt.requestStatus) ? (
                    <div>
                      <dt className="sc-label sc-ink--blue">Cash-Out</dt>
                      <dd className="sc-ink--silver">
                        {receipt.type === 'cashout_request_escrow' &&
                        cashoutStatusLabel(receipt.requestStatus) === 'Waiting'
                          ? waitingFor(receipt.requestCreatedAt ?? receipt.createdAt)
                          : cashoutStatusLabel(receipt.requestStatus)}
                      </dd>
                    </div>
                  ) : null}
                  {receipt.invoiceNumber ? (
                    <div>
                      <dt className="sc-label sc-ink--blue">Invoice</dt>
                      <dd className="sc-ink--silver">{receipt.invoiceNumber}</dd>
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
              onClose={asking ? undefined : () => setAskOpen(false)}
              eyebrow="Funding Request"
              title="Request Chips"
              titleId="cashier-ask-title"
              pill={asking ? 'Sending' : 'Ready'}
              pillInk={asking ? 'blue' : 'green'}
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
                  type="text"
                  inputMode="decimal"
                  min={0}
                  value={formatCashierAmountInput(askAmount)}
                  step="0.01"
                  aria-label="Chips Requested"
                  onChange={(e) => setAskAmount(cashierAmountInputValue(e.target.value))}
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
          // Closing a dialog never reloads or resets the working page.
          setActiveCashier(null);
          setCashierPreset(null);
        }}
        clubId={clubUuid || clubParam || ''}
        role={myRole}
        walletType={activeCashier || DEFAULT_CASHIER_WALLET}
        initialRecipientId={cashierPreset?.recipientId ?? null}
        initialDestination={cashierPreset?.destination ?? null}
      />

      {clubUuid && user?.id && (
        <CashoutRequestModal
          key={`${user.id}:${clubUuid}`}
          isOpen={showCashoutRequest}
          onClose={() => setShowCashoutRequest(false)}
          playerId={user.id}
          clubId={clubUuid}
          currentBalance={loading ? null : myBalance}
          onComplete={() => void loadClub(true)}
        />
      )}

      {showCashoutQueue && managementClaims && clubUuid && (
        <div className={styles.modalOverlay} onClick={() => setShowCashoutQueue(false)}>
          <div
            className={styles.consoleDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-cashout-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <AgentCashoutPanel
              clubId={clubUuid}
              eyebrow="Club Cashier"
              onClose={() => setShowCashoutQueue(false)}
              onCashoutProcessed={() => {
                pendingCashouts.reload();
                void loadClub(true);
              }}
            />
          </div>
        </div>
      )}

      {/* Amount modal */}
      {amountModal && (
        <div
          className={styles.modalOverlay}
          onClick={() => {
            if (busy || diamondSending) return;
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
              onClose={
                busy || diamondSending
                  ? undefined
                  : () => {
                      setAmountModal(null);
                      setTransferFailures([]);
                    }
              }
              eyebrow={`${compactChips(picked.length)} Player${picked.length === 1 ? '' : 's'} · ${fmt(previewTotal)} Total`}
              title={
                amountModal === 'send'
                  ? 'Send Out'
                  : amountModal === 'ticket'
                    ? 'Send Ticket'
                    : 'Send Diamonds'
              }
              titleId="cashier-amount-title"
              pill={busy ? 'Working' : 'Ready'}
              pillInk={busy ? 'blue' : 'green'}
              foot={amountModal === 'diamonds' ? 'foot' : 'plates'}
              className={styles.console}
              plates={
                amountModal === 'diamonds'
                  ? undefined
                  : {
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
                        disabled:
                          !isOnline ||
                          breakFrozen ||
                          picked.length === 0 ||
                          cashierAuthorityBlocked ||
                          (amountModal === 'send' && selectedSourceBalance === null) ||
                          (amountModal === 'ticket' && !ticketTournament) ||
                          !canHoldAgentWallet(myRole),
                        onClick: () => void runTransfers(amountModal),
                      },
                    }
              }
            >
              <div className={styles.glass}>
                <div className={styles.modalActions} aria-label="Player Transfer Actions">
                  <button
                    type="button"
                    disabled={busy || diamondSending || Boolean(transferRecovery)}
                    onClick={() => setAmountModal('send')}
                  >
                    Send Out
                  </button>
                  <button
                    type="button"
                    disabled={busy || diamondSending || Boolean(transferRecovery)}
                    onClick={() => {
                      setClaimRecipient(picked.length === 1 ? picked[0].userId : null);
                      setAmountModal(null);
                      setClaimOpen(true);
                    }}
                  >
                    Claim Back
                  </button>
                  <button
                    type="button"
                    disabled={busy || diamondSending || Boolean(transferRecovery)}
                    onClick={() => setAmountModal('ticket')}
                  >
                    Send Ticket
                  </button>
                  <button
                    type="button"
                    disabled={
                      busy || diamondSending || Boolean(transferRecovery) || picked.length !== 1
                    }
                    onClick={() => setAmountModal('diamonds')}
                  >
                    Send Diamonds
                  </button>
                </div>
                {(() => {
                  const sourceLabel =
                    amountModal === 'ticket'
                      ? 'From Your Player Wallet'
                      : amountModal === 'send'
                        ? `From ${SEND_SOURCE_LABELS[sendSource]}`
                        : null;
                  const sourceBalance =
                    amountModal === 'ticket' ? myBalance : selectedSourceBalance;
                  return (
                    <>
                      {picked.length === 1 && (
                        <CashierPlayerCard
                          row={picked[0]}
                          balanceLabel={
                            amountModal === 'send'
                              ? SEND_DESTINATION_LABELS[transferDestination(picked[0])]
                              : 'Player Wallet'
                          }
                          walletControl={
                            amountModal === 'send' ? recipientWalletControl(picked[0]) : undefined
                          }
                          walletBalance={
                            amountModal === 'send'
                              ? (targetBalances[picked[0].userId]?.[
                                  transferDestination(picked[0])
                                ] ?? null)
                              : undefined
                          }
                        />
                      )}
                      {sourceLabel && (
                        <CashierWalletRow label={sourceLabel} balance={sourceBalance}>
                          {amountModal === 'send' && (
                            <select
                              className={styles.walletSelect}
                              aria-label="Send From"
                              value={sendSource}
                              disabled={busy || Boolean(transferRecovery)}
                              onChange={(event) => {
                                setSendSource(event.target.value as SendSource);
                                setTransferFailures([]);
                              }}
                            >
                              {availableSendSources.map((source) => (
                                <option key={source} value={source}>
                                  From {SEND_SOURCE_LABELS[source]}:{' '}
                                  {sourceBalanceFor(source) === null
                                    ? 'Unavailable'
                                    : formatWalletChips(sourceBalanceFor(source)!)}
                                </option>
                              ))}
                            </select>
                          )}
                        </CashierWalletRow>
                      )}
                    </>
                  );
                })()}
                {amountModal === 'diamonds' && user?.id && picked.length === 1 ? (
                  <DiamondWalletTransfer
                    key={`${user?.id}:${picked[0].userId}`}
                    userId={user.id}
                    initialRecipientId={picked[0].userId}
                    initiallyOpen
                    onBusyChange={setDiamondSending}
                    onComplete={() =>
                      masterBus.emit('BALANCE_UPDATED', { source: 'cashier-diamonds' })
                    }
                  />
                ) : (
                  <>
                    {amountModal === 'ticket' ? (
                      /* SEND TICKET INTO ONE TOURNAMENT (Dan 2026-10-15). The
                         list is every future or running event this club's
                         cashier may ticket; the price is the server's. */
                      <label className={styles.entryRow}>
                        <span className={styles.entryRowSlot}>Event</span>
                        <span className={styles.entryRowPlate}>
                          <select
                            className={styles.entrySelect}
                            aria-label="Tournament"
                            value={ticketTournamentId}
                            disabled={busy || ticketTournaments === null}
                            onChange={(event) => {
                              setTicketTournamentId(event.target.value);
                              if (transferFailures.length) setTransferFailures([]);
                            }}
                          >
                            <option value="">
                              {ticketTournamentsError
                                ? 'Tournaments Unavailable'
                                : ticketTournaments === null
                                  ? 'Loading Tournaments'
                                  : ticketTournaments.length === 0
                                    ? 'No Open Tournaments'
                                    : 'Choose A Tournament'}
                            </option>
                            {retainedTicketTournament ? (
                              <option value={retainedTicketTournament.tournamentId}>
                                {retainedTicketTournament.name} ·{' '}
                                {exactChipFigure(retainedTicketTournament.price)}
                              </option>
                            ) : null}
                            {(ticketTournaments ?? []).map((row) => (
                              <option key={row.tournamentId} value={row.tournamentId}>
                                {titleCase(row.name)}
                                {row.startTime
                                  ? ` · ${new Date(row.startTime).toLocaleString([], {
                                      month: 'short',
                                      day: 'numeric',
                                      hour: 'numeric',
                                      minute: '2-digit',
                                    })}`
                                  : ''}
                                {row.status === 'RUNNING' ? ' · Late Reg' : ''}
                                {` · ${exactChipFigure(row.price)}`}
                              </option>
                            ))}
                          </select>
                        </span>
                      </label>
                    ) : (
                      <label className={styles.entryRow}>
                        <span className={styles.entryRowSlot}>Amount</span>
                        <span className={styles.entryRowPlate}>
                          <input
                            className={styles.entryInput}
                            type="text"
                            inputMode="decimal"
                            aria-label="Amount"
                            aria-invalid={uniformAmountInvalid}
                            aria-describedby="cashier-amount-validation"
                            value={formatCashierAmountInput(uniformAmountValue)}
                            disabled={busy}
                            onChange={(e) => {
                              setAmount(cashierAmountInputValue(e.target.value));
                              setRecipientAmounts({});
                              if (transferFailures.length) setTransferFailures([]);
                            }}
                            placeholder="Enter Amount"
                            autoFocus
                          />
                        </span>
                      </label>
                    )}
                    {walletBalancesError && amountModal === 'send' && (
                      <p role="alert">{walletBalancesError}</p>
                    )}
                    {amountModal === 'send' &&
                      picked.length > 1 &&
                      picked.map((r) => (
                        <div key={`wallet-${r.userId}`}>
                          <CashierPlayerCard
                            row={r}
                            balanceLabel={SEND_DESTINATION_LABELS[transferDestination(r)]}
                            walletControl={recipientWalletControl(r)}
                            walletBalance={
                              targetBalances[r.userId]?.[transferDestination(r)] ?? null
                            }
                          />
                          <label className={styles.entryRow}>
                            <span className={styles.entryRowSlot}>Amount</span>
                            <span className={styles.entryRowPlate}>
                              <input
                                className={styles.entryInput}
                                type="text"
                                inputMode="decimal"
                                aria-label={`Amount For ${r.name}`}
                                aria-invalid={!batchPlan.ok && batchPlan.userId === r.userId}
                                aria-describedby="cashier-amount-validation"
                                disabled={busy}
                                value={formatCashierAmountInput(
                                  recipientAmounts[r.userId] ?? amount
                                )}
                                onChange={(event) => {
                                  setRecipientAmounts((previous) => ({
                                    ...previous,
                                    [r.userId]: cashierAmountInputValue(event.target.value),
                                  }));
                                  setTransferFailures([]);
                                }}
                              />
                            </span>
                          </label>
                        </div>
                      ))}
                    {/* WHO, WHEN THERE IS MORE THAN ONE (Dan 2026-08-25). On a
                        375px screen the selection has scrolled out of view, so
                        every recipient is named with its own amount. */}
                    {picked.length > 1 && amountModal !== 'send' && (
                      <div className={styles.modalTargets}>
                        {picked.map((r) => (
                          <div className={styles.modalTargetRow} key={r.userId}>
                            <img
                              className={styles.modalTargetAvatar}
                              src={r.avatarUrl || generateAvatarSvg(r.userId, r.name || '?')}
                              alt=""
                            />
                            <span className={styles.modalTargetName}>
                              {r.name}
                              <small>
                                {r.playerNumber ? `ID: ${r.playerNumber}` : 'ID Unavailable'}
                              </small>
                            </span>
                            <span>
                              {exactChipFigure(batchPlan.ok ? batchPlan.amounts[r.userId] : 0)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className={styles.modalTotal}>Total: {exactChipFigure(previewTotal)}</div>
                    <div id="cashier-amount-validation" className={styles.modalHint} role="status">
                      {breakFrozen
                        ? PLATFORM_FROZEN_MESSAGE
                        : !batchPlan.ok
                          ? amountModal === 'ticket'
                            ? batchPlan.error
                            : `Amount For ${picked.find((row) => row.userId === batchPlan.userId)?.name || 'Cashier Recipient'}: ${batchPlan.error}`
                          : cashierAuthorityBlocked || !canHoldAgentWallet(myRole)
                            ? ''
                            : amountModal === 'send' && selectedSourceBalance === null
                              ? 'Selected Wallet Could Not Be Verified'
                              : batchPlan.total >
                                  (amountModal === 'send'
                                    ? (selectedSourceBalance ?? Number.POSITIVE_INFINITY) +
                                      (sendSource === 'agent_wallet' ? agentCredit : 0)
                                    : myBalance)
                                ? 'Insufficient Chips In The Funding Wallet'
                                : ''}
                    </div>
                    {transferFailures.length > 0 && (
                      <div className={styles.modalFailures} role="alert">
                        <div className={styles.modalFailuresTitle}>
                          {transferRecovery
                            ? `${transferRecovery.failures.length} Need Outcome Verification`
                            : `${transferFailures.length} Transfers Refused`}
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
                  </>
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
            if (claimingId || mgmtClaiming) return;
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
              onClose={claimingId || mgmtClaiming ? undefined : () => setClaimOpen(false)}
              eyebrow={managementClaims ? 'Into The Club Bank' : 'Ten Minute Reversal'}
              title="Claim Back"
              titleId="cashier-claim-title"
              pill={
                claimingId || mgmtClaiming ? 'Working' : managementClaims ? 'Any Time' : 'Limited'
              }
              pillInk={claimingId || mgmtClaiming ? 'blue' : managementClaims ? 'blue' : 'red'}
              foot={managementClaimTarget ? 'plates' : 'foot'}
              plates={
                managementClaimTarget
                  ? {
                      secondary: {
                        label: 'Cancel',
                        disabled: mgmtClaiming,
                        onClick: () => setClaimOpen(false),
                      },
                      primary: {
                        label: 'Claim Back',
                        ink: 'red',
                        disabled:
                          !isOnline ||
                          breakFrozen ||
                          mgmtClaiming ||
                          cashierAuthorityBlocked ||
                          !parseTradeAmount(mgmtClaimAmount).ok,
                        onClick: () => void claimToBank(managementClaimTarget),
                      },
                    }
                  : undefined
              }
              className={styles.console}
            >
              <div className={styles.glass}>
                {/* OWNERS, CO OWNERS AND ADMINS CLAIM BACK AT ANY POINT (Dan
                    2026-10-15). Any amount the player holds, straight into the
                    Club Bank, on fn_club_bank_claim_back. Every other role keeps
                    the ten minute reversal below. */}
                {managementClaims && managementClaimTarget && (
                  <>
                    <CashierPlayerCard row={managementClaimTarget} balanceLabel="Player Wallet" />
                    <CashierWalletRow label="Into The Club Bank" balance={bankBalance} />
                    <label className={styles.entryRow}>
                      <span className={styles.entryRowSlot}>Amount</span>
                      <span className={styles.entryRowPlate}>
                        <input
                          className={styles.entryInput}
                          type="text"
                          inputMode="decimal"
                          min={0}
                          step="0.01"
                          aria-label="Claim Back Amount"
                          value={formatCashierAmountInput(mgmtClaimAmount)}
                          disabled={mgmtClaiming}
                          onChange={(event) =>
                            setMgmtClaimAmount(cashierAmountInputValue(event.target.value))
                          }
                          placeholder="Enter Amount"
                          autoFocus
                        />
                      </span>
                    </label>
                    <button
                      type="button"
                      className={styles.claimAll}
                      disabled={mgmtClaiming || managementClaimTarget.chipBalance <= 0}
                      onClick={() =>
                        setMgmtClaimAmount(
                          String(Math.floor(managementClaimTarget.chipBalance * 100) / 100)
                        )
                      }
                    >
                      Claim All {formatWalletChips(managementClaimTarget.chipBalance)}
                    </button>
                  </>
                )}
                {managementClaims && !managementClaimTarget && (
                  <div className={styles.modalHint}>
                    Select One Player To Claim Back Any Amount.
                  </div>
                )}
                {!managementClaimTarget && reversibleLoading && (
                  <div className={styles.empty}>Reading Your Recent Sends...</div>
                )}
                {!managementClaimTarget && !reversibleLoading && reversibleError && (
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
                {!managementClaimTarget &&
                  !reversibleLoading &&
                  !reversibleError &&
                  stillClaimable.filter(
                    (row) => !claimRecipient || row.to_user_id === claimRecipient
                  ).length === 0 && (
                    <div className={styles.empty}>
                      {
                        'Nothing Is Still Inside Its Ten Minute Window. Ask The Player To Request A Cash Out.'
                      }
                    </div>
                  )}
                {!managementClaimTarget &&
                  !reversibleLoading &&
                  !reversibleError &&
                  stillClaimable.length > 0 && (
                    <div className={styles.claimList}>
                      {stillClaimable
                        .filter((row) => !claimRecipient || row.to_user_id === claimRecipient)
                        .map((row) => {
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
                              <img
                                className={styles.modalTargetAvatar}
                                src={
                                  rosterById.get(row.to_user_id)?.avatarUrl ||
                                  generateAvatarSvg(row.to_user_id, row.to_name || '?')
                                }
                                alt=""
                              />
                              <div className={styles.rowInfo}>
                                <span className={styles.rowName}>{row.to_name}</span>
                                <span className={styles.rowSub}>
                                  {row.destination === 'promo_wallet'
                                    ? 'Promo Wallet'
                                    : row.destination === 'agent_wallet'
                                      ? 'Agent Wallet'
                                      : 'Player Wallet'}{' '}
                                  &middot; {mm}:{ss} Left
                                </span>
                              </div>
                              <span className={styles.rowBalance}>
                                {formatWalletChips(row.remaining)}
                              </span>
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
                {!managementClaimTarget && (
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
                )}
              </div>
            </SpadeConsole>
          </div>
        </div>
      )}
    </div>
  );
}
