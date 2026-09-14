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
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useIsMounted } from '../../hooks/useIsMounted';
import { masterBus } from '../../core/MasterBus';
import { useToast } from '../common/Toast';
import { useRecentRecipients } from '../../hooks/useRecentRecipients';
import { fuzzyMatch } from '../../utils/fuzzyMatch';

import { reportError } from '../../utils/errorReporter';
import { resolveClubUUID, isUUID } from '../../utils/clubIdResolver';
import { roleLabel, normaliseRole, roleRank } from '../../types/clubRoles';
import { canMintInClubBank, canHoldAgentWallet } from './walletRows';
import {
  cashierTabs,
  cashierDestinations,
  canUseCashier,
  destinationBlurb,
  claimNeedsConfirm,
  coercesToAgentWallet,
  cashierRefusesSelfSend,
  secondsLeftFromServer,
  DEFAULT_CASHIER_WALLET,
  promoSourceFor,
  promoSendRpc,
  promoLedgerScope,
  promoBalanceLabel,
  promoSourceBlurb,
  type CashierTab,
  type CashierDestination,
  type CashierWalletType,
  type PromoSource,
} from './cashierModes';
import { cashierRecipientBlock } from '../../lib/cashierRoster';
import { SpadeConsole } from '../console/SpadeConsole';
import ChipMintModal from './ChipMintModal';
import './WalletCashierModal.css';
import { downloadBlob } from '../../utils/downloadCsv';

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
}

const fmt = (n?: number | null) =>
  n === undefined || n === null
    ? '...'
    : (Number.isFinite(n) ? n : 0).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

const fmtWhole = (n: number) => Math.round(n).toLocaleString('en-US');

