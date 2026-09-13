/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CASHIER PAGE — Universal Chip Transfer Hub (Facebook Dark)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  ALL chip movements happen through the Cashier via respective wallets.
 *
 *  Chip Flow: Union → Club Bank → Agent Wallet → Player Wallet → Games
 *
 *  Roles & Actions:
 *  - Union Owner: Mint, Send to clubs, Send to agents/players, History
 *  - Club Owner (standalone): Mint, Send to agents/players, History
 *  - Club Owner (in union): Send to agents/players, History (no mint)
 *  - Agent/Super Agent: Send to sub-agents/players, History
 *  - Sub Agent: Send to players, History
 *  - Player: Buy-in, Cash-out, History
 *
 *  Every single chip transaction is recorded with full audit trail.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { isClubStaff, isAgentRole } from '../types/clubRoles';
import { useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { withClubContext } from '../utils/clubScopedPath';
import { masterBus } from '../core/MasterBus';
import { useMasterBusChannel } from '../hooks/useMasterBusChannel';
import {
  useMasterBusSubscription,
  useMasterBusSubscriptions,
} from '../hooks/useMasterBusSubscription';
import { useWalletStore } from '../stores/useWalletStore';
import { useAuthUser } from '../hooks/useAuthUser';
import { cashoutService } from '../services/CashoutService';
import { supabase } from '../lib/supabase';
import CashierClubSwitcher from '../components/club/CashierClubSwitcher';

import { useToast } from '../components/common/Toast';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { resolveClubUUID } from '../utils/clubIdResolver';
import {
  resolveTargetClub,
  readCachedQuickLinkClubs,
  fetchQuickLinkClubs,
  fetchClubChipBalances,
  clearClubChipBalanceCache,
  CHIP_BALANCE_EVENTS,
} from '../utils/clubQuickLink';
import { checkSettlementLock } from '../utils/settlementLock';
import AgentPromoPanel from '../components/agent/AgentPromoPanel';
import CashoutRequestModal from '../components/wallet/CashoutRequestModal';
import DynamicWallet from '../components/wallet/DynamicWallet';
import WalletCashierModal from '../components/wallet/WalletCashierModal';
import { DEFAULT_CASHIER_WALLET } from '../components/wallet/cashierModes';
import { canHoldAgentWallet } from '../components/wallet/walletRows';
import PlayerWalletModal from '../components/wallet/PlayerWalletModal';
import StandardContentLayout from '../components/layouts/StandardContentLayout';
import styles from './CashierPage.module.css';
import { useIsMounted } from '../hooks/useIsMounted';
import { retryFetch } from '../utils/retryFetch';
import { reportError } from '../utils/errorReporter';
import { formatPopupText } from '../utils/popupStyle';
import CashierConsoleSurface from '../components/cashier/CashierConsoleSurface';

type CashierAction = 'send' | 'distribute' | 'buyin' | 'cashout' | 'mint' | 'history';

interface Transaction {
  id: string;
  wallet_type: string;
  amount: number;
  type: string;
  category: string;
  description: string;
  created_at: string;
}

interface Recipient {
  id: string;
  username: string;
  role: string;
  balance: number;
  commissionRate?: number;
  isPrepaid?: boolean;
}

/** Hard ceiling mirrored from atomic_chip_transfer's own AMOUNT_EXCEEDS_LIMIT guard. */
export const MAX_CHIP_AMOUNT = 1_000_000_000_000;

/**
 * Validate a typed chip amount.
 *
 * TWO DECIMAL PLACES, because that is what a chip is here (2026-09-05, phase
 * 7). This used to refuse any fraction, and said why: "the per-club ledger
 * column (club_members.chip_balance) is an integer, so a fractional amount is
 * rounded on write while the sending side is debited the exact decimal". That
 * premise is false and was measured false - the column is `numeric(20,2)`, it
 * stores 12.34 exactly, and nothing rounds. Meanwhile the Trade cashier on the
 * same platform accepts 2dp and says "Chips Go To Two Decimal Places", so the
 * two cashiers disagreed about what a chip IS: an operator could send 0.50
 * from one screen and be refused it on the other.
 *
 * The bound and the exponent rule stay: `parseFloat` accepted "1e9", which is
 * a billion chips from four keystrokes, and the ceiling mirrors the database's
 * own AMOUNT_EXCEEDS_LIMIT guard.
 */
export function parseChipAmount(
  raw: string
): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { ok: false, error: 'Please enter an amount' };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: 'Please enter a valid amount' };
  }
  // numeric(20,2): more than two decimals cannot be stored exactly, and the
  // difference between what the operator typed and what the ledger keeps is
  // money created or destroyed.
  if (Math.round(value * 100) !== value * 100) {
    return { ok: false, error: 'Chips go to two decimal places' };
  }
  if (value > MAX_CHIP_AMOUNT) {
    return { ok: false, error: 'Amount exceeds the maximum transfer limit' };
  }
  return { ok: true, value };
}

