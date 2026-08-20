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
import { useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { masterBus } from '../core/MasterBus';
import { useMasterBusChannel } from '../hooks/useMasterBusChannel';
import {
  useMasterBusSubscription,
  useMasterBusSubscriptions,
} from '../hooks/useMasterBusSubscription';
import { useWalletStore } from '../stores/useWalletStore';
import { useAuthUser } from '../hooks/useAuthUser';
import { ChipFlowService } from '../services/ChipFlowService';
import { cashoutService } from '../services/CashoutService';
import { supabase } from '../lib/supabase';
import ClubBottomNav from '../components/club/ClubBottomNav';
import CashierClubSwitcher from '../components/club/CashierClubSwitcher';

import { useToast } from '../components/common/Toast';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { callClubArenaApi } from '../services/clubArenaApi';
import {
  resolveTargetClub,
  readCachedQuickLinkClubs,
  fetchQuickLinkClubs,
  fetchClubChipBalances,
  clearClubChipBalanceCache,
} from '../utils/clubQuickLink';
import { checkSettlementLock } from '../utils/settlementLock';
import AgentPromoPanel from '../components/agent/AgentPromoPanel';
import CashoutRequestModal from '../components/wallet/CashoutRequestModal';
import DynamicWallet from '../components/wallet/DynamicWallet';
import styles from './CashierPage.module.css';
import { useIsMounted } from '../hooks/useIsMounted';
import { retryFetch } from '../utils/retryFetch';
import { reportError } from '../utils/errorReporter';

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
 * Chips are whole units: the per-club ledger column (club_members.chip_balance)
 * is an integer, so a fractional amount is rounded on write while the sending
 * side is debited the exact decimal — that difference is money created or
 * destroyed. `parseFloat` alone also accepted exponent notation ("1e9"), so the
 * bound is enforced here as well as in the database.
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
  if (!Number.isInteger(value)) {
    return { ok: false, error: 'Chips must be a whole number' };
  }
  if (value > MAX_CHIP_AMOUNT) {
    return { ok: false, error: 'Amount exceeds the maximum transfer limit' };
  }
  return { ok: true, value };
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
  TIP: 'Dealer Tip',
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
  TIP: '♥',
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

  const { balances, mintChips, loadBalances } = useWalletStore();
  const toast = useToast();

  const [action, setAction] = useState<CashierAction>('send');
  const [amount, setAmount] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Rate limiting: minimum 2s between financial actions (beyond the 3s cooldown)
  const lastActionRef = useRef<number>(0);
  const RATE_LIMIT_MS = 2000;

  // Connection status: track realtime channel health
  const [realtimeStatus, setRealtimeStatus] = useState<'connected' | 'reconnecting' | 'error'>(
    'connected'
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
      let target = resolveTargetClub(readCachedQuickLinkClubs());
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
  const [isInUnion, setIsInUnion] = useState(false);
  const [isUnionOwner, setIsUnionOwner] = useState(false);
  const [clubName, setClubName] = useState('');

  // Send chips state
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [selectedRecipient, setSelectedRecipient] = useState('');
  const [loadingRecipients, setLoadingRecipients] = useState(false);

  // Transaction history state
  const [transactions, setTransactions] = useState<Transaction[]>([]);
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
      if (live && isMounted.current) setMyClubChips(map.get(resolved) ?? 0);
    })();
    return () => {
      live = false;
    };
  }, [user?.id, clubId, clubChipsNonce, isMounted]);
  const [loadingTx, setLoadingTx] = useState(false);
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
    setUserRole('member');
    setIsInUnion(false);
    setIsUnionOwner(false);
    setSelectedRecipient('');
    setTxFilter('all');
    setPendingCashouts([]);
    recipientsCacheRef.current = null;
    setTxPage(1);
    setLoadingContext(true);
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

  const loadUserContext = async () => {
    if (!clubId || !user?.id) return;
    try {
      const resolvedId = await resolveClubUUID(clubId);
      if (!isMounted.current) return;

      // PERF: Parallelize role + club data queries (was 4 sequential, now 2 parallel)
      const [memberResult, clubResult] = await Promise.all([
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
      ]);
      if (!isMounted.current) return;

      const role = memberResult?.data?.role || 'member';
      setUserRole(role);
      setClubName(clubResult?.data?.name || '');

      // Union check — derived from combined query above
      const detectedUnionId = clubResult?.data?.union_id;
      if (detectedUnionId) {
        setIsInUnion(true);
        // Only need 1 more query: union owner check
        const { data: unionData } = await retryFetch(
          () =>
            supabase
              .from('unions')
              .select('owner_id')
              .eq('id', detectedUnionId)
              .maybeSingle()
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        );
        if (!isMounted.current) return;
        setIsUnionOwner(unionData?.owner_id === user.id);
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
      if (userRole === 'owner' || isUnionOwner) {
        roleFilter = ['agent', 'super_agent', 'sub_agent', 'member', 'player'];
      } else if (userRole === 'agent' || userRole === 'super_agent') {
        roleFilter = ['sub_agent', 'member', 'player'];
      } else if (userRole === 'sub_agent') {
        roleFilter = ['member', 'player'];
      } else {
        // Regular members can't send chips
        setRecipients([]);
        setLoadingRecipients(false);
        return;
      }

      // Fetch members — role-based visibility:
      // Union/Club owners + admins: see everyone
      // Agents/sub-agents: see only their downline (filtered by agent_id)
      let query = supabase
        .from('club_members')
        .select('user_id, role, display_name, nickname, chip_balance, agent_id')
        .eq('club_id', resolvedId)
        .neq('user_id', user.id)
        .in('role', roleFilter)
        .limit(500);

      // For agents: only show their assigned downline players
      if (userRole === 'agent' || userRole === 'sub_agent') {
        // Get this user's agent record ID
        const { data: agentRecord } = await retryFetch(
          () =>
            supabase
              .from('agents')
              .select('id')
              .eq('user_id', user.id)
              .eq('club_id', resolvedId)
              .maybeSingle()
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        );
        if (!isMounted.current) return;

        if (agentRecord?.id) {
          query = query.eq('agent_id', agentRecord.id);
        }
      }

      const { data } = await retryFetch(() => query.then((r) => r), {
        maxRetries: 2,
        isMountedRef: isMounted,
      });

      // Map recipients — use display_name/nickname from club_members directly
      const members = (data || []) as Array<{
        user_id: string;
        role: string;
        display_name: string | null;
        nickname: string | null;
        chip_balance: number | null;
      }>;

      // Batch-fetch display names from profiles for members without display_name
      const needNames = members.filter((m) => !m.display_name && !m.nickname).map((m) => m.user_id);
      const profileMap: Record<string, string> = {};
      if (needNames.length > 0) {
        const chunkSize = 200;
        for (let i = 0; i < needNames.length; i += chunkSize) {
          if (!isMounted.current) return;
          const chunk = needNames.slice(i, i + chunkSize);
          const { data: profiles } = await retryFetch(
            () =>
              supabase
                .from('profiles')
                .select('id, display_name, username')
                .in('id', chunk)
                .then((r) => r),
            { maxRetries: 2, isMountedRef: isMounted }
          );
          if (profiles) {
            for (const p of profiles) {
              profileMap[p.id] = p.display_name || p.username || 'Player';
            }
          }
        }
      }

      // Fetch commission rates for agent-type recipients
      const agentUserIds = members
        .filter((m) => ['agent', 'super_agent', 'sub_agent'].includes(m.role))
        .map((m) => m.user_id);
      const agentMap: Record<string, { commission_rate: number; is_prepaid: boolean }> = {};
      if (agentUserIds.length > 0) {
        if (!isMounted.current) return;
        const { data: agentRecords } = await retryFetch(
          () =>
            supabase
              .from('agents')
              .select('user_id, commission_rate, is_prepaid')
              .in('user_id', agentUserIds)
              .eq('club_id', resolvedId)
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        );
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

  const txLoadingRef = useRef(false); // Prevent duplicate loadTransactions calls

  const loadTransactions = useCallback(async () => {
    if (!user?.id) return;
    if (!clubId) return;
    if (txLoadingRef.current) return; // Deduplication — skip if already loading
    txLoadingRef.current = true;
    setLoadingTx(true);
    try {
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

      if (isMounted.current) {
        setTransactions(merged);
        try {
          sessionStorage.setItem(
            `cashier_tx_cache_${user.id}`,
            JSON.stringify({
              data: merged.slice(0, 30),
              cachedAt: Date.now(),
            })
          );
        } catch (e) {
          reportError(e, 'CashierPage.sort');
          /* storage full */
        }
      }
    } catch (e) {
      reportError(e, 'CashierPage.sort');
      /* silent */
    } finally {
      txLoadingRef.current = false;
      if (isMounted.current) setLoadingTx(false);
    }
    // clubId added: history is now scoped to the club being viewed, so
    // switching clubs must re-query rather than show the previous club's rows.
  }, [user?.id, clubId]);

  useEffect(() => {
    if (action === 'history') {
      // SWR: show cached transactions instantly while fresh data loads
      // TTL: skip caches older than 5 minutes
      const SWR_TTL_MS = 5 * 60 * 1000;
      if (user?.id) {
        try {
          const cached = sessionStorage.getItem(`cashier_tx_cache_${user.id}`);
          if (cached) {
            const parsed = JSON.parse(cached);
            const age = parsed.cachedAt ? Date.now() - parsed.cachedAt : Infinity;
            if (Array.isArray(parsed.data) && parsed.data.length > 0 && age < SWR_TTL_MS) {
              setTransactions(parsed.data);
            }
          }
        } catch (e) {
          reportError(e, 'CashierPage.useEffect');
          /* */
        }
      }
      loadTransactions();
    }
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
  });

  // ── Bus Listeners: instant balance refresh from engine events ──
  // Load balances only
  useMasterBusSubscriptions(
    [
      'BALANCE_UPDATED',
      'CHIPS_ADDED',
      'CHIPS_WITHDRAWN',
      'CASHIER_BALANCE_CHANGED',
      'RAKEBACK_CLAIMED',
      'DAILY_REWARD_CLAIMED',
    ],
    () => {
      if (user?.id) loadBalances(user.id);
    },
    { debounce: 500 }
  );

  // Live transaction updates — refresh history when new ledger entries arrive
  useMasterBusSubscriptions(
    ['TRANSACTION_LOGGED' as any],
    () => {
      loadTransactions();
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
        loadTransactions();
      }
    },
    { debounce: 1000 }
  );

  useMasterBusSubscriptions(
    ['SETTLEMENT_COMPLETED', 'COMMISSION_PAID'],
    () => {
      if (user?.id) {
        loadBalances(user.id);
        loadTransactions();
      }
    },
    { debounce: 500 }
  );

  // Supabase Realtime channel for chip_transactions (cross-device sync)
  useEffect(() => {
    if (!user?.id) return;
    const chipTxnChannel = masterBus
      .getOrCreateChannel(`cashier-chip-txns-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'chip_transactions',
          filter: `from_user_id=eq.${user.id}`,
        },
        () => {
          loadBalances(user.id);
          loadTransactions();
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'chip_transactions',
          filter: `to_user_id=eq.${user.id}`,
        },
        () => {
          loadBalances(user.id);
          loadTransactions();
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'SUBSCRIBED') {
          if (isMounted.current) setRealtimeStatus('connected');
        }
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'CashierPage._Realtime_channel_error');
          if (isMounted.current) setRealtimeStatus('error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[CashierPage] Realtime channel timed out');
          if (isMounted.current) setRealtimeStatus('reconnecting');
        }
      });
    return () => {
      masterBus.removeRegisteredChannel(`cashier-chip-txns-${user.id}`);
    };
  }, [user?.id, loadBalances, loadTransactions]);

  // ─────────────────────────────────────────────────────────────────────────────
  // DETERMINE AVAILABLE TABS
  // ─────────────────────────────────────────────────────────────────────────────

  const canSend =
    userRole === 'owner' ||
    isUnionOwner ||
    userRole === 'agent' ||
    userRole === 'super_agent' ||
    userRole === 'sub_agent';
  const canMint = (userRole === 'owner' && !isInUnion) || isUnionOwner;

  const canDistribute =
    userRole === 'owner' || isUnionOwner || userRole === 'agent' || userRole === 'super_agent';

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
        if (balances.PLAYER.available < value) {
          if (isMounted.current)
            setMessage({
              type: 'error',
              text: `Insufficient balance. Available: ${balances.PLAYER.available.toLocaleString()}`,
            });
          if (isMounted.current) setIsProcessing(false);
          return;
        }

        const recipient = recipients.find((r) => r.id === recipientIdForAction);
        const recipientIsAgent = recipient?.role === 'agent' || recipient?.role === 'super_agent';

        if (userRole === 'owner' && recipientIsAgent) {
          // clubId here may be the 6-digit club code rather than the UUID.
          // Every other DB call on this page resolves first; this one passed
          // the raw param into a uuid argument, so an owner arriving on
          // /clubs/25450/cashier got `invalid input syntax for type uuid`.
          const resolvedForTransfer = (await resolveClubUUID(clubId!)) || clubId!;
          await ChipFlowService.clubToAgent(
            user.id,
            recipientIdForAction,
            resolvedForTransfer,
            value,
            recipient?.username || 'Agent',
            clubName
          );
        } else if (userRole === 'owner' || isUnionOwner) {
          await ChipFlowService.clubToPlayer(
            user.id,
            recipientIdForAction,
            value,
            recipient?.username || 'Player',
            clubName
          );
        } else {
          await ChipFlowService.agentToPlayer(
            user.id,
            recipientIdForAction,
            value,
            user.username || 'Agent',
            recipient?.username || 'Player',
            clubName
          );
        }

        if (isMounted.current)
          setMessage({
            type: 'success',
            text: `Sent ${value.toLocaleString()} chips to ${recipient?.username}`,
          });
        loadBalances(user.id);
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
              text: mintResult.error || 'Minting failed. Please try again.',
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
          // table, where the engine owns the withdrawal end to end —
          // GameServerAPI.removeChips -> atomic_table_withdraw credits the
          // wallet and reduces the seat stack atomically, only between hands,
          // deriving the amount from authoritative state rather than a text box.
          if (isMounted.current)
            setMessage({
              type: 'info',
              text: 'Cash out from the table itself — taking you there now.',
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

          if (balances.PLAYER.available < value) {
            if (isMounted.current)
              setMessage({
                type: 'error',
                text: `Insufficient balance. Available: ${balances.PLAYER.available.toLocaleString()}`,
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
            await cashoutService.requestCashout(user.id, clubId!, value);
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
    setCashoutConfirm({ show: false, value: 0 });
    setIsProcessing(true);
    try {
      if (balances.PLAYER.available < value) {
        if (isMounted.current)
          setMessage({
            type: 'error',
            text: `Insufficient balance. Available: ${balances.PLAYER.available.toLocaleString()}`,
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
      await cashoutService.requestCashout(user.id, clubId, value);
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

  // Use integer arithmetic to avoid floating-point precision issues: (chips * 38) / 100
  const DIAMOND_RATE_NUM = 38;
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
      <div className={styles.page}>
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>
            <span className={styles.cardTitleIcon}>◆</span>Cashier
          </h2>
          <div className={styles.cardBody}>
            {hasNoClubs ? (
              <>
                <div className={`${styles.message} ${styles.messageInfo}`}>
                  The cashier belongs to a club — chips are held per club, so there is no cashier
                  until you join one.
                </div>
                <button type="button" className={styles.btnPrimary} onClick={() => navigate('/')}>
                  Find a club
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
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {/* Loading context skeleton — shown INSIDE content area, NOT blocking tabs/nav */}

      {/* ── Club context bar — which club's cashier, with multi-club switcher ── */}
      {clubId && <CashierClubSwitcher clubId={clubId} clubName={clubName} />}

      {/* ── Wallet Display — always visible, real-time updates ── */}
      {user?.id && clubId && (
        <div className={styles.walletHeader}>
          <DynamicWallet
            userId={user.id}
            clubId={clubId}
            variant={
              isInUnion && (userRole === 'owner' || isUnionOwner)
                ? 'union'
                : userRole === 'owner'
                  ? 'owner'
                  : 'player'
            }
            onBuyDiamonds={() => navigate(`/vip`)}
            onMintChips={() => setAction('mint')}
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

      {/* Action Tabs */}
      {/* Connection status indicator */}
      {realtimeStatus !== 'connected' && (
        <div className={styles.connectionBanner} role="status" aria-live="polite">
          {realtimeStatus === 'reconnecting' ? (
            <>
              <span className={styles.connectionDot} style={{ background: '#f59e0b' }} />{' '}
              Reconnecting to live updates…
            </>
          ) : (
            <>
              <span className={styles.connectionDot} style={{ background: '#ef4444' }} /> Live
              connection lost — data may be stale
            </>
          )}
        </div>
      )}

      <nav
        className={styles.tabNav}
        role="tablist"
        aria-label="Cashier actions"
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
            <div className={`${styles.message} ${styles.messageInfo}`}>
              Send chips from your wallet to{' '}
              {userRole === 'owner'
                ? 'agents, sub-agents, and players'
                : userRole === 'agent' || userRole === 'super_agent'
                  ? 'sub-agents and players'
                  : 'players'}
            </div>

            {/* Recipient Select */}
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>SEND TO:</label>
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
                  <option value="">Select recipient</option>
                  {recipients.map((r) => {
                    const isAgent = ['agent', 'super_agent', 'sub_agent'].includes(r.role);
                    const roleTag =
                      r.role === 'super_agent'
                        ? 'SA'
                        : r.role === 'agent'
                          ? 'AGT'
                          : r.role === 'sub_agent'
                            ? 'SUB'
                            : '';
                    const commInfo =
                      isAgent && r.commissionRate ? ` ${(r.commissionRate * 100).toFixed(0)}%` : '';
                    const typeInfo = isAgent ? (r.isPrepaid ? ' PP' : ' CR') : '';
                    return (
                      <option key={r.id} value={r.id}>
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
              <button
                className={styles.presetBtn}
                onClick={() => setAmount(String(balances.PLAYER.available))}
              >
                Max
              </button>
            </div>

            {/* Preview */}
            {selectedRecipientData && amount && parseFloat(amount) > 0 && (
              <div className={styles.transferPreview}>
                <div className={styles.previewRow}>
                  <span>You</span>
                  <span>
                    {balances.PLAYER.available.toLocaleString()} →{' '}
                    {Math.max(0, balances.PLAYER.available - parseFloat(amount)).toLocaleString()}
                  </span>
                </div>
                <div className={styles.previewRow}>
                  <span>{selectedRecipientData.username}</span>
                  <span>
                    {selectedRecipientData.balance.toLocaleString()} →{' '}
                    {(selectedRecipientData.balance + parseFloat(amount)).toLocaleString()}
                  </span>
                </div>
              </div>
            )}

            {message && (
              <div
                className={`${styles.message} ${message.type === 'success' ? styles.messageSuccess : message.type === 'error' ? styles.messageError : styles.messageInfo}`}
              >
                {message.text}
              </div>
            )}

            <button
              className={styles.btnPrimary}
              aria-label={`Send ${amount || '0'} chips to selected recipient`}
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
              Distribute chips directly to players or agents from the club bank. Each distribution
              is logged with a full audit trail.
            </div>

            {/* Player Selector */}
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>Recipient</label>
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
                  <option value="">Select player...</option>
                  {recipients.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.username} ({r.role}) — {r.balance.toLocaleString()} chips
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
                placeholder="Enter chip amount"
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
                {message.text}
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
                  // Distribute SERVER-SIDE. `distribute_promo_chips` is granted
                  // to postgres/service_role only, so the browser rpc() this
                  // used to call returned 42501 permission denied, was retried
                  // three times, and surfaced as a raw Postgres string — the
                  // Distribute tab could never succeed for anyone. The route
                  // identifies the agent from the JWT (no agents.id lookup
                  // needed, which also unblocks owners who have no agents row),
                  // enforces the promo caps, and writes the audit trail.
                  // Same call the Agent promo panel already uses.
                  await callClubArenaApi('distribute-promo', {
                    action: 'send',
                    clubId: (await resolveClubUUID(clubId || '')) || clubId || '',
                    targetUserId: selectedRecipient,
                    amount: value,
                  });
                  const recipient = recipients.find((r) => r.id === selectedRecipient);
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
                        text: 'Too many distributions — please wait 60 seconds',
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
                        text: 'Your agent record was not found — contact club owner',
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
                You are requesting a high-value cashout of{' '}
                <strong className={styles.escrowAmount}>
                  {cashoutConfirm.value.toLocaleString()} chips
                </strong>
                .<br />
                This amount triggers our mandatory escrow protocols to ensure player security.
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
                    Request amount confirmed against your club balance
                  </span>
                </div>
                <div className={styles.escrowCheckItem}>
                  <div className={`${styles.escrowCheckIcon} ${styles.escrowCheckAmber}`}>◷</div>
                  <span className={styles.escrowCheckLabel}>
                    Escrow holding — chips are reserved until review completes
                  </span>
                </div>
                <div className={styles.escrowCheckItem}>
                  <div className={`${styles.escrowCheckIcon} ${styles.escrowCheckAmber}`}>◷</div>
                  <span className={styles.escrowCheckLabel}>
                    Pending club agent review and approval
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
                      <span>{pc.amount.toLocaleString()} chips</span>
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
                  Your chips will be held in escrow until your assigned agent approves the cashout.
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
                  diamonds required
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
                    className={styles.presetBtn}
                    onClick={() => setAmount(String(balances.PLAYER.available))}
                  >
                    Max
                  </button>
                )}
              </div>

              {message && (
                <div
                  className={`${styles.message} ${message.type === 'success' ? styles.messageSuccess : message.type === 'error' ? styles.messageError : styles.messageInfo}`}
                >
                  {message.text}
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
                <p className={styles.tableContext}>Returning to table after transaction</p>
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

            {loadingTx ? (
              <div className={styles.txLoading} aria-busy="true">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div
                    key={i}
                    className={styles.txSkeletonRow}
                    style={{ animationDelay: `${i * 0.08}s` }}
                  >
                    <div
                      className={`${styles.skeletonBar}`}
                      style={{ width: '28px', height: '28px', borderRadius: '50%', flexShrink: 0 }}
                    />
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
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
            ) : filteredTransactions.length === 0 ? (
              <div className={styles.txEmpty}>
                <span className={styles.txEmptyIcon}>▦</span>
                <span className={styles.txEmptyTitle}>No transactions recorded yet</span>
                <span className={styles.txEmptyDesc}>
                  Your buy-ins, cashouts, and chip transfers will appear here.
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
                        <span className={styles.txIcon}>{CATEGORY_ICONS[tx.category] || '●'}</span>
                        <div className={styles.txDetails}>
                          <span className={styles.txCategory}>
                            {CATEGORY_LABELS[tx.category] ||
                              (tx.category || tx.type || '').replace(/_/g, ' ').toUpperCase()}
                          </span>
                          <span className={styles.txDesc}>{tx.description}</span>
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
                    aria-label="Load more transactions"
                  >
                    Load More ({filteredTransactions.length - txPage * TX_PAGE_SIZE} remaining)
                  </button>
                )}
              </>
            )}
          </div>
        </section>
      )}

      {clubId && (
        <ClubBottomNav
          clubId={clubId}
          userRole={userRole as 'owner' | 'admin' | 'agent' | 'member'}
        />
      )}

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
          <div className={styles.confirmModal} onClick={(e) => e.stopPropagation()}>
            <h3 id="send-confirm-title" className={styles.confirmTitle}>
              Confirm High-Value Transfer
            </h3>
            <p className={styles.confirmText}>
              You are about to send <strong>{sendConfirm.value.toLocaleString()}</strong> chips to{' '}
              <strong>{sendConfirm.recipientName}</strong>.
            </p>
            <p className={styles.confirmWarning}>
              This action cannot be undone. Please verify the amount and recipient.
            </p>
            <div className={styles.confirmButtons}>
              <button
                type="button"
                className={styles.btnSecondary}
                onClick={() =>
                  setSendConfirm({ show: false, value: 0, recipientId: '', recipientName: '' })
                }
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.btnDanger}
                disabled={isProcessing}
                onClick={() => {
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
                  setSendConfirm({ show: false, value: 0, recipientId: '', recipientName: '' });
                  handleAction(confirmed);
                }}
              >
                Confirm Send {sendConfirm.value.toLocaleString()} Chips
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
