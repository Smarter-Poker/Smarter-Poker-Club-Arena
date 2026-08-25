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
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChipFlowService } from '../../services/ChipFlowService';
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
  type CashierTab,
  type CashierDestination,
  type CashierWalletType,
} from './cashierModes';
import ChipMintModal from './ChipMintModal';
import './WalletCashierModal.css';

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
 * A membership row means "in this club", and the column says so in two ways:
 * rows created before 2026-07-22 say 'approved', everything since says
 * 'active', and most of production is still the older word. Asking for one
 * hides most of a real club. Named here for the same reason CashierTradePage
 * names it: so the next screen copies the set rather than one of its halves.
 */
const MEMBER_IN_CLUB = ['active', 'approved'];

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
  chip_balance: number;
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

interface WalletCashierModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Club code or UUID. Resolved internally, same as ChipMintModal. */
  clubId: string;
  /** The viewer's role in this club. Presentation only; the server re-checks. */
  role: string;
  walletType?: CashierWalletType;
}

const fmt = (n: number) =>
  (Number.isFinite(n) ? n : 0).toLocaleString('en-US', {
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
  walletType = 'club_bank',
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
  const destinations = cashierDestinations(walletType);

  // ── Club + bank balance ───────────────────────────────────────────────────
  const loadClub = useCallback(async () => {
    if (!clubId) return;
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
    const { data: club } = await supabase
      .from('clubs')
      .select('id, name, union_id, chip_treasury')
      .eq('id', uuid)
      .maybeSingle();
    if (!isMounted.current) return;
    setClubUuid(uuid);
    setClubName((club?.name as string) || 'Club');
    setInUnion(club ? Boolean(club.union_id) : null);

    if (walletType === 'promo_wallet') {
      const { data: agent } = await supabase
        .from('agents')
        .select('promo_wallet_balance')
        .eq('club_id', uuid)
        .eq('user_id', user?.id)
        .maybeSingle();
      setBank(Number(agent?.promo_wallet_balance) || 0);
    } else if (walletType === 'agent_wallet') {
      const { data: agent } = await supabase
        .from('agents')
        .select('agent_wallet_balance')
        .eq('club_id', uuid)
        .eq('user_id', user?.id)
        .maybeSingle();
      setBank(Number(agent?.agent_wallet_balance) || 0);
    } else {
      setBank(Number(club?.chip_treasury) || 0);
    }
    setClubLoading(false);
  }, [clubId, walletType, user?.id, isMounted]);

  // ── Members who can receive ───────────────────────────────────────────────
  const loadMembers = useCallback(
    async (uuid: string) => {
      setMembersLoading(true);
      // PostgREST caps a page at 1,000 rows. Paging in a deterministic order
      // is the same shape CashierPage uses, and for the same reason: a 588
      // member club silently lost 88 people to an unordered .limit().
      const PAGE = 500;
      const collected: Array<Record<string, unknown>> = [];
      for (let from = 0; from < 10000; from += PAGE) {
        const { data: page, error } = await supabase
          .from('club_members')
          .select(
            'user_id, role, nickname, chip_balance, profiles!inner ( player_number, avatar_url, username, display_name )'
          )
          .eq('club_id', uuid)
          .in('status', MEMBER_IN_CLUB)
          .order('joined_at', { ascending: true })
          .order('user_id', { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) break;
        collected.push(...((page || []) as Array<Record<string, unknown>>));
        if (!page || page.length < PAGE) break;
      }
      if (!isMounted.current) return;
      setMembers(
        collected.map((m) => {
          const profile = m.profiles as Record<string, unknown>;
          return {
            user_id: String(m.user_id),
            role: String(m.role || 'player'),
            name:
              (profile?.display_name as string) ||
              (m.nickname as string) ||
              (profile?.username as string) ||
              `Member ${String(m.user_id).slice(0, 8)}`,
            chip_balance: Number(m.chip_balance) || 0,
            avatar_url: (profile?.avatar_url as string) || '',
            username: (profile?.username as string) || '',
            short_id: String((profile?.player_number as number) || '----'),
          };
        })
      );
      setMembersLoading(false);
    },
    [isMounted]
  );

  // ── The ledger. Every single chip movement, newest first. ─────────────────
  const loadLedger = useCallback(
    async (uuid: string, offset: number, types: string | null) => {
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
        if (!isMounted.current) return;
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
        if (isMounted.current) setLedgerError('Could Not Load The Ledger');
      } finally {
        if (isMounted.current) setLedgerLoading(false);
      }
    },
    [isMounted]
  );

  // ── Open / reset ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen || !user?.id) return;
    setTab('send');
    if (walletType === 'club_bank') setDestination('agent_wallet');
    else setDestination('player_wallet');

    setRecipient(null);
    setAmount('');
    setReason('');
    setSearch('');
    setConfirming(false);
    setLedger([]);
    setTypeFilter(null);
    opIdRef.current = newOpId();
    busyRef.current = false;
    loadClub();
  }, [isOpen, user?.id, loadClub, walletType]);

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
    loadLedger(clubUuid, 0, typeFilter);
    // typeFilter is a dependency on purpose: changing the filter re-reads from
    // offset 0 rather than appending a differently-filtered page onto the old
    // list, which is how a ledger comes to show rows that do not match its own
    // filter chip.
  }, [isOpen, clubUuid, allowed, tab, typeFilter, loadLedger]);

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
      setHolderHeld(recipient.chip_balance);
      return;
    }
    let cancelled = false;
    setHolderHeld(null);
    (async () => {
      const { data } = await supabase
        .from('agents')
        .select('agent_wallet_balance, promo_wallet_balance')
        .eq('club_id', clubUuid)
        .eq('user_id', recipient.user_id)
        .maybeSingle();
      if (cancelled || !isMounted.current) return;
      setHolderHeld(
        destination === 'promo_wallet'
          ? Number(data?.promo_wallet_balance) || 0
          : Number(data?.agent_wallet_balance) || 0
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
          if (!isMounted.current || walletType !== 'club_bank') return;
          if (p.new?.chip_treasury !== undefined) setBank(Number(p.new.chip_treasury) || 0);
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'agents', filter: `user_id=eq.${user?.id}` },
        (p) => {
          if (!isMounted.current || p.new?.club_id !== clubUuid) return;
          if (walletType === 'promo_wallet' && p.new?.promo_wallet_balance !== undefined)
            setBank(Number(p.new.promo_wallet_balance) || 0);
          if (walletType === 'agent_wallet' && p.new?.agent_wallet_balance !== undefined)
            setBank(Number(p.new.agent_wallet_balance) || 0);
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
    if (tab === 'ledger') loadLedger(clubUuid, 0, typeFilter);
    else setLedger([]);
  }, [loadClub, loadMembers, loadLedger, clubUuid, tab, typeFilter]);

  const { recentIds, addRecipient } = useRecentRecipients(user?.id, clubUuid, walletType);

  const eligible = useMemo(() => {
    const needsAgent = AGENT_ONLY.includes(destination);
    const q = search.trim().toLowerCase();

    const destinationMembers = members.filter((m) =>
      needsAgent ? canHoldAgentWallet(m.role) : true
    );

    if (q.length < 2) {
      let recent = destinationMembers
        .filter((m) => recentIds.includes(m.user_id))
        .sort((a, b) => recentIds.indexOf(a.user_id) - recentIds.indexOf(b.user_id));

      if (recent.length < 5) {
        const fallback = destinationMembers
          .filter((m) => !recentIds.includes(m.user_id))
          .sort((a, b) => roleRank(b.role) - roleRank(a.role) || a.name.localeCompare(b.name))
          .slice(0, 5 - recent.length);
        recent = [...recent, ...fallback];
      }
      return recent;
    }

    return destinationMembers
      .filter((m) => fuzzyMatch(q, m.name) || (m.username && fuzzyMatch(q, m.username)))
      .sort((a, b) => roleRank(b.role) - roleRank(a.role) || a.name.localeCompare(b.name))
      .slice(0, 60);
  }, [members, destination, search, user?.id, recentIds]);

  // Changing destination can strand a recipient who cannot hold the new wallet.
  useEffect(() => {
    if (!recipient) return;
    if (AGENT_ONLY.includes(destination) && !canHoldAgentWallet(recipient.role)) {
      setRecipient(null);
    }
  }, [destination, recipient]);

  const amt = Number(amount) || 0;
  // A send is capped by the wallet being SPENT (the bank, or the caller's own
  // float). A claim is capped by the wallet being CLAIMED FROM. The two caps
  // are different accounts, and mixing them up is how a claim gets refused for
  // "insufficient bank" while the bank is the thing being paid.
  const cap = tab === 'claim' ? holderHeld : bank;
  const overCap = cap !== null && amt > cap;
  const canSend = Boolean(recipient) && amt > 0 && cap !== null && !overCap && !sending;
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
        const { data, error } = await supabase.rpc('fn_promo_wallet_send', {
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
        await ChipFlowService.agentToPlayer(
          user?.id || '',
          recipient.user_id,
          amt,
          'Agent',
          recipient.name,
          clubName
        );
        res = { success: true, replayed: false };
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

  const reverse = async (row: LedgerRow) => {
    if (!clubUuid || reversingId || busyRef.current) return;
    busyRef.current = true;
    setReversingId(row.id);
    try {
      const { data, error } = await supabase.rpc('fn_club_bank_reverse', {
        p_transaction_id: row.id,
        p_reason: 'Reversed From The Club Bank Cashier',
        p_op_id: newOpId(),
      });
      if (error) throw error;
      const res = (Array.isArray(data) ? data[0] : data) as {
        success?: boolean;
        error?: string;
      } | null;
      if (!res?.success) throw new Error(res?.error || 'That Send Could Not Be Reversed');
      toast?.success?.(`Reversed ${fmtWhole(row.amount)} Chips Back Into The Club Bank`);
      masterBus.emit('BALANCE_UPDATED', { source: 'club_bank_reverse', userId: user?.id || '' });
      refresh();
    } catch (e) {
      reportError(e, 'WalletCashierModal.reverse');
      toast?.error?.((e as Error).message || 'Reversal Failed');
    } finally {
      busyRef.current = false;
      if (isMounted.current) setReversingId(null);
    }
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
    const blob = new Blob([[header.map(csvCell).join(','), ...body].join('\r\n')], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `club-bank-ledger-${clubName.replace(/\W+/g, '-').toLowerCase()}-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast?.success?.(`Exported ${rows.length} Ledger Entries`);
  };

  if (!isOpen) return null;

  const cashierTitle =
    walletType === 'promo_wallet'
      ? 'PROMO WALLET'
      : walletType === 'agent_wallet'
        ? 'AGENT WALLET'
        : 'CLUB BANK';

  // Belt and braces: this modal is only mounted behind a role check, and the
  // row that opens it only renders for roles that hold the wallet. If it is
  // somehow reached anyway, say so plainly rather than rendering an empty
  // cashier.
  if (!allowed) {
    return (
      <div className="cbc-overlay" role="dialog" aria-label="Club Bank Cashier" onClick={onClose}>
        <div className="cbc-panel cbc-panel--denied" onClick={(e) => e.stopPropagation()}>
          <div className="cbc-title">{cashierTitle}</div>
          {/* "Co Owners" cannot appear in JSX text here: check-title-case
              treats a bare `co` as the poker position (cutoff) and rewrites it
              to "CO". Co-owners are covered by "Owners" in plain speech, and
              the precise four-role list is in the server's own refusal string,
              which reaches the screen through an expression rather than page
              copy and so keeps its casing. */}
          <p className="cbc-denied">
            {walletType === 'club_bank'
              ? 'The Club Bank Is Restricted To Owners, Admins And Super Agents.'
              : 'This Wallet Belongs To Agents And Club Staff.'}
          </p>
          <div className="cbc-actions">
            <button onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        className="cbc-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Club Bank Cashier"
        onClick={() => !sending && onClose()}
      >
        <div className="cbc-panel" onClick={(e) => e.stopPropagation()}>
          {/* ── Header ───────────────────────────────────────────────────── */}
          <div className="cbc-head">
            <div>
              <div className="cbc-title">{cashierTitle}</div>
            </div>
            <button className="cbc-x" onClick={onClose} aria-label="Close">
              &times;
            </button>
          </div>

          <div className="cbc-bank">
            <span>
              {walletType === 'promo_wallet'
                ? 'Promo Wallet Balance'
                : walletType === 'agent_wallet'
                  ? 'Agent Wallet Balance'
                  : 'Club Bank Balance'}
            </span>
            <strong aria-live="polite">{bank === null ? '...' : fmt(bank)}</strong>
          </div>

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
            {tab === 'send' || tab === 'claim' ? (
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
                  <div className="cbc-blurb">{destinationBlurb(walletType, destination, tab)}</div>
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
                    aria-label="Search recipients"
                  />
                  <div className="cbc-list">
                    {membersLoading && <div className="cbc-empty">Loading Members...</div>}
                    {!membersLoading && eligible.length === 0 && (
                      <div className="cbc-empty">
                        {AGENT_ONLY.includes(destination)
                          ? 'No Agents In This Club Yet. Promote A Member To Agent First.'
                          : 'No Members Match That Search.'}
                      </div>
                    )}
                    {eligible.map((m) => (
                      <button
                        key={m.user_id}
                        className={
                          recipient?.user_id === m.user_id
                            ? 'cbc-member cbc-member--on'
                            : 'cbc-member'
                        }
                        onClick={() => setRecipient(m)}
                        aria-pressed={recipient?.user_id === m.user_id}
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
                        <span className="cbc-member-bal">{fmt(m.chip_balance)}</span>
                      </button>
                    ))}
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
                    inputMode="decimal"
                    min={1}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder=""
                    aria-label=""
                  />

                  {tab === 'claim' && recipient && (
                    <div className="cbc-blurb">
                      {holderHeld === null
                        ? 'Reading That Wallet...'
                        : `${recipient.name} Holds ${fmt(holderHeld)} In That Wallet.`}
                    </div>
                  )}
                  {amt > 0 && !overCap && (
                    <div className="cbc-blurb">
                      {tab === 'claim'
                        ? `Claiming ${fmt(amt)}. The Club Bank Would Hold ${fmt((bank ?? 0) + amt)} Afterwards.`
                        : `Sending ${fmt(amt)}. The Wallet Would Hold ${fmt((bank ?? 0) - amt)} Afterwards.`}
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

                <div className="cbc-actions">
                  <button
                    disabled={sending}
                    onClick={() => (confirming ? setConfirming(false) : onClose())}
                  >
                    {confirming ? 'Go Back' : 'Cancel'}
                  </button>
                  <button className="cbc-confirm" disabled={!canSend} onClick={onSendPressed}>
                    {sending
                      ? tab === 'claim'
                        ? 'Claiming...'
                        : 'Sending...'
                      : confirming
                        ? tab === 'claim'
                          ? 'Yes, Claim It'
                          : 'Yes, Send It'
                        : tab === 'claim'
                          ? 'Claim Chips'
                          : 'Send Chips'}
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
              </>
            )}
          </div>
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