/** "Club Bank Send" from "club_bank_send". Popup and label casing law. */
function titleCase(raw: string): string {
  return raw
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
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

/** RFC 4180 enough for a spreadsheet: quote everything, double the quotes. */
function csvCell(v: unknown): string {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

export default function WalletCashierModal({
  isOpen,
  onClose,
  clubId,
  role,
  walletType = DEFAULT_CASHIER_WALLET,
}: WalletCashierModalProps) {
  const { user } = useAuthUser();
  const toast = useToast();
  const isMounted = useIsMounted();

  const [clubLoading, setClubLoading] = useState(true);
  const [clubUuid, setClubUuid] = useState<string | null>(null);
  const [clubName, setClubName] = useState('');
  const [inUnion, setInUnion] = useState<boolean | null>(null);
  const [bank, setBank] = useState<number | null>(null);

  const [tab, setTab] = useState<Tab>('send');
  const [destination, setDestination] = useState<DestinationWallet>('agent_wallet');
  const [members, setMembers] = useState<Member[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [recipient, setRecipient] = useState<Member | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
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
  const [reversingId, setReversingId] = useState<string | null>(null);

  const [showMint, setShowMint] = useState(false);

  /**
   * The idempotency key for the CURRENT attempt. Regenerated when the form is
   * cleared or the inputs change, held across a retry of the same attempt.
   * A ref, not state: a re-render must not mint a new key mid-flight.
   */
  const opIdRef = useRef<string>(newOpId());
  const claimOpIdsRef = useRef<Map<string, string>>(new Map());
  const reverseOpIdsRef = useRef<Map<string, string>>(new Map());
  /** Beats the double tap that lands before `sending` has re-rendered. */
  const busyRef = useRef(false);

  const viewerRole = normaliseRole(role);
  // Who may stand at THIS cashier. The Club Bank keeps its four roles; the
  // promo and agent wallet cashiers admit the people who HOLD those wallets.
  // cashierModes.ts is the pinned law; the server re-checks either way.
  const allowed = canUseCashier(walletType, viewerRole);
  const mayMint =
    walletType === 'club_bank' && canMintInClubBank(viewerRole, { standalone: inUnion === false });

  const tabs = cashierTabs(walletType);
  /* AGENT TO AGENT ALWAYS CREDITS THE AGENT WALLET (Dan 2026-08-25).
     A recipient who holds a float is funded IN that float, so the choice
     disappears rather than being offered and then overridden. The database
     coerces it too - fn_agent_wallet_send derives the destination from the
     recipient's role and ignores what the client asked for - because a
     dropdown is a suggestion and anything holding a session can call the RPC
     directly. This is the half that stops the mistake being OFFERED.

     SCOPED TO THE AGENT WALLET'S SEND TAB, and only there (2026-08-25 fix).
     The narrowing used to apply to EVERY cashier and BOTH tabs, which broke
     three things the law never touched:
       - the Club Bank could no longer fund an agent's PROMO wallet, because
         picking an agent collapsed the segmented control to Agent Wallet -
         and fn_club_bank_send happily accepts promo_wallet;
       - the Club Bank could no longer send a plain player-wallet credit to
         someone who happens to be an agent;
       - the Club Bank's Claim Back could only ever pull from an agent's float,
         never from their promo wallet or their player balance, even though
         fn_club_bank_claim_back takes all three.
     "Agent to agent" is fn_agent_wallet_send. It is not the club bank. */
  const recipientHoldsFloat = recipient ? canHoldAgentWallet(recipient.role) : false;
  const coerceToAgentWallet = coercesToAgentWallet(walletType, tab, recipientHoldsFloat);
  const destinations = useMemo(() => {
    const all = cashierDestinations(walletType);
    if (!coerceToAgentWallet) return all;
    const only = all.filter((d) => d === 'agent_wallet');
    return only.length > 0 ? only : all;
  }, [walletType, coerceToAgentWallet]);
  /** The agent wallet's Claim Back tab is a different shape from the bank's. */
  const agentClaimTab = walletType === 'agent_wallet' && tab === 'claim';

  /* Picking a player, choosing their player wallet, then switching to an agent
     would otherwise leave `destination` on a value the list no longer offers -
     the send would still be coerced server-side, but the summary line above
     the button would be describing a transfer that is not the one about to
     happen. */
  useEffect(() => {
    if (coerceToAgentWallet && destination !== 'agent_wallet') setDestination('agent_wallet');
  }, [coerceToAgentWallet, destination]);

  // ── Club + bank balance ───────────────────────────────────────────────────
  const loadClub = useCallback(async () => {
    if (!clubId) {
      /* Returning before setClubLoading(false) left `clubLoading` true
         forever, which SUPPRESSES the "That Club Could Not Be Resolved" note
         below and shows "..." where the balance belongs, permanently. */
      setClubUuid(null);
      setBank(null);
      setClubLoading(false);
      return;
    }
    setClubLoading(true);
    setBank(null);
    // resolveClubUUID NEVER returns null - on a failed lookup it hands back
    // whatever it was given, so `|| clubId` catches nothing. A 6-digit club
    // CODE reaching a uuid RPC argument is a raw postgres error at the worst
    // moment, so the failure is caught here instead.
    const uuid = await resolveClubUUID(clubId);
    if (!isMounted.current) return;
    if (!isUUID(uuid)) {
      setClubUuid(null);
      setBank(null);
      setClubLoading(false);
      return;
    }
    setClubUuid(uuid);
    const { data: club, error: clubReadError } = await supabase
      .from('clubs')
      .select('id, name, union_id, chip_treasury, promo_balance')
      .eq('id', uuid)
      .maybeSingle();
    if (!isMounted.current) return;
    /* A READ THAT FAILED IS NOT A TREASURY OF ZERO. Every balance below used
       to be `Number(undefined) || 0`, so an RLS refusal or a dropped
       connection printed a confident 0.00 as the Club Bank - and `cap` became
       0, so every send was refused with "The Wallet Only Holds 0 Chips". Left
       null, the header renders "..." and the note says it could not be read. */
    if (clubReadError) {
      reportError(clubReadError, 'WalletCashierModal.loadClub');
      setBank(null);
      setClubLoading(false);
      return;
    }
    setClubUuid(uuid);
    setClubName((club?.name as string) || 'Club');
    setInUnion(club ? Boolean(club.union_id) : null);

    if (walletType === 'promo_wallet') {
      /* BOTH promo accounts are read, every time. The pot came off the club
         row above; the float is the viewer's own agents row. `bank` - the
         figure this cashier spends against - is derived from whichever source
         is selected, below, so a source switch never waits on a refetch. A
         bank role with no agents row has no float: null, never 0.00. */
      setPromoPot(
        club?.promo_balance !== undefined && club?.promo_balance !== null
          ? Number(club?.promo_balance)
          : null
      );
      const { data: agent, error: agentReadError } = await supabase
        .from('agents')
        .select('promo_wallet_balance')
        .eq('club_id', uuid)
        .eq('user_id', user?.id)
        .maybeSingle();
      if (agentReadError) {
        reportError(agentReadError, 'WalletCashierModal.loadClub_promo_wallet');
        setPromoFloat(null);
      } else {
        setPromoFloat(
          agent?.promo_wallet_balance !== undefined && agent?.promo_wallet_balance !== null
            ? Number(agent?.promo_wallet_balance)
            : null
        );
      }
    } else if (walletType === 'agent_wallet') {
      const { data: agent, error: agentReadError } = await supabase
        .from('agents')
        .select('agent_wallet_balance')
        .eq('club_id', uuid)
        .eq('user_id', user?.id)
        .maybeSingle();
      if (agentReadError) {
        reportError(agentReadError, 'WalletCashierModal.loadClub_agent_wallet');
        setBank(null);
      } else {
        setBank(
          agent?.agent_wallet_balance !== undefined && agent?.agent_wallet_balance !== null
            ? Number(agent?.agent_wallet_balance)
            : null
        );
      }
    } else {
      setBank(
        club?.chip_treasury !== undefined && club?.chip_treasury !== null
          ? Number(club?.chip_treasury)
          : null
      );
    }
    setClubLoading(false);
  }, [clubId, walletType, user?.id, isMounted]);

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
      setMembersLoading(true);
      const { data, error } = await supabase.rpc('fn_club_cashier_members', {
        p_club_id: uuid,
      });
      if (!isMounted.current) return;
      if (error) {
        /* A read that failed is not an empty club. Leaving the roster empty and
           saying so is honest; pretending the club has nobody in it would let a
           search box sit there returning nothing forever. */
        reportError(error, 'WalletCashierModal.loadMembers');
        setMembers([]);
        setMembersLoading(false);
        return;
      }
      const rows = (data || []) as Array<Record<string, unknown>>;
      setMembers(
        rows.map((m) => ({
          user_id: String(m.user_id),
          role: String(m.role || 'player'),
          name: (m.name as string) || `Member ${String(m.user_id).slice(0, 8)}`,
          chip_balance:
            m.chip_balance !== undefined && m.chip_balance !== null
              ? Number(m.chip_balance)
              : undefined,
          avatar_url: (m.avatar_url as string) || '',
          username: (m.username as string) || '',
          short_id: String(m.player_number || '----'),
        }))
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
      setReversibleLoading(true);
      const { data, error } = await supabase.rpc('fn_agent_wallet_reversible', {
        p_club_id: uuid,
      });
      if (!isMounted.current) return;
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
      const current = () => isMounted.current && seq === ledgerSeqRef.current;
      setLedgerLoading(true);
      setLedgerError(null);
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
        setLedger((prev) => (offset === 0 ? res.rows || [] : [...prev, ...(res.rows || [])]));
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
      const current = () => isMounted.current && seq === promoLedgerSeqRef.current;
      setLedgerLoading(true);
      setLedgerError(null);
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
        setPromoLedger((prev) => (offset === 0 ? res.rows || [] : [...prev, ...(res.rows || [])]));
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
    setPromoSource(promoSourceFor(role));
    setPromoPot(null);
    setPromoFloat(null);
    setPromoLedger([]);
    if (walletType === 'club_bank') setDestination('agent_wallet');
    else setDestination('player_wallet');

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
    opIdRef.current = newOpId();
    busyRef.current = false;
    loadClub();
  }, [isOpen, user?.id, loadClub, walletType, role]);

  // Escape closes, and the page behind stops scrolling. Both are what a person
  // expects of a modal and neither was here.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busyRef.current) onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen, onClose]);

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
    if (tab !== 'claim' || !recipient || !clubUuid) {
      setHolderHeld(null);
      return;
    }
    if (destination === 'player_wallet') {
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
        destination === 'promo_wallet'
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
  }, [tab, destination, recipient, clubUuid, isMounted]);

  // ── Realtime: the bank balance is live while the cashier is open ──────────
  // Two people funding agents at once is the normal case in a busy club, and a
  // balance that is only correct at open time is how one of them authorises a
  // send against money the other already moved.
  useEffect(() => {
    if (!isOpen || !clubUuid || !allowed) return;
    const channel = supabase
      .channel(`club-bank-cashier-${clubUuid}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'clubs', filter: `id=eq.${clubUuid}` },
        (p) => {
          if (!isMounted.current) return;
          if (walletType === 'club_bank' && p.new?.chip_treasury !== undefined)
            setBank(p.new.chip_treasury !== null ? Number(p.new.chip_treasury) : null);
          // The club promo pot is live too: a union promo send lands while
          // the cashier is open and the header moves without a reopen.
          if (walletType === 'promo_wallet' && p.new?.promo_balance !== undefined)
            setPromoPot(p.new.promo_balance !== null ? Number(p.new.promo_balance) : null);
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'agents', filter: `user_id=eq.${user?.id}` },
        (p) => {
          if (!isMounted.current || p.new?.club_id !== clubUuid) return;
          if (walletType === 'promo_wallet' && p.new?.promo_wallet_balance !== undefined)
            setPromoFloat(
              p.new.promo_wallet_balance !== null ? Number(p.new.promo_wallet_balance) : null
            );
          if (walletType === 'agent_wallet' && p.new?.agent_wallet_balance !== undefined)
            setBank(
              p.new.agent_wallet_balance !== null ? Number(p.new.agent_wallet_balance) : null
            );
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [isOpen, clubUuid, allowed, isMounted, walletType, user?.id]);

  // A send that lands, a claim, a reversal, or a mint changes the bank and the
  // recipient. Refetch rather than patching state by hand — a hand-patched
  // balance that drifts from the database is the exact class of bug this
  // cashier exists to end.
  const refresh = useCallback(() => {
    loadClub();
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
   * fn_agent_wallet_send and fn_promo_wallet_send both refuse
   * `p_to_user_id = auth.uid()` outright ("You Cannot Send Chips To Yourself"),
   * and fn_club_cashier_members returns the caller in its own list for a staff
   * viewer (scope 'all'). So the roster rendered the viewer with a "(You)" tag,
   * let them pick it, and the send failed on tap with no way to understand why.
   *
   * The CLUB BANK is deliberately exempt: fn_club_bank_send has no self guard
   * because an owner funding their OWN agent float out of the treasury is the
   * normal way an owner gets a float at all. Removing themselves from that list
   * would break the funding route the whole hierarchy hangs off.
   */
  const excludeSelf = cashierRefusesSelfSend(walletType, promoSource);

  /**
   * ONE RULE FOR EVERY CASHIER SURFACE (Dan 2026-09-04 round 2, see
   * lib/cashierRoster). This list used to DELETE the viewer, and delete every
   * member whose role cannot hold an agent wallet, whenever the send would be
   * refused - the same "gone, not explained" shape that made the club owner
   * unsearchable in his own cashier. Everyone stays; the ones who cannot
   * receive this destination carry the reason and cannot be picked.
   */
  const blockFor = useCallback(
    (m: Member) =>
      cashierRecipientBlock({
        isSelf: m.user_id === user?.id,
        refusesSelfSend: excludeSelf,
        destinationNeedsAgentWallet: AGENT_ONLY.includes(destination),
        memberHoldsAgentWallet: canHoldAgentWallet(m.role),
      }),
    [user?.id, excludeSelf, destination]
  );

  const eligible = useMemo(() => {
    const q = search.trim().toLowerCase();

    const destinationMembers = members;

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
  }, [members, destination, search, user?.id, recentIds, excludeSelf, blockFor]);

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
  // A send is capped by the wallet being SPENT (the bank, or the caller's own
  // float). A claim is capped by the wallet being CLAIMED FROM. The two caps
  // are different accounts, and mixing them up is how a claim gets refused for
  // "insufficient bank" while the bank is the thing being paid.
  const cap = tab === 'claim' ? holderHeld : bank;
  const overCap = cap !== null && amt > cap;
  /* WHOLE CHIPS ONLY. `amt > 0` accepted 0.4, which the RPC took verbatim
     while the success toast (which formats with fmtWhole) reported "Sent 0
     Chips" - and 10.6 reported 11. The `min={1}` on the input never applied
     because submission goes through onClick, not form validation. */
  const amountIsWhole = Number.isFinite(amt) && Number.isInteger(amt) && amt >= 1;
  const canSend = Boolean(recipient) && amountIsWhole && cap !== null && !overCap && !sending;
  const needsConfirm =
    tab === 'claim'
      ? claimNeedsConfirm(amt)
      : bank !== null && bank > 0 && amt >= bank * CONFIRM_SHARE_OF_BANK;

  // Any change to what is being sent is a NEW operation, so it gets a new key.
  // Without this, correcting a typo after a failed attempt would replay the
  // first attempt's amount if that attempt had in fact committed.
  useEffect(() => {
    opIdRef.current = newOpId();
    setConfirming(false);
  }, [recipient?.user_id, amount, destination, tab]);

  const doSend = async () => {
    if (!canSend || !clubUuid || !recipient || busyRef.current) return;
    busyRef.current = true;
    setSending(true);
    try {
      let res: {
        success?: boolean;
        error?: string;
        replayed?: boolean;
      } | null = null;
      if (tab === 'claim') {
        // CLAIM BACK. Chips come OUT of the chosen wallet INTO the Club Bank.
        const { data, error } = await supabase.rpc('fn_club_bank_claim_back', {
          p_club_id: clubUuid,
          p_from_user_id: recipient.user_id,
          p_amount: amt,
          p_source: destination,
          p_reason: reason.trim() || null,
          p_op_id: opIdRef.current,
        });
        if (error) throw error;
        res = Array.isArray(data) ? data[0] : data;
      } else if (walletType === 'promo_wallet') {
        // Dan 2026-08-24: the promo wallet sends to a player wallet (as cash)
        // or to another agent's promo wallet. One RPC, one ledger row, keyed.
        // 2026-09-05: WHICH promo wallet is the source switch's decision -
        // fn_club_promo_wallet_send spends the club pot, fn_promo_wallet_send
        // the caller's own float. Same arguments, same receipt shape.
        const { data, error } = await supabase.rpc(promoSendRpc(promoSource), {
          p_club_id: clubUuid,
          p_to_user_id: recipient.user_id,
          p_amount: amt,
          p_destination: destination,
          p_reason: reason.trim() || null,
          p_op_id: opIdRef.current,
        });
        if (error) throw error;
        res = Array.isArray(data) ? data[0] : data;
      } else if (walletType === 'agent_wallet') {
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
        throw new Error(res?.error || 'The Cashier Refused That Movement');
      }

      const destLabel = DESTINATION_LABELS[destination] || 'Wallet';
      toast?.success?.(
        tab === 'claim'
          ? res.replayed
            ? `That Claim Had Already Gone Through. ${fmtWhole(amt)} Chips Are Back In The Club Bank`
            : `Claimed ${fmtWhole(amt)} Chips Back From ${recipient.name} Into The Club Bank`
          : res.replayed
            ? `That Send Had Already Gone Through. ${fmtWhole(amt)} Chips Are With ${recipient.name}`
            : `Sent ${fmtWhole(amt)} Chips To ${recipient.name} ${destLabel}`
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
      setConfirming(false);
      opIdRef.current = newOpId();
      refresh();
    } catch (e) {
      reportError(e, 'WalletCashierModal.send');
      toast?.error?.((e as Error).message || 'Send Failed');
      // The key is NOT rotated here. If this failed because the response was
      // lost rather than because the send was refused, the retry must be able
      // to find the original instead of sending a second time.
    } finally {
      busyRef.current = false;
      if (isMounted.current) setSending(false);
    }
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
    busyRef.current = true;
    setClaimingId(row.transaction_id);
    try {
      const opId = claimOpIdsRef.current.get(row.transaction_id) || newOpId();
      claimOpIdsRef.current.set(row.transaction_id, opId);
      const { data, error } = await supabase.rpc('fn_agent_wallet_claim_back', {
        p_club_id: clubUuid,
        p_transaction_id: row.transaction_id,
        p_amount: row.remaining,
        p_reason: 'Claimed Back From The Agent Wallet Cashier',
        p_op_id: opId,
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
          ? `That Claim Had Already Gone Through. ${fmtWhole(row.remaining)} Chips Are Back In Your Agent Wallet`
          : `Claimed ${fmtWhole(row.remaining)} Chips Back From ${row.to_name}`
      );
      masterBus.emit('BALANCE_UPDATED', { source: 'agent_wallet_claim', userId: user?.id || '' });
      masterBus.emit('BALANCE_UPDATED', {
        source: 'agent_wallet_claim',
        userId: row.to_user_id,
      });
      claimOpIdsRef.current.delete(row.transaction_id);
      refresh();
    } catch (e) {
      reportError(e, 'WalletCashierModal.claimBack');
      toast?.error?.((e as Error).message || 'Claim Back Failed');
    } finally {
      busyRef.current = false;
      if (isMounted.current) setClaimingId(null);
    }
  };

  const reverse = async (row: LedgerRow) => {
    if (!clubUuid || reversingId || busyRef.current) return;
    busyRef.current = true;
    setReversingId(row.id);
    try {
      const opId = reverseOpIdsRef.current.get(row.id) || newOpId();
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
      if (!res?.success) throw new Error(res?.error || 'That Send Could Not Be Reversed');
      toast?.success?.(`Reversed ${fmtWhole(row.amount)} Chips Back Into The Club Bank`);
      masterBus.emit('BALANCE_UPDATED', { source: 'club_bank_reverse', userId: user?.id || '' });
      reverseOpIdsRef.current.delete(row.id);
      refresh();
    } catch (e) {
      reportError(e, 'WalletCashierModal.reverse');
      toast?.error?.((e as Error).message || 'Reversal Failed');
    } finally {
      busyRef.current = false;
      if (isMounted.current) setReversingId(null);
    }
  };

  /** One download path for both ledgers. The shared helper carries the
      Safari/Firefox revoke timing AND the app's share-sheet branch; this
      used to be a local copy with the same name, which is why a grep for
      the helper looked clean while the app silently downloaded nothing. */
  const downloadLedgerCsv = (name: string, header: string[], body: string[]) => {
    downloadBlob(
      `${name}-${clubName.replace(/\W+/g, '-').toLowerCase()}-${new Date()
        .toISOString()
        .slice(0, 10)}.csv`,
      new Blob([[header.map(csvCell).join(','), ...body].join('\r\n')], {
        type: 'text/csv;charset=utf-8',
      })
    );
  };

  /** The promo ledger rows on screen, as a spreadsheet. */
  const exportPromoCsv = () => {
    const rows = promoLedger.slice(0, EXPORT_MAX);
    if (rows.length === 0) return;
    downloadLedgerCsv(
      promoSource === 'club_pot' ? 'club-promo-wallet-ledger' : 'promo-float-ledger',
      ['When', 'Direction', 'Category', 'Amount', 'Counterparty', 'By', 'Wallet After', 'Note'],
      rows.map((r) =>
        [
          new Date(r.created_at).toISOString(),
          r.direction,
          r.category,
          r.amount,
          r.counterparty_name ?? r.counterparty_type ?? '',
          r.actor_name ?? '',
          r.balance_after ?? '',
          r.notes ?? '',
        ]
          .map(csvCell)
          .join(',')
      )
    );
    toast?.success?.(`Exported ${rows.length.toLocaleString('en-US')} Ledger Entries`);
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
        new Date(r.created_at).toISOString(),
        r.transaction_type,
        r.amount,
        r.from_name ?? '',
        r.to_name ?? '',
        ((r.metadata?.destination || r.metadata?.source) as string) ?? '',
        r.balance_after ?? '',
        r.is_reversed ? 'yes' : 'no',
        r.notes ?? '',
      ]
        .map(csvCell)
        .join(',')
    );
    /* REVOKE AFTER THE DOWNLOAD HAS STARTED, not in the same tick. Safari and
       Firefox read the blob asynchronously once the click is dispatched, so a
       synchronous revoke cancelled the save and the Export button did nothing
       at all on those browsers. One second is long enough for the fetch to be
       issued and short enough that the blob is not held. (downloadCsv above.) */
    downloadLedgerCsv('club-bank-ledger', header, body);
    toast?.success?.(`Exported ${rows.length.toLocaleString('en-US')} Ledger Entries`);
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
  const closeIfIdle = () => {
    if (!inFlight) onClose();
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

  // Belt and braces: this modal is only mounted behind a role check, and the
  // row that opens it only renders for roles that hold the wallet. If it is
  // somehow reached anyway, say so plainly rather than rendering an empty
  // cashier.
  if (!allowed) {
    return (
      <div
        className="cbc-overlay wcm-overlay"
        role="dialog"
        aria-label="Club Bank Cashier"
        onClick={onClose}
      >
        <div
          className="cbc-panel cbc-panel--denied wcm ac-popup"
          onClick={(e) => e.stopPropagation()}
        >
          <SpadeConsole
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
      </div>
    );
  }

  return (
    <>
      <div
        className="cbc-overlay wcm-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={`${cashierTitle} Cashier`}
        onClick={closeIfIdle}
      >
        <div className="cbc-panel wcm ac-popup" onClick={(e) => e.stopPropagation()}>
          <SpadeConsole
            as="div"
            /* The club in the header well's eyebrow, the account engraved
               beneath it, and the viewer's own standing in the well's painted
               pill slot. The corner X is gone: the foot and the flat cap carry
               Close now, at 44px in the thumb zone, exactly as every other
               surface on this master does. `closeIfIdle` is unchanged and is
               still what the overlay, the Escape key and every Close calls. */
            eyebrow={clubName || 'Club Arena'}
            title={cashierTitle}
            pill={roleLabel(viewerRole)}
            pillInk="blue"
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
            <div className="cbc-bank">
              <span>
                {walletType === 'promo_wallet'
                  ? promoBalanceLabel(promoSource)
                  : walletType === 'agent_wallet'
                    ? 'Agent Wallet Balance'
                    : 'Club Bank Balance'}
              </span>
              <strong aria-live="polite">{bank === null ? '...' : fmt(bank)}</strong>
              {walletType === 'promo_wallet' && clubName && (
                <em className="cbc-bank-sub">
                  {promoSource === 'club_pot' ? clubName : `${clubName} Agent Float`}
                </em>
              )}
            </div>

            {/* TWO PROMO ACCOUNTS, ONE SWITCH (2026-09-05). Offered only when the
                viewer can stand at both: a Club Bank role who also holds a
                personal float. An agent sees their float alone; a bank role with
                no float sees the pot alone. Both balances are printed on the
                switch so the one you are NOT looking at is never a mystery. */}
            {walletType === 'promo_wallet' &&
              promoSourceFor(viewerRole) === 'club_pot' &&
              promoFloat !== null && (
                <div className="cbc-source" role="radiogroup" aria-label="Promo Wallet Source">
                  <button
                    role="radio"
                    aria-checked={promoSource === 'club_pot'}
                    className={promoSource === 'club_pot' ? 'cbc-source-on' : ''}
                    onClick={() => {
                      setPromoSource('club_pot');
                      setRecipient(null);
                    }}
                  >
                    <span>Club Promo Wallet</span>
                    <strong>{promoPot === null ? '...' : fmt(promoPot)}</strong>
                  </button>
                  <button
                    role="radio"
                    aria-checked={promoSource === 'own_float'}
                    className={promoSource === 'own_float' ? 'cbc-source-on' : ''}
                    onClick={() => {
                      setPromoSource('own_float');
                      setRecipient(null);
                    }}
                  >
                    <span>My Promo Float</span>
                    <strong>{fmt(promoFloat)}</strong>
                  </button>
                </div>
              )}
            {walletType === 'promo_wallet' && (
              <div className="cbc-note">{promoSourceBlurb(promoSource)}</div>
            )}

            {clubUuid === null && !clubLoading && (
              <div className="cbc-note cbc-note--bad">
                That Club Could Not Be Resolved, So Nothing Can Be Sent From Here.
              </div>
            )}

            {/* Chip Mint lives HERE and only for a standalone club. A club inside
                a union has no mint at all - chips flow down from the union. */}
            {mayMint && (
              <button className="cbc-mint" onClick={() => setShowMint(true)}>
                Mint Chips Into The Club Bank
              </button>
            )}

            {/* ── Tabs ─────────────────────────────────────────────────────── */}
            <div className="cbc-tabs" role="tablist">
              {tabs.map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  className={tab === t ? 'cbc-tab cbc-tab--on' : 'cbc-tab'}
                  onClick={() => setTab(t)}
                >
                  {TAB_LABELS[t]}
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
                  <div className="cbc-blurb">
                    {destinationBlurb(walletType, destination, 'claim')}
                  </div>
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
                          <span className="cbc-tx-type">{row.to_name}</span>
                          <span className="cbc-tx-amount">{fmt(row.remaining)}</span>
                        </div>
                        <div className="cbc-tx-mid">
                          <span>Into {titleCase(row.destination)}</span>
                          <span className="cbc-tx-when">
                            {Math.floor(left / 60)}m {left % 60}s Left
                          </span>
                        </div>
                        {/* `claimed_back` was fetched and never shown, so a send
                            already partly reversed elsewhere displayed only its
                            remainder with no hint that the original was larger -
                            which reads as the wrong amount having been sent. */}
                        {Number(row.claimed_back) > 0 && (
                          <div className="cbc-tx-foot">
                            <span>
                              Sent {fmt(row.amount)}, {fmt(row.claimed_back)} Already Claimed Back
                            </span>
                          </div>
                        )}
                        <button
                          className="cbc-undo"
                          disabled={claimingId !== null}
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
                  <div className="cbc-field">
                    <label className="cbc-label">
                      {tab === 'claim' ? 'Claim From' : 'Send Into'}
                    </label>
                    <div className="cbc-seg">
                      {destinations.map((key) => (
                        <button
                          key={key}
                          className={destination === key ? 'cbc-seg-on' : ''}
                          onClick={() => setDestination(key)}
                        >
                          {DESTINATION_LABELS[key]}
                        </button>
                      ))}
                    </div>
                    <div className="cbc-blurb">
                      {destinationBlurb(walletType, destination, tab)}
                    </div>
                  </div>

                  {/* Recipient (send) or holder (claim) */}
                  <div className="cbc-field">
                    <label className="cbc-label" htmlFor="cbc-search">
                      {tab === 'claim' ? 'Claim From Member' : 'Recipient'}
                    </label>
                    <input
                      id="cbc-search"
                      className="cbc-input"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder={
                        AGENT_ONLY.includes(destination) ? 'Search Agents' : 'Search Members'
                      }
                      aria-label="Search Recipients"
                    />
                    <div className="cbc-list">
                      {membersLoading && <div className="cbc-empty">Loading Members...</div>}
                      {!membersLoading && eligible.length === 0 && (
                        <div className="cbc-empty">
                          {members.length === 0
                            ? 'No Members In This Club Yet.'
                            : 'No Members Match That Search.'}
                        </div>
                      )}
                      {eligible.map((m) => {
                        const block = blockFor(m);
                        return (
                          <button
                            key={m.user_id}
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
                            <div
                              className="cbc-member-avatar"
                              style={{ backgroundImage: `url(${m.avatar_url || ''})` }}
                            />
                            <div className="cbc-member-info">
                              <span className="cbc-member-name">
                                {m.name}
                                {m.user_id === user?.id && ' (You)'}
                              </span>
                              <span className="cbc-member-id">#{m.short_id}</span>
                            </div>
                            <span className="cbc-member-role">{roleLabel(m.role)}</span>
                            {block ? (
                              <span className="cbc-member-block">{block.label}</span>
                            ) : (
                              <span className="cbc-member-bal">{fmt(m.chip_balance)}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Amount */}
                  <div className="cbc-field">
                    <label className="cbc-label" htmlFor="cbc-amount">
                      Amount
                    </label>
                    <input
                      id="cbc-amount"
                      className="cbc-input"
                      type="number"
                      /* Whole chips only (see amountIsWhole), so the keypad that
                         comes up is the numeric one rather than the decimal one
                         offering a point the field will then reject. */
                      inputMode="numeric"
                      min={1}
                      step={1}
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="Whole Chips"
                      /* aria-label was the EMPTY STRING, which is worse than
                         absent: it overrides the visible <label> and announces an
                         unnamed spin button to a screen reader on the one field
                         that decides how much money moves. */
                      aria-label={tab === 'claim' ? 'Chips To Claim Back' : 'Chips To Send'}
                    />

                    {tab === 'claim' && recipient && (
                      <div className="cbc-blurb">
                        {holderHeld === null
                          ? 'Reading That Wallet...'
                          : `${recipient.name} Holds ${fmt(holderHeld)} In That Wallet.`}
                      </div>
                    )}
                    {/* A BALANCE WE COULD NOT READ CANNOT PROJECT AN AFTER
                        FIGURE. `bank ?? 0` turned an unread treasury into a
                        confident "The Wallet Would Hold -500.00 Afterwards" -
                        directly beneath a header already showing "..." for the
                        same number. The send is refused anyway (canSend requires
                        cap !== null); the sentence just has to stop lying. */}
                    {amt > 0 && !overCap && bank !== null && (
                      <div className="cbc-blurb">
                        {tab === 'claim'
                          ? `Claiming ${fmt(amt)}. The Club Bank Would Hold ${fmt(bank + amt)} Afterwards.`
                          : `Sending ${fmt(amt)}. The Wallet Would Hold ${fmt(bank - amt)} Afterwards.`}
                      </div>
                    )}
                    {overCap && (
                      <div className="cbc-warn">
                        {tab === 'claim'
                          ? `That Wallet Only Holds ${fmt(cap ?? 0)} Chips.`
                          : `The Wallet Only Holds ${fmt(cap ?? 0)} Chips.`}
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
                      {tab === 'claim'
                        ? `Claim ${fmt(amt)} Chips From ${recipient.name} Back Into The Club Bank?`
                        : `That Is ${Math.round((amt / (bank || 1)) * 100)} Percent Of The Club Bank. Send ${fmt(amt)} Chips To ${recipient.name}?`}
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
                        <strong className="cbc-in">{fmt(promoLedgerTotals.in)}</strong>
                      </div>
                      <div>
                        <span>Handed Out</span>
                        <strong className="cbc-out">{fmt(promoLedgerTotals.out)}</strong>
                      </div>
                      <div>
                        <span>Net</span>
                        <strong>{fmt(promoLedgerTotals.net)}</strong>
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
                        disabled={promoLedger.length === 0}
                      >
                        Export CSV
                      </button>
                    </div>
                  )}

                  {!ledgerError &&
                    promoLedger.map((row) => {
                      const inbound = row.direction === 'in';
                      const other =
                        row.counterparty_name ||
                        (row.counterparty_type ? titleCase(row.counterparty_type) : 'Ledger');
                      const note =
                        row.notes && !row.notes.startsWith('auto-ledgered') ? row.notes : null;
                      return (
                        <div key={row.id} className={inbound ? 'cbc-tx cbc-tx--in' : 'cbc-tx'}>
                          <div className="cbc-tx-top">
                            <span className="cbc-tx-type">{titleCase(row.category)}</span>
                            <span
                              className={inbound ? 'cbc-tx-amount cbc-in' : 'cbc-tx-amount cbc-out'}
                            >
                              {inbound ? '+' : '-'}
                              {fmt(row.amount)}
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
                            {note && <span>{note}</span>}
                            {row.actor_name && <span>By {row.actor_name}</span>}
                            {row.balance_after !== null && row.balance_after !== undefined && (
                              <span>Wallet After {fmt(Number(row.balance_after))}</span>
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

                  {!ledgerError && ledgerTotals && (
                    <div className="cbc-totals">
                      <div>
                        <span>Into The Bank</span>
                        <strong className="cbc-in">{fmt(ledgerTotals.into_bank)}</strong>
                      </div>
                      <div>
                        <span>Out Of The Bank</span>
                        <strong className="cbc-out">{fmt(ledgerTotals.out_of_bank)}</strong>
                      </div>
                      <div>
                        <span>Net</span>
                        <strong>{fmt(ledgerTotals.net)}</strong>
                      </div>
                    </div>
                  )}

                  {!ledgerError && (
                    <div className="cbc-ledger-head">
                      <span>
                        {ledgerTotal.toLocaleString('en-US')}{' '}
                        {typeFilter ? `${titleCase(typeFilter)} Entries` : 'Entries'}
                      </span>
                      <button
                        className="cbc-export"
                        onClick={exportCsv}
                        disabled={ledger.length === 0}
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
                          {titleCase(t)}
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
                            <span className="cbc-tx-type">{titleCase(row.transaction_type)}</span>
                            <span className="cbc-tx-amount">{fmt(row.amount)}</span>
                          </div>
                          <div className="cbc-tx-mid">
                            <span>
                              {row.from_name || 'Club Bank'}
                              {' → '}
                              {row.transaction_type === 'club_bank_claim'
                                ? 'Club Bank'
                                : row.to_name || (dest ? titleCase(dest) : 'Club Bank')}
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
                            {row.notes && <span>{row.notes}</span>}
                            {dest && <span>Into {titleCase(dest)}</span>}
                            {src && row.transaction_type === 'club_bank_claim' && (
                              <span>From {titleCase(src)}</span>
                            )}
                            {row.balance_after !== null && (
                              <span>Bank After {fmt(Number(row.balance_after))}</span>
                            )}
                            {row.is_reversed && <span className="cbc-tx-rev">Reversed</span>}
                          </div>
                          {row.reversible && (
                            <button
                              className="cbc-undo"
                              disabled={reversingId !== null}
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
          is a convenience gate, not the rule. */}
      <ChipMintModal
        isOpen={showMint}
        onClose={() => setShowMint(false)}
        clubId={clubUuid || clubId}
        onMinted={refresh}
      />
    </>
  );
}