/**
 * crypto.randomUUID is not in every embedded webview, and fn_agent_wallet_send
 * takes `p_op_id uuid` - so the fallback must still BE a uuid or the one call
 * that moves the chips fails with a 22P02 on exactly the browsers that lack it.
 * Same shim as WalletCashierModal and CashierTradePage.
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

const CATEGORY_LABELS: Record<string, string> = {
  buyin: 'Buy-In',
  cashout: 'Cash-Out',
  rake: 'Rake',
  prize: 'Prize',
  rebuy: 'Rebuy',
  addon: 'Add-On',
  mint: 'Mint',
  settlement: 'Settlement',
  commission: 'Commission',
  // 'TIP' intentionally absent: dealer tipping was removed on 2026-08-20
  // and no row has ever carried this category. Both readers fall back to the
  // raw category string, so a legacy row would still render.
  INSURANCE: 'Insurance',
  funding: 'Funding',
  promotion: 'Promotion',
  promo: 'Promo Bonus',
  bbj: 'Bad Beat Jackpot',
  horse_refill: 'Auto Refill',
  transfer: 'Transfer',
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  refund: 'Refund',
  bonus: 'Bonus',
};

const CATEGORY_ICONS: Record<string, string> = {
  buyin: '▦',
  cashout: '◉',
  rake: '%',
  prize: '★',
  rebuy: '↺',
  addon: '⊞',
  mint: '◆',
  settlement: '≡',
  commission: '◈',
  INSURANCE: '⊕',
  funding: '→',
  promotion: '↑',
  promo: '★',
  bbj: '♣',
  horse_refill: '↺',
  transfer: '→',
  deposit: '+',
  withdrawal: '-',
  refund: '↻',
  bonus: '★',
};

import { useRealtimeFinancials } from '../hooks/useRealtimeFinancials';
import { useCashierHistory } from '../hooks/useCashierHistory';

import { safeErrorMessage } from '../utils/safeErrorMessage';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';
export default function CashierPage() {
  useRealtimeFinancials();
  useEffect(() => {
    document.title = 'Cashier | Smarter Poker';
  }, []);

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { clubId: routeClubId } = useParams<{ clubId?: string }>();
  const tableId = searchParams.get('table');
  const clubId = routeClubId || searchParams.get('club');

  const { user } = useAuthUser();

  /* `balances` is deliberately NOT destructured any more. It is the GLOBAL
     player wallet, and the last three things on this page that read it were all
     quoting the wrong account: the Send guard, the Send preview and the Max
     preset. Every chip figure here is now either the per-club balance
     (myClubChips, what a cashout debits) or the agent wallet (myAgentWallet,
     what a send debits). Leaving it destructured is an invitation to reach for
     it again. */
  const { mintChips, loadBalances } = useWalletStore();
  const toast = useToast();

  const [action, setAction] = useState<CashierAction>('send');
  const [amount, setAmount] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Rate limiting: minimum 2s between financial actions (beyond the 3s cooldown)
  const lastActionRef = useRef<number>(0);
  /**
   * 2026-08-27: idempotency keys for the CURRENT money intent, one per action.
   * Minted per INTENT, not per call: held across a failed attempt so a retry
   * of the same send/cashout/distribution replays server-side instead of
   * debiting twice, and rotated when the inputs change (a corrected amount is
   * a NEW intent - replaying the old key would move the wrong number). Every
   * success path here clears the inputs, so success rotates them too via the
   * effect below the input state. Pattern: WalletCashierModal.doSend.
   */
  const sendOpIdRef = useRef<string>(newOpId());
  const cashoutOpIdRef = useRef<string>(newOpId());
  const promoOpIdRef = useRef<string>(newOpId());
  const RATE_LIMIT_MS = 2000;

  // Connection status: track realtime channel health
  // Starts 'reconnecting', not 'connected': asserting a healthy live link
  // before any channel has reported SUBSCRIBED is the same unearned claim the
  // fabricated AML checklist made.
  const [realtimeStatus, setRealtimeStatus] = useState<'connected' | 'reconnecting' | 'error'>(
    'reconnecting'
  );
  const [message, setMessage] = useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);
  const [cashoutConfirm, setCashoutConfirm] = useState({ show: false, value: 0 });
  const [showCashoutModal, setShowCashoutModal] = useState(false);

  // Send confirmation for high-value transfers (≥10K)
  const [sendConfirm, setSendConfirm] = useState<{
    show: boolean;
    value: number;
    recipientId: string;
    recipientName: string;
  }>({ show: false, value: 0, recipientId: '', recipientName: '' });

  const isMounted = useIsMounted();

  // ── /cashier with no club in the URL ─────────────────────────────────────
  // The table menu links here without a club param. Every data effect below
  // bails on `!clubId`, but loadingContext stays true, so the page used to
  // sit on a skeleton forever. Resolve the user's club (same rule as the
  // lobby quick links) and redirect; only show the empty state if they
  // genuinely have no club.
  const [hasNoClubs, setHasNoClubs] = useState(false);
  useEffect(() => {
    if (clubId || !user?.id) return;
    let live = true;
    (async () => {
      let target = resolveTargetClub(readCachedQuickLinkClubs(user.id));
      if (!target) target = resolveTargetClub(await fetchQuickLinkClubs(user.id));
      if (!live) return;
      if (target) navigate(`/clubs/${target.id}/cashier`, { replace: true });
      else setHasNoClubs(true);
    })();
    return () => {
      live = false;
    };
  }, [clubId, user?.id, navigate]);

  // Auto-dismiss success/error messages after 8s
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 8000);
    return () => clearTimeout(t);
  }, [message]);

  // Rate limiting: 3s cooldown after each action
  const startCooldown = useCallback(() => {
    setCooldown(3);
    if (cooldownRef.current) clearInterval(cooldownRef.current);
    cooldownRef.current = setInterval(() => {
      setCooldown((prev) => {
        if (prev <= 1) {
          clearInterval(cooldownRef.current!);
          cooldownRef.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  // Cleanup cooldown interval on unmount
  useEffect(() => {
    return () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current);
    };
  }, []);

  // Role state
  const [userRole, setUserRole] = useState<string>('member');
  // Dan 2026-08-23: the Club Bank row opens the Club Bank Cashier here too, so
  // the control means the same thing on every surface it appears on.
  const [activeCashier, setActiveCashier] = useState<
    'club_bank' | 'promo_wallet' | 'agent_wallet' | null
  >(null);
  // Dan 2026-08-24: "PLAYER WALLET NEEDS TO BE FULLY CLICKABLE AND OPEN TO SEE
  // ALL TRANSACTIONS AND OTHER AVAILABLE DATA WHEN CLICKED." The row opens the
  // member's own statement - a read-only view, so it is not an activeCashier.
  const [showPlayerWallet, setShowPlayerWallet] = useState(false);
  const [isInUnion, setIsInUnion] = useState(false);
  const [isUnionOwner, setIsUnionOwner] = useState(false);
  const [clubName, setClubName] = useState('');
  /**
   * agents.agent_wallet_balance for the viewer IN THIS CLUB - the account the
   * Send tab actually spends (see handleAction's 'send' branch).
   *
   * Null while unknown, never 0: a figure we could not read must not refuse a
   * send the server would have allowed, and must not authorise one it will
   * refuse. The Send preview and the Max preset both read this, because
   * balances.PLAYER.available is the GLOBAL wallet and has nothing to do with
   * the chips this action moves.
   */
  const [myAgentWallet, setMyAgentWallet] = useState<number | null>(null);

  // Send chips state
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [selectedRecipient, setSelectedRecipient] = useState('');
  // Any change to what is being moved is a NEW intent - fresh keys.
  useEffect(() => {
    sendOpIdRef.current = newOpId();
    cashoutOpIdRef.current = newOpId();
    promoOpIdRef.current = newOpId();
  }, [amount, selectedRecipient]);
  const [loadingRecipients, setLoadingRecipients] = useState(false);
  const [recipientSearch, setRecipientSearch] = useState('');

  const filteredRecipients = useMemo(() => {
    if (!recipientSearch.trim()) return recipients;
    const q = recipientSearch.trim().toLowerCase();
    return recipients.filter(
      (r) =>
        r.username.toLowerCase().includes(q) ||
        r.role.toLowerCase().includes(q) ||
        (r.id === user?.id && 'you'.includes(q))
    );
  }, [recipients, recipientSearch, user?.id]);

  // Buy Chips entry point (audit s21/s34: the server-priced purchase flow
  // worked end-to-end but nothing in the UI could reach it).

  // ── This user's chip balance IN THIS CLUB ─────────────────────────────────
  // Chips are per club. The cashout modal was being handed
  // balances.PLAYER.available — the GLOBAL wallet — while the server debits
  // club_members.chip_balance for this club, so the same screen showed two
  // different "chip balance" figures and the modal's Max button could prefill
  // an amount the server always rejects.
  const [myClubChips, setMyClubChips] = useState<number | null>(null);
  const [clubChipsNonce, setClubChipsNonce] = useState(0);
  useEffect(() => {
    if (!user?.id || !clubId) return;
    let live = true;
    (async () => {
      const resolved = (await resolveClubUUID(clubId)) || clubId;
      const map = await fetchClubChipBalances(user.id);
      /* NULL map = the read FAILED with nothing cached (Cashier audit
         2026-08-27). Collapsing that into 0 told the cashout modal the
         player has no chips in this club: Max prefilled 0 and the local
         amount check refused every cashout without asking the server. The
         null state ("Still loading your club balance") already renders for
         exactly this; keep it. A missing membership ROW in a map that DID
         load is still a real zero. */
      if (live && isMounted.current) {
        setMyClubChips(map === null ? null : (map.get(resolved) ?? 0));
      }
    })();
    return () => {
      live = false;
    };
  }, [user?.id, clubId, clubChipsNonce]);

  // Any chip movement invalidates the per-club figure. Without this the nonce
  // was bumped in exactly ONE place (the cashout modal's onComplete), so an
  // inline cashout, a send or a distribute left `myClubChips` showing the
  // pre-transaction balance — and the modal's Max button would then prefill an
  // amount the server rejects. CashierClubSwitcher and ClubQuickLinkTile
  // already subscribe to the same event group and clear the shared memo; this
  // page was clearing it only from the modal.
  useMasterBusSubscriptions(
    [...CHIP_BALANCE_EVENTS],
    () => {
      clearClubChipBalanceCache();
      setClubChipsNonce((n) => n + 1);
    },
    { debounce: 500 }
  );
  const [txFilter, setTxFilter] = useState('all');
  const [txPage, setTxPage] = useState(1);
  const TX_PAGE_SIZE = 25;

  // Distribute rate limit: 1 per 10 seconds
  const lastDistributeRef = useRef(0);
  const DISTRIBUTE_RATE_LIMIT_MS = 10_000;

  // Pending cashout state (U-02 FIX: show escrow status)
  const [pendingCashouts, setPendingCashouts] = useState<
    { id: string; amount: number; status: string; created_at: string }[]
  >([]);
  // U-01: Loading context state — shows skeleton during initial club data fetch
  const [loadingContext, setLoadingContext] = useState(true);

  // Recipient cache ref — avoids re-fetching on every tab switch (60s TTL)
  const recipientsCacheRef = useRef<{ data: Recipient[]; ts: number; clubId: string } | null>(null);
  const RECIPIENT_CACHE_TTL = 60_000;

  // ── CRITICAL: Reset per-club state when navigating between clubs ──
  // Prevents financial state (userRole, pending cashouts) from carrying over.
  useEffect(() => {
    setAction('send');
    setAmount('');
    setIsProcessing(false);
    setCooldown(0);
    setMessage(null);
    setCashoutConfirm({ show: false, value: 0 });
    setShowCashoutModal(false);
    setSendConfirm({ show: false, value: 0, recipientId: '', recipientName: '' });
    setLoadingContext(true);
    setUserRole('player');
    setIsInUnion(false);
    setIsUnionOwner(false);
    setSelectedRecipient('');
    setTxFilter('all');
    setPendingCashouts([]);
    recipientsCacheRef.current = null;
    setTxPage(1);
    // Not knowing the new club's chip balance yet is different from it being
    // zero: null keeps the cashout Max button from prefilling the PREVIOUS
    // club's figure during the switch.
    setMyClubChips(null);
    setRecipients([]);
    setClubName('');
    // Chips are per club, and so is the float. Carrying the previous club's
    // agent wallet across a switch would quote a balance this club cannot spend.
    setMyAgentWallet(null);
  }, [clubId]);

  // ─────────────────────────────────────────────────────────────────────────────
  // LOAD ROLE, UNION STATUS, AND RECIPIENTS
  // ─────────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!clubId || !user?.id) return;
    setLoadingContext(true);
    loadUserContext();
  }, [clubId, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load pending cashouts
  useEffect(() => {
    if (!clubId || !user?.id) return;
    loadPendingCashouts();
  }, [clubId, user?.id, action]); // eslint-disable-line react-hooks/exhaustive-deps

  // NOTE: WALLET_REFRESHED is handled by the combined subscriber at line ~710
  // (removed duplicate subscription that was here)

  const loadPendingCashouts = useCallback(async () => {
    if (!clubId || !user?.id) return;
    try {
      const resolvedId = await resolveClubUUID(clubId);
      const { data } = await retryFetch(
        () =>
          supabase
            .from('cashout_requests')
            .select('id, amount, status, created_at')
            .eq('club_id', resolvedId)
            .eq('player_id', user.id)
            .in('status', ['pending'])
            .order('created_at', { ascending: false })
            .then((r) => r),
        { maxRetries: 2, isMountedRef: isMounted }
      );
      if (isMounted.current) {
        setPendingCashouts(data || []);
      }
    } catch (e) {
      reportError(e, 'CashierPage.then');
      /* silent */
    }
  }, [clubId, user?.id]);

  useVisibilityRefresh(() => loadPendingCashouts());

  // Guards every async loader below against a club switch landing mid-flight.
  // Without it a slow response for club A could resolve AFTER club B is on
  // screen and overwrite B's role, union status, club name and recipient list.
  // That is not cosmetic: userRole/isUnionOwner drive canSend/canMint/
  // canDistribute and the tab set, so a stale 'owner' hands someone a Mint tab
  // in a club where they are a member; and clubName is written verbatim into
  // the ChipFlowService audit trail, so a send could be recorded against the
  // wrong club's name. DynamicWallet already uses this exact pattern.
  const contextVersionRef = useRef(0);
  useEffect(() => {
    contextVersionRef.current += 1;
  }, [clubId]);

  const loadUserContext = async () => {
    if (!clubId || !user?.id) return;
    const myVersion = contextVersionRef.current;
    const stale = () => contextVersionRef.current !== myVersion;
    try {
      const resolvedId = await resolveClubUUID(clubId);
      if (!isMounted.current || stale()) return;

      // PERF: Parallelize role + club data queries (was 4 sequential, now 2 parallel)
      const [memberResult, clubResult, floatResult] = await Promise.all([
        // Query 1: user role
        retryFetch(
          () =>
            supabase
              .from('club_members')
              .select('role')
              .eq('club_id', resolvedId)
              .eq('user_id', user.id)
              .maybeSingle()
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        ),
        // Query 2: club name + union_id (combined — was 2 separate queries)
        retryFetch(
          () =>
            supabase
              .from('clubs')
              .select('name, union_id')
              .eq('id', resolvedId)
              .maybeSingle()
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        ),
        // Query 3: the agent wallet the Send tab spends. Staff hold one too -
        // the Club Bank funds it, and fn_agent_wallet_send refuses every caller
        // who has not been funded, owners included.
        retryFetch(
          () =>
            supabase
              .from('agents')
              .select('agent_wallet_balance')
              .eq('club_id', resolvedId)
              .eq('user_id', user.id)
              .maybeSingle()
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        ),
      ]);
      if (!isMounted.current || stale()) return;

      const role = memberResult?.data?.role || 'member';
      setUserRole(role);
      setClubName(clubResult?.data?.name || '');
      // A row that does not exist is a float of zero. A row we could not READ
      // is unknown, and stays null so the pre-flight check below cannot refuse
      // a send the server would have allowed.
      setMyAgentWallet(
        floatResult?.error
          ? null
          : floatResult?.data
            ? Number(floatResult.data.agent_wallet_balance) || 0
            : 0
      );

      // Union check — derived from combined query above
      const detectedUnionId = clubResult?.data?.union_id;
      if (detectedUnionId) {
        setIsInUnion(true);
        // Only need 1 more query: union owner check
        /* `retryFetch` RETURNS the Supabase result with `error` set rather
           than throwing, so reading only `data` made a failed union lookup
           indistinguishable from "you are not the union owner" - the operator
           silently lost Mint gating and the distribute path with nothing said.
           Refusing is still the safe default; being told is the difference. */
        const { data: unionData, error: unionErr } = await retryFetch(
          () =>
            supabase
              .from('unions')
              .select('owner_id')
              .eq('id', detectedUnionId)
              .maybeSingle()
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        );
        if (!isMounted.current || stale()) return;
        if (unionErr) {
          reportError(unionErr, 'CashierPage.union_owner_lookup_failed');
          setIsUnionOwner(false);
          setMessage({
            type: 'error',
            text: 'Your Union Role Could Not Be Read, So Union Actions Are Hidden. Refresh To Try Again.',
          });
        } else {
          setIsUnionOwner(unionData?.owner_id === user.id);
        }
      } else {
        setIsInUnion(false);
        setIsUnionOwner(false);
      }
    } catch (e) {
      reportError(e, 'CashierPage.then');
      // Keep defaults
    } finally {
      if (isMounted.current) setLoadingContext(false);
    }
  };

  // Load recipients when "Send" or "Distribute" tab is active
  // MUST include userRole + isUnionOwner — loadRecipients uses them for role-based filtering
  useEffect(() => {
    if ((action === 'send' || action === 'distribute') && user?.id && clubId) {
      loadRecipients();
    }
  }, [action, user?.id, clubId, userRole, isUnionOwner]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadRecipients = async (forceRefresh = false) => {
    if (!user?.id || !clubId) return;
    const myVersion = contextVersionRef.current;
    const stale = () => contextVersionRef.current !== myVersion;

    // Check cache — skip fetch if fresh data exists (60s TTL)
    if (
      !forceRefresh &&
      recipientsCacheRef.current &&
      recipientsCacheRef.current.clubId === clubId &&
      Date.now() - recipientsCacheRef.current.ts < RECIPIENT_CACHE_TTL
    ) {
      setRecipients(recipientsCacheRef.current.data);
      return;
    }
    setLoadingRecipients(true);
    try {
      const resolvedId = await resolveClubUUID(clubId);
      // Determine which roles this user can send to
      let roleFilter: string[];
      // 'admin' was missing from every branch, so a club admin fell through to
      // the else below and was told "regular members can't send chips" - on a
      // page whose own comment two lines down says admins see everyone.
      if (isClubStaff(userRole) || isUnionOwner) {
        roleFilter = [
          'owner',
          'co_owner',
          'admin',
          'agent',
          'super_agent',
          'sub_agent',
          'member',
          'player',
        ];
      } else if (userRole === 'agent' || userRole === 'super_agent') {
        roleFilter = [
          'owner',
          'co_owner',
          'admin',
          'agent',
          'super_agent',
          'sub_agent',
          'member',
          'player',
        ];
      } else if (userRole === 'sub_agent') {
        roleFilter = ['sub_agent', 'member', 'player'];
      } else {
        // Regular members can't send chips
        setRecipients([]);
        setLoadingRecipients(false);
        return;
      }

      /**
       * ── WHO THIS PAGE MAY SEND TO (Dan 2026-08-25, binding) ───────────────
       *
       * "Super Agents, Agents, and Sub Agents should ONLY EVER SEE their
       *  downlines, and their downline agents' downlines. Nobody else. Owners,
       *  Co Owners and Admins should see everyone."
       *
       * The agent-scoped branch here was BROKEN, not merely divergent.
       * `ca_club_my_downline` returns a TABLE - one row per downline AGENT,
       * with columns (agent_id, path, depth, username, ...). This code read the
       * response as an object and asked it for `.scoped` and `.user_ids`, which
       * are not fields it has ever had. Both came back undefined, so
       * `downlineIds` became `[]`, `effectiveDownline` became `[user.id]`, and
       * the query filtered the whole club down to the viewer themselves.
       *
       * Net effect in production: every super agent, agent and sub agent opened
       * the Send tab and found exactly one recipient - their own name - which
       * fn_agent_wallet_send then refuses as a self-send. The tab was unusable
       * for the three roles it exists for, and looked like an empty club.
       *
       * fn_club_cashier_members answers the question in the database, walking
       * the same recursive club_members.agent_id edge that
       * fn_club_cashier_can_transact refuses on - and it is the SAME source the
       * Cashier Trade grid and the Wallet Cashier modal already read, so all
       * three surfaces and the server now agree by construction rather than by
       * three separate hand-rolled attempts.
       *
       * Staff keep the paged club_members read: fn_club_cashier_scope returns
       * 'all' for owner/co_owner/admin, which is the same set, and a union
       * owner who is not a club member has no club_members row at all and would
       * be handed an empty list by the RPC.
       */
      const agentScoped = ['super_agent', 'agent', 'sub_agent'].includes(userRole);

      type RecipientRow = {
        user_id: string;
        role: string;
        display_name: string | null;
        nickname: string | null;
        chip_balance: number | null;
      };
      let members: RecipientRow[] = [];

      if (agentScoped) {
        const { data: scoped, error: scopedErr } = await retryFetch(
          () => supabase.rpc('fn_club_cashier_members', { p_club_id: resolvedId }).then((r) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        );
        if (!isMounted.current || stale()) return;
        // A read that failed is not an empty downline. Say so rather than
        // rendering "no recipients" over a network error.
        if (scopedErr) throw scopedErr;
        members = ((scoped || []) as Array<Record<string, unknown>>)
          // The viewer is never in their own downline walk, but guard anyway:
          // fn_agent_wallet_send refuses a self-send outright.
          .filter((m) => String(m.user_id) !== user.id)
          .map((m) => ({
            user_id: String(m.user_id),
            role: String(m.role || 'player'),
            display_name: (m.name as string) || null,
            nickname: (m.username as string) || null,
            chip_balance: Number(m.chip_balance) || 0,
          }));
      } else {
        // PostgREST caps a response at 1,000 rows and .limit(500) capped it
        // lower still, with no ORDER BY - so on a 588-member club, 88 people
        // vanished in whatever order Postgres happened to return, and the most
        // recently added members are exactly the ones that fall off the end.
        // Pages through in a deterministic order instead.
        const PAGE = 500;
        const MAX_RECIPIENTS = 10000;
        const collected: Array<Record<string, unknown>> = [];
        for (let from = 0; from < MAX_RECIPIENTS; from += PAGE) {
          const query = supabase
            .from('club_members')
            .select('user_id, role, display_name, nickname, chip_balance, agent_id')
            .eq('club_id', resolvedId)
            .in('role', roleFilter)
            .in('status', ['active', 'approved'])
            .order('joined_at', { ascending: true })
            .order('user_id', { ascending: true })
            .range(from, from + PAGE - 1);

          /* A FAILED PAGE IS NOT THE END OF THE LIST. Reading only `data` made
             an error look like "that was the last page", so the recipient list
             for a chip send ended early - or empty - and a member simply was
             not there to send to, with nothing on screen saying why. */
          const { data: page, error: pageErr } = await retryFetch(() => query.then((r) => r), {
            maxRetries: 2,
            isMountedRef: isMounted,
          });
          if (!isMounted.current || stale()) return;
          if (pageErr) {
            reportError(pageErr, 'CashierPage.recipient_page_failed');
            throw new Error(
              'The member list could not be loaded in full. Refresh before sending, so you are not choosing from a partial list.'
            );
          }
          collected.push(...((page || []) as Array<Record<string, unknown>>));
          if (!page || page.length < PAGE) break;
        }
        members = collected as unknown as RecipientRow[];
      }

      // Batch-fetch display names from profiles for members without display_name
      // PERF 2026-08-23: both lookups below derive from `members` and neither
      // depends on the other, yet they ran in series - and the display-name
      // fetch ran one chunk at a time, so a 588-member club paid three round
      // trips before the agents query had even started. They are all issued
      // together now; the consuming loops are unchanged.
      const needNames = members.filter((m) => !m.display_name && !m.nickname).map((m) => m.user_id);
      const profileMap: Record<string, string> = {};
      const CHUNK_SIZE = 200;
      const nameChunks: string[][] = [];
      for (let i = 0; i < needNames.length; i += CHUNK_SIZE) {
        nameChunks.push(needNames.slice(i, i + CHUNK_SIZE));
      }

      // Fetch commission rates for agent-type recipients
      const agentUserIds = members
        .filter((m) => ['agent', 'super_agent', 'sub_agent'].includes(m.role))
        .map((m) => m.user_id);
      const agentMap: Record<string, { commission_rate: number; is_prepaid: boolean }> = {};

      const namesPromise = Promise.all(
        nameChunks.map((chunk) =>
          retryFetch(
            () =>
              supabase
                .from('profiles')
                .select(`id, ${PLAYER_NAME_COLUMNS}`)
                .in('id', chunk)
                .then((r) => r),
            { maxRetries: 2, isMountedRef: isMounted }
          )
        )
      ).then(
        (r) => r,
        (error) => {
          reportError(error, 'CashierPage.loadRecipients.names');
          return [] as Array<{
            data: Array<{
              id: string;
              display_name: string | null;
              username: string | null;
            }> | null;
          }>;
        }
      );

      const agentsPromise =
        agentUserIds.length > 0
          ? retryFetch(
              () =>
                supabase
                  .from('agents')
                  .select('user_id, commission_rate, is_prepaid')
                  .in('user_id', agentUserIds)
                  .eq('club_id', resolvedId)
                  .then((r) => r),
              { maxRetries: 2, isMountedRef: isMounted }
            ).then(
              (r) => r,
              (error) => {
                reportError(error, 'CashierPage.loadRecipients.agents');
                return { data: null };
              }
            )
          : Promise.resolve({ data: null });

      const [nameResults, agentResult] = await Promise.all([namesPromise, agentsPromise]);
      if (!isMounted.current || stale()) return;

      for (const { data: profiles } of nameResults) {
        if (profiles) {
          for (const p of profiles) {
            profileMap[p.id] = playerDisplayName(p);
          }
        }
      }

      {
        const { data: agentRecords } = agentResult;
        if (agentRecords) {
          for (const a of agentRecords) {
            agentMap[a.user_id] = {
              commission_rate: a.commission_rate || 0,
              is_prepaid: a.is_prepaid || false,
            };
          }
        }
      }

      const list: Recipient[] = members
        .filter((m) => m.user_id)
        .map((m) => ({
          id: m.user_id,
          username: m.display_name || m.nickname || profileMap[m.user_id] || 'Player',
          role: m.role,
          balance: m.chip_balance || 0,
          commissionRate: agentMap[m.user_id]?.commission_rate,
          isPrepaid: agentMap[m.user_id]?.is_prepaid,
        }))
        .sort((a: Recipient, b: Recipient) => {
          const order: Record<string, number> = {
            agent: 0,
            super_agent: 0,
            sub_agent: 1,
            member: 2,
            player: 2,
          };
          return (order[a.role] || 3) - (order[b.role] || 3);
        });

      if (isMounted.current) {
        setRecipients(list);
        // Update cache
        recipientsCacheRef.current = { data: list, ts: Date.now(), clubId };
      }
    } catch (err: unknown) {
      reportError(err, 'CashierPage.Failed_to_load_recipients');
      toast.error(err instanceof Error ? err.message : 'Failed to load eligible recipients');
    }
    if (isMounted.current) setLoadingRecipients(false);
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // LOAD TRANSACTIONS
  // ─────────────────────────────────────────────────────────────────────────────

  const readTransactions = useCallback(async (): Promise<Transaction[]> => {
    if (!user?.id || !clubId) return [];
    const historyClubId = (await resolveClubUUID(clubId)) || clubId;
    // Query BOTH wallet_transactions AND chip_ledger for complete history
    const [wtResult, clResult] = await Promise.all([
      retryFetch(
        () =>
          supabase
            .from('wallet_transactions')
            .select(
              'id, user_id, wallet_type, amount, type, category, description, related_entity_id, created_at'
            )
            .eq('user_id', user.id)
            // wallet_transactions has no club column; the cashier passes the
            // club as related_entity_id. Rows with no entity (mints, global
            // adjustments) are kept rather than hidden — the alternative is
            // silently dropping records the user is entitled to see.
            .or(`related_entity_id.eq.${historyClubId},related_entity_id.is.null`)
            .order('created_at', { ascending: false })
            .limit(50)
            .then((r) => r),
        { maxRetries: 2, isMountedRef: isMounted }
      ),
      retryFetch(
        () =>
          supabase
            .from('chip_ledger')
            .select(
              'id, performed_by, from_type, from_label, from_entity_id, to_type, to_label, to_entity_id, amount, category, description, created_at, club_id'
            )
            // from_entity_id was missing here while the RLS policy allows it
            // (performed_by OR from_entity_id OR to_entity_id), so chips moved
            // OUT of this user by an admin or the system were readable but
            // never requested — they simply vanished from their history.
            .or(
              `performed_by.eq.${user.id},to_entity_id.eq.${user.id},from_entity_id.eq.${user.id}`
            )
            // Scope to THIS club. Chips are per club, but this query had no
            // club filter at all, so every club's cashier showed the same
            // global history — and the CSV export inherited it.
            .eq('club_id', historyClubId)
            .order('created_at', { ascending: false })
            .limit(50)
            .then((r) => r),
        { maxRetries: 2, isMountedRef: isMounted }
      ),
    ]);

    if (wtResult?.error) throw wtResult.error;
    if (clResult?.error) throw clResult.error;
    if (!Array.isArray(wtResult?.data) || !Array.isArray(clResult?.data)) {
      throw new Error('Transaction history response is incomplete');
    }

    // Merge and deduplicate — chip_ledger entries get converted to transaction format
    const wtData = (wtResult?.data || []) as any[];
    const clData = (clResult?.data || []).map((entry: any) => ({
      id: entry.id,
      user_id: user.id,
      wallet_type: 'PLAYER',
      amount: entry.amount,
      // Direction is who the chips moved BETWEEN, not who clicked the button.
      // Keying off performed_by rendered every self-initiated credit (a mint
      // to yourself, a refill you triggered) as a debit with a leading minus
      // — money coming in displayed as money going out.
      type:
        entry.to_entity_id === user.id
          ? 'credit'
          : entry.from_entity_id === user.id
            ? 'debit'
            : entry.performed_by === user.id
              ? 'debit'
              : 'credit',
      category: entry.category,
      description: entry.description || `${entry.from_label} → ${entry.to_label}`,
      related_entity_id: entry.to_entity_id,
      created_at: entry.created_at,
      _source: 'chip_ledger',
      _from: entry.from_label,
      _to: entry.to_label,
    }));

    // ── Cross-source dedupe ────────────────────────────────────────────
    // The two tables record the SAME economic events with independent id
    // spaces, so deduplicating by `id` (as this did) never removed anything:
    // measured in production, 626 of 1,326 chip_ledger rows have a
    // same-second, same-amount wallet_transactions twin for the same user.
    // Every one of those was listed twice, and the CSV export double-counted
    // with it. wallet_transactions is the authoritative ledger (the mint and
    // transfer RPCs write it), so a chip_ledger row is dropped when a
    // wallet_transactions row already describes the same movement.
    const econKey = (amount: unknown, createdAt: string) =>
      `${Math.abs(Number(amount) || 0)}@${new Date(createdAt).toISOString().slice(0, 19)}`;
    const authoritative = new Set(wtData.map((tx) => econKey(tx.amount, tx.created_at)));

    const seen = new Set<string>();
    const merged = [...wtData, ...clData]
      .filter((tx) => {
        if (tx._source === 'chip_ledger' && authoritative.has(econKey(tx.amount, tx.created_at))) {
          return false;
        }
        if (seen.has(tx.id)) return false;
        seen.add(tx.id);
        return true;
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 100);

    return merged;
  }, [user?.id, clubId]);

  const {
    transactions,
    loading: loadingTx,
    error: txError,
    load: loadTransactions,
  } = useCashierHistory({ userId: user?.id, clubId, read: readTransactions });

  useEffect(() => {
    if (action === 'history') loadTransactions();
  }, [action, loadTransactions]);

  // ─────────────────────────────────────────────────────────────────────────────
  // REALTIME WALLET SUBSCRIPTION (#1: Using Channel Registry)
  // ─────────────────────────────────────────────────────────────────────────────
  // Subscribes to both wallets and wallet_transactions tables for live updates

  // Initial load
  useEffect(() => {
    if (!user?.id) return;
    loadBalances(user.id);
    loadTransactions();
  }, [user?.id, loadBalances, loadTransactions]);

  // Wallets channel
  const handleWalletUpdate = useCallback(
    (payload: { eventType: string }) => {
      if (payload.eventType === 'UPDATE' || payload.eventType === 'INSERT') {
        if (user?.id) loadBalances(user.id);
      }
    },
    [user?.id, loadBalances]
  );

  useMasterBusChannel({
    channelName: user?.id ? `cashier-realtime-wallets-${user.id}` : null,
    table: 'wallets',
    filter: user?.id ? `user_id=eq.${user.id}` : null,
    event: '*',
    onPayload: handleWalletUpdate,
    enabled: !!user?.id,
    // Without this a dead wallets/cashouts channel was completely silent: the
    // page has a degraded-connection banner and a realtimeStatus state, but
    // only the chip_transactions channel ever drove them. Balances could go
    // stale with the UI still claiming a live connection.
    onSubscriptionError: () => {
      if (isMounted.current) setRealtimeStatus('error');
    },
  });

  // Wallet transactions channel — DISABLED (Phase 2 cost cut).
  // wallet_transactions is being dropped from supabase_realtime to save egress.
  // The page already refreshes on the canonical balance events via
  // useMasterBusSubscriptions below (BALANCE_UPDATED, CHIPS_ADDED,
  // CHIPS_WITHDRAWN, CASHIER_BALANCE_CHANGED, RAKEBACK_CLAIMED,
  // DAILY_REWARD_CLAIMED). The `cashout_requests` subscription still covers
  // pending-cashout state which is the cashier's primary action surface.

  // Cashout requests channel
  const handleCashoutUpdate = useCallback(() => {
    loadPendingCashouts();
  }, [loadPendingCashouts]);

  useMasterBusChannel({
    channelName: user?.id ? `cashier-realtime-cashouts-${user.id}` : null,
    table: 'cashout_requests',
    filter: user?.id ? `player_id=eq.${user.id}` : null,
    event: '*',
    onPayload: handleCashoutUpdate,
    enabled: !!user?.id,
    // Without this a dead wallets/cashouts channel was completely silent: the
    // page has a degraded-connection banner and a realtimeStatus state, but
    // only the chip_transactions channel ever drove them. Balances could go
    // stale with the UI still claiming a live connection.
    onSubscriptionError: () => {
      if (isMounted.current) setRealtimeStatus('error');
    },
  });

  // ── Bus Listeners: instant balance refresh from engine events ──
  // Load balances only
  useMasterBusSubscriptions(
    [
      'BALANCE_UPDATED',
      'CHIPS_ADDED',
      'CASHIER_BALANCE_CHANGED',
      'RAKEBACK_CLAIMED',
      'DAILY_REWARD_CLAIMED',
    ],
    () => {
      if (user?.id) loadBalances(user.id, { force: true });
    },
    { debounce: 500 }
  );

  // Refresh history after ledger changes or financial snapshot invalidations.
  useMasterBusSubscriptions(
    [
      'TRANSACTION_LOGGED',
      'BALANCE_UPDATED',
      'CHIPS_ADDED',
      'CASHIER_BALANCE_CHANGED',
      'RAKEBACK_CLAIMED',
      'DAILY_REWARD_CLAIMED',
      'WALLET_REFRESHED',
      'CHIPS_DISTRIBUTED',
      'CASHOUT_CANCELLED',
      'CASHOUT_APPROVED',
    ],
    () => {
      loadTransactions({ force: true });
    },
    { debounce: 1000 }
  );

  // Load balances and pending cashouts
  useMasterBusSubscriptions(
    ['WALLET_REFRESHED', 'CHIPS_DISTRIBUTED', 'CASHOUT_CANCELLED', 'CASHOUT_APPROVED'],
    () => {
      if (user?.id) {
        loadBalances(user.id);
        loadPendingCashouts();
      }
    },
    { debounce: 500 }
  );

  // Load pending cashouts only
  useMasterBusSubscription(
    'CASHOUT_REQUESTED',
    () => {
      if (user?.id) loadPendingCashouts();
    },
    { debounce: 500 }
  );

  // Load balances and transactions (HAND_COMPLETED debounces at 1000ms, others at 500ms)
  useMasterBusSubscription(
    'HAND_COMPLETED',
    () => {
      if (user?.id) {
        loadBalances(user.id);
        loadTransactions({ force: true });
      }
    },
    { debounce: 1000 }
  );

  useMasterBusSubscriptions(
    ['SETTLEMENT_COMPLETED', 'COMMISSION_PAID'],
    () => {
      if (user?.id) {
        loadBalances(user.id);
        loadTransactions({ force: true });
      }
    },
    { debounce: 500 }
  );

  // Supabase Realtime channel for chip_transactions (cross-device sync)
  //
  // Registered with a FACTORY. Previously this called getOrCreateChannel and
  // subscribed directly, with no registerChannelFactory. MasterBus's 30s health
  // monitor takes the no-factory branch for such a channel and simply removes
  // it ("No factory for ... -- removed only"), which also aborts Supabase's own
  // auto-rejoin. The effect deps never change, so nothing rebuilt it: one
  // transient error and cross-device chip sync was dead for the whole session.
  //
  // The subscribe callback also had no 'CLOSED' case, and removeChannel drives
  // the channel to CLOSED rather than CHANNEL_ERROR — so realtimeStatus stayed
  // 'connected' and the degraded-connection banner never appeared. On a money
  // screen that means a stale balance presented as live.
  useEffect(() => {
    if (!user?.id) return;
    const key = `cashier-chip-txns-${user.id}`;
    const onRowChange = () => {
      loadBalances(user.id);
      loadTransactions({ force: true });
    };
    const subscribeChannel = () =>
      masterBus
        .getOrCreateChannel(key)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'chip_transactions',
            filter: `from_user_id=eq.${user.id}`,
          },
          onRowChange
        )
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'chip_transactions',
            filter: `to_user_id=eq.${user.id}`,
          },
          onRowChange
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'SUBSCRIBED') {
            if (isMounted.current) setRealtimeStatus('connected');
          }
          if (status === 'CHANNEL_ERROR') {
            if (err) reportError(err?.message || err, 'CashierPage._Realtime_channel_error');
            if (isMounted.current) setRealtimeStatus('error');
          }
          if (status === 'CLOSED') {
            if (isMounted.current) setRealtimeStatus('error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[CashierPage] Realtime channel timed out');
            if (isMounted.current) setRealtimeStatus('reconnecting');
          }
        });

    // Factory FIRST, so a channel that dies on its very first subscribe can
    // still be recovered by the health monitor.
    masterBus.registerChannelFactory(key, subscribeChannel);
    subscribeChannel();
    return () => {
      masterBus.removeChannelFactory(key);
      masterBus.removeRegisteredChannel(key);
    };
  }, [user?.id, loadBalances, loadTransactions]);

  // ─────────────────────────────────────────────────────────────────────────────
  // DETERMINE AVAILABLE TABS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * co_owner and admin were MISSING from this list while being present in
   * every other rule around it: loadRecipients hands them the whole club
   * (isClubStaff), the Financial quick links render on `canSend`, and
   * fn_agent_wallet_send admits both roles outright. So two roles were given a
   * recipient list, a funded agent wallet and a server that would accept the
   * send, and no Send tab to do it from. Asked through the one helper that
   * knows what "runs the club" means, exactly as canMint already does.
   */
  const canSend = isClubStaff(userRole) || isAgentRole(userRole) || isUnionOwner;
  // Mirrors fn_mint_chips_from_diamonds: a STANDALONE club's owner, co-owner
  // or admin, or a union owner minting into the union bank. co_owner and admin
  // were missing here while the RPC has always admitted them, so two roles saw
  // no Mint tab on a club they are entitled to mint for. (Dan 2026-08-23.)
  const canMint = (!isInUnion && ['owner', 'co_owner', 'admin'].includes(userRole)) || isUnionOwner;

  // The Club Bank row routes here, and it renders for owner / co_owner / admin
  // / super_agent — so all four must have the tab, or the row would open a tab
  // that does not exist and the clamp below would bounce them elsewhere.
  const canDistribute =
    ['owner', 'co_owner', 'admin', 'super_agent', 'agent'].includes(userRole) || isUnionOwner;

  const tabs = useMemo(() => {
    const t: CashierAction[] = [];
    if (canSend) t.push('send');
    if (canDistribute) t.push('distribute');
    t.push('buyin', 'cashout');
    if (canMint) t.push('mint');
    t.push('history');
    return t;
  }, [canSend, canDistribute, canMint]);

  // `action` defaults to 'send', but a plain player has no Send tab. Left
  // unclamped the tablist had no selected tab (every roving tabindex was -1,
  // so Tab could not reach it) and the Send panel rendered for someone with
  // no permission to use it and an always-empty recipient list.
  // Gated on loadingContext: userRole starts at 'member', so for the first
  // moments of every visit `tabs` is the player set. Clamping during that
  // window moved an owner off Send onto Buy-In and left them there once the
  // real role arrived. Only correct an impossible tab once the role is known.
  useEffect(() => {
    if (loadingContext) return;
    if (tabs.length > 0 && !tabs.includes(action)) setAction(tabs[0]);
  }, [tabs, action, loadingContext]);

  const tabLabels: Record<CashierAction, string> = {
    send: 'Send',
    distribute: 'Distribute',
    buyin: 'Buy-In',
    cashout: 'Cash-Out',
    mint: 'Mint',
    history: 'History',
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // HANDLE ACTIONS
  // ─────────────────────────────────────────────────────────────────────────────

  // Helper to notify the parent World Hub and the local Master Bus of a balance change
  const notifyWalletChange = (targetUserId: string, chipAmount: number) => {
    try {
      // 1. Notify local React app via MasterBus for instant sync
      // NOTE: Do not pass stale balance values here — the receiver should
      // re-query from Supabase to get the latest actual balance
      masterBus.emit('WALLET_REFRESHED', {
        walletType: 'PLAYER',
        available: 0,
        total: 0,
      });

      // 2. Emit balance updated event (handled by MasterBus)
      masterBus.emit('BALANCE_UPDATED', {
        source: 'cashier',
        userId: targetUserId,
        amount: chipAmount,
      });
    } catch (e) {
      reportError(e, 'CashierPage.Failed_to_notify_of_wallet_change');
    }
  };

  const selectedRecipientData = useMemo(() => {
    return recipients.find((r) => r.id === selectedRecipient);
  }, [recipients, selectedRecipient]);

  // ── Keyboard navigation for tabs (Arrow Left/Right) ──
  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const idx = tabs.indexOf(action);
        const next =
          e.key === 'ArrowRight'
            ? tabs[(idx + 1) % tabs.length]
            : tabs[(idx - 1 + tabs.length) % tabs.length];
        setAction(next);
        setMessage(null);
        // Focus the new tab button
        const btn = document.querySelector(
          `[aria-controls="cashier-panel-${next}"]`
        ) as HTMLElement;
        btn?.focus();
      }
    },
    [tabs, action]
  );

  const handleAction = async (override?: { value?: number; recipientId?: string }) => {
    // Chips are whole units. `parseFloat` alone accepted 0.5 and 1e9: the
    // per-club ledger column is an integer, so a fractional amount is rounded
    // on write while the sending side is debited the exact decimal — money
    // created or destroyed by rounding. Reject anything that is not a
    // positive whole number up front.
    const parsed = parseChipAmount(override?.value !== undefined ? String(override.value) : amount);
    if (!parsed.ok) {
      setMessage({ type: 'error', text: parsed.error });
      return;
    }
    const value = parsed.value;
    // The confirmation modal captured what the user agreed to; use that rather
    // than re-reading live state that a realtime refresh may have changed.
    const recipientIdForAction = override?.recipientId ?? selectedRecipient;
    if (!user?.id) return;

    // Rate limit: block rapid successive actions (2s minimum)
    const now = Date.now();
    if (now - lastActionRef.current < RATE_LIMIT_MS) {
      setMessage({ type: 'error', text: 'Please wait before submitting another action' });
      return;
    }

    setIsProcessing(true);
    setMessage(null);

    // SETTLEMENT FREEZE CHECK — Block all chip movements during settlement
    if (clubId) {
      try {
        const lockResult = await checkSettlementLock(clubId);
        if (lockResult.locked) {
          if (isMounted.current)
            setMessage({
              type: 'error',
              text: `Chip movements are frozen during settlement (${lockResult.reason || 'Monday 4AM payout in progress'}). Please try again after settlement completes.`,
            });
          if (isMounted.current) setIsProcessing(false);
          return;
        }
      } catch (e) {
        reportError(e, 'CashierPage');
        // Non-blocking: if settlement check fails, allow the action to proceed
      }
    }

    try {
      if (action === 'send') {
        // ─── SEND CHIPS ───
        if (!recipientIdForAction) {
          if (isMounted.current) setMessage({ type: 'error', text: 'Please select a recipient' });
          if (isMounted.current) setIsProcessing(false);
          return;
        }
        // Stamp the rate limiter only once the submission is actually valid,
        // so a rejected attempt does not lock out the corrected retry.
        lastActionRef.current = now;

        const recipient = recipients.find((r) => r.id === recipientIdForAction);

        /**
         * ── SENDS COME OUT OF THE AGENT WALLET (Dan 2026-08-25, binding) ────
         *
         * "Any chips sent or claimed back transact from the Agent Wallet."
         *
         * This branch used to be a THIRD money path, and not one that obeyed
         * that sentence:
         *
         *   - it checked `balances.PLAYER.available`, the viewer's GLOBAL
         *     wallet, which has nothing to do with this club's chips;
         *   - ChipFlowService.agentToPlayer moved the agent's own PLAYER
         *     wallet, not agents.agent_wallet_balance (its own doc comment says
         *     so: "from their own PLAYER wallet");
         *   - ChipFlowService.clubToAgent moved the OWNER'S personal wallet,
         *     not clubs.chip_treasury, despite being named for the club bank;
         *   - none of the three carried an idempotency key, so a response lost
         *     on the way back was indistinguishable from a send that never
         *     happened, and the obvious retry sent a second time;
         *   - none of them asked whether the recipient was in the caller's
         *     downline, so the only scoping was the (broken) recipient list.
         *
         * It is now the same one call the Trade grid and the Wallet Cashier
         * make: fn_agent_wallet_send. One transaction, one chip_transactions
         * row, one op_id, a downline check before any money moves, and a ten
         * minute clawback window the Claim Back surfaces can act on.
         *
         * `p_destination` follows the RECIPIENT's role - chips to an agent land
         * in the float they distribute from, chips to a player land in the
         * balance they buy in with - and the database derives it again from the
         * recipient regardless of what is sent here.
         */
        if (myAgentWallet !== null && myAgentWallet < value) {
          if (isMounted.current)
            setMessage({
              type: 'error',
              text: `Insufficient chips in your agent wallet. Available: ${myAgentWallet.toLocaleString()}`,
            });
          if (isMounted.current) setIsProcessing(false);
          return;
        }

        const resolvedForTransfer = (await resolveClubUUID(clubId!)) || clubId!;
        const { data: sendData, error: sendError } = await supabase.rpc('fn_agent_wallet_send', {
          p_club_id: resolvedForTransfer,
          p_to_user_id: recipientIdForAction,
          p_amount: value,
          p_destination: canHoldAgentWallet(recipient?.role) ? 'agent_wallet' : 'player_wallet',
          p_reason: `Cashier Send To ${recipient?.username || 'Member'}`,
          // Per-INTENT key (see sendOpIdRef). A key minted inside the call
          // protects nothing: the dangerous shape is commit + lost response +
          // user retry, and that retry must present the SAME key so the
          // server replays instead of debiting again. The 30-line note above
          // this call claimed that was already true. It was not.
          p_op_id: sendOpIdRef.current,
        });
        if (sendError) throw sendError;
        const sendRes = (Array.isArray(sendData) ? sendData[0] : sendData) as {
          success?: boolean;
          error?: string;
          replayed?: boolean;
        } | null;
        // The RPC reports a refusal as { success: false, error }. The old path
        // had no result check at all, so a refusal printed "Sent 500 chips".
        if (!sendRes?.success) {
          throw new Error(sendRes?.error || 'The Cashier Refused That Send');
        }

        if (isMounted.current)
          setMessage({
            type: 'success',
            text: sendRes.replayed
              ? `That send had already gone through. ${value.toLocaleString()} chips are with ${recipient?.username || 'them'}`
              : `Sent ${value.toLocaleString()} chips to ${recipient?.username || 'them'} from your agent wallet`,
          });
        loadBalances(user.id);
        loadUserContext(); // the agent wallet figure on screen just changed
        loadRecipients(true); // Force refresh — a send just changed recipient balances; skip the 60s cache
        setSelectedRecipient('');
        notifyWalletChange(user.id, value);
        notifyWalletChange(recipientIdForAction, value);
      } else if (action === 'mint') {
        // ─── MINT CHIPS ───
        lastActionRef.current = now;
        const mintResult = await mintChips(clubId!, value);
        if (!mintResult.success) {
          // The store catches everything and returns success:false, so the
          // real reason ("Minting is locked for clubs in a union — only the
          // Union owner can mint", auth errors, economy caps) was replaced by
          // "try again", which is the wrong advice for a union-locked club.
          if (isMounted.current)
            setMessage({
              type: 'error',
              text: safeErrorMessage(mintResult.error, 'Minting failed. Please try again.'),
            });
          if (isMounted.current) setIsProcessing(false);
          return;
        }
        // chip_ledger narration REMOVED (2026-08-15): chip_ledger is the
        // legacy ledger and is now server-owned (client INSERT revoked, the
        // open forge policy dropped). mintChips' server RPC writes the
        // authoritative wallet_transactions row; a client-authored audit row
        // was forgeable narration, not a record.

        if (isMounted.current)
          setMessage({ type: 'success', text: `Minted ${value.toLocaleString()} chips` });
        loadBalances(user.id);
        notifyWalletChange(user.id, value);
      } else if (action === 'buyin') {
        // ─── TABLE BUY-IN ───
        // AUDIT P1-2 FIX: This Cashier action previously called lockForBuyIn
        // (WalletService → atomic_deduct_wallet_and_log, a REAL wallet debit)
        // and then merely navigated to the table — it never called
        // atomic_table_buyin, never inserted a table_seats row, and never
        // notified the engine. That debited the wallet with no corresponding
        // stack anywhere (orphaned debit) and forced the player to buy in a
        // SECOND time via the in-table BuyInModal. The premature debit and its
        // (misleading) chip_ledger write are removed: NO money moves in the
        // Cashier. The player is routed to the table, where the authoritative
        // in-table buy-in RPC (atomic_table_buyin) is the single point at which
        // funds move and a seat is atomically created.
        if (!tableId) {
          if (isMounted.current)
            setMessage({ type: 'error', text: 'No table selected for buy-in.' });
          if (isMounted.current) setIsProcessing(false);
          return;
        }
        navigate(`/table/${tableId}`);
      } else if (action === 'cashout') {
        // ─── CASH OUT ───
        // BUG-02 FIX: Two distinct flows:
        // 1) If at a table (tableId present) → unlock chips from table
        // 2) If no table → request-cashout API (escrow → agent approval)

        if (tableId) {
          // AUDIT M17: the Cashier used to move this money itself — it called
          // unlockFromTable with the amount the PLAYER TYPED, which credited the
          // wallet through a generic credit RPC with no offsetting debit
          // anywhere. There is no seat-stack decrement on that path at all; the
          // store only adjusted `locked` optimistically, client-side. It was
          // inert solely because RLS refused the credit, and it would have
          // become an unlimited mint the moment anyone widened that grant.
          //
          // This now mirrors the 'buyin' branch above exactly, and for the same
          // reason: NO money moves in the Cashier. The player is routed to the
          // table. CHIP CONTINUITY (2026-09-04): there is no partial cash-out
          // at a cash table any more - chips come off the felt only when the
          // player leaves, through the engine's leave path (which may hold
          // them for the stay clock). The only honest copy is "leave to cash
          // out".
          if (isMounted.current)
            setMessage({
              type: 'info',
              text: 'Leave The Table To Cash Out - Taking You There Now.',
            });
          navigate(`/table/${tableId}`);
        } else {
          // Standard cashout: request-cashout API (escrow → agent approval)
          // U-03 FIX: Confirmation for high-value cashouts
          if (value >= 10000) {
            // High-value cashout: show confirmation modal instead of blocking confirm()
            setCashoutConfirm({ show: true, value });
            if (isMounted.current) setIsProcessing(false);
            return;
          }

          // Cashout debits club_members.chip_balance for THIS club
          // (fn_request_cashout), so it must be checked against the per-club
          // figure. balances.PLAYER.available is the GLOBAL wallet — using it
          // here let a player request a cashout the server always rejects, and
          // blocked one it would have allowed. Send is deliberately left on the
          // global figure because atomic_chip_transfer really does debit that.
          if (myClubChips === null) {
            if (isMounted.current)
              setMessage({ type: 'error', text: 'Still loading your club balance - try again.' });
            if (isMounted.current) setIsProcessing(false);
            return;
          }
          if (myClubChips < value) {
            if (isMounted.current)
              setMessage({
                type: 'error',
                text: `Insufficient chips in this club. Available: ${myClubChips.toLocaleString()}`,
              });
            if (isMounted.current) setIsProcessing(false);
            return;
          }

          // Stamp the rate limiter for this money action too. Moving the stamp
          // out of the top of handleAction (so a rejected submit no longer
          // locked out the retry) left cashout — the one path that actually
          // moves money from here — with no 2s throttle at all.
          lastActionRef.current = now;

          // Call CashoutService directly for unified audit logging, notifications, and DB RPC logic
          let cashoutFailed = false;
          try {
            if (!clubId) throw new Error('Club ID is missing');
            await cashoutService.requestCashout(
              user.id,
              clubId!,
              value,
              undefined,
              cashoutOpIdRef.current
            );
            if (isMounted.current)
              setMessage({
                type: 'success',
                text: `Cashout request submitted! ${value.toLocaleString()} chips are now held in escrow. Your agent will review shortly.`,
              });
            loadBalances(user.id);
            loadPendingCashouts();
            notifyWalletChange(user.id, value);
          } catch (err: unknown) {
            cashoutFailed = true;
            if (isMounted.current)
              setMessage({
                type: 'error',
                text:
                  (err instanceof Error ? err.message : String(err)) || 'Cashout request failed.',
              });
          }
          // A failed cashout used to fall through to the blanket setAmount('')
          // below, wiping what the user typed while showing them an error they
          // are meant to retry.
          if (cashoutFailed) {
            if (isMounted.current) setIsProcessing(false);
            return;
          }
        }
      }
      setAmount('');
    } catch (error: unknown) {
      if (isMounted.current)
        setMessage({
          type: 'error',
          text:
            (error instanceof Error ? error.message : String(error)) ||
            'Transaction failed. Please try again.',
        });
    }
    if (isMounted.current) setIsProcessing(false);
    startCooldown(); // Rate limit
  };

  // Process high-value cashout after ConfirmModal approval
  const processHighValueCashout = async (value: number) => {
    if (!user?.id) return;
    // 2026-08-27: this path had no double-submit guard. setIsProcessing is
    // React state and applies after a render, so two taps on the confirm
    // modal inside one frame both reached the RPC (with, before today, two
    // different op ids). Same 2s ref limiter the non-modal cashout path
    // already stamps.
    const nowHV = Date.now();
    if (nowHV - lastActionRef.current < 2000) return;
    lastActionRef.current = nowHV;
    setCashoutConfirm({ show: false, value: 0 });
    setIsProcessing(true);
    try {
      // Per-club figure: this is the high-value cashout path and the server
      // debits club_members.chip_balance.
      if (myClubChips !== null && myClubChips < value) {
        if (isMounted.current)
          setMessage({
            type: 'error',
            text: `Insufficient chips in this club. Available: ${myClubChips.toLocaleString()}`,
          });
        if (isMounted.current) setIsProcessing(false);
        return;
      }
      if (!clubId) {
        if (isMounted.current) setMessage({ type: 'error', text: 'Club ID is missing' });
        if (isMounted.current) setIsProcessing(false);
        return;
      }

      // Use CashoutService directly (same as normal cashout path) — no World Hub API dependency
      await cashoutService.requestCashout(
        user.id,
        clubId,
        value,
        undefined,
        cashoutOpIdRef.current
      );
      if (isMounted.current)
        setMessage({
          type: 'success',
          text: `Cashout request submitted! ${value.toLocaleString()} chips are now held in escrow. Your agent will review shortly.`,
        });
      loadBalances(user.id);
      loadPendingCashouts();
      notifyWalletChange(user.id, value);
      setAmount('');
    } catch (error: unknown) {
      if (isMounted.current)
        setMessage({
          type: 'error',
          text:
            (error instanceof Error ? error.message : String(error)) ||
            'Cashout failed. Please try again.',
        });
    }
    if (isMounted.current) setIsProcessing(false);
    startCooldown();
  };

  // Dan 2026-08-21, BINDING: "100 DIAMONDS EQUALS 10,000 CHIPS" — i.e. 1
  // diamond per 100 chips. Supersedes the old 38-per-100 rate, which made the
  // classic cashier quote a different price than the Chip Mint for the same
  // chips. Integer arithmetic kept so the quote can never drift by a cent.
  const DIAMOND_RATE_NUM = 1;
  const DIAMOND_RATE_DEN = 100;
  const preset = [100, 500, 1000, 5000];

  const filteredTransactions = useMemo(
    () =>
      txFilter === 'all'
        ? transactions
        : txFilter === 'credit'
          ? transactions.filter((t) => t.type === 'credit')
          : txFilter === 'debit'
            ? transactions.filter((t) => t.type === 'debit')
            : transactions.filter((t) => t.category === txFilter),
    [transactions, txFilter]
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // CSV EXPORT LOGIC
  // ─────────────────────────────────────────────────────────────────────────────
  /**
   * One CSV cell, quoted and de-weaponised.
   *
   * Only the description used to be quoted, and nothing was protected against
   * formula injection. Descriptions are partly attacker-controlled — they carry
   * usernames ("alice -> bob") and free-text transfer notes — so a value
   * beginning with = + - @ or a leading tab/CR is executed as a formula the
   * moment a club owner opens this audit trail in Excel or Sheets. Prefixing a
   * single quote is the standard neutralisation (OWASP CSV injection); it is
   * invisible in the spreadsheet and preserved in plain text.
   */
  const csvCell = (value: unknown): string => {
    let str = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
    return `"${str.replace(/"/g, '""')}"`;
  };

  const exportCSV = () => {
    if (filteredTransactions.length === 0) {
      // The History panel renders no {message} block, so this error was
      // invisible — Export on an empty filter looked like a dead button.
      setMessage({ type: 'error', text: 'No transactions to export' });
      toast.info('No transactions to export');
      return;
    }

    const headers = ['Date', 'Time', 'Type', 'Category', 'Amount', 'Wallet', 'Description'];
    const rows = filteredTransactions.map((tx) => {
      const date = new Date(tx.created_at).toLocaleDateString();
      const time = new Date(tx.created_at).toLocaleTimeString();
      const typeText = tx.type === 'credit' ? 'Credit' : 'Debit';
      const categoryText =
        CATEGORY_LABELS[tx.category] ||
        (tx.category || tx.type || '').replace(/_/g, ' ').toUpperCase();

      return [date, time, typeText, categoryText, tx.amount, tx.wallet_type, tx.description || '']
        .map(csvCell)
        .join(',');
    });

    // CRLF per RFC 4180, and a BOM so Excel reads it as UTF-8 instead of
    // mangling every non-ASCII username in the audit trail.
    const csvContent = '\uFEFF' + [headers.map(csvCell).join(','), ...rows].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute(
      'download',
      `audit_trail_${txFilter}_${new Date().toISOString().split('T')[0]}.csv`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Prevent blob URL memory leak — release after download triggers
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────

  // No club in the URL: either we are still resolving one to redirect to, or
  // the user genuinely has no club. Previously this state fell through to the
  // main render, where every data effect had bailed and the skeleton never
  // cleared — an permanent loading page reachable from the table menu.
  if (!clubId) {
    return (
      <StandardContentLayout className={styles.page} title="Cashier">
        <CashierConsoleSurface
          eyebrow="Club Arena Cashier"
          title="Cashier"
          subtitle="Club Wallet Access"
          pill={hasNoClubs ? 'No Club' : 'Loading'}
          pillInk={hasNoClubs ? 'red' : 'gold'}
          crest="diamond"
          className={styles.console}
        >
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>
              <span className={styles.cardTitleIcon}>◆</span>Cashier
            </h2>
            <div className={styles.cardBody}>
              {hasNoClubs ? (
                <>
                  <div className={`${styles.message} ${styles.messageInfo}`}>
                    The Cashier Belongs To A Club - Chips Are Held Per Club, So There Is No Cashier
                    Until You Join One.
                  </div>
                  <button type="button" className={styles.btnPrimary} onClick={() => navigate('/')}>
                    Find A Club
                  </button>
                </>
              ) : (
                <div className={styles.loadingSkeleton} aria-busy="true">
                  <div className={styles.skeletonBar} style={{ width: '45%', height: '14px' }} />
                  <div className={styles.skeletonBar} style={{ width: '100%', height: '44px' }} />
                </div>
              )}
            </div>
          </section>
        </CashierConsoleSurface>
      </StandardContentLayout>
    );
  }

  return (
    <StandardContentLayout className={styles.page}>
      {/* ── Wallet Display — a separate approved master, never nested in the console. ── */}
      {user?.id && clubId && (
        <div className={styles.walletHeader}>
          <DynamicWallet
            userId={user.id}
            clubId={clubId}
            /**
             * WALLET SEPARATION LAW (Dan 2026-08-20). This is the CLUB
             * cashier — the screen for moving THIS club's chips. It used to
             * flip to the union panel whenever the viewer happened to own the
             * union, replacing Club Bank with Union Bank on the very screen
             * where a mint or a payout is authorised. Owning the union does
             * not make its treasury this club's balance. Union funds are
             * managed on the union's own surfaces; never here.
             */
            variant="club"
            // Dan 2026-08-23: which rows exist is the viewer's role, not a
            // second variant. A player sees one wallet here, an agent three,
            // and only owner/co-owner/admin/super agent see the Club Bank.
            role={userRole}
            // userRole starts at 'member' and hydrates from club_members. Until
            // it lands, normaliseRole reads it as 'player' and the panel would
            // show one row and then pop three more in underneath. The skeleton
            // holds instead.
            roleReady={!loadingContext}
            onBuyDiamonds={() => navigate(withClubContext('/vip', clubId))}
            // Dan 2026-08-23: clicking Club Bank opens the Club Bank Cashier.
            // It opens the SAME modal here as it does in the lobby - an earlier
            // version routed to this page's own distribute tab, which meant the
            // row's own hint ("Tap For The Club Bank Cashier") described
            // something that did not happen.
            onOpenPlayerWallet={() => setShowPlayerWallet(true)}
            onOpenPromoWallet={() => setActiveCashier('promo_wallet')}
            onOpenAgentWallet={() => setActiveCashier('agent_wallet')}
            onOpenClubBank={() => setActiveCashier('club_bank')}
            onOpenBBJ={() => clubId && navigate(`/clubs/${clubId}/jackpot`)}
          />
          {/* "Get Chips" (diamonds -> chips) REMOVED 2026-08-19.
              Chips can NEVER be bought with diamonds — product rule, Dan.
              Diamonds are the global purchasable currency; chips are per-club
              gambling balance and the two must never convert. The endpoint now
              returns 410 and the underlying RPCs have EXECUTE revoked from
              every application role, so this was the last of three layers.
              Do not reinstate without an explicit product decision. */}
        </div>
      )}

      {/* Club Bank Cashier — the same modal the lobby opens. Role-gated inside,
          and gated again by fn_can_use_club_bank on every read and write. */}
      {clubId && (
        <>
          <WalletCashierModal
            isOpen={!!activeCashier}
            onClose={() => setActiveCashier(null)}
            clubId={clubId}
            role={userRole}
            walletType={activeCashier || DEFAULT_CASHIER_WALLET}
          />
          <PlayerWalletModal
            isOpen={showPlayerWallet}
            onClose={() => setShowPlayerWallet(false)}
            clubId={clubId}
          />
        </>
      )}

      <CashierConsoleSurface
        eyebrow="Club Arena Cashier"
        title="Cashier"
        subtitle={clubName || 'Club Wallet'}
        pill={realtimeStatus === 'connected' ? 'Live' : 'Syncing'}
        pillInk={realtimeStatus === 'connected' ? 'green' : 'gold'}
        crest="diamond"
        className={styles.console}
      >
        {/* Loading context skeleton — shown INSIDE content area, NOT blocking tabs/nav */}

        {/* ── Club context bar — which club's cashier, with multi-club switcher ── */}
        {clubId && <CashierClubSwitcher clubId={clubId} clubName={clubName} />}

        {/* Action Tabs */}
        {/* Connection status indicator */}
        {realtimeStatus !== 'connected' && (
          <div className={styles.connectionBanner} role="status" aria-live="polite">
            {realtimeStatus === 'reconnecting' ? (
              <>
                <span className={styles.connectionDot} style={{ background: '#6fdcff' }} />{' '}
                Reconnecting To Live Updates…
              </>
            ) : (
              <>
                <span className={styles.connectionDot} style={{ background: '#ef4444' }} /> Live
                Connection Lost - Data May Be Stale
              </>
            )}
          </div>
        )}

        <nav
          className={styles.tabNav}
          role="tablist"
          aria-label="Cashier Actions"
          onKeyDown={handleTabKeyDown}
        >
          {tabs.map((act) => (
            <button
              key={act}
              role="tab"
              tabIndex={action === act ? 0 : -1}
              aria-selected={action === act}
              aria-controls={`cashier-panel-${act}`}
              className={`${styles.tab} ${action === act ? styles.tabActive : ''}`}
              onClick={() => {
                setAction(act);
                setMessage(null);
              }}
            >
              {tabLabels[act]}
            </button>
          ))}
        </nav>

        {/* Financial Quick Links — visible to owners/admins/agents */}
        {canSend && clubId && (
          <div className={styles.quickLinks}>
            {/* These were raw <a href="/clubs/..."> tags. The app mounts under
              basename="/hub/club-arena" (main.tsx), and a plain href is NOT
              basename-aware — so every one of them resolved to
              smarter.poker/clubs/<id>/disputes, a path that does not exist.
              All three chips were dead links to routes that were present and
              working the whole time.
              react-router's navigate() applies the basename, and it keeps the
              SPA mounted instead of triggering a full document load that drops
              the realtime subscriptions this page opens. Same pattern already
              used for the jackpot link above. */}
            <button
              type="button"
              onClick={() => clubId && navigate(`/clubs/${clubId}/disputes`)}
              className={`${styles.quickLink} ${styles.quickLinkWarning}`}
            >
              Disputes
            </button>
            <button
              type="button"
              onClick={() => navigate('/financial-alerts')}
              className={`${styles.quickLink} ${styles.quickLinkDanger}`}
            >
              Alerts
            </button>
            <button
              type="button"
              onClick={() => clubId && navigate(`/clubs/${clubId}/financials`)}
              className={`${styles.quickLink} ${styles.quickLinkPrimary}`}
            >
              Financials
            </button>
          </div>
        )}

        {/* Agent Promo Panel — visible to agents only */}
        {(userRole === 'agent' || userRole === 'super_agent' || userRole === 'sub_agent') &&
          clubId &&
          user?.id && (
            <AgentPromoPanel
              clubId={clubId}
              userId={user.id}
              role={userRole}
              onDistribute={() => loadBalances(user.id)}
            />
          )}

        {/* Context Loading Skeleton — shown inside content while role/union data loads */}
        {loadingContext && (
          <div className={styles.card} aria-busy="true">
            <div className={styles.loadingSkeleton}>
              <div className={styles.skeletonBar} style={{ width: '45%', height: '14px' }} />
              <div className={styles.skeletonBar} style={{ width: '70%', height: '44px' }} />
              <div className={styles.skeletonBar} style={{ width: '100%', height: '44px' }} />
              <div className={styles.skeletonBar} style={{ width: '100%', height: '48px' }} />
            </div>
          </div>
        )}

        {/* ═══ SEND CHIPS ═══ */}
        {/* `canSend` guard added: `action` defaults to 'send', so a plain player
          — who has no Send tab at all — was shown a fully rendered Send Chips
          panel with a permanently empty recipient dropdown. */}
        {action === 'send' && canSend && (
          <section className={styles.card} id="cashier-panel-send" role="tabpanel">
            <h2 className={styles.cardTitle}>
              <span className={styles.cardTitleIcon}>↗</span>Send Chips
            </h2>
            <div className={styles.cardBody}>
              {/* Names the ACCOUNT and the SCOPE, both of which this line used to
                get wrong: it said "your wallet" (it is the agent wallet) and it
                described the recipients by role when the real rule is the
                downline. Staff see everyone; the three agent roles see their
                downline and their downline agents' downlines, nobody else. */}
              <div className={`${styles.message} ${styles.messageInfo}`}>
                Send Chips From Your Agent Wallet To{' '}
                {isClubStaff(userRole) || isUnionOwner
                  ? 'Anyone In This Club'
                  : 'Your Downline, And Their Downlines'}
                . You Can Claim A Send Back For Ten Minutes.
              </div>

              {/* Recipient Select */}
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>SEND TO:</label>
                <input
                  type="text"
                  placeholder="Search Member, Role Or (You)..."
                  className={styles.input}
                  style={{ marginBottom: '8px' }}
                  value={recipientSearch}
                  onChange={(e) => setRecipientSearch(e.target.value)}
                  aria-label="Search Recipients"
                />
                {loadingRecipients ? (
                  <div className={styles.recipientSkeleton} aria-busy="true">
                    <div className={styles.recipientSkeletonBar} />
                  </div>
                ) : (
                  <select
                    className={styles.select}
                    value={selectedRecipient}
                    onChange={(e) => setSelectedRecipient(e.target.value)}
                  >
                    <option value="">Select Recipient</option>
                    {filteredRecipients.map((r) => {
                      const isSelf = r.id === user?.id;
                      const isAgent = ['agent', 'super_agent', 'sub_agent'].includes(r.role);
                      const roleTag =
                        r.role === 'owner'
                          ? 'OWNER'
                          : r.role === 'co_owner'
                            ? 'CO-OWNER'
                            : r.role === 'admin'
                              ? 'ADMIN'
                              : r.role === 'super_agent'
                                ? 'SA'
                                : r.role === 'agent'
                                  ? 'AGT'
                                  : r.role === 'sub_agent'
                                    ? 'SUB'
                                    : '';
                      const commInfo =
                        isAgent && r.commissionRate
                          ? ` ${(r.commissionRate * 100).toFixed(0)}%`
                          : '';
                      const typeInfo = isAgent ? (r.isPrepaid ? ' PP' : ' CR') : '';
                      return (
                        <option key={r.id} value={r.id}>
                          {isSelf ? '(YOU) ' : ''}
                          {roleTag ? `[${roleTag}${commInfo}${typeInfo}] ` : ''}
                          {r.username} (Bal: {r.balance.toLocaleString()})
                        </option>
                      );
                    })}
                  </select>
                )}
              </div>

              <div className={styles.formGroup}>
                <label className={styles.formLabel} htmlFor="cashier-send-amount">
                  AMOUNT:
                </label>
                <input
                  id="cashier-send-amount"
                  className={styles.input}
                  type="number"
                  placeholder="0"
                  value={amount}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAmount(e.target.value)}
                  min={1}
                  step={1}
                  max={MAX_CHIP_AMOUNT}
                  inputMode="numeric"
                />
              </div>

              {/* Quick amounts */}
              <div className={styles.presetGrid}>
                {preset.map((val) => (
                  <button
                    key={val}
                    className={styles.presetBtn}
                    onClick={() => setAmount(val.toString())}
                  >
                    {val.toLocaleString()}
                  </button>
                ))}
                {/* Max is the AGENT WALLET, because that is the account
                  fn_agent_wallet_send debits. It used to prefill the global
                  player wallet, which for most staff is a completely different
                  (usually larger) number, so Max produced an amount the server
                  refused every time. Disabled until the figure is known rather
                  than offering a confident 0. */}
                <button
                  className={styles.presetBtn}
                  disabled={myAgentWallet === null}
                  onClick={() => setAmount(String(Math.floor(myAgentWallet ?? 0)))}
                >
                  Max
                </button>
              </div>

              {/* Preview. The "before" figure is the AGENT WALLET, the account
                this send debits - it quoted the global player wallet, so the
                two lines described a movement between two accounts neither of
                which was involved. Suppressed entirely while the float is
                unknown rather than projecting a subtraction from nothing. */}
              {selectedRecipientData &&
                amount &&
                parseFloat(amount) > 0 &&
                myAgentWallet !== null && (
                  <div className={styles.transferPreview}>
                    <div className={styles.previewRow}>
                      <span>Your Agent Wallet</span>
                      <span>
                        {myAgentWallet.toLocaleString()} →{' '}
                        {Math.max(0, myAgentWallet - parseFloat(amount)).toLocaleString()}
                      </span>
                    </div>
                    <div className={styles.previewRow}>
                      <span>{selectedRecipientData.username}</span>
                      <span>
                        {selectedRecipientData.balance.toLocaleString()} →{' '}
                        {(selectedRecipientData.balance + parseFloat(amount)).toLocaleString()}
                      </span>
                    </div>
                    <div className={styles.previewRow}>
                      <span>Claim Back Window</span>
                      <span>Ten Minutes</span>
                    </div>
                  </div>
                )}

              {message && (
                <div
                  className={`${styles.message} ${message.type === 'success' ? styles.messageSuccess : message.type === 'error' ? styles.messageError : styles.messageInfo}`}
                >
                  {formatPopupText(message.text)}
                </div>
              )}

              <button
                className={styles.btnPrimary}
                aria-label={`Send ${amount || '0'} Chips To Selected Recipient`}
                onClick={() => {
                  const value = parseFloat(amount);
                  if (!isNaN(value) && value >= 10000 && selectedRecipientData) {
                    setSendConfirm({
                      show: true,
                      value,
                      recipientId: selectedRecipient,
                      recipientName: selectedRecipientData.username,
                    });
                  } else {
                    handleAction();
                  }
                }}
                disabled={isProcessing || cooldown > 0 || !amount || !selectedRecipient}
              >
                {isProcessing ? (
                  <>
                    <span className={styles.spinner} />
                    Processing...
                  </>
                ) : (
                  'CONFIRM SEND'
                )}
              </button>
            </div>
          </section>
        )}

        {/* ═══ DISTRIBUTE CHIPS ═══ */}
        {action === 'distribute' && canDistribute && (
          <section className={styles.card} id="cashier-panel-distribute" role="tabpanel">
            <h2 className={styles.cardTitle}>
              <span className={styles.cardTitleIcon}>↓</span>Distribute Chips
            </h2>
            <div className={styles.cardBody}>
              <div className={`${styles.message} ${styles.messageInfo}`}>
                {['owner', 'co_owner', 'admin', 'super_agent'].includes(userRole) || isUnionOwner
                  ? 'Distribute Chips Directly To Players Or Agents From The Club Bank. Each Distribution Is Logged With A Full Audit Trail.'
                  : 'Distribute Chips To Your Downline From Your Agent Wallet. Each Distribution Is Logged With A Full Audit Trail.'}
              </div>

              {/* Player Selector */}
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Recipient</label>
                <input
                  type="text"
                  placeholder="Search Member, Role Or (You)..."
                  className={styles.input}
                  style={{ marginBottom: '8px' }}
                  value={recipientSearch}
                  onChange={(e) => setRecipientSearch(e.target.value)}
                  aria-label="Search Distribute Recipients"
                />
                {loadingRecipients ? (
                  <div className={styles.recipientSkeleton} aria-busy="true">
                    <div className={styles.recipientSkeletonBar} />
                  </div>
                ) : (
                  <select
                    className={styles.select}
                    value={selectedRecipient}
                    onChange={(e) => setSelectedRecipient(e.target.value)}
                  >
                    <option value="">Select Player...</option>
                    {filteredRecipients.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.id === user?.id ? '(YOU) ' : ''}
                        {r.username} ({r.role}) - {r.balance.toLocaleString()} Chips
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Amount */}
              <div className={styles.formGroup}>
                <label className={styles.formLabel} htmlFor="cashier-distribute-amount">
                  Amount
                </label>
                <input
                  id="cashier-distribute-amount"
                  className={styles.input}
                  type="number"
                  placeholder="Enter Chip Amount"
                  value={amount}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAmount(e.target.value)}
                  min={1}
                  step={1}
                  max={MAX_CHIP_AMOUNT}
                  inputMode="numeric"
                />
              </div>

              {message && (
                <div
                  className={`${styles.message} ${message.type === 'success' ? styles.messageSuccess : message.type === 'error' ? styles.messageError : styles.messageInfo}`}
                >
                  {formatPopupText(message.text)}
                </div>
              )}

              {/* Execute Button */}
              <button
                className={styles.btnPrimary}
                disabled={isProcessing || cooldown > 0 || !selectedRecipient || !amount}
                onClick={async () => {
                  const parsed = parseChipAmount(amount);
                  if (!parsed.ok) {
                    setMessage({ type: 'error', text: parsed.error });
                    return;
                  }
                  const value = parsed.value;
                  if (!user?.id || !selectedRecipient) return;

                  // DISTRIBUTE RATE LIMIT — prevent rapid-fire distributions (10s cooldown)
                  const now = Date.now();
                  const elapsed = now - lastDistributeRef.current;
                  if (elapsed < DISTRIBUTE_RATE_LIMIT_MS) {
                    const waitSec = Math.ceil((DISTRIBUTE_RATE_LIMIT_MS - elapsed) / 1000);
                    setMessage({
                      type: 'error',
                      text: `Please wait ${waitSec}s before distributing again`,
                    });
                    return;
                  }

                  setIsProcessing(true);
                  setMessage(null);

                  // SETTLEMENT FREEZE CHECK — Block distributions during settlement
                  if (clubId) {
                    try {
                      const lockResult = await checkSettlementLock(clubId);
                      if (lockResult.locked) {
                        if (isMounted.current)
                          setMessage({
                            type: 'error',
                            text: `Chip movements are frozen during settlement (${lockResult.reason || 'settlement in progress'}). Please try again after settlement completes.`,
                          });
                        if (isMounted.current) setIsProcessing(false);
                        return;
                      }
                    } catch (e) {
                      reportError(e, 'CashierPage');
                      // Non-blocking: if settlement check fails, allow the action to proceed
                    }
                  }

                  try {
                    /**
                     * THE TAB NOW DOES WHAT ITS OWN COPY SAYS (audit 2026-08-27).
                     *
                     * The card reads "Distribute Chips ... From The Club Bank",
                     * but this called the distribute-promo World Hub route,
                     * whose RPC (transfer_promo_agent_to_player) debits
                     * club_members.promo_balance - a pool that is zero for
                     * every member in production and that nothing funds. The
                     * tab has NEVER moved a chip: zero ledger rows of that
                     * type exist.
                     *
                     * It now routes by the caller's role onto the two
                     * canonical RPCs. The four bank roles spend the CLUB BANK
                     * (fn_club_bank_send - self-send permitted there, which is
                     * how an owner funds their own float); an agent spends
                     * their AGENT WALLET (fn_agent_wallet_send, downline
                     * enforced server-side). Both derive the destination from
                     * the recipient's role and write one ledger row.
                     * promoOpIdRef is the page's per-INTENT key: held across a
                     * failed attempt, rotated when the inputs change.
                     */
                    const resolvedForDistribute =
                      (await resolveClubUUID(clubId || '')) || clubId || '';
                    const recipientRow = recipients.find((r) => r.id === selectedRecipient);
                    const viaClubBank =
                      ['owner', 'co_owner', 'admin', 'super_agent'].includes(userRole) ||
                      isUnionOwner;
                    const { data: distData, error: distError } = await supabase.rpc(
                      viaClubBank ? 'fn_club_bank_send' : 'fn_agent_wallet_send',
                      {
                        p_club_id: resolvedForDistribute,
                        p_to_user_id: selectedRecipient,
                        p_amount: value,
                        p_destination: canHoldAgentWallet(recipientRow?.role)
                          ? 'agent_wallet'
                          : 'player_wallet',
                        p_reason: viaClubBank
                          ? 'Distributed From The Club Bank'
                          : 'Distributed From The Agent Wallet',
                        p_op_id: promoOpIdRef.current,
                      }
                    );
                    if (distError) throw distError;
                    const distRes = (Array.isArray(distData) ? distData[0] : distData) as {
                      success?: boolean;
                      error?: string;
                    } | null;
                    if (!distRes?.success) {
                      throw new Error(distRes?.error || 'The Cashier Refused That Distribution');
                    }
                    const recipient = recipientRow;
                    if (isMounted.current)
                      setMessage({
                        type: 'success',
                        text: `Distributed ${value.toLocaleString()} chips to ${recipient?.username || 'player'}`,
                      });
                    masterBus.emit('CHIPS_DISTRIBUTED', {
                      clubId: clubId || '',
                      amount: value,
                      userId: selectedRecipient,
                    });

                    // chip_ledger narration REMOVED (2026-08-15): server-owned
                    // now; the distribution RPC writes wallet_transactions.
                    setAmount('');
                    setSelectedRecipient('');
                    loadBalances(user.id);
                    loadRecipients(true); // Force refresh — distribution just changed recipient balances
                    // Notify both sender and recipient for cross-page sync
                    notifyWalletChange(user.id, value);
                    notifyWalletChange(selectedRecipient, value);
                    startCooldown();
                    lastDistributeRef.current = Date.now();
                  } catch (err: unknown) {
                    const msg =
                      (err instanceof Error ? err.message : String(err)) || 'Distribution failed';
                    if (msg.includes('Rate limit')) {
                      if (isMounted.current)
                        setMessage({
                          type: 'error',
                          text: 'Too many distributions - please wait 60 seconds',
                        });
                    } else if (msg.includes('Insufficient promo')) {
                      if (isMounted.current)
                        setMessage({
                          type: 'error',
                          text: 'Insufficient promo balance for this distribution',
                        });
                    } else if (msg.includes('Player not found')) {
                      if (isMounted.current)
                        setMessage({ type: 'error', text: 'Player is not a member of this club' });
                    } else if (msg.includes('Agent not found')) {
                      if (isMounted.current)
                        setMessage({
                          type: 'error',
                          text: 'Your agent record was not found - contact club owner',
                        });
                    } else {
                      if (isMounted.current) setMessage({ type: 'error', text: msg });
                    }
                  } finally {
                    if (isMounted.current) setIsProcessing(false);
                  }
                }}
              >
                {isProcessing
                  ? 'Distributing...'
                  : cooldown > 0
                    ? `Wait ${cooldown}s`
                    : `Distribute ${amount ? parseFloat(amount).toLocaleString() : '0'} Chips`}
              </button>
            </div>
          </section>
        )}

        {/* ═══ BUY-IN / CASH-OUT / MINT ═══ */}
        {(action === 'buyin' || action === 'cashout' || action === 'mint') && (
          <section className={styles.card} id={`cashier-panel-${action}`} role="tabpanel">
            <h2 className={styles.cardTitle}>
              <span className={styles.cardTitleIcon}>
                {action === 'cashout' && cashoutConfirm.show
                  ? '◈'
                  : action === 'buyin'
                    ? '▶'
                    : action === 'cashout'
                      ? '◀'
                      : '◆'}
              </span>
              {action === 'cashout' && cashoutConfirm.show
                ? 'Escrow Verification'
                : action === 'buyin'
                  ? 'Table Buy-In'
                  : action === 'cashout'
                    ? 'Cash Out'
                    : 'Mint Chips'}
            </h2>
            {action === 'cashout' && cashoutConfirm.show ? (
              <div className={styles.escrowFlow}>
                <div className={styles.escrowIcon}>◈</div>
                <h3 className={styles.escrowTitle}>Security Verification Required</h3>
                <p className={styles.escrowDesc}>
                  You Are Requesting A High-Value Cashout Of{' '}
                  <strong className={styles.escrowAmount}>
                    {cashoutConfirm.value.toLocaleString()} Chips
                  </strong>
                  .<br />
                  This Amount Triggers Our Mandatory Escrow Protocols To Ensure Player Security.
                </p>

                {/* These three rows previously rendered "Anti-Money Laundering
                  (AML) Check Passed" and "Identity Verification Confirmed"
                  with green ticks, hardcoded. No AML or identity check is
                  performed here or in cashoutService.requestCashout — the app
                  was asserting a compliance result it had never computed, at
                  the exact moment of a large withdrawal. Replaced with what
                  actually happens to the request. */}
                <div className={styles.escrowChecklist}>
                  <div className={styles.escrowCheckItem}>
                    <div className={`${styles.escrowCheckIcon} ${styles.escrowCheckGreen}`}>✓</div>
                    <span className={styles.escrowCheckLabel}>
                      Request Amount Confirmed Against Your Club Balance
                    </span>
                  </div>
                  <div className={styles.escrowCheckItem}>
                    <div className={`${styles.escrowCheckIcon} ${styles.escrowCheckAmber}`}>◷</div>
                    <span className={styles.escrowCheckLabel}>
                      Escrow Holding - Chips Are Reserved Until Review Completes
                    </span>
                  </div>
                  <div className={styles.escrowCheckItem}>
                    <div className={`${styles.escrowCheckIcon} ${styles.escrowCheckAmber}`}>◷</div>
                    <span className={styles.escrowCheckLabel}>
                      Pending Club Agent Review And Approval
                    </span>
                  </div>
                </div>

                <div className={styles.btnRow}>
                  <button
                    className={styles.btnGhost}
                    onClick={() => setCashoutConfirm({ show: false, value: 0 })}
                    disabled={isProcessing}
                  >
                    CANCEL
                  </button>
                  <button
                    className={styles.btnPrimary}
                    onClick={() => processHighValueCashout(cashoutConfirm.value)}
                    disabled={isProcessing}
                  >
                    {isProcessing ? (
                      <>
                        <span className={styles.spinner} />
                        Processing...
                      </>
                    ) : (
                      'CONFIRM SECURE CASHOUT'
                    )}
                  </button>
                </div>
              </div>
            ) : (
              <div className={styles.cardBody}>
                {/* U-02 FIX: Show pending cashouts when on cashout tab */}
                {action === 'cashout' && pendingCashouts.length > 0 && (
                  <div className={styles.pendingBox}>
                    <div className={styles.pendingTitle}>Pending Cashouts</div>
                    {pendingCashouts.map((pc) => (
                      <div key={pc.id} className={styles.pendingRow}>
                        <span>{pc.amount.toLocaleString()} Chips</span>
                        <span className={styles.pendingStatus}>
                          {pc.status === 'pending' ? 'Awaiting Agent' : 'Processing'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Open full CashoutRequestModal for premium step-tracker experience */}
                {action === 'cashout' && !tableId && clubId && user?.id && (
                  <button className={styles.btnSuccess} onClick={() => setShowCashoutModal(true)}>
                    Manage Cashout Requests
                  </button>
                )}

                {/* Cashout context info */}
                {action === 'cashout' && !tableId && (
                  <div className={`${styles.message} ${styles.messageInfo}`}>
                    Your Chips Will Be Held In Escrow Until Your Assigned Agent Approves The
                    Cashout.
                  </div>
                )}

                <div className={styles.formGroup}>
                  <label className={styles.formLabel} htmlFor="cashier-amount">
                    {action === 'mint' ? 'CHIPS TO MINT:' : 'AMOUNT:'}
                  </label>
                  <input
                    id="cashier-amount"
                    className={styles.input}
                    type="number"
                    placeholder="0"
                    value={amount}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAmount(e.target.value)}
                    min={1}
                    step={1}
                    max={MAX_CHIP_AMOUNT}
                    inputMode="numeric"
                  />
                </div>

                {action === 'mint' && amount && (
                  <div className={`${styles.message} ${styles.messageInfo}`}>
                    {Math.ceil(
                      (parseFloat(amount || '0') * DIAMOND_RATE_NUM) / DIAMOND_RATE_DEN
                    ).toLocaleString()}{' '}
                    Diamonds Required
                  </div>
                )}

                {/* Presets */}
                <div className={styles.presetGrid}>
                  {preset.map((val) => (
                    <button
                      key={val}
                      className={styles.presetBtn}
                      onClick={() => setAmount(val.toString())}
                    >
                      {val.toLocaleString()}
                    </button>
                  ))}
                  {action === 'cashout' && (
                    <button
                      type="button"
                      className={styles.presetBtn}
                      // Per-club, matching what fn_request_cashout debits. This
                      // prefilled the GLOBAL wallet figure, which for most users
                      // is far larger than their balance in this club, so "Max"
                      // produced an amount the server always rejected. Disabled
                      // until the club figure is known, rather than offering 0.
                      disabled={myClubChips === null}
                      onClick={() => setAmount(String(Math.floor(myClubChips ?? 0)))}
                    >
                      Max
                    </button>
                  )}
                </div>

                {message && (
                  <div
                    className={`${styles.message} ${message.type === 'success' ? styles.messageSuccess : message.type === 'error' ? styles.messageError : styles.messageInfo}`}
                  >
                    {formatPopupText(message.text)}
                  </div>
                )}

                <button
                  type="button"
                  className={styles.btnPrimary}
                  // Called through a wrapper: passing the handler directly hands
                  // React's MouseEvent in as the override argument.
                  onClick={() => handleAction()}
                  disabled={isProcessing || cooldown > 0 || !amount}
                >
                  {isProcessing ? (
                    <>
                      <span className={styles.spinner} />
                      Processing...
                    </>
                  ) : action === 'buyin' ? (
                    'CONFIRM BUY-IN'
                  ) : action === 'cashout' ? (
                    tableId ? (
                      'CONFIRM CASH-OUT'
                    ) : (
                      'REQUEST CASHOUT'
                    )
                  ) : (
                    'CONFIRM MINT'
                  )}
                </button>

                {tableId && (
                  <p className={styles.tableContext}>Returning To Table After Transaction</p>
                )}
              </div>
            )}
          </section>
        )}

        {/* ═══ TRANSACTION HISTORY ═══ */}
        {action === 'history' && (
          <section className={styles.card} id="cashier-panel-history" role="tabpanel">
            <h2 className={styles.cardTitle}>
              <span className={styles.cardTitleIcon}>≡</span>Transaction History
            </h2>
            <div className={styles.txContainer}>
              {/* Filters */}
              <div className={styles.txFilters}>
                {['all', 'credit', 'debit', 'transfer', 'buyin', 'cashout', 'rake', 'prize'].map(
                  (f) => (
                    <button
                      key={f}
                      className={`${styles.txFilterBtn} ${txFilter === f ? styles.txFilterActive : ''}`}
                      onClick={() => {
                        setTxFilter(f);
                        setTxPage(1);
                      }}
                    >
                      {f === 'all'
                        ? 'All'
                        : f === 'credit'
                          ? 'Credits'
                          : f === 'debit'
                            ? 'Debits'
                            : CATEGORY_LABELS[f] || f}
                    </button>
                  )
                )}
                <button className={styles.txExportBtn} onClick={exportCSV}>
                  Export CSV
                </button>
              </div>

              {txError && (
                <div role="alert" className={`${styles.message} ${styles.messageError}`}>
                  <span>{txError}</span>
                  <button
                    type="button"
                    className={styles.txExportBtn}
                    onClick={() => loadTransactions({ force: true })}
                  >
                    Retry History
                  </button>
                </div>
              )}
              {loadingTx && transactions.length === 0 ? (
                <div className={styles.txLoading} aria-busy="true">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div
                      key={i}
                      className={styles.txSkeletonRow}
                      style={{ animationDelay: `${i * 0.08}s` }}
                    >
                      <div
                        className={`${styles.skeletonBar}`}
                        style={{
                          width: '28px',
                          height: '28px',
                          borderRadius: '50%',
                          flexShrink: 0,
                        }}
                      />
                      <div
                        style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}
                      >
                        <div
                          className={styles.skeletonBar}
                          style={{ width: `${55 + i * 5}%`, height: '12px' }}
                        />
                        <div
                          className={styles.skeletonBar}
                          style={{ width: '40%', height: '10px' }}
                        />
                      </div>
                      <div
                        className={styles.skeletonBar}
                        style={{ width: '60px', height: '14px', flexShrink: 0 }}
                      />
                    </div>
                  ))}
                </div>
              ) : txError && transactions.length === 0 ? null : filteredTransactions.length ===
                0 ? (
                <div className={styles.txEmpty}>
                  <span className={styles.txEmptyIcon}>▦</span>
                  <span className={styles.txEmptyTitle}>No Transactions Recorded Yet</span>
                  <span className={styles.txEmptyDesc}>
                    Your Buy-Ins, Cashouts, And Chip Transfers Will Appear Here.
                  </span>
                </div>
              ) : (
                <>
                  <div className={styles.txList}>
                    {filteredTransactions
                      .slice(0, txPage * TX_PAGE_SIZE)
                      .map((tx: any, idx: number) => (
                        <div
                          key={tx.id}
                          className={styles.txRow}
                          style={{ animationDelay: `${idx * 0.05}s` }}
                        >
                          <span className={styles.txIcon}>
                            {CATEGORY_ICONS[tx.category] || '●'}
                          </span>
                          <div className={styles.txDetails}>
                            <span className={styles.txCategory}>
                              {CATEGORY_LABELS[tx.category] ||
                                (tx.category || tx.type || '').replace(/_/g, ' ').toUpperCase()}
                            </span>
                            <span className={styles.txDesc}>{formatPopupText(tx.description)}</span>
                          </div>
                          <div className={styles.txAmounts}>
                            <span
                              className={`${styles.txAmount} ${tx.type === 'credit' ? styles.txPositive : styles.txNegative}`}
                            >
                              {tx.type === 'credit' ? '+' : '-'}
                              {Math.abs(tx.amount).toLocaleString()}
                            </span>
                            <span className={styles.txWallet}>{tx.wallet_type}</span>
                          </div>
                          <span className={styles.txTime}>
                            {new Date(tx.created_at).toLocaleDateString([], {
                              month: 'short',
                              day: 'numeric',
                            })}{' '}
                            {new Date(tx.created_at).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                      ))}
                  </div>
                  {/* Pagination — Load More */}
                  {filteredTransactions.length > txPage * TX_PAGE_SIZE && (
                    <button
                      className={styles.loadMoreBtn}
                      onClick={() => setTxPage((p) => p + 1)}
                      aria-label="Load More Transactions"
                    >
                      Load More ({filteredTransactions.length - txPage * TX_PAGE_SIZE} Remaining)
                    </button>
                  )}
                </>
              )}
            </div>
          </section>
        )}
      </CashierConsoleSurface>

      {/* Cashout Request Modal — Full step tracker UX */}
      {clubId && user?.id && (
        <CashoutRequestModal
          isOpen={showCashoutModal}
          onClose={() => setShowCashoutModal(false)}
          playerId={user.id}
          clubId={clubId}
          // Per-club chips, matching what request-cashout.js actually checks.
          currentBalance={myClubChips ?? 0}
          onComplete={() => {
            loadBalances(user.id);
            loadPendingCashouts();
            clearClubChipBalanceCache();
            setClubChipsNonce((n) => n + 1);
          }}
        />
      )}

      {/* Send Confirmation Modal for high-value transfers (≥10K) */}
      {sendConfirm.show && (
        <div
          className={styles.modalOverlay}
          onClick={() =>
            setSendConfirm({ show: false, value: 0, recipientId: '', recipientName: '' })
          }
          role="dialog"
          aria-modal="true"
          aria-labelledby="send-confirm-title"
        >
          <div className={styles.consoleDialog} onClick={(e) => e.stopPropagation()}>
            <CashierConsoleSurface
              eyebrow="Protected Transfer"
              title="Confirm Transfer"
              titleId="send-confirm-title"
              subtitle={`${sendConfirm.value.toLocaleString()} Chips To ${sendConfirm.recipientName}`}
              pill="Verify"
              pillInk="gold"
              crest="diamond"
              actions={{
                secondary: {
                  label: 'Cancel',
                  onClick: () =>
                    setSendConfirm({
                      show: false,
                      value: 0,
                      recipientId: '',
                      recipientName: '',
                    }),
                },
                primary: {
                  label: isProcessing ? 'Sending' : 'Confirm Send',
                  ink: 'blue',
                  disabled: isProcessing,
                  onClick: () => {
                    // Send exactly what the user was shown and agreed to.
                    // This used to call handleAction() with no arguments, which
                    // re-read `amount` and `selectedRecipient` from live state —
                    // a realtime-driven refresh between opening and confirming
                    // could send a different amount to a different person than
                    // the modal displayed. sendConfirm.recipientId was captured
                    // for exactly this and was never read.
                    const confirmed = {
                      value: sendConfirm.value,
                      recipientId: sendConfirm.recipientId,
                    };
                    setSendConfirm({
                      show: false,
                      value: 0,
                      recipientId: '',
                      recipientName: '',
                    });
                    handleAction(confirmed);
                  },
                },
              }}
            >
              <p className={styles.confirmText}>
                You Are About To Send <strong>{sendConfirm.value.toLocaleString()}</strong> Chips To{' '}
                <strong>{sendConfirm.recipientName}</strong>.
              </p>
              <p className={styles.confirmWarning}>
                {/* THE SAME SCREEN SAYS "Claim Back Window: Ten Minutes" three
                  hundred lines up. This warning said the opposite - "This
                  Action Cannot Be Undone" - on a send the page itself
                  advertises as reversible, which is not a scarier warning, it
                  is a false one: an operator who believed it would not go
                  looking for the Claim Back that could still save them. */}
                You Can Claim This Back For Ten Minutes, And Not After That. Please Verify The
                Amount And Recipient.
              </p>
            </CashierConsoleSurface>
          </div>
        </div>
      )}
    </StandardContentLayout>
  );
}
