import {
  claimReturnWallets,
  CLAIM_DESTINATION_LABELS,
  type ClaimDestination,
} from './claimReturnWallets';
import { formatCashierAmountInput, cashierAmountInputValue } from '../../utils/cashierAmount';
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CLUB BANK CASHIER (Dan 2026-08-23, BINDING; Claim Back + Promo Send 2026-08-24)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "INSIDE THE CLUB ARENA FOR CLUB OWNERS, IF THEY CLICK ON CLUB BANK, THAT
 *  SHOULD OPEN THE CLUB BANK CASHIER. THATS WHERE OWNERS, CO OWNERS, ADMINS
 *  AND SUPER AGENTS SHOULD BE SENDING INITIAL CHIPS FROM TO FUND AGENT
 *  WALLETS. THERE MUST BE A FULL TRANSACTION LEDGER FOR EVERY SINGLE CHIP
 *  MOVEMENT. ONLY THOSE ROLES HAVE ACCESS TO THE CLUB BANK OR SHOULD EVEN SEE
 *  THE CLUB BANK."
 *
 * Dan 2026-08-24, three additions, all law:
 *  - "CLUB BANK NEEDS THE ABILITY TO CLAIM BACK, NOT JUST SEND OUT." The
 *    Claim Back tab pulls chips FROM an agent, promo or player wallet back
 *    INTO the bank, through fn_club_bank_claim_back — which refuses to take
 *    any wallet negative.
 *  - "PROMO WALLET NEEDS THE ABILITY TO SEND TO PLAYER WALLETS OR AGENT
 *    WALLETS." To a player it is JUST AS GOOD AS CASH (credits chip_balance);
 *    to an agent it lands in THEIR promo wallet. fn_promo_wallet_send.
 *  - The mode rules live in cashierModes.ts so a unit test can pin them.
 *
 * The Club Bank is `clubs.chip_treasury` — the same figure DynamicWallet has
 * always shown as "Club Bank", so this cashier spends the money on screen
 * rather than a second account nobody can see.
 *
 * ── WHY EVERY RULE IS ALSO ON THE SERVER ────────────────────────────────────
 * This component hides what a role may not use. It does not DECIDE it.
 *   fn_can_use_club_bank  — owner / co_owner / admin / super_agent; the ledger
 *                           refuses anyone else outright rather than filtering,
 *                           so there is nothing to leak;
 *   fn_club_bank_send     — re-checks the role, locks the club row, refuses an
 *                           overdraft, and writes the ledger row in the SAME
 *                           transaction as the two balance updates;
 *   fn_club_bank_claim_back — the same, in the other direction;
 *   fn_promo_wallet_send  — spends only the CALLER's own promo float;
 *   fn_club_promo_wallet_send — spends the CLUB's promo pot (clubs.promo_balance),
 *                           Club Bank roles only; which of the two this cashier
 *                           stands at is promoSourceFor(role) in cashierModes.ts
 *                           (Dan 2026-09-05, see docs/LAWS.md Resolved conflicts);
 *   fn_club_bank_reverse  — puts the chips back and writes a MATCHING ROW;
 *   fn_mint_chips_from_diamonds — refuses any club that is in a union.
 * Closing this modal with devtools buys nothing.
 *
 * ── IDEMPOTENCY ────────────────────────────────────────────────────────────
 * Every send carries an `op_id` generated ONCE per attempt and reused on every
 * retry of that attempt. A unique index on (club_id, metadata->>'op_id')
 * makes the second delivery a no-op that reports the first one's result. This
 * repo has paid for that lesson three times at three different sites
 * (tests/config/walletCreditIntegrity.test.ts), and a cashier is the worst
 * possible place to learn it a fourth.
 *
 * ── CHIP MINT ──────────────────────────────────────────────────────────────
 * "THE ABILITY TO MINT CHIPS MUST DISAPPEAR ONCE THEY ARE A PART OF A UNION.
 *  IF IT IS A STAND ALONE CLUB, CHIP MINTING EXISTS INSIDE THEIR CLUB BANK."
 * So the mint entry point is here and nowhere else, and only when the club has
 * no union_id. In a union, chips flow DOWN from the union bank.
 *
 * ── ROLE SCOPED WALLETS (Dan 2026-08-25, binding) ──────────────────────────
 *
 * "If they simply just click cashier, this must always default to Agent and
 *  player wallets only... Super Agents, Agents, and Sub Agents should ONLY EVER
 *  SEE their downlines, and their downline agents' downlines - nobody else.
 *  Owners, Co Owners and Admins see everyone. Any chips sent or claimed back
 *  transact from the Agent Wallet."
 *
 * Three things changed here, and each was broken rather than merely missing:
 *
 *  - `walletType` now defaults to DEFAULT_CASHIER_WALLET ('agent_wallet'). It
 *    defaulted to 'club_bank', and all four mount points spelled that fallback
 *    out by hand, so a fifth would have copied it.
 *
 *  - loadMembers paged the ENTIRE club_members table with no scoping at all: a
 *    sub agent was offered the club owner as a recipient. It now reads
 *    fn_club_cashier_members, which walks the same downline edge the send RPC
 *    refuses on, so the list and the refusal cannot disagree.
 *
 *  - the agent send went through ChipFlowService.agentToPlayer, which capped
 *    against agents.agent_wallet_balance but debited `wallets`, wrote NO ledger
 *    row, had no idempotency key inside a three-attempt retry, and had its
 *    result hard-coded to `{ success: true }` here regardless of what happened.
 *    It is now fn_agent_wallet_send: one transaction, one ledger row, one
 *    op_id, and a ten minute clawback window the Claim Back tab can act on.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useIsMounted } from '../../hooks/useIsMounted';
import { masterBus } from '../../core/MasterBus';
import { useToast } from '../common/Toast';
import { useRecentRecipients } from '../../hooks/useRecentRecipients';
import { fuzzyMatch } from '../../utils/fuzzyMatch';

import { reportError } from '../../utils/errorReporter';
import {
  reserveCashierWalletOperation,
  clearCashierWalletOperation,
} from '../../services/CashierWalletRecovery';
import { readCashierBalances } from '../../services/cashierBalanceRead';
import { useVisibleRead } from '../../hooks/useVisibleRead';
import { roleLabel, normaliseRole, roleRank } from '../../types/clubRoles';
import { canMintInClubBank, canHoldAgentWallet, holdsPlayerWallet } from './walletRows';
import {
  cashierTabs,
  cashierDestinations,
  canUseCashier,
  claimNeedsConfirm,
  cashierRefusesSelfSend,
  secondsLeftFromServer,
  DEFAULT_CASHIER_WALLET,
  promoSourceFor,
  promoSendRpc,
  promoLedgerScope,
  promoBalanceLabel,
  type CashierTab,
  type CashierDestination,
  type CashierWalletType,
  type PromoSource,
} from './cashierModes';
import { cashierRecipientBlock } from '../../lib/cashierRoster';
import { SpadeConsole } from '../console/SpadeConsole';
import { enumToTitleCase, titleCase } from '../../utils/titleCase';
import ChipMintModal from './ChipMintModal';
import './WalletCashierModal.css';
import { CashierFrameBalance } from './CashierFrameBalance';
import transferStyles from '../../pages/CashierTradePage.module.css';
import { downloadBlob } from '../../utils/downloadCsv';
import { statementCsvCell } from '../../utils/cashierStatementCsv';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { compactChips, formatWalletChips } from '../../utils/format';
import { generateAvatarSvg } from '../../utils/avatarGenerator';
import { safeErrorMessage } from '../../utils/safeErrorMessage';

type DestinationWallet = CashierDestination;
type Tab = CashierTab;

const DESTINATION_LABELS: Record<DestinationWallet, string> = {
  agent_wallet: 'Agent Wallet',
  promo_wallet: 'Promo Wallet',
  player_wallet: 'Player Wallet',
};

const TAB_LABELS: Record<Tab, string> = {
  send: 'Send Chips',
  claim: 'Claim Back',
  ledger: 'Transaction Ledger',
};

/** Wallets only an agent-shaped member can hold. See canHoldAgentWallet. */
const AGENT_ONLY: DestinationWallet[] = ['agent_wallet', 'promo_wallet'];

/**
 * A send at or above this share of the bank asks a second time. Funding an
 * agent is routine; emptying the club's operating account in one tap because a
 * zero was mistyped is not, and the confirm costs one tap when it is genuinely
 * meant.
 */
const CONFIRM_SHARE_OF_BANK = 0.25;

const LEDGER_PAGE = 40;
/** Client-side cap on an export, so a 37,000-row ledger cannot hang a phone. */
const EXPORT_MAX = 200;

interface Member {
  user_id: string;
  username?: string;
  role: string;
  name: string;
  avatar_url?: string;
  short_id?: string;
  chip_balance?: number;
}

interface LedgerRow {
  id: string;
  created_at: string;
  amount: number;
  transaction_type: string;
  notes: string | null;
  balance_after: number | null;
  from_name: string | null;
  to_name: string | null;
  metadata: Record<string, unknown> | null;
  is_reversed: boolean;
  reversible: boolean;
}

interface LedgerTotals {
  into_bank: number;
  out_of_bank: number;
  net: number;
}

/**
 * One movement on a promo wallet, straight off fn_promo_wallet_ledger. The
 * same shape for the club pot and for an agent's own float, so one renderer
 * serves both; `direction` is relative to the wallet being looked at.
 */
interface PromoLedgerRow {
  id: string;
  created_at: string;
  amount: number;
  direction: 'in' | 'out';
  category: string;
  notes: string | null;
  balance_after: number | null;
  counterparty_type: string | null;
  counterparty_name: string | null;
  actor_name: string | null;
}

interface PromoLedgerTotals {
  in: number;
  out: number;
  net: number;
}

/**
 * One agent wallet send that is still inside its ten minute window, straight
 * off fn_agent_wallet_reversible. `seconds_left` is computed by the database so
 * a phone with a wrong clock cannot offer a claim the server will refuse.
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

interface WalletCashierModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Club code or UUID. Resolved internally, same as ChipMintModal. */
  clubId: string;
  /** The viewer's role in this club. Presentation only; the server re-checks. */
  role: string;
  walletType?: CashierWalletType;
  /**
   * Open the Send tab with this member already chosen, once the roster has
   * them - the Trade page's "To My Player Wallet" on the owner's own row
   * (Dan 2026-10-11). Only ever a preselection: the row still has to pass
   * blockFor, and the server re-checks everything.
   */
  initialRecipientId?: string | null;
  /** The wallet to open the Send tab on, when the cashier offers it. */
  initialDestination?: CashierDestination | null;
}

/** Wallet balances always retain cents and separators (Dan 2026-10-18).
 * Unknown and unreadable balances remain distinct from a verified zero.
 * Transactions and ledger aggregates use compactChips at their render sites. */
const fmtWallet = (n?: number | null) =>
  n === undefined || n === null ? '...' : Number.isFinite(n) ? formatWalletChips(n) : 'Unavailable';

/** The amount being moved, exactly: a confirmation or a receipt never abbreviates it. */
const fmtWhole = (n: number) => Math.round(n).toLocaleString('en-US');

/** An exact figure that may carry cents, such as the part of a send drawn on credit. */
const fmtExact = (n: number) =>
  (Number.isFinite(n) ? n : 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

/**
 * Append a ledger page, dropping rows already listed. The ledgers page by
 * OFFSET, so a row written between two pages shifts the next one and its
 * first rows repeat the last ones on screen (audit C2-17).
 */
function appendNew<T extends { id: string }>(listed: T[], page: T[]): T[] {
  const seen = new Set(listed.map((r) => r.id));
  return [...listed, ...page.filter((r) => !seen.has(r.id))];
}

/* "Club Bank Send" from "club_bank_send" is `enumToTitleCase`, the house
   transform in src/utils/titleCase.ts. A local copy lived here and lower-cased
   the tail of every word, so an initialism printed as "Bbj Promo Sweep". Names
   and notes that come out of a row go through `titleCase` where they print. */

/** A refusal the server answered with: the move did not happen. */
class CashierRefusal extends Error {}

/**
 * True when a money RPC failed WITHOUT the server answering, so the move may
 * have committed before its response was lost (2026-10-09, dialogs merge). A
 * refusal came back as `{ success: false }`; any PostgREST error that carries
 * a SQLSTATE rolled its transaction back. What is left - a transport failure
 * with no code, or a dropped database connection (class 08) - is unknown.
 */
function outcomeUnknown(e: unknown): boolean {
  if (e instanceof CashierRefusal) return false;
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || code.trim() === '') return true;
  return code.startsWith('08');
}

/** crypto.randomUUID is not in every embedded webview; fall back rather than throw. */
function newOpId(): string {
  try {
    const c = globalThis.crypto as Crypto | undefined;
    if (c?.randomUUID) return c.randomUUID();
  } catch {
    /* fall through */
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * ONE ESCAPER FOR EVERY CASHIER CSV (launch audit S-04 and audit C2-16,
 * 2026-10-09). A note on a send is text the sender typed, and a name is text
 * a player chose: `=HYPERLINK(...)`, `@evil` or `-2+3|cmd` in either used to
 * be written quoted but otherwise verbatim, which a spreadsheet evaluates on
 * open. The statement export already had the hardened cell (control
 * characters flattened, invisibles stripped, every formula trigger including
 * the pipe, the percent and the full-width forms prefixed), so the ledgers now
 * use it: figures and timestamps pass raw only when they match their strict
 * shape, everything else is treated as untrusted text.
 */
const csvText = (v: unknown) => statementCsvCell(v, 'text');
const csvDecimal = (v: unknown) => statementCsvCell(v, 'decimal');
const csvTimestamp = (v: unknown) => statementCsvCell(v, 'timestamp');
/** The spelling of a whole-chip amount: digits only, no sign, no exponent. */
const WHOLE_CHIPS = /^\d+$/;

export default function WalletCashierModal({
  isOpen,
  onClose,
  clubId,
  role,
  walletType = DEFAULT_CASHIER_WALLET,
  initialRecipientId = null,
  initialDestination = null,
}: WalletCashierModalProps) {
  const { user } = useAuthUser();
  const toast = useToast();
  const isMounted = useIsMounted();

  const [clubLoading, setClubLoading] = useState(true);
  const [clubUuid, setClubUuid] = useState<string | null>(null);
  const [clubName, setClubName] = useState('');
  const [inUnion, setInUnion] = useState<boolean | null>(null);
  const [bank, setBank] = useState<number | null>(null);
  // false: the agent float row does not exist yet (D-16, launch audit
  // 2026-10-09). That is neither 0 nor unavailable, and the header says so.
  const [hasFloat, setHasFloat] = useState<boolean | null>(null);
  /**
   * THE CREDIT LINE BEHIND THE AGENT WALLET (audit C2-1): credit_limit -
   * credit_used for an agent who is not prepaid, 0 for everyone else. A send
   * spends the float and draws any shortfall against the line
   * (fn_agent_wallet_send_core), so what this cashier may send is the float
   * PLUS this. It capped every send at the float, and a credit agent with an
   * empty float could not send at all. Read with the float; null while unread.
   */
  const [credit, setCredit] = useState<number | null>(null);

  const [tab, setTab] = useState<Tab>('send');
  // Funding belongs to the draft, independently of the bank's ledger and claim tab.
  const [bankSendSource, setBankSendSource] = useState<CashierWalletType>('club_bank');
  const [fundingBalance, setFundingBalance] = useState<number | null>(null);
  const [fundingCredit, setFundingCredit] = useState(0);
  const spendWallet = walletType === 'club_bank' && tab === 'send' ? bankSendSource : walletType;
  const [destination, setDestination] = useState<DestinationWallet>('agent_wallet');
  const [members, setMembers] = useState<Member[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  /** The roster read FAILED, which is not the same thing as an empty club (audit C2-15). */
  const [membersError, setMembersError] = useState(false);
  const [search, setSearch] = useState('');
  const [recipient, setRecipient] = useState<Member | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendReceipt, setSendReceipt] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  /**
   * What the CLAIM source wallet actually holds, fetched when a holder is
   * chosen on the Claim Back tab. A claim is capped by THIS figure, never by
   * the bank — the bank grows on a claim. Null while unknown, and the button
   * stays disabled until it is known, because "take an amount we could not
   * read" is not a button this cashier offers.
   */
  const [holderHeld, setHolderHeld] = useState<number | null>(null);

  /**
   * The AGENT wallet's Claim Back tab: the sends this agent made inside the
   * last ten minutes, and which one is being undone right now.
   */
  const [reversible, setReversible] = useState<ReversibleSend[]>([]);
  const [reversibleLoading, setReversibleLoading] = useState(false);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  /**
   * THE COUNTDOWN IS THE SERVER'S, NOT THE PHONE'S (Dan 2026-08-25).
   *
   * `seconds_left` is computed by fn_agent_wallet_reversible and was fetched
   * and then never read: the countdown subtracted `Date.now()` from
   * `reversible_until`, which is the browser wall clock the comment above the
   * interface promises it is not. A phone ten minutes fast showed every row as
   * expired and offered no claim at all; a phone ten minutes slow offered a
   * claim on every row and each tap collected a server refusal.
   *
   * So the deadline is anchored ONCE, at the moment the list lands, and only
   * LOCALLY MEASURED ELAPSED TIME is subtracted from it. performance.now() is
   * monotonic - it is unaffected by a wrong clock, by an NTP correction, and by
   * daylight saving - so what is on screen is the database's ten minutes,
   * counted down by a stopwatch rather than by a calendar.
   */
  const [reversibleAnchor, setReversibleAnchor] = useState<number | null>(null);
  /** Ticks once a second so each countdown on that list re-renders. */
  const [, setNowTick] = useState(0);
  /** Bumped after a claim lands so the agent / promo holder figure re-reads. */
  const [holderNonce, setHolderNonce] = useState(0);
  /**
   * A MONEY MOVE THAT GOT NO ANSWER (2026-10-09, dialogs merge; the "unknown
   * outcome" render). A send, claim, claim back or reversal whose request died
   * in transit may have committed, and the toast door silences connection
   * errors by house rule, so this sheet said nothing at all: the plate went
   * back to Send and the form sat there as if untouched. It now says so inside
   * the frame and re-reads the figures. The key is still held, so the same
   * request sent again can only replay the first one, never move chips twice.
   */
  const [unconfirmed, setUnconfirmed] = useState<'send' | 'claim' | 'undo' | 'reverse' | null>(
    null
  );
  /** Brings that sentence into view once, when it appears (a stable ref, so a re-render never scrolls). */
  const revealOnMount = useCallback((el: HTMLElement | null) => {
    el?.scrollIntoView?.({ block: 'nearest' });
  }, []);

  /**
   * WHICH PROMO ACCOUNT THIS CASHIER SPENDS (2026-09-05). A Club Bank role
   * stands at the CLUB'S promo pot by default; an agent at their own float.
   * A bank role who also holds a float may switch, because the union can pay
   * promo into either one and both have to be reachable from this screen.
   */
  const [promoSource, setPromoSource] = useState<PromoSource>(() => promoSourceFor(role));
  const [promoPot, setPromoPot] = useState<number | null>(null);
  const [promoFloat, setPromoFloat] = useState<number | null>(null);
  const [promoLedger, setPromoLedger] = useState<PromoLedgerRow[]>([]);
  const [promoLedgerTotal, setPromoLedgerTotal] = useState(0);
  const [promoLedgerTotals, setPromoLedgerTotals] = useState<PromoLedgerTotals | null>(null);

  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [ledgerTotal, setLedgerTotal] = useState(0);
  const [ledgerTotals, setLedgerTotals] = useState<LedgerTotals | null>(null);
  const [ledgerTypes, setLedgerTypes] = useState<string[]>([]);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const exportBusyRef = useRef(false);
  const [reversingId, setReversingId] = useState<string | null>(null);

  const [showMint, setShowMint] = useState(false);
  /**
   * ESCAPE BELONGS TO THE TOP SHEET (launch audit D-01 / audit C2-4,
   * 2026-10-09). The mint stacks above this cashier and both listen on
   * `document`, so one Escape ran both: the mint's guard held while a mint was
   * in flight, and the cashier closed anyway, unmounting the mint and its
   * idempotency key mid RPC. A ref, because the key listener is registered
   * once per open. While the Chip Mint is up, Escape and every close path here
   * belong to the mint (closeIfIdle and the corner X below read it too).
   */
  const showMintRef = useRef(false);
  useEffect(() => {
    showMintRef.current = showMint;
  }, [showMint]);

  /**
   * The idempotency key for the CURRENT attempt. Regenerated when the form is
   * cleared or the inputs change, held across a retry of the same attempt.
   * A ref, not state: a re-render must not mint a new key mid-flight.
   */
  const opIdRef = useRef<string>(newOpId());
  const claimOpIdsRef = useRef<Map<string, string>>(new Map());
  const reverseOpIdsRef = useRef<Map<string, string>>(new Map());
  /** Beats the double tap that lands before `sending` has re-rendered. */
  const spendPromoSource = walletType === 'club_bank' ? 'club_pot' : promoSource;
  const actionViewKey = JSON.stringify([
    isOpen,
    clubId,
    user?.id,
    walletType,
    role,
    bankSendSource,
  ]);
  const actionView = useRef({ key: actionViewKey });
  if (actionView.current.key !== actionViewKey) actionView.current = { key: actionViewKey };
  const exportViewKey = JSON.stringify([actionViewKey, tab, promoSource, typeFilter]);
  const exportView = useRef({ key: exportViewKey });
  if (exportView.current.key !== exportViewKey) exportView.current = { key: exportViewKey };
  const busyRef = useRef(false);

  const viewerRole = normaliseRole(role);
  const [claimReturn, setClaimReturn] = useState<ClaimDestination>('agent_wallet');
  const claimReturns = claimReturnWallets(destination, viewerRole);
  const effectiveClaimReturn = claimReturns.includes(claimReturn) ? claimReturn : claimReturns[0];
  const claimReturnLabel = CLAIM_DESTINATION_LABELS[effectiveClaimReturn];
  // Who may stand at THIS cashier. The Club Bank keeps its four roles; the
  // promo and agent wallet cashiers admit the people who HOLD those wallets.
  // cashierModes.ts is the pinned law; the server re-checks either way.
  const allowed = canUseCashier(walletType, viewerRole);
  const mayMint =
    walletType === 'club_bank' && canMintInClubBank(viewerRole, { standalone: inUnion === false });

  const tabs = cashierTabs(walletType);
  // Every send honors the selected wallet. Eligibility is explained on each
  // roster row; the transaction validates it again before moving chips.
  const destinations = cashierDestinations(spendWallet);
  const shownDestination =
    spendWallet === 'promo_wallet' && destination === 'agent_wallet' ? 'promo_wallet' : destination;
  const destinationLabel = (key: DestinationWallet) =>
    DESTINATION_LABELS[
      spendWallet === 'promo_wallet' && key === 'agent_wallet' ? 'promo_wallet' : key
    ];
  const agentClaimTab = walletType === 'agent_wallet' && tab === 'claim';

  const loadFunding = useVisibleRead({
    manualOnly: true,
    scopeKey: `${clubId}:${user?.id}:${spendWallet}`,
    enabled:
      isOpen &&
      allowed &&
      walletType === 'club_bank' &&
      tab === 'send' &&
      spendWallet !== 'club_bank' &&
      Boolean(clubId && user?.id),
    read: (signal) => readCashierBalances(clubId, user!.id, spendWallet, signal),
    onReset: () => {
      setFundingBalance(null);
      setFundingCredit(0);
    },
    onData: (snapshot) => {
      setFundingBalance(spendWallet === 'promo_wallet' ? snapshot.promoPot : snapshot.bank);
      setFundingCredit(snapshot.credit);
    },
    onError: (error) => {
      setFundingBalance(null);
      setFundingCredit(0);
      reportError(error, 'WalletCashierModal.loadFunding');
    },
  });
  useEffect(() => {
    if (!destinations.includes(destination)) setDestination(destinations[0]);
    // The destination list is derived only from the selected source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spendWallet, destination]);

  const balanceScopeRef = useRef(0);
  /* The member the cashier was opened for (initialRecipientId). Cleared on use
     so a later roster refresh never re-selects a member the sender has since
     moved away from. */
  const presetRecipientRef = useRef<string | null>(null);

  // clubs and agents are deliberately excluded from Realtime publication.
  // Read only while this cashier is open and visible, rather than publishing
  // every hand's treasury/agent updates across the platform. Money commands
  // still authorize and lock the actual balance inside their transaction.
  const loadClub = useVisibleRead({
    manualOnly: true,
    // Role resolution also resets the promo accounts below. It must own a new
    // read, even when both roles can use this cashier.
    scopeKey: `${clubId}:${user?.id}:${walletType}:${role}`,
    enabled: isOpen && allowed && Boolean(clubId && user?.id),
    read: (signal) => readCashierBalances(clubId, user!.id, walletType, signal),
    onReset: () => {
      balanceScopeRef.current++;
      setClubUuid(null);
      setBank(null);
      setHasFloat(null);
      setCredit(null);
      setPromoPot(null);
      setPromoFloat(null);
      setInUnion(null);
      setClubLoading(isOpen && allowed && Boolean(clubId && user?.id));
    },
    onData: (snapshot) => {
      setClubUuid(snapshot.clubId);
      setClubName(snapshot.name);
      setInUnion(snapshot.inUnion);
      setHasFloat(snapshot.hasFloat);
      if (walletType !== 'promo_wallet') setBank(snapshot.bank);
      setCredit(snapshot.credit);
      setPromoPot(snapshot.promoPot);
      setPromoFloat(snapshot.promoFloat);
      setClubLoading(false);
    },
    onError: (error) => {
      reportError(error, 'WalletCashierModal.loadClub');
      // An unread balance is unavailable, never zero or permission to spend.
      setBank(null);
      setHasFloat(null);
      setCredit(null);
      setPromoPot(null);
      setPromoFloat(null);
      setInUnion(null);
      setClubLoading(false);
    },
  });

  /**
   * ── Who this cashier may transact with ────────────────────────────────────
   *
   * This used to page EVERY club_members row for the club, 500 at a time, with
   * no scoping whatsoever: an agent was offered the club owner, and a sub agent
   * was offered every one of the club's 584 members. There was no server rule
   * to disagree with either - the send path never asked who the recipient was
   * beneath.
   *
   * fn_club_cashier_members answers that question in the database, walking the
   * SAME club_members.agent_id edge that fn_agent_wallet_send now refuses on:
   * everyone for an owner, co owner or admin; the recursive downline for a
   * super agent, agent or sub agent; nobody for a plain player. A recipient
   * offered here is one the server will accept, which is the whole point - a
   * list that offers someone the RPC then rejects is a dead end nobody can
   * diagnose from the screen.
   */
  const loadMembers = useCallback(
    async (uuid: string) => {
      const scope = balanceScopeRef.current;
      setMembersLoading(true);
      setMembersError(false);
      const { data, error } = await supabase.rpc('fn_club_cashier_members', {
        p_club_id: uuid,
      });
      if (!isMounted.current || scope !== balanceScopeRef.current) return;
      if (error) {
        /* A read that failed is not an empty club. Leaving the roster empty and
           saying so is honest; pretending the club has nobody in it would let a
           search box sit there returning nothing forever. */
        reportError(error, 'WalletCashierModal.loadMembers');
        setMembers([]);
        setMembersError(true);
        setMembersLoading(false);
        return;
      }
      const rows = (data || []) as Array<Record<string, unknown>>;
      const mapped: Member[] = rows.map((m) => ({
        user_id: String(m.user_id),
        role: String(m.role || 'player'),
        /* fn_arena_name already falls back through alias, username and the
           name columns. A member with none of them is unnamed - never
           "Member" plus the first eight characters of an internal id. */
        name: (m.name as string) || (m.username as string) || 'Unnamed Member',
        chip_balance:
          m.chip_balance !== undefined && m.chip_balance !== null
            ? Number(m.chip_balance)
            : undefined,
        avatar_url: (m.avatar_url as string) || '',
        username: (m.username as string) || '',
        short_id: String(m.player_number || '----'),
      }));
      setMembers(mapped);
      /* THE CHOSEN RECIPIENT IS RE-READ WITH THE ROSTER (launch audit D-04).
         After a claim the roster was refetched but `recipient` kept the OLD
         row, so the Claim tab still said "Holds 1,000" after taking 500 and
         offered a second 1,000. The holder figure and the cap read this
         object, so it follows the refresh. A recipient who left the roster
         is dropped rather than kept on a stale figure. */
      setRecipient((prev) =>
        prev ? (mapped.find((m) => m.user_id === prev.user_id) ?? null) : prev
      );
      setMembersLoading(false);
    },
    [isMounted]
  );

  /**
   * The Claim Back list for an AGENT wallet: this agent's own sends that are
   * still inside their ten minute window. Computed by the database
   * (fn_agent_wallet_reversible) rather than from created_at on the client, so
   * a phone with a skewed clock cannot offer a claim the server will refuse.
   */
  const loadReversible = useCallback(
    async (uuid: string) => {
      const scope = balanceScopeRef.current;
      setReversibleLoading(true);
      const { data, error } = await supabase.rpc('fn_agent_wallet_reversible', {
        p_club_id: uuid,
      });
      if (!isMounted.current || scope !== balanceScopeRef.current) return;
      if (error) {
        reportError(error, 'WalletCashierModal.loadReversible');
        setReversible([]);
        setReversibleAnchor(null);
      } else {
        setReversible(((data || []) as ReversibleSend[]).map((r) => ({ ...r })));
        // Anchor the server's countdown against a monotonic local stopwatch.
        setReversibleAnchor(performance.now());
      }
      setReversibleLoading(false);
    },
    [isMounted]
  );

  // ── The ledger. Every single chip movement, newest first. ─────────────────
  /**
   * Only the NEWEST ledger request may paint. Changing the type filter twice
   * quickly, or tapping Load More while a filter change is still in flight,
   * fired two overlapping reads whose responses could land in either order -
   * and the loser then appended a differently-filtered page onto the winner's
   * list, which is exactly how a ledger comes to show rows that contradict its
   * own filter chip. isMounted is an unmount guard; it cannot see this.
   */
  const ledgerSeqRef = useRef(0);
  const loadLedger = useCallback(
    async (uuid: string, offset: number, types: string | null) => {
      const seq = ++ledgerSeqRef.current;
      const scope = balanceScopeRef.current;
      const current = () =>
        isMounted.current && seq === ledgerSeqRef.current && scope === balanceScopeRef.current;
      setLedgerLoading(true);
      setLedgerError(null);
      if (offset === 0) {
        setLedger([]);
        setLedgerTotal(0);
        setLedgerTotals(null);
      }
      try {
        const { data, error } = await supabase.rpc('fn_club_bank_ledger', {
          p_club_id: uuid,
          p_limit: LEDGER_PAGE,
          p_offset: offset,
          p_types: types ? [types] : null,
        });
        if (error) throw error;
        const res = (Array.isArray(data) ? data[0] : data) as {
          authorized?: boolean;
          error?: string;
          total?: number;
          types?: string[];
          totals?: LedgerTotals;
          rows?: LedgerRow[];
        } | null;
        if (!current()) return;
        if (!res?.authorized) {
          setLedgerError(res?.error || 'The Club Bank Ledger Is Not Available To You');
          setLedger([]);
          return;
        }
        setLedgerTotal(Number(res.total) || 0);
        setLedgerTotals(res.totals ?? null);
        if (Array.isArray(res.types)) setLedgerTypes(res.types);
        setLedger((prev) => (offset === 0 ? res.rows || [] : appendNew(prev, res.rows || [])));
      } catch (e) {
        reportError(e, 'WalletCashierModal.loadLedger');
        if (current()) setLedgerError('Could Not Load The Ledger');
      } finally {
        if (current()) setLedgerLoading(false);
      }
    },
    [isMounted]
  );

  /**
   * THE LEDGER ATTACHED TO THE PROMO WALLET (Dan 2026-09-05). One RPC,
   * fn_promo_wallet_ledger, scoped to the account on screen: 'club' reads the
   * club pot's rows off chip_ledger, 'agent' reads the viewer's own float in
   * this club. Same newest-request-wins guard as the bank ledger above.
   */
  const promoLedgerSeqRef = useRef(0);
  const loadPromoLedger = useCallback(
    async (uuid: string, offset: number, source: PromoSource) => {
      const seq = ++promoLedgerSeqRef.current;
      const scope = balanceScopeRef.current;
      const current = () =>
        isMounted.current && seq === promoLedgerSeqRef.current && scope === balanceScopeRef.current;
      setLedgerLoading(true);
      setLedgerError(null);
      if (offset === 0) {
        setPromoLedger([]);
        setPromoLedgerTotal(0);
        setPromoLedgerTotals(null);
      }
      try {
        const { data, error } = await supabase.rpc('fn_promo_wallet_ledger', {
          p_scope: promoLedgerScope(source),
          p_scope_id: uuid,
          p_limit: LEDGER_PAGE,
          p_offset: offset,
        });
        if (error) throw error;
        const res = (Array.isArray(data) ? data[0] : data) as {
          authorized?: boolean;
          error?: string;
          total?: number;
          totals?: PromoLedgerTotals;
          rows?: PromoLedgerRow[];
        } | null;
        if (!current()) return;
        if (!res?.authorized) {
          setLedgerError(res?.error || 'The Promo Wallet Ledger Is Not Available To You');
          setPromoLedger([]);
          return;
        }
        // First page only carries the count and the totals (see
        // fn_promo_wallet_ledger); a Load More page answers null for both.
        if (offset === 0 || res.total != null) setPromoLedgerTotal(Number(res.total) || 0);
        if (offset === 0 || res.totals) setPromoLedgerTotals(res.totals ?? null);
        setPromoLedger((prev) => (offset === 0 ? res.rows || [] : appendNew(prev, res.rows || [])));
      } catch (e) {
        reportError(e, 'WalletCashierModal.loadPromoLedger');
        if (current()) setLedgerError('Could Not Load The Ledger');
      } finally {
        if (current()) setLedgerLoading(false);
      }
    },
    [isMounted]
  );

  /* The figure this cashier spends against, for the promo wallet, is the
     selected account. Kept in `bank` so every cap, warning, confirm threshold
     and "would hold afterwards" sentence below reads one variable. */
  useEffect(() => {
    if (walletType !== 'promo_wallet') return;
    setBank(promoSource === 'club_pot' ? promoPot : promoFloat);
  }, [walletType, promoSource, promoPot, promoFloat]);

  // ── Open / reset ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen || !user?.id) return;
    setTab('send');
    setBankSendSource('club_bank');
    setSendError(null);
    setSendReceipt(null);
    setPromoSource(promoSourceFor(role));
    setPromoPot(null);
    setPromoFloat(null);
    setPromoLedger([]);
    if (initialDestination && cashierDestinations(walletType).includes(initialDestination))
      setDestination(initialDestination);
    else if (walletType === 'club_bank') setDestination('agent_wallet');
    else setDestination('player_wallet');
    presetRecipientRef.current = initialRecipientId;

    setRecipient(null);
    setAmount('');
    setReason('');
    setSearch('');
    setConfirming(false);
    setLedger([]);
    setTypeFilter(null);
    /* THE ROSTER BELONGS TO THE CLUB THAT WAS OPEN. It was not cleared here,
       so reopening the cashier for a DIFFERENT club rendered the previous
       club's members as selectable recipients for the whole window between
       open and the new club id resolving. */
    setMembers([]);
    setMembersLoading(true);
    setHolderHeld(null);
    setReversible([]);
    setClaimingId(null);
    /* THE LEDGER FIGURES BELONG TO THE CLUB THAT WAS OPEN TOO (launch audit
       D-03). Reopened for another club, the eyebrow printed the previous
       club's name and the Ledger tab its totals, count and type chips until
       the new club's first page landed. */
    setClubName('');
    setLedgerTotal(0);
    setLedgerTotals(null);
    setLedgerTypes([]);
    setLedgerError(null);
    setPromoLedgerTotal(0);
    setPromoLedgerTotals(null);
    setReversibleAnchor(null);
    setUnconfirmed(null);
    opIdRef.current = newOpId();
    // initialRecipientId/initialDestination are read at open, not followed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, clubId, user?.id, walletType, role]);

  // Escape closes, and the page behind stops scrolling. Both are what a person
  // expects of a modal and neither was here.
  // NOT WHILE THE CHIP MINT IS UP (audit C2-4). The mint listens for Escape on
  // the same document, and this listener was registered first: one Escape
  // closed the whole cashier, unmounting the mint mid-mint with the key it was
  // holding. With the mint open, Escape is the mint's alone.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busyRef.current || showMintRef.current) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen, onClose]);

  /* Tab stays inside the sheet, focus lands on its first control and returns
     to the control that opened it (launch audit D-11). NOT suspended while
     the mint is stacked above (regression review G-05): suspending ran this
     trap's cleanup, which focused the cashier's opener BEHIND both sheets;
     the mint then recorded that as its own return target, and on its close
     this trap re-activated on its first control instead of the Mint control
     the user was on. useFocusTrap gives Tab to the most recently activated
     trap, so the mint owns the keyboard while it is up and hands it back,
     with focus on the control that opened it, when it closes. */
  const panelRef = useFocusTrap<HTMLDivElement>(isOpen);

  useEffect(() => {
    if (!isOpen || !clubUuid || !allowed) return;
    loadMembers(clubUuid);
  }, [isOpen, clubUuid, allowed, loadMembers]);

  useEffect(() => {
    if (!isOpen || !clubUuid || !allowed || tab !== 'ledger') return;
    if (walletType === 'promo_wallet') {
      // The promo ledger follows the SOURCE switch: flip from the club pot to
      // your own float and the list re-reads from offset 0 for that account.
      loadPromoLedger(clubUuid, 0, promoSource);
      return;
    }
    loadLedger(clubUuid, 0, typeFilter);
    // typeFilter is a dependency on purpose: changing the filter re-reads from
    // offset 0 rather than appending a differently-filtered page onto the old
    // list, which is how a ledger comes to show rows that do not match its own
    // filter chip.
  }, [
    isOpen,
    clubUuid,
    allowed,
    tab,
    typeFilter,
    loadLedger,
    walletType,
    promoSource,
    loadPromoLedger,
  ]);

  // The agent wallet's Claim Back list, and a one-second tick so the countdown
  // on each row is the truth rather than the value it had when the tab opened.
  useEffect(() => {
    if (!isOpen || !clubUuid || !allowed || walletType !== 'agent_wallet' || tab !== 'claim')
      return;
    loadReversible(clubUuid);
    const t = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [isOpen, clubUuid, allowed, walletType, tab, loadReversible]);

  /**
   * The rows still inside their window, recomputed on every tick. Filtering
   * here rather than returning null from the map is what lets the empty state
   * appear when the LAST row expires with the tab open: `reversible.length` was
   * still non-zero, so "Nothing To Claim Back" never rendered and the user was
   * left looking at a blank panel with no explanation.
   */
  const secondsLeftFor = useCallback(
    (row: ReversibleSend): number =>
      reversibleAnchor === null
        ? 0
        : secondsLeftFromServer(row.seconds_left, performance.now() - reversibleAnchor),
    [reversibleAnchor]
  );
  const stillClaimable = reversible.filter((r) => secondsLeftFor(r) > 0);

  // ── Claim Back: what does the chosen wallet actually hold? ────────────────
  // The player wallet figure already rides on the member row; the agent and
  // promo floats live on the agents table and are fetched when the holder is
  // chosen. The claim button stays disabled until the figure is known.
  useEffect(() => {
    /* EVERY WALLET'S SEND FORM OPENS ON THE CHOSEN PLAYER (Dan 2026-10-19), and
       that card prints what they hold in the destination wallet, so the figure
       is read for any send or claim form - not only the Club Bank's. */
    if ((tab !== 'claim' && tab !== 'send') || !recipient || !clubUuid) {
      setHolderHeld(null);
      return;
    }
    if (shownDestination === 'player_wallet') {
      setHolderHeld(recipient.chip_balance ?? null);
      return;
    }
    let cancelled = false;
    setHolderHeld(null);
    (async () => {
      const { data, error: holderError } = await supabase
        .from('agents')
        .select('agent_wallet_balance, promo_wallet_balance')
        .eq('club_id', clubUuid)
        .eq('user_id', recipient.user_id)
        .maybeSingle();
      if (cancelled || !isMounted.current) return;
      /* Same rule as the bank balance above: an unread figure stays null (the
         claim button is already gated on that) rather than becoming a
         confident "Holds 0.00 In That Wallet", which silently disabled a claim
         that was in fact available. */
      if (holderError) {
        reportError(holderError, 'WalletCashierModal.holderHeld');
        setHolderHeld(null);
        return;
      }
      setHolderHeld(
        shownDestination === 'promo_wallet'
          ? data?.promo_wallet_balance !== undefined && data?.promo_wallet_balance !== null
            ? Number(data?.promo_wallet_balance)
            : null
          : data?.agent_wallet_balance !== undefined && data?.agent_wallet_balance !== null
            ? Number(data?.agent_wallet_balance)
            : null
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, shownDestination, recipient, clubUuid, isMounted, holderNonce, walletType]);

  // A send that lands, a claim, a reversal, or a mint changes the bank and the
  // recipient. Refetch rather than patching state by hand — a hand-patched
  // balance that drifts from the database is the exact class of bug this
  // cashier exists to end.
  const refresh = useCallback(() => {
    loadClub();
    loadFunding();
    if (!clubUuid) return;
    loadMembers(clubUuid);
    if (walletType === 'agent_wallet') loadReversible(clubUuid);
    if (tab === 'ledger') {
      if (walletType === 'promo_wallet') loadPromoLedger(clubUuid, 0, promoSource);
      else loadLedger(clubUuid, 0, typeFilter);
    } else {
      setLedger([]);
      setPromoLedger([]);
    }
  }, [
    loadClub,
    loadFunding,
    loadMembers,
    loadLedger,
    loadPromoLedger,
    loadReversible,
    clubUuid,
    tab,
    typeFilter,
    walletType,
    promoSource,
  ]);

  const { recentIds, addRecipient } = useRecentRecipients(user?.id, clubUuid, walletType);

  /**
   * NEVER OFFER A RECIPIENT THE SERVER WILL REFUSE.
   *
   * Owner October 21: agent-wallet to own player-wallet is allowed. Other
   * agent-wallet destinations and the agent's promo float still refuse self.
   * Eligibility follows both the selected source and destination.
   *
   * The CLUB BANK is deliberately exempt: fn_club_bank_send has no self guard
   * because an owner funding their OWN agent float out of the treasury is the
   * normal way an owner gets a float at all. Removing themselves from that list
   * would break the funding route the whole hierarchy hangs off.
   */
  const excludeSelf = cashierRefusesSelfSend(spendWallet, spendPromoSource, destination);

  // Wallet destinations list only members who can hold that wallet. Other
  // refusals (such as self-send) remain visible with their existing reason.
  const blockFor = useCallback(
    (m: Member) =>
      cashierRecipientBlock({
        isSelf: m.user_id === user?.id,
        refusesSelfSend: excludeSelf,
        destinationNeedsAgentWallet: AGENT_ONLY.includes(destination),
        memberHoldsAgentWallet: canHoldAgentWallet(m.role),
        // An admin holds no player wallet; every send honors this eligibility.
        destinationIsPlayerWallet: destination === 'player_wallet',
        memberHoldsPlayerWallet: holdsPlayerWallet(m.role),
      }),
    [user?.id, excludeSelf, destination]
  );

  /* THE PRESET RECIPIENT (presetRecipientRef), applied once when the roster
     first contains them. */
  useEffect(() => {
    const wanted = presetRecipientRef.current;
    if (!wanted || tab !== 'send') return;
    const row = members.find((m) => m.user_id === wanted);
    if (!row) return;
    presetRecipientRef.current = null;
    if (!blockFor(row)) setRecipient(row);
  }, [members, tab, blockFor]);

  const eligible = useMemo(() => {
    const q = search.trim().toLowerCase();

    const destinationMembers = AGENT_ONLY.includes(destination)
      ? members.filter((m) => canHoldAgentWallet(m.role))
      : members;

    if (q.length < 2) {
      let recent = destinationMembers
        .filter((m) => recentIds.includes(m.user_id))
        .sort((a, b) => recentIds.indexOf(a.user_id) - recentIds.indexOf(b.user_id));

      if (recent.length < 5) {
        // The short "who might I mean" list before a search leads with people
        // who can actually receive; the blocked ones are still one search away.
        const fallback = destinationMembers
          .filter((m) => !recentIds.includes(m.user_id) && !blockFor(m))
          .sort((a, b) => roleRank(b.role) - roleRank(a.role) || a.name.localeCompare(b.name))
          .slice(0, 5 - recent.length);
        recent = [...recent, ...fallback];
      }
      return recent;
    }

    return (
      destinationMembers
        .filter(
          (m) =>
            fuzzyMatch(q, m.name) ||
            (m.username && fuzzyMatch(q, m.username)) ||
            // Findable by the id printed on the row, the only handle a member
            // with no alias and no username has.
            (m.short_id || '').toLowerCase().includes(q)
        )
        // Sendable first, then by role: a blocked row is discoverable, not in
        // the way of the person you were actually looking for.
        .sort(
          (a, b) =>
            Number(Boolean(blockFor(a))) - Number(Boolean(blockFor(b))) ||
            roleRank(b.role) - roleRank(a.role) ||
            a.name.localeCompare(b.name)
        )
        .slice(0, 60)
    );
  }, [members, search, recentIds, blockFor, destination]);

  // Changing destination can strand a recipient who cannot hold the new wallet,
  // and a viewer who picked themselves on a cashier that then narrows to one the
  // server refuses self-sends on would keep a selection nothing on screen shows.
  useEffect(() => {
    if (!recipient) return;
    if (AGENT_ONLY.includes(destination) && !canHoldAgentWallet(recipient.role)) {
      setRecipient(null);
      return;
    }
    if (excludeSelf && recipient.user_id === user?.id) setRecipient(null);
  }, [destination, recipient, excludeSelf, user?.id]);

  const amt = Number(amount) || 0;
  /* What an agent wallet send may draw past the float: the credit line still
     open (audit C2-1). Nothing else in this cashier lends. */
  const spendBalance =
    walletType === 'club_bank' && tab === 'send' && spendWallet !== 'club_bank'
      ? fundingBalance
      : bank;
  const creditLine =
    spendWallet === 'agent_wallet' && tab === 'send'
      ? walletType === 'club_bank'
        ? fundingCredit
        : (credit ?? 0)
      : 0;
  /** The part of this send that the credit line would cover, if any. */
  const creditDraw =
    spendBalance !== null && creditLine > 0 && amt > spendBalance ? amt - spendBalance : 0;
  // A send is capped by the wallet being SPENT (the bank, or the caller's own
  // float plus any credit line still open). A claim is capped by the wallet
  // being CLAIMED FROM. The two caps are different accounts, and mixing them up
  // is how a claim gets refused for "insufficient bank" while the bank is the
  // thing being paid.
  const cap =
    tab === 'claim' ? holderHeld : spendBalance === null ? null : spendBalance + creditLine;
  const overCap = cap !== null && amt > cap;
  /* WHOLE CHIPS ONLY. `amt > 0` accepted 0.4, which the RPC took verbatim
     while the success toast (which formats with fmtWhole) reported "Sent 0
     Chips" - and 10.6 reported 11. The `min={1}` on the input never applied
     because submission goes through onClick, not form validation. */
  /* AND THE SPELLING IS INSPECTED, NOT JUST THE VALUE (launch audit D-15):
     `Number('1e3')` is 1000, whole and finite, so "1e3" sent a thousand chips
     the typist never saw written out. Digits only. */
  const amountIsWhole =
    Number.isFinite(amt) && Number.isInteger(amt) && amt >= 1 && WHOLE_CHIPS.test(amount.trim());
  const canSend =
    Boolean(recipient && !blockFor(recipient)) &&
    amountIsWhole &&
    cap !== null &&
    !overCap &&
    !sending;
  // A send that borrows on the credit line always asks first: it creates debt.
  const needsConfirm =
    tab === 'claim'
      ? claimNeedsConfirm(amt)
      : creditDraw > 0 ||
        (spendBalance !== null && spendBalance > 0 && amt >= spendBalance * CONFIRM_SHARE_OF_BANK);
  /** The account a send spends, by name, for the sentences that quote it (audit C2-14). */
  const spentAccount =
    spendWallet === 'club_bank'
      ? 'The Club Bank'
      : spendWallet === 'agent_wallet'
        ? 'Your Agent Wallet'
        : spendPromoSource === 'club_pot'
          ? 'The Club Promo Wallet'
          : 'Your Promo Float';

  // Any change to what is being sent is a NEW operation, so it gets a new key.
  // Without this, correcting a typo after a failed attempt would replay the
  // first attempt's amount if that attempt had in fact committed.
  // THE REASON IS PART OF THE OPERATION (audit C2-5): fn_cashier_exact_intent_begin
  // binds the key to the reason too, and a refused attempt keeps its intent, so
  // editing only the reason and retrying was refused, every time, as "That Retry
  // Key Belongs To A Different Cashier Request".
  useEffect(() => {
    opIdRef.current = newOpId();
    setConfirming(false);
    setSendError(null);
  }, [recipient?.user_id, amount, destination, tab, reason, spendWallet, effectiveClaimReturn]);

  const doSend = async () => {
    if (!canSend || !clubUuid || !recipient || busyRef.current) return;
    const owningView = actionView.current;
    busyRef.current = true;
    setSending(true);
    setSendError(null);
    setSendReceipt(null);
    let closeAfterSuccess = false;
    try {
      const action =
        tab === 'claim'
          ? 'fn_club_wallet_claim_back'
          : spendWallet === 'promo_wallet'
            ? promoSendRpc(spendPromoSource)
            : spendWallet === 'agent_wallet'
              ? 'fn_agent_wallet_send'
              : 'fn_club_bank_send';
      const operation = await reserveCashierWalletOperation(user?.id || '', clubUuid, action, {
        p_club_id: clubUuid,
        ...(tab === 'claim'
          ? {
              p_from_user_id: recipient.user_id,
              p_source: destination,
              p_destination: effectiveClaimReturn,
            }
          : { p_to_user_id: recipient.user_id, p_destination: destination }),
        p_amount: amt,
        p_reason: reason.trim() || null,
      });
      if (!operation) throw new CashierRefusal('Cashier Safety Storage Is Unavailable. Try Again');
      if (!isMounted.current || actionView.current !== owningView) return;
      opIdRef.current = operation.operationId;
      let res: {
        success?: boolean;
        error?: string;
        replayed?: boolean;
      } | null = null;
      if (tab === 'claim') {
        // CLAIM BACK. Chips come OUT of the chosen wallet INTO the Club Bank.
        const { data, error } = await supabase.rpc('fn_club_wallet_claim_back', {
          p_club_id: clubUuid,
          p_from_user_id: recipient.user_id,
          p_amount: amt,
          p_source: destination,
          p_destination: effectiveClaimReturn,
          p_reason: reason.trim() || null,
          p_op_id: opIdRef.current,
        });
        if (error) throw error;
        res = Array.isArray(data) ? data[0] : data;
      } else if (spendWallet === 'promo_wallet') {
        // Dan 2026-08-24: the promo wallet sends to a player wallet (as cash)
        // or to another agent's promo wallet. One RPC, one ledger row, keyed.
        // 2026-09-05: WHICH promo wallet is the source switch's decision -
        // fn_club_promo_wallet_send spends the club pot, fn_promo_wallet_send
        // the caller's own float. Same arguments, same receipt shape.
        const { data, error } = await supabase.rpc(promoSendRpc(spendPromoSource), {
          p_club_id: clubUuid,
          p_to_user_id: recipient.user_id,
          p_amount: amt,
          p_destination: destination,
          p_reason: reason.trim() || null,
          p_op_id: opIdRef.current,
        });
        if (error) throw error;
        res = Array.isArray(data) ? data[0] : data;
      } else if (spendWallet === 'agent_wallet') {
        /* THE AGENT WALLET IS AN ACCOUNT NOW. This used to call
           ChipFlowService.agentToPlayer, which capped the send against
           agents.agent_wallet_balance and then debited an entirely different
           account, wrote nothing to the ledger, carried no idempotency key
           inside a three-attempt retry, and had its result hard-coded to
           success below - so a refusal toasted "Sent". */
        const { data, error } = await supabase.rpc('fn_agent_wallet_send', {
          p_club_id: clubUuid,
          p_to_user_id: recipient.user_id,
          p_amount: amt,
          p_destination: destination,
          p_reason: reason.trim() || null,
          p_op_id: opIdRef.current,
        });
        if (error) throw error;
        res = Array.isArray(data) ? data[0] : data;
      } else {
        const { data, error } = await supabase.rpc('fn_club_bank_send', {
          p_club_id: clubUuid,
          p_to_user_id: recipient.user_id,
          p_amount: amt,
          p_destination: destination,
          p_reason: reason.trim() || null,
          p_op_id: opIdRef.current,
        });
        if (error) throw error;
        res = Array.isArray(data) ? data[0] : data;
      }
      // The RPCs return refusals as { success: false, error } rather than
      // throwing. Toasting success over a refusal is how a cashier lies.
      if (!res?.success) {
        throw new CashierRefusal(res?.error || 'The Cashier Refused That Movement');
      }

      await clearCashierWalletOperation(operation);
      if (!isMounted.current || actionView.current !== owningView) return;
      const destLabel = destinationLabel(destination) || 'Wallet';
      toast?.success?.(
        tab === 'claim'
          ? res.replayed
            ? `That Claim Had Already Gone Through. ${fmtWhole(amt)} Chips Are Back In ${claimReturnLabel}`
            : `Claimed ${fmtWhole(amt)} Chips Back From ${titleCase(recipient.name)} Into ${claimReturnLabel}`
          : res.replayed
            ? `That Send Had Already Gone Through. ${fmtWhole(amt)} Chips Are With ${titleCase(recipient.name)}`
            : `Sent ${fmtWhole(amt)} Chips To ${titleCase(recipient.name)} ${destLabel}`,
        undefined,
        undefined,
        operation.operationId
      );
      masterBus.emit('CHIPS_DISTRIBUTED', {
        clubId: clubUuid,
        amount: amt,
        userId: recipient.user_id,
      });
      masterBus.emit('BALANCE_UPDATED', { source: 'club_bank_cashier', userId: user?.id || '' });
      addRecipient(recipient.user_id);
      setAmount('');
      setReason('');
      setSendReceipt(
        tab === 'claim'
          ? `Claimed ${fmtWhole(amt)} Chips Into ${claimReturnLabel}`
          : `Sent ${fmtWhole(amt)} Chips To ${titleCase(recipient.name)} ${destLabel}`
      );
      setConfirming(false);
      opIdRef.current = newOpId();
      setHolderNonce((n) => n + 1);
      setUnconfirmed(null);
      refresh();
      /* Dan, 2026-10-22: a confirmed send or claim toasts and closes the
         cashier. The operator never has to X off a finished movement. Refusals
         and unknown outcomes keep the cashier open with their reason. */
      closeAfterSuccess = true;
    } catch (e) {
      if (!isMounted.current || actionView.current !== owningView) return;
      reportError(e, 'WalletCashierModal.send');
      // A refusal sentence passes through; a thrown object never prints raw.
      const message = safeErrorMessage(e, 'Send Failed');
      setSendError(message);
      toast?.error?.(message);
      // The key is NOT rotated here. If this failed because the response was
      // lost rather than because the send was refused, the retry must be able
      // to find the original instead of sending a second time. And the sheet
      // says so, and re-reads what it can, because that toast is silenced.
      if (outcomeUnknown(e) && isMounted.current) {
        setUnconfirmed(tab === 'claim' ? 'claim' : 'send');
        refresh();
      }
    } finally {
      busyRef.current = false;
      if (isMounted.current) setSending(false);
    }
    if (closeAfterSuccess && isMounted.current) onClose();
  };

  const onSendPressed = () => {
    if (!canSend) return;
    if (needsConfirm && !confirming) {
      setConfirming(true);
      return;
    }
    void doSend();
  };

  /**
   * THE TEN MINUTE MISTAKE ERASER.
   *
   * Dan 2026-08-25: "Agents can only claim back chips that were sent in the
   * first 10 minutes (reconciling a mistake); after that they cannot remove
   * chips from downline wallets unless the downline requests a cash out."
   *
   * The button is only rendered while the row still has time on it, but the
   * clock that DECIDES is the database's: fn_agent_wallet_claim_back re-reads
   * reversible_until on the originating row and refuses a late claim outright.
   * This is the narrow exception to the chip-removal authority policy and it is
   * anchored on a specific send, never on a balance.
   */
  const claimBack = async (row: ReversibleSend) => {
    if (!clubUuid || claimingId || busyRef.current) return;
    const owningView = actionView.current;
    busyRef.current = true;
    setClaimingId(row.transaction_id);
    let closeAfterSuccess = false;
    const returnWallets = claimReturnWallets(row.destination, viewerRole);
    const returnWallet = returnWallets.includes(claimReturn) ? claimReturn : returnWallets[0];
    const returnLabel = CLAIM_DESTINATION_LABELS[returnWallet];
    try {
      const operation = await reserveCashierWalletOperation(
        user?.id || '',
        clubUuid,
        'fn_club_wallet_claim_back',
        {
          p_club_id: clubUuid,
          p_transaction_id: row.transaction_id,
          p_from_user_id: row.to_user_id,
          p_source: row.destination,
          p_destination: returnWallet,
          p_amount: null,
          p_reason: 'Claimed Back From The Agent Wallet Cashier',
        }
      );
      if (!operation) throw new CashierRefusal('Cashier Safety Storage Is Unavailable. Try Again');
      if (!isMounted.current || actionView.current !== owningView) return;
      const opId = operation.operationId;
      claimOpIdsRef.current.set(row.transaction_id, opId);
      const { data, error } = await supabase.rpc('fn_club_wallet_claim_back', {
        p_club_id: clubUuid,
        p_transaction_id: row.transaction_id,
        p_from_user_id: row.to_user_id,
        p_source: row.destination,
        p_destination: returnWallet,
        p_amount: null,
        p_reason: 'Claimed Back From The Agent Wallet Cashier',
        p_op_id: opId,
      });
      if (error) throw error;
      const res = (Array.isArray(data) ? data[0] : data) as {
        success?: boolean;
        error?: string;
        replayed?: boolean;
        amount?: number;
      } | null;
      if (!res?.success)
        throw new CashierRefusal(res?.error || 'Those Chips Could Not Be Claimed Back');
      await clearCashierWalletOperation(operation);
      if (!isMounted.current || actionView.current !== owningView) return;
      toast?.success?.(
        res.replayed
          ? `That Claim Had Already Gone Through. ${fmtWhole(Number(res.amount) || 0)} Chips Are Back In ${returnLabel}`
          : `Claimed ${fmtWhole(Number(res.amount) || 0)} Chips Back From ${titleCase(row.to_name)}`,
        undefined,
        undefined,
        operation.operationId
      );
      addRecipient(row.to_user_id);
      masterBus.emit('BALANCE_UPDATED', { source: 'agent_wallet_claim', userId: user?.id || '' });
      masterBus.emit('BALANCE_UPDATED', {
        source: 'agent_wallet_claim',
        userId: row.to_user_id,
      });
      claimOpIdsRef.current.delete(row.transaction_id);
      setUnconfirmed(null);
      refresh();
      // A confirmed claim back toasts and closes the cashier (Dan, 2026-10-22).
      closeAfterSuccess = true;
    } catch (e) {
      if (!isMounted.current || actionView.current !== owningView) return;
      reportError(e, 'WalletCashierModal.claimBack');
      toast?.error?.(safeErrorMessage(e, 'Claim Back Failed'));
      if (outcomeUnknown(e) && isMounted.current) {
        setUnconfirmed('undo');
        refresh();
      }
    } finally {
      busyRef.current = false;
      if (isMounted.current) setClaimingId(null);
    }
    if (closeAfterSuccess && isMounted.current) onClose();
  };

  const reverse = async (row: LedgerRow) => {
    if (!clubUuid || reversingId || busyRef.current) return;
    const owningView = actionView.current;
    busyRef.current = true;
    setReversingId(row.id);
    try {
      const operation = await reserveCashierWalletOperation(
        user?.id || '',
        clubUuid,
        'fn_club_bank_reverse',
        { p_transaction_id: row.id, p_reason: 'Reversed From The Club Bank Cashier' }
      );
      if (!operation) throw new CashierRefusal('Cashier Safety Storage Is Unavailable. Try Again');
      if (!isMounted.current || actionView.current !== owningView) return;
      const opId = operation.operationId;
      reverseOpIdsRef.current.set(row.id, opId);
      const { data, error } = await supabase.rpc('fn_club_bank_reverse', {
        p_transaction_id: row.id,
        p_reason: 'Reversed From The Club Bank Cashier',
        p_op_id: opId,
      });
      if (error) throw error;
      const res = (Array.isArray(data) ? data[0] : data) as {
        success?: boolean;
        error?: string;
      } | null;
      if (!res?.success) throw new CashierRefusal(res?.error || 'That Send Could Not Be Reversed');
      await clearCashierWalletOperation(operation);
      if (!isMounted.current || actionView.current !== owningView) return;
      toast?.success?.(`Reversed ${fmtWhole(row.amount)} Chips Back Into The Club Bank`);
      masterBus.emit('BALANCE_UPDATED', { source: 'club_bank_reverse', userId: user?.id || '' });
      reverseOpIdsRef.current.delete(row.id);
      setUnconfirmed(null);
      refresh();
    } catch (e) {
      if (!isMounted.current || actionView.current !== owningView) return;
      reportError(e, 'WalletCashierModal.reverse');
      toast?.error?.(safeErrorMessage(e, 'Reversal Failed'));
      if (outcomeUnknown(e) && isMounted.current) {
        setUnconfirmed('reverse');
        refresh();
      }
    } finally {
      busyRef.current = false;
      if (isMounted.current) setReversingId(null);
    }
  };

  /** One download path for both ledgers. The shared helper carries the
      Safari/Firefox revoke timing AND the app's share-sheet branch; this
      used to be a local copy with the same name, which is why a grep for
      the helper looked clean while the app silently downloaded nothing. */
  // Observe the actual file handoff, including native sharing. A closed or
  // changed ledger cannot hand an old account's bytes to the share sheet.
  const downloadLedgerCsv = async (name: string, header: string[], body: string[]) => {
    if (exportBusyRef.current || ledgerLoading) return;
    const owningView = exportView.current;
    const ledgerRequest = ledgerSeqRef.current;
    const promoRequest = promoLedgerSeqRef.current;
    const current = () =>
      isMounted.current &&
      exportView.current === owningView &&
      ledgerSeqRef.current === ledgerRequest &&
      promoLedgerSeqRef.current === promoRequest;
    exportBusyRef.current = true;
    setExporting(true);
    try {
      const handedOff = await downloadBlob(
        `${name}-${clubName.replace(/\W+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`,
        new Blob(['\ufeff' + [header.map(csvText).join(','), ...body].join('\r\n') + '\r\n'], {
          type: 'text/csv;charset=utf-8',
        }),
        current
      );
      if (!current()) return;
      if (!handedOff) throw new Error('Could Not Export The Ledger');
      toast?.success?.(`Exported ${body.length.toLocaleString('en-US')} Ledger Entries`);
    } catch (error) {
      if (!current()) return;
      reportError(error, 'WalletCashierModal.exportLedger');
      toast?.error?.(safeErrorMessage(error, 'Could Not Export The Ledger'));
    } finally {
      exportBusyRef.current = false;
      if (isMounted.current) setExporting(false);
    }
  };

  /** The promo ledger rows on screen, as a spreadsheet. */
  const exportPromoCsv = () => {
    const rows = promoLedger.slice(0, EXPORT_MAX);
    if (rows.length === 0) return;
    void downloadLedgerCsv(
      promoSource === 'club_pot' ? 'club-promo-wallet-ledger' : 'promo-float-ledger',
      ['When', 'Direction', 'Category', 'Amount', 'Counterparty', 'By', 'Wallet After', 'Note'],
      rows.map((r) =>
        [
          csvTimestamp(new Date(r.created_at).toISOString()),
          csvText(r.direction),
          csvText(r.category),
          csvDecimal(r.amount),
          csvText(r.counterparty_name ?? r.counterparty_type ?? ''),
          csvText(r.actor_name ?? ''),
          csvDecimal(r.balance_after ?? ''),
          csvText(r.notes ?? ''),
        ].join(',')
      )
    );
  };

  /** The rows on screen, as a spreadsheet. Nothing leaves that is not shown. */
  const exportCsv = () => {
    const rows = ledger.slice(0, EXPORT_MAX);
    if (rows.length === 0) return;
    const header = [
      'When',
      'Type',
      'Amount',
      'From',
      'To',
      'Into Wallet',
      'Bank Balance After',
      'Reversed',
      'Note',
    ];
    const body = rows.map((r) =>
      [
        csvTimestamp(new Date(r.created_at).toISOString()),
        csvText(r.transaction_type),
        csvDecimal(r.amount),
        csvText(r.from_name ?? ''),
        csvText(r.to_name ?? ''),
        csvText(((r.metadata?.destination || r.metadata?.source) as string) ?? ''),
        csvDecimal(r.balance_after ?? ''),
        csvText(r.is_reversed ? 'yes' : 'no'),
        csvText(r.notes ?? ''),
      ].join(',')
    );
    // The shared downloader retains the browser read window before revoking.
    void downloadLedgerCsv('club-bank-ledger', header, body);
  };

  if (!isOpen) return null;

  /**
   * Every dismissal path guards on the SAME condition. Escape already checked
   * busyRef, and the overlay checked `sending` - but the X in the corner
   * checked nothing at all, so the one control a thumb reaches first could
   * close the cashier in the middle of a claim back or a ledger reversal. And
   * `sending` alone was too narrow: it is false for both of those.
   */
  const inFlight = sending || claimingId !== null || reversingId !== null;
  // While the Chip Mint is up, every close path here is the mint's to use
  // (audit C2-4): closing the cashier would unmount a mint in flight.
  const closeIfIdle = () => {
    if (!inFlight && !showMint) onClose();
  };

  const cashierTitle =
    walletType === 'promo_wallet'
      ? 'PROMO WALLET'
      : walletType === 'agent_wallet'
        ? 'AGENT WALLET'
        : 'CLUB BANK';

  /* THE FOOT PAINTS BOTH PLATES, so it is only used where there are genuinely
     two actions: the send and claim forms, which have a cancel and a confirm.
     The agent claim list, the two ledgers and the refusal each have exactly
     one, so they close with the flat cap and print that action as a lit word
     on the glass. */
  const formTab = !agentClaimTab && (tab === 'send' || tab === 'claim');
  const bankTransfer = walletType === 'club_bank' && formTab;
  /* TAPPING A MEMBER OPENS THE SEND TO THAT MEMBER, IN EVERY WALLET (Dan
     2026-10-19: "when i click a player ... it should open up to that user to
     send chips. currently it does nothing"). Only the Club Bank swapped the
     roster for the chosen player's card; the Promo and Agent Wallets just
     lit the row's text, so a tap read as nothing happening. Any wallet's send
     or claim form with a recipient chosen now shows that player's card, the
     destination picker on it, and Change Recipient - the same face for all
     three. Pinned by tests/wallet-recipient-tap-opens-send.law.test.tsx. */
  const showRecipientCard = formTab && Boolean(recipient);

  // Belt and braces: this modal is only mounted behind a role check, and the
  // row that opens it only renders for roles that hold the wallet. If it is
  // somehow reached anyway, say so plainly rather than rendering an empty
  // cashier.
  if (!allowed) {
    return createPortal(
      <div
        className="cbc-overlay wcm-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Club Bank Cashier"
        onClick={onClose}
      >
        <div ref={panelRef} className="cbc-panel wcm ac-popup" onClick={(e) => e.stopPropagation()}>
          <SpadeConsole
            onClose={onClose}
            as="div"
            eyebrow={clubName || 'Club Arena'}
            title={cashierTitle}
            pill="Locked"
            pillInk="red"
            foot="foot"
          >
            {/* "Co Owners" cannot appear in JSX text here: check-title-case
                treats a bare `co` as the poker position (cutoff) and rewrites it
                to "CO". Co-owners are covered by "Owners" in plain speech, and
                the precise four-role list is in the server's own refusal string,
                which reaches the screen through an expression rather than page
                copy and so keeps its casing. */}
            <p className="cbc-denied sc-copy sc-copy--center">
              {walletType === 'club_bank'
                ? 'The Club Bank Is Restricted To Owners, Admins And Super Agents.'
                : 'This Wallet Belongs To Agents And Club Staff.'}
            </p>
            <div className="cbc-actions">
              <button onClick={onClose}>Close</button>
            </div>
          </SpadeConsole>
        </div>
      </div>,
      document.body
    );
  }

  /* RENDERED INTO <body> (audit C2-17, render-measured). Mounted inside <main>,
     whose .casinoStage sets `isolation: isolate`, the fixed footer (z-index
     1000, outside <main>) painted over the bottom 22-26px of this panel at any
     z-index - the welcome modal's 2026-10-05 cause and cure. */
  return createPortal(
    <>
      <div
        className="cbc-overlay wcm-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={`${cashierTitle} Cashier`}
        onClick={closeIfIdle}
      >
        <div
          ref={panelRef}
          className={`cbc-panel wcm ac-popup${bankTransfer ? ' cbc-bank-transfer' : ''}`}
          onClick={(e) => e.stopPropagation()}
        >
          <SpadeConsole
            onClose={inFlight || showMint ? undefined : closeIfIdle}
            as="div"
            /* The club in the header well's eyebrow, the account engraved
               beneath it, and the viewer's own standing in the well's painted
               pill slot. THE CORNER X GOES THROUGH closeIfIdle (launch audit
               D-02 / audit C2-3): SpadeConsole paints an X for any onClose
               since 2026-09-23, and this one called onClose directly, so the
               one control a thumb reaches first closed the cashier with a send,
               a claim back or a reversal in flight - and the reopen minted a
               fresh key for the retry. No X is painted at all while anything is
               travelling or the Chip Mint is up, exactly as the cashout sheet
               and the mint hide theirs; the overlay, Escape and every Close
               word guard the same. */
            className={bankTransfer ? transferStyles.console : undefined}
            eyebrow={
              bankTransfer ? `${clubName || 'Club Arena'} · Club Bank` : clubName || 'Club Arena'
            }
            title={bankTransfer ? (tab === 'claim' ? 'Claim Back' : 'Send Out') : cashierTitle}
            pill={bankTransfer ? (inFlight ? 'Working' : 'Ready') : roleLabel(viewerRole)}
            pillInk={bankTransfer ? (inFlight ? 'blue' : 'green') : 'blue'}
            foot={formTab ? 'plates' : 'foot'}
            plates={
              formTab
                ? {
                    secondary: {
                      label: confirming ? 'Go Back' : 'Cancel',
                      disabled: inFlight,
                      onClick: () => (confirming ? setConfirming(false) : closeIfIdle()),
                      'aria-label': confirming ? 'Go Back' : 'Close The Cashier',
                    },
                    primary: {
                      label: sending
                        ? tab === 'claim'
                          ? 'Claiming'
                          : 'Sending'
                        : confirming
                          ? tab === 'claim'
                            ? 'Yes, Claim It'
                            : 'Yes, Send It'
                          : bankTransfer
                            ? 'Confirm'
                            : tab === 'claim'
                              ? 'Claim Chips'
                              : 'Send Chips',
                      ink: canSend ? 'white' : 'muted',
                      disabled: !canSend,
                      onClick: onSendPressed,
                    },
                  }
                : undefined
            }
          >
            <button type="button" className="cbc-word" disabled={inFlight} onClick={refresh}>
              Refresh Balances
            </button>
            <div className="cbc-bank" hidden={bankTransfer}>
              <span>
                {walletType === 'promo_wallet'
                  ? promoBalanceLabel(promoSource)
                  : walletType === 'agent_wallet'
                    ? 'Agent Wallet Balance'
                    : 'Club Bank Balance'}
              </span>
              <strong aria-live="polite">
                {walletType === 'agent_wallet' && hasFloat === false
                  ? 'No Agent Float Yet'
                  : bank === null
                    ? clubLoading
                      ? '...'
                      : 'Unavailable'
                    : fmtWallet(bank)}
              </strong>
              {walletType === 'promo_wallet' && clubName && (
                <em className="cbc-bank-sub">
                  {promoSource === 'club_pot' ? clubName : `${clubName} Agent Float`}
                </em>
              )}
              {/* The line a send may draw past the float, printed only when
                  there is one, so a prepaid agent reads what they always read. */}
              {walletType === 'agent_wallet' && bank !== null && credit !== null && credit > 0 && (
                <em className="cbc-bank-sub">
                  {`Plus ${fmtWallet(credit)} Credit Line Left, So You Can Send ${fmtWallet(bank + credit)}`}
                </em>
              )}
            </div>

            {/* TWO PROMO ACCOUNTS, ONE SWITCH (2026-09-05). Offered only when the
                viewer can stand at both: a Club Bank role who also holds a
                personal float. An agent sees their float alone; a bank role with
                no float sees the pot alone. Both balances are printed on the
                switch so the one you are NOT looking at is never a mystery.
                "Holds a float" is `hasFloat`, the agents row itself (2026-10-09):
                a missing row now reads as an empty float (0) rather than an
                unknown one, so `promoFloat !== null` alone would offer a bank
                role a float they do not have. */}
            {walletType === 'promo_wallet' &&
              promoSourceFor(viewerRole) === 'club_pot' &&
              hasFloat === true &&
              promoFloat !== null && (
                <div className="cbc-source" role="radiogroup" aria-label="Promo Wallet Source">
                  <button
                    role="radio"
                    disabled={inFlight}
                    aria-checked={promoSource === 'club_pot'}
                    className={promoSource === 'club_pot' ? 'cbc-source-on' : ''}
                    onClick={() => {
                      setPromoSource('club_pot');
                      setRecipient(null);
                    }}
                  >
                    <span>Club Promo Wallet</span>
                    <strong>
                      {promoPot === null
                        ? clubLoading
                          ? '...'
                          : 'Unavailable'
                        : fmtWallet(promoPot)}
                    </strong>
                  </button>
                  <button
                    role="radio"
                    disabled={inFlight}
                    aria-checked={promoSource === 'own_float'}
                    className={promoSource === 'own_float' ? 'cbc-source-on' : ''}
                    onClick={() => {
                      setPromoSource('own_float');
                      setRecipient(null);
                    }}
                  >
                    <span>My Promo Float</span>
                    <strong>{fmtWallet(promoFloat)}</strong>
                  </button>
                </div>
              )}

            {clubUuid === null && !clubLoading && (
              <div className="cbc-note cbc-note--bad">
                That Club Could Not Be Resolved, So Nothing Can Be Sent From Here.
              </div>
            )}

            {/* Chip Mint lives HERE and only for a standalone club. A club inside
                a union has no mint at all - chips flow down from the union. */}
            {mayMint && (
              <button className="cbc-mint" disabled={inFlight} onClick={() => setShowMint(true)}>
                Mint Chips Into The Club Bank
              </button>
            )}

            {/* ── Tabs ─────────────────────────────────────────────────────── */}
            <div className="cbc-tabs" role="tablist">
              {tabs.map((t) => (
                <button
                  key={t}
                  role="tab"
                  disabled={inFlight}
                  aria-selected={tab === t}
                  className={tab === t ? 'cbc-tab cbc-tab--on' : 'cbc-tab'}
                  onClick={() => setTab(t)}
                >
                  {walletType === 'club_bank' && t === 'send' ? 'Send Out' : TAB_LABELS[t]}
                </button>
              ))}
            </div>

            <div className="cbc-body">
              {agentClaimTab ? (
                /* THE AGENT WALLET'S CLAIM BACK TAB. Not the club bank's kind:
                   there is no member to pick and no amount to type, because the
                   only thing an agent may take back is a send they already made,
                   and only while its ten minute window is open. One row per send,
                   one tap, and the row disappears when the clock runs out. */
                <>
                  {unconfirmed === 'undo' && (
                    <div className="cbc-warn" role="alert" ref={revealOnMount}>
                      That Claim Back Got No Answer And May Have Gone Through. Tapping It Again
                      Cannot Take Twice.
                    </div>
                  )}
                  {reversibleLoading && (
                    <div className="cbc-empty">Reading Your Recent Sends...</div>
                  )}
                  {!reversibleLoading && stillClaimable.length === 0 && (
                    <div className="cbc-empty">
                      Nothing To Claim Back. Only Sends Made In The Last Ten Minutes Can Be Undone.
                    </div>
                  )}
                  {stillClaimable.map((row) => {
                    const left = secondsLeftFor(row);
                    return (
                      <div key={row.transaction_id} className="cbc-tx">
                        <div className="cbc-tx-top">
                          <span className="cbc-tx-type">{titleCase(row.to_name)}</span>
                          <span className="cbc-tx-amount">{fmtWallet(row.remaining)}</span>
                        </div>
                        <div className="cbc-tx-mid">
                          <span>Into {enumToTitleCase(row.destination)}</span>
                          <label>
                            Return To
                            <select
                              aria-label={`Return Wallet For ${row.to_name}`}
                              value={
                                claimReturnWallets(row.destination, viewerRole).includes(
                                  claimReturn
                                )
                                  ? claimReturn
                                  : claimReturnWallets(row.destination, viewerRole)[0]
                              }
                              disabled={claimingId !== null}
                              onChange={(event) =>
                                setClaimReturn(event.target.value as ClaimDestination)
                              }
                            >
                              {claimReturnWallets(row.destination, viewerRole).map((wallet) => (
                                <option key={wallet} value={wallet}>
                                  {CLAIM_DESTINATION_LABELS[wallet]}
                                </option>
                              ))}
                            </select>
                          </label>
                          <span className="cbc-tx-when">
                            {Math.floor(left / 60)} Min {left % 60} Sec Left
                          </span>
                        </div>
                        {/* `claimed_back` was fetched and never shown, so a send
                            already partly reversed elsewhere displayed only its
                            remainder with no hint that the original was larger -
                            which reads as the wrong amount having been sent. */}
                        {Number(row.claimed_back) > 0 && (
                          <div className="cbc-tx-foot">
                            <span>
                              Sent {compactChips(row.amount)}, {compactChips(row.claimed_back)}{' '}
                              Already Claimed Back
                            </span>
                          </div>
                        )}
                        <button
                          className="cbc-undo"
                          disabled={inFlight}
                          onClick={() => void claimBack(row)}
                        >
                          {claimingId === row.transaction_id
                            ? 'Claiming...'
                            : `Claim Back ${fmtWhole(row.remaining)} Chips`}
                        </button>
                      </div>
                    );
                  })}
                  <div className="cbc-actions">
                    <button disabled={inFlight} onClick={closeIfIdle}>
                      Close
                    </button>
                  </div>
                </>
              ) : tab === 'send' || tab === 'claim' ? (
                <>
                  {/* Destination (send) or source (claim) */}
                  <div className="cbc-field" hidden={showRecipientCard}>
                    <label className="cbc-label cbc-destination-label">
                      {tab === 'claim' ? 'Claim From' : 'Send Into'}
                    </label>
                    <div className="cbc-seg">
                      {destinations.map((key) => (
                        <button
                          key={key}
                          disabled={inFlight}
                          className={destination === key ? 'cbc-seg-on' : ''}
                          onClick={() => setDestination(key)}
                        >
                          {destinationLabel(key)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Recipient (send) or holder (claim) */}
                  {showRecipientCard && recipient && (
                    /* Outside the Club Bank the dialog is not the transfer
                       console, so the card brings the console's scope with it
                       (its frame and inks are scoped to .console). */
                    <div className={bankTransfer ? undefined : transferStyles.console}>
                      <section
                        ref={revealOnMount}
                        className={transferStyles.playerCard}
                        aria-label="Selected Player"
                      >
                        <img
                          className={transferStyles.playerCardAvatar}
                          src={
                            recipient.avatar_url ||
                            generateAvatarSvg(recipient.user_id, recipient.name)
                          }
                          alt=""
                          onError={(event) => {
                            event.currentTarget.onerror = null;
                            event.currentTarget.src = generateAvatarSvg(
                              recipient.user_id,
                              recipient.name
                            );
                          }}
                        />
                        <span className={transferStyles.playerCardPlate}>
                          <span className={transferStyles.playerCardIdentity}>
                            <strong className={transferStyles.playerCardName}>
                              {titleCase(recipient.name)}
                            </strong>
                            <span className={transferStyles.playerCardId}>
                              ID: {recipient.short_id}
                            </span>
                          </span>
                          <span className={transferStyles.playerCardBalance}>
                            <span>{destinationLabel(destination)}</span>
                            <svg
                              className={transferStyles.entityChevron}
                              viewBox="0 0 12 8"
                              aria-hidden="true"
                            >
                              <path
                                d="M1 1.5 6 6.5 11 1.5"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                              />
                            </svg>
                            <CashierFrameBalance text={fmtWallet(holderHeld)} />
                          </span>
                        </span>
                        <select
                          className={transferStyles.walletSelect}
                          aria-label={tab === 'claim' ? 'Claim From' : 'Send Into'}
                          value={destination}
                          disabled={inFlight}
                          onChange={(event) =>
                            setDestination(event.target.value as DestinationWallet)
                          }
                        >
                          {destinations.map((key) => (
                            <option key={key} value={key}>
                              {destinationLabel(key)}
                            </option>
                          ))}
                        </select>
                      </section>
                    </div>
                  )}
                  {showRecipientCard && (
                    <button
                      type="button"
                      className="cbc-word"
                      disabled={inFlight}
                      onClick={() => setRecipient(null)}
                    >
                      Change Recipient
                    </button>
                  )}
                  <div className="cbc-field" hidden={showRecipientCard}>
                    <label className="cbc-label" htmlFor="cbc-search">
                      {tab === 'claim' ? 'Claim From Member' : 'Recipient'}
                    </label>
                    <input
                      id="cbc-search"
                      className="cbc-input cbc-search"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder={
                        AGENT_ONLY.includes(destination) ? 'Search Agents' : 'Search Members'
                      }
                      aria-label="Search Recipients"
                      disabled={inFlight}
                    />
                    <div className="cbc-list">
                      {membersLoading && <div className="cbc-empty">Loading Members...</div>}
                      {/* A READ THAT FAILED IS NOT AN EMPTY CLUB (audit C2-15).
                          It printed "No Members In This Club Yet." over a
                          network error, the same words an agent with no
                          downline reads, with nothing to try again. */}
                      {!membersLoading && membersError && (
                        <>
                          <div className="cbc-empty cbc-empty--bad" role="alert">
                            The Member List Could Not Be Loaded.
                          </div>
                          <button
                            className="cbc-more"
                            onClick={() => clubUuid && void loadMembers(clubUuid)}
                          >
                            Retry
                          </button>
                        </>
                      )}
                      {!membersLoading && !membersError && eligible.length === 0 && (
                        <div className="cbc-empty">
                          {members.length > 0
                            ? 'No Members Match That Search.'
                            : ['super_agent', 'agent', 'sub_agent'].includes(viewerRole)
                              ? 'Nobody In Your Downline Yet.'
                              : 'No Members In This Club Yet.'}
                        </div>
                      )}
                      {eligible.map((m) => {
                        const block = blockFor(m);
                        return (
                          <button
                            key={m.user_id}
                            disabled={inFlight}
                            className={
                              block
                                ? 'cbc-member cbc-member--blocked'
                                : recipient?.user_id === m.user_id
                                  ? 'cbc-member cbc-member--on'
                                  : 'cbc-member'
                            }
                            onClick={() => {
                              if (!block) setRecipient(m);
                            }}
                            aria-pressed={recipient?.user_id === m.user_id}
                            aria-disabled={block ? true : undefined}
                            title={block ? block.reason : undefined}
                          >
                            {/* A photograph when there is one; no grey placeholder
                                square when there is not - the name identifies
                                the member. */}
                            {m.avatar_url && (
                              <img
                                className="cbc-member-avatar"
                                src={m.avatar_url}
                                alt=""
                                loading="lazy"
                              />
                            )}
                            <div className="cbc-member-info">
                              <span className="cbc-member-name">
                                {titleCase(m.name)}
                                {m.user_id === user?.id && ' (You)'}
                              </span>
                              <span className="cbc-member-id">#{m.short_id}</span>
                            </div>
                            <span className="cbc-member-role">{roleLabel(m.role)}</span>
                            {block ? (
                              <span className="cbc-member-block">{block.label}</span>
                            ) : (
                              <span className="cbc-member-bal">{fmtWallet(m.chip_balance)}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {bankTransfer && (
                    <section
                      className={transferStyles.walletRow}
                      aria-label={
                        tab === 'claim' ? `Return To ${claimReturnLabel}` : `From ${spentAccount}`
                      }
                    >
                      <span className={transferStyles.walletRowSlot} aria-hidden="true">
                        <img
                          src={`${import.meta.env.BASE_URL}assets/club-buttons/wallets/wallet-mark-v1.svg`}
                          alt=""
                        />
                      </span>
                      <span className={transferStyles.walletRowPlate}>
                        <span className={transferStyles.walletRowLabel}>
                          {tab === 'claim'
                            ? `Return To ${claimReturnLabel}`
                            : `From ${spentAccount}`}
                        </span>
                        <svg
                          className={transferStyles.entityChevron}
                          viewBox="0 0 12 8"
                          aria-hidden="true"
                        >
                          <path
                            d="M1 1.5 6 6.5 11 1.5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          />
                        </svg>
                        <CashierFrameBalance
                          text={spendBalance === null ? 'Unavailable' : fmtWallet(spendBalance)}
                        />
                      </span>
                      <select
                        className={transferStyles.walletSelect}
                        aria-label={tab === 'claim' ? 'Claim Into' : 'Send From'}
                        value={tab === 'claim' ? effectiveClaimReturn : bankSendSource}
                        disabled={inFlight || Boolean(unconfirmed)}
                        onChange={(event) => {
                          if (busyRef.current || unconfirmed) return;
                          if (tab === 'claim') {
                            setClaimReturn(event.target.value as ClaimDestination);
                            setConfirming(false);
                            return;
                          }
                          if (tab !== 'send') return;
                          setFundingBalance(null);
                          setFundingCredit(0);
                          setBankSendSource(event.target.value as CashierWalletType);
                          setSendError(null);
                          setSendReceipt(null);
                        }}
                      >
                        {tab === 'claim' ? (
                          claimReturns.map((wallet) => (
                            <option key={wallet} value={wallet}>
                              {CLAIM_DESTINATION_LABELS[wallet]}
                            </option>
                          ))
                        ) : (
                          <option value="club_bank">Club Bank</option>
                        )}
                        {tab === 'send' && canUseCashier('agent_wallet', viewerRole) && (
                          <option value="agent_wallet">Your Agent Wallet</option>
                        )}
                        {tab === 'send' && canUseCashier('promo_wallet', viewerRole) && (
                          <option value="promo_wallet">The Club Promo Wallet</option>
                        )}
                      </select>
                    </section>
                  )}
                  {/* Amount */}
                  <div className="cbc-field">
                    <label className={bankTransfer ? transferStyles.entryRow : undefined}>
                      {bankTransfer && <span className={transferStyles.entryRowSlot}>Amount</span>}
                      <span className={bankTransfer ? transferStyles.entryRowPlate : undefined}>
                        <span className="cbc-label" hidden={bankTransfer}>
                          Amount
                        </span>
                        <input
                          id="cbc-amount"
                          disabled={inFlight}
                          className={bankTransfer ? transferStyles.entryInput : 'cbc-input'}
                          type="text"
                          /* Whole chips only (see amountIsWhole), so the keypad that
                         comes up is the numeric one rather than the decimal one
                         offering a point the field will then reject. */
                          inputMode="numeric"
                          min={1}
                          step={1}
                          value={formatCashierAmountInput(amount)}
                          onChange={(e) => setAmount(cashierAmountInputValue(e.target.value))}
                          placeholder="Whole Chips"
                          /* aria-label was the EMPTY STRING, which is worse than
                         absent: it overrides the visible <label> and announces an
                         unnamed spin button to a screen reader on the one field
                         that decides how much money moves. */
                          aria-label={tab === 'claim' ? 'Chips To Claim Back' : 'Chips To Send'}
                        />
                      </span>
                    </label>
                    {bankTransfer && (
                      <div className={transferStyles.modalTotal}>Total: {fmtWhole(amt)}</div>
                    )}
                    {tab === 'claim' && recipient && !bankTransfer && (
                      <div className="cbc-blurb">
                        {holderHeld === null
                          ? 'Reading That Wallet...'
                          : `${titleCase(recipient.name)} Holds ${fmtWallet(holderHeld)} In That Wallet.`}
                      </div>
                    )}
                    {/* A BALANCE WE COULD NOT READ CANNOT PROJECT AN AFTER
                        FIGURE. `bank ?? 0` turned an unread treasury into a
                        confident "The Wallet Would Hold -500.00 Afterwards" -
                        directly beneath a header already showing "..." for the
                        same number. The send is refused anyway (canSend requires
                        cap !== null); the sentence just has to stop lying. */}
                    {amt > 0 && !overCap && spendBalance !== null && (
                      <div className="cbc-blurb">
                        {tab === 'claim'
                          ? `Claiming ${fmtWhole(amt)}. Returning To ${claimReturnLabel}.`
                          : creditDraw > 0
                            ? `Sending ${fmtWhole(amt)}. ${fmtExact(creditDraw)} Of It Is Drawn From Your Credit Line.`
                            : `Sending ${fmtWhole(amt)}. The Wallet Would Hold ${fmtWallet(spendBalance - amt)} Afterwards.`}
                      </div>
                    )}
                    {overCap && (
                      <div className="cbc-warn">
                        {tab === 'claim'
                          ? `That Wallet Only Holds ${fmtWallet(cap ?? 0)} Chips.`
                          : creditLine > 0
                            ? `Your Wallet And Credit Line Cover ${fmtWallet(cap ?? 0)} Chips.`
                            : `The Wallet Only Holds ${fmtWallet(cap ?? 0)} Chips.`}
                      </div>
                    )}
                    {sendError && (
                      <div className="cbc-warn" role="alert" ref={revealOnMount}>
                        {titleCase(sendError)}
                      </div>
                    )}
                    {sendReceipt && (
                      <div className="cbc-blurb" role="status" ref={revealOnMount}>
                        {titleCase(sendReceipt)}
                      </div>
                    )}
                    {/* THE UNKNOWN OUTCOME, INSIDE THE FRAME and under the
                        figures it is about (see `unconfirmed`), scrolled into
                        view: the plate that was tapped sits in the foot. */}
                    {unconfirmed === 'claim' && (
                      <div className="cbc-warn" role="alert" ref={revealOnMount}>
                        That Claim Got No Answer And May Have Gone Through. Check The Balance Above:
                        Claiming It Again Unchanged Cannot Take Twice.
                      </div>
                    )}
                    {unconfirmed === 'send' && (
                      <div className="cbc-warn" role="alert" ref={revealOnMount}>
                        That Send Got No Answer And May Have Gone Through. Check The Balance Above:
                        Sending It Again Unchanged Cannot Pay Twice.
                      </div>
                    )}
                  </div>

                  {/* Reason — lands in the ledger row, so it is worth typing. */}
                  <div className="cbc-field">
                    <label className="cbc-label" htmlFor="cbc-reason">
                      Reason (Optional)
                    </label>
                    <input
                      id="cbc-reason"
                      disabled={inFlight}
                      className="cbc-input"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Shows On The Ledger Entry"
                      maxLength={140}
                      aria-label="Reason"
                    />
                  </div>

                  {confirming && recipient && (
                    <div className="cbc-confirmbox" role="alert">
                      {/* THE ACCOUNT BY ITS NAME (audit C2-14). This said "Of The
                          Club Bank" on every cashier, so an agent sending 20 of
                          a 40 chip float read "50 Percent Of The Club Bank". */}
                      {tab === 'claim'
                        ? `Claim ${fmtWhole(amt)} Chips From ${titleCase(recipient.name)} Into ${claimReturnLabel}?`
                        : creditDraw > 0
                          ? `Send ${fmtWhole(amt)} Chips To ${titleCase(recipient.name)}? ${fmtExact(creditDraw)} Of Them Are Drawn From Your Credit Line.`
                          : `That Is ${((amt / (spendBalance || 1)) * 100).toFixed(1)} Percent Of ${spentAccount}. Send ${fmtWhole(amt)} Chips To ${titleCase(recipient.name)}?`}
                    </div>
                  )}

                  {/* CANCEL / SEND ARE THE PAINTED PLATES NOW. The pair used to
                      be two drawn pills at the bottom of the scrolling body,
                      which put the confirm for a send worth a quarter of the club
                      bank below the fold on a phone. They are the foot's own art,
                      always in view, and they carry the same labels, the same
                      disabled conditions and the same two handlers. */}
                </>
              ) : walletType === 'promo_wallet' ? (
                /* THE PROMO WALLET LEDGER. Every movement on the account the
                   viewer is standing at, newest first, with the other side of
                   each one named: the union that funded it, the player it was
                   handed to, the agent float it topped up. */
                <>
                  {ledgerError && <div className="cbc-empty cbc-empty--bad">{ledgerError}</div>}

                  {!ledgerError && promoLedgerTotals && (
                    <div className="cbc-totals">
                      <div>
                        <span>Received</span>
                        <strong className="cbc-in">{compactChips(promoLedgerTotals.in)}</strong>
                      </div>
                      <div>
                        <span>Handed Out</span>
                        <strong className="cbc-out">{compactChips(promoLedgerTotals.out)}</strong>
                      </div>
                      <div>
                        <span>Net</span>
                        <strong>{compactChips(promoLedgerTotals.net)}</strong>
                      </div>
                    </div>
                  )}

                  {!ledgerError && (
                    <div className="cbc-ledger-head">
                      <span>
                        {promoLedgerTotal.toLocaleString('en-US')} Entries
                        {' · '}
                        {promoSource === 'club_pot' ? 'Club Promo Wallet' : 'Your Promo Float'}
                      </span>
                      <button
                        className="cbc-export"
                        onClick={exportPromoCsv}
                        disabled={exporting || ledgerLoading || promoLedger.length === 0}
                      >
                        Export CSV
                      </button>
                    </div>
                  )}

                  {!ledgerError &&
                    promoLedger.map((row) => {
                      const inbound = row.direction === 'in';
                      const other =
                        titleCase(row.counterparty_name) ||
                        (row.counterparty_type ? enumToTitleCase(row.counterparty_type) : 'Ledger');
                      const note =
                        row.notes && !row.notes.startsWith('auto-ledgered') ? row.notes : null;
                      return (
                        <div key={row.id} className="cbc-tx">
                          <div className="cbc-tx-top">
                            <span className="cbc-tx-type">{enumToTitleCase(row.category)}</span>
                            <span
                              className={inbound ? 'cbc-tx-amount cbc-in' : 'cbc-tx-amount cbc-out'}
                            >
                              {inbound ? '+' : '-'}
                              {compactChips(row.amount)}
                            </span>
                          </div>
                          <div className="cbc-tx-mid">
                            <span>{inbound ? `From ${other}` : `To ${other}`}</span>
                            <span className="cbc-tx-when">
                              {new Date(row.created_at).toLocaleString('en-US', {
                                month: 'short',
                                day: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit',
                              })}
                            </span>
                          </div>
                          <div className="cbc-tx-foot">
                            {note && <span>{titleCase(note)}</span>}
                            {row.actor_name && <span>By {titleCase(row.actor_name)}</span>}
                            {row.balance_after !== null && row.balance_after !== undefined && (
                              <span>Wallet After {fmtWallet(Number(row.balance_after))}</span>
                            )}
                          </div>
                        </div>
                      );
                    })}

                  {!ledgerError && !ledgerLoading && promoLedger.length === 0 && (
                    <div className="cbc-empty">
                      Nothing Has Moved Through This Promo Wallet Yet. A Union Promo Send, A Jackpot
                      Promo Sweep Or A Hand Out Writes A Row Here.
                    </div>
                  )}
                  {ledgerLoading && <div className="cbc-empty">Loading Ledger...</div>}
                  {!ledgerError && !ledgerLoading && promoLedger.length < promoLedgerTotal && (
                    <button
                      className="cbc-more"
                      onClick={() =>
                        clubUuid && loadPromoLedger(clubUuid, promoLedger.length, promoSource)
                      }
                    >
                      Load More
                    </button>
                  )}
                  <div className="cbc-actions">
                    <button disabled={inFlight} onClick={closeIfIdle}>
                      Close
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {ledgerError && <div className="cbc-empty cbc-empty--bad">{ledgerError}</div>}
                  {unconfirmed === 'reverse' && (
                    <div className="cbc-warn" role="alert" ref={revealOnMount}>
                      That Reversal Got No Answer And May Have Gone Through. Tapping It Again Cannot
                      Reverse Twice.
                    </div>
                  )}

                  {!ledgerError && ledgerTotals && (
                    <div className="cbc-totals">
                      <div>
                        <span>Into The Bank</span>
                        <strong className="cbc-in">{compactChips(ledgerTotals.into_bank)}</strong>
                      </div>
                      <div>
                        <span>Out Of The Bank</span>
                        <strong className="cbc-out">
                          {compactChips(ledgerTotals.out_of_bank)}
                        </strong>
                      </div>
                      <div>
                        <span>Net</span>
                        <strong>{compactChips(ledgerTotals.net)}</strong>
                      </div>
                    </div>
                  )}

                  {!ledgerError && (
                    <div className="cbc-ledger-head">
                      <span>
                        {ledgerTotal.toLocaleString('en-US')}{' '}
                        {typeFilter ? `${enumToTitleCase(typeFilter)} Entries` : 'Entries'}
                      </span>
                      <button
                        className="cbc-export"
                        onClick={exportCsv}
                        disabled={exporting || ledgerLoading || ledger.length === 0}
                      >
                        Export CSV
                      </button>
                    </div>
                  )}

                  {!ledgerError && ledgerTypes.length > 0 && (
                    <div className="cbc-chips">
                      <button
                        className={typeFilter === null ? 'cbc-chip cbc-chip--on' : 'cbc-chip'}
                        onClick={() => setTypeFilter(null)}
                      >
                        Everything
                      </button>
                      {ledgerTypes.map((t) => (
                        <button
                          key={t}
                          className={typeFilter === t ? 'cbc-chip cbc-chip--on' : 'cbc-chip'}
                          onClick={() => setTypeFilter(t)}
                        >
                          {enumToTitleCase(t)}
                        </button>
                      ))}
                    </div>
                  )}

                  {!ledgerError &&
                    ledger.map((row) => {
                      const dest = row.metadata?.destination as string | undefined;
                      const src = row.metadata?.source as string | undefined;
                      return (
                        <div
                          key={row.id}
                          className={row.is_reversed ? 'cbc-tx cbc-tx--reversed' : 'cbc-tx'}
                        >
                          <div className="cbc-tx-top">
                            <span className="cbc-tx-type">
                              {enumToTitleCase(row.transaction_type)}
                            </span>
                            <span className="cbc-tx-amount">{compactChips(row.amount)}</span>
                          </div>
                          <div className="cbc-tx-mid">
                            <span>
                              {titleCase(row.from_name) || 'Club Bank'}
                              {' → '}
                              {row.transaction_type === 'club_bank_claim'
                                ? 'Club Bank'
                                : titleCase(row.to_name) ||
                                  (dest ? enumToTitleCase(dest) : 'Club Bank')}
                            </span>
                            <span className="cbc-tx-when">
                              {new Date(row.created_at).toLocaleString('en-US', {
                                month: 'short',
                                day: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit',
                              })}
                            </span>
                          </div>
                          <div className="cbc-tx-foot">
                            {row.notes && <span>{titleCase(row.notes)}</span>}
                            {dest && <span>Into {enumToTitleCase(dest)}</span>}
                            {src && row.transaction_type === 'club_bank_claim' && (
                              <span>From {enumToTitleCase(src)}</span>
                            )}
                            {row.balance_after !== null && (
                              <span>Bank After {fmtWallet(Number(row.balance_after))}</span>
                            )}
                            {row.is_reversed && <span className="cbc-tx-rev">Reversed</span>}
                          </div>
                          {row.reversible && (
                            <button
                              className="cbc-undo"
                              disabled={inFlight}
                              onClick={() => void reverse(row)}
                            >
                              {reversingId === row.id ? 'Reversing...' : 'Reverse This Send'}
                            </button>
                          )}
                        </div>
                      );
                    })}

                  {!ledgerError && !ledgerLoading && ledger.length === 0 && (
                    <div className="cbc-empty">No Chip Movements Recorded Yet.</div>
                  )}
                  {ledgerLoading && <div className="cbc-empty">Loading Ledger...</div>}
                  {!ledgerError && !ledgerLoading && ledger.length < ledgerTotal && (
                    <button
                      className="cbc-more"
                      onClick={() => clubUuid && loadLedger(clubUuid, ledger.length, typeFilter)}
                    >
                      Load More
                    </button>
                  )}
                  <div className="cbc-actions">
                    <button disabled={inFlight} onClick={closeIfIdle}>
                      Close
                    </button>
                  </div>
                </>
              )}
            </div>
          </SpadeConsole>
        </div>
      </div>

      {/* Stacked above the cashier. The RPC still refuses a union club, so this
          is a convenience gate, not the rule. While it is up the keyboard is
          the mint's: its own focus trap holds Tab, and this cashier's trap is
          suspended (useFocusTrap above). */}
      <ChipMintModal
        isOpen={showMint}
        onClose={() => setShowMint(false)}
        clubId={clubUuid || clubId}
        onMinted={refresh}
      />
    </>,
    document.body
  );
}
