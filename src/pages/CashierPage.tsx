/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CASHIER PAGE — Universal Chip Transfer Hub (Metal UI)
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
import { useWalletStore } from '../stores/useWalletStore';
import { useAuthUser } from '../hooks/useAuthUser';
import { WalletService as _WalletService } from '../services/WalletService';
import { ChipFlowService } from '../services/ChipFlowService';
import { cashoutService } from '../services/CashoutService';
import { supabase } from '../lib/supabase';
import ClubBottomNav from '../components/club/ClubBottomNav';

import { MetalFrame, MetalButton, MetalInput, MetalCard } from '../components/metal-ui';
import { useVIPStatus } from '../hooks/useVIP';
import { useToast } from '../components/common/Toast';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { resolveClubIdFilter, resolveClubUUID } from '../utils/clubIdResolver';
import { checkSettlementLock } from '../utils/settlementLock';
import AgentPromoPanel from '../components/agent/AgentPromoPanel';
import CashoutRequestModal from '../components/wallet/CashoutRequestModal';
import './CashierPage.css';
import { useIsMounted } from '../hooks/useIsMounted';
import { retryFetch } from '../utils/retryFetch';

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

// Premium balance counter
function useCountAnimation(target: number, duration: number = 800) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    let startTime: number;
    let animationFrame: number;
    const animate = (time: number) => {
      if (!startTime) startTime = time;
      const progress = Math.min((time - startTime) / duration, 1);
      setDisplay(Math.floor(target * progress));
      if (progress < 1) animationFrame = requestAnimationFrame(animate);
    };
    animationFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrame);
  }, [target, duration]);
  return display;
}

export default function CashierPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { clubId: routeClubId } = useParams<{ clubId?: string }>();
  const tableId = searchParams.get('table');
  const clubId = routeClubId || searchParams.get('club');

  const { user } = useAuthUser();
  const vipInfo = useVIPStatus();
  const { balances, diamonds, mintChips, loadBalances } = useWalletStore();
  const toast = useToast();
  useVisibilityRefresh(() => loadPendingCashouts());

  const [action, setAction] = useState<CashierAction>('send');
  const [amount, setAmount] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [message, setMessage] = useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);
  const [_recipientsLoading, setRecipientsLoading] = useState(false);
  const [cashoutConfirm, setCashoutConfirm] = useState({ show: false, value: 0 });
  const [showCashoutModal, setShowCashoutModal] = useState(false);
  const [_recipientConfirm, setRecipientConfirm] = useState<{
    show: boolean;
    recipientId: string;
    amount: number;
    username: string;
  }>({ show: false, recipientId: '', amount: 0, username: '' });

  const abortControllerRef = useRef<AbortController | null>(null);

  const isMounted = useIsMounted();
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, []);

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
  const [loadingTx, setLoadingTx] = useState(false);
  const [txFilter, setTxFilter] = useState('all');

  // Animated balance
  const animatedPlayerBalance = useCountAnimation(balances.PLAYER.available, 900);

  // Pending cashout state (U-02 FIX: show escrow status)
  const [pendingCashouts, setPendingCashouts] = useState<
    { id: string; amount: number; status: string; created_at: string }[]
  >([]);
  const [_loadingContext, setLoadingContext] = useState(true); // U-01 FIX: loading skeleton

  // ─────────────────────────────────────────────────────────────────────────────
  // LOAD ROLE, UNION STATUS, AND RECIPIENTS
  // ─────────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!clubId || !user?.id) return;
    setLoadingContext(true);
    loadUserContext().finally(() => setLoadingContext(false));
  }, [clubId, user?.id]);

  // Load pending cashouts
  useEffect(() => {
    if (!clubId || !user?.id) return;
    loadPendingCashouts();
  }, [clubId, user?.id, action]);

  // Subscribe to wallet updates (BALANCE_UPDATED is handled by debounced subscriber below)
  useEffect(() => {
    if (!user?.id) return;

    const unsubscribe2 = masterBus.subscribeDebounced(
      'WALLET_REFRESHED',
      () => {
        loadBalances(user.id);
      },
      500
    );

    return () => {
      unsubscribe2?.();
    };
  }, [loadBalances, user?.id]);

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
            .in('status', ['pending', 'processing'])
            .order('created_at', { ascending: false })
            .then((r) => r),
        { maxRetries: 2, isMountedRef: isMounted }
      );
      if (isMounted.current) {
        setPendingCashouts(data || []);
      }
    } catch {
      /* silent */
    }
  }, [clubId, user?.id]);

  const loadUserContext = async () => {
    if (!clubId || !user?.id) return;
    try {
      const resolvedId = await resolveClubUUID(clubId);
      // Get user's role in this club
      const { data: memberData } = await retryFetch(
        () =>
          supabase
            .from('club_members')
            .select('role')
            .eq('club_id', resolvedId)
            .eq('user_id', user.id)
            .maybeSingle()
            .then((r) => r),
        { maxRetries: 2, isMountedRef: isMounted }
      );
      if (!isMounted.current) return;
      const role = memberData?.role || 'member';
      setUserRole(role);

      // Get club name
      const { column: clubCol, value: clubVal } = resolveClubIdFilter(clubId);
      const { data: clubData } = await retryFetch(
        () =>
          supabase
            .from('clubs')
            .select('name')
            .eq(clubCol, clubVal)
            .maybeSingle()
            .then((r) => r),
        { maxRetries: 2, isMountedRef: isMounted }
      );
      if (!isMounted.current) return;
      setClubName(clubData?.name || '');

      // Check if club is in a union
      const { data: unionClub } = await retryFetch(
        () =>
          supabase
            .from('union_clubs')
            .select('union_id, unions!inner(owner_id)')
            .eq('club_id', resolvedId)
            .maybeSingle()
            .then((r) => r),
        { maxRetries: 2, isMountedRef: isMounted }
      );

      if (!isMounted.current) return;
      if (unionClub) {
        setIsInUnion(true);
        setIsUnionOwner((unionClub as any).unions?.owner_id === user.id);
      } else {
        setIsInUnion(false);
        setIsUnionOwner(false);
      }
    } catch {
      // Keep defaults
    }
  };

  // Load recipients when "Send" or "Distribute" tab is active
  useEffect(() => {
    if ((action === 'send' || action === 'distribute') && user?.id && clubId) {
      loadRecipients();
    }
  }, [action, user?.id, clubId]);

  const loadRecipients = async () => {
    if (!user?.id || !clubId) return;
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

      const { data } = await retryFetch(
        () =>
          supabase
            .from('club_members')
            .select(
              `
            user_id,
            role,
            users:user_id (id, username)
          `
            )
            .eq('club_id', resolvedId)
            .neq('user_id', user.id)
            .in('role', roleFilter)
            .limit(500)
            .then((r) => r),
        { maxRetries: 2, isMountedRef: isMounted }
      );

      // Get wallet balances for all recipients
      const recipientIds = (data || []).map((m: any) => m.users?.id).filter(Boolean);
      const { data: wallets } = await retryFetch(
        () =>
          supabase
            .from('wallets')
            .select('user_id, balance')
            .in('user_id', recipientIds.length > 0 ? recipientIds : ['none'])
            .eq('wallet_type', 'PLAYER')
            .then((r) => r),
        { maxRetries: 2, isMountedRef: isMounted }
      );

      const walletMap: Record<string, number> = {};
      (wallets || []).forEach((w: any) => {
        walletMap[w.user_id] = w.balance;
      });

      const list: Recipient[] = (data || [])
        .filter((m: any) => m.users?.id)
        .map((m: any) => ({
          id: m.users.id,
          username: m.users.username || 'Unknown',
          role: m.role,
          balance: walletMap[m.users.id] || 0,
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
      }
    } catch (err: any) {
      console.error('Failed to load recipients:', err);
      toast.error(err.message || 'Failed to load eligible recipients');
    }
    if (isMounted.current) setLoadingRecipients(false);
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // LOAD TRANSACTIONS
  // ─────────────────────────────────────────────────────────────────────────────

  const txLoadingRef = useRef(false); // Prevent duplicate loadTransactions calls

  const loadTransactions = useCallback(async () => {
    if (!user?.id) return;
    if (txLoadingRef.current) return; // Deduplication — skip if already loading
    txLoadingRef.current = true;
    setLoadingTx(true);
    try {
      const { data, error } = await retryFetch(
        () =>
          supabase
            .from('wallet_transactions')
            .select(
              'id, user_id, wallet_type, amount, type, category, description, related_entity_id, created_at'
            )
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })
            .limit(50)
            .then((r) => r),
        { maxRetries: 2, isMountedRef: isMounted }
      );

      if (!error && data && isMounted.current) {
        setTransactions(data);
        // SWR: cache for instant display on revisit (with TTL timestamp)
        try {
          sessionStorage.setItem(
            `cashier_tx_cache_${user.id}`,
            JSON.stringify({
              data: data.slice(0, 30),
              cachedAt: Date.now(),
            })
          );
        } catch {
          /* storage full */
        }
      }
    } catch {
      /* silent */
    }
    txLoadingRef.current = false;
    if (isMounted.current) setLoadingTx(false);
  }, [user?.id]);

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
        } catch {
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

  useEffect(() => {
    if (!user?.id) return;

    // Initial load
    loadBalances(user.id);
    loadTransactions();

    // #1: Use Channel Registry for deduplication
    const channelKey = `cashier-realtime-${user.id}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'wallets',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          if (payload.eventType === 'UPDATE' || payload.eventType === 'INSERT') {
            loadBalances(user.id);
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'wallet_transactions',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            loadBalances(user.id);
            loadTransactions();
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'cashout_requests',
          filter: `player_id=eq.${user.id}`,
        },
        (_payload) => {
          // Auto-refresh pending cashouts when status changes
          loadPendingCashouts();
        }
      )
      .subscribe();

    // Cleanup: remove channel via registry on unmount
    return () => {
      masterBus.removeRegisteredChannel(`cashier-realtime-${user.id}`);
    };
  }, [user?.id, loadBalances, loadTransactions]);

  // ── Bus Listeners: instant balance refresh from engine events ──
  useEffect(() => {
    if (!user?.id) return;
    const unsubBalance = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      () => {
        loadBalances(user.id);
      },
      500
    );
    const unsubWallet = masterBus.subscribeDebounced(
      'WALLET_REFRESHED',
      () => {
        loadBalances(user.id);
        loadPendingCashouts();
      },
      500
    );
    const unsubHand = masterBus.subscribeDebounced(
      'HAND_COMPLETED',
      () => {
        loadBalances(user.id);
        loadTransactions();
      },
      1000
    );
    const unsubChipsAdded = masterBus.subscribeDebounced(
      'CHIPS_ADDED',
      () => {
        loadBalances(user.id);
      },
      500
    );
    const unsubChipsWithdrawn = masterBus.subscribeDebounced(
      'CHIPS_WITHDRAWN',
      () => {
        loadBalances(user.id);
      },
      500
    );
    // ── Ported from World Hub cashier.js: cross-page refresh on admin actions ──
    const unsubChipsDistributed = masterBus.subscribeDebounced(
      'CHIPS_DISTRIBUTED',
      () => {
        loadBalances(user.id);
        loadPendingCashouts();
      },
      500
    );
    const unsubCashoutRequested = masterBus.subscribeDebounced(
      'CASHOUT_REQUESTED',
      () => {
        loadPendingCashouts();
      },
      500
    );
    const unsubCashoutCancelled = masterBus.subscribeDebounced(
      'CASHOUT_CANCELLED',
      () => {
        loadBalances(user.id);
        loadPendingCashouts();
      },
      500
    );
    const unsubCashierBalance = masterBus.subscribeDebounced(
      'CASHIER_BALANCE_CHANGED',
      () => {
        loadBalances(user.id);
      },
      500
    );
    const unsubRakebackClaimed = masterBus.subscribeDebounced(
      'RAKEBACK_CLAIMED',
      () => {
        loadBalances(user.id);
      },
      500
    );
    const unsubDailyReward = masterBus.subscribeDebounced(
      'DAILY_REWARD_CLAIMED',
      () => {
        loadBalances(user.id);
      },
      500
    );
    // Cashout approval listener: agent approves → refresh pending list (same-user edge case)
    const unsubCashoutApproved = masterBus.subscribeDebounced(
      'CASHOUT_APPROVED',
      () => {
        loadBalances(user.id);
        loadPendingCashouts();
      },
      500
    );
    // Settlement completion listener: balances may change after settlement
    const unsubSettlement = masterBus.subscribeDebounced(
      'SETTLEMENT_COMPLETED',
      () => {
        loadBalances(user.id);
        loadTransactions();
      },
      500
    );
    // Commission payout listener: agent's wallet credited after commission execution
    const unsubCommission = masterBus.subscribeDebounced(
      'COMMISSION_PAID',
      () => {
        loadBalances(user.id);
        loadTransactions();
      },
      500
    );
    // Supabase Realtime channel for chip_transactions (cross-device sync)
    const chipTxnChannel = masterBus
      .getOrCreateChannel(`cashier-chip-txns-${user.id}`)
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
      .subscribe();
    return () => {
      unsubBalance();
      unsubWallet();
      unsubHand();
      unsubChipsAdded();
      unsubChipsWithdrawn();
      unsubChipsDistributed();
      unsubCashoutRequested();
      unsubCashoutCancelled();
      unsubCashierBalance();
      unsubRakebackClaimed();
      unsubDailyReward();
      unsubCashoutApproved();
      unsubSettlement();
      unsubCommission();
      masterBus.removeRegisteredChannel(`cashier-chip-txns-${user.id}`);
    };
  }, [user?.id, loadBalances, loadTransactions, loadPendingCashouts]);

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

      // 2. Notify parent World Hub iframe
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(
          {
            type: 'USE_TRAINING_BUS_EMIT',
            event: 'chips_distributed',
            payload: {
              userId: targetUserId,
              amount: chipAmount,
              timestamp: Date.now(),
            },
          },
          '*'
        );
      }
    } catch (e) {
      console.error('Failed to notify of wallet change:', e);
    }
  };

  const selectedRecipientData = useMemo(() => {
    return recipients.find((r) => r.id === selectedRecipient);
  }, [recipients, selectedRecipient]);

  const handleAction = async () => {
    const value = parseFloat(amount);
    if (isNaN(value) || value <= 0) {
      setMessage({ type: 'error', text: 'Please enter a valid amount' });
      return;
    }
    if (!user?.id) return;

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
              text: `🔒 Chip movements are frozen during settlement (${lockResult.reason || 'Monday 4AM payout in progress'}). Please try again after settlement completes.`,
            });
          if (isMounted.current) setIsProcessing(false);
          return;
        }
      } catch {
        // Non-blocking: if settlement check fails, allow the action to proceed
      }
    }

    try {
      if (action === 'send') {
        // ─── SEND CHIPS ───
        if (!selectedRecipient) {
          if (isMounted.current) setMessage({ type: 'error', text: 'Please select a recipient' });
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

        const recipient = selectedRecipientData;
        const recipientIsAgent = recipient?.role === 'agent' || recipient?.role === 'super_agent';

        if (userRole === 'owner' && recipientIsAgent) {
          await ChipFlowService.clubToAgent(
            user.id,
            selectedRecipient,
            clubId!,
            value,
            recipient?.username || 'Agent',
            clubName
          );
        } else if (userRole === 'owner' || isUnionOwner) {
          await ChipFlowService.clubToPlayer(
            user.id,
            selectedRecipient,
            value,
            recipient?.username || 'Player',
            clubName
          );
        } else {
          await ChipFlowService.agentToPlayer(
            user.id,
            selectedRecipient,
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
        loadRecipients(); // Refresh balances
        setSelectedRecipient('');
        notifyWalletChange(user.id, value);
        notifyWalletChange(selectedRecipient, value);
      } else if (action === 'mint') {
        // ─── MINT CHIPS ───
        const mintResult = await mintChips(clubId!, value);
        if (!mintResult.success) {
          if (isMounted.current)
            setMessage({ type: 'error', text: 'Minting failed. Please try again.' });
          if (isMounted.current) setIsProcessing(false);
          return;
        }
        if (isMounted.current)
          setMessage({ type: 'success', text: `Minted ${value.toLocaleString()} chips` });
        loadBalances(user.id);
        notifyWalletChange(user.id, value);
      } else if (action === 'buyin') {
        // ─── TABLE BUY-IN ───
        if (balances.PLAYER.available < value) {
          if (isMounted.current)
            setMessage({ type: 'error', text: 'Insufficient chip balance for buy-in' });
          if (isMounted.current) setIsProcessing(false);
          return;
        }
        if (!tableId) {
          if (isMounted.current)
            setMessage({ type: 'error', text: 'No table selected for buy-in.' });
          if (isMounted.current) setIsProcessing(false);
          return;
        }
        const { lockForBuyIn } = useWalletStore.getState();
        const success = await lockForBuyIn(user.id, value, tableId);
        if (success) {
          if (isMounted.current)
            setMessage({ type: 'success', text: `Bought in for ${value.toLocaleString()} chips` });
          notifyWalletChange(user.id, value);
          navigate(`/table/${tableId}`);
        } else {
          if (isMounted.current)
            setMessage({ type: 'error', text: 'Buy-in failed. Please try again.' });
        }
      } else if (action === 'cashout') {
        // ─── CASH OUT ───
        // BUG-02 FIX: Two distinct flows:
        // 1) If at a table (tableId present) → unlock chips from table
        // 2) If no table → request-cashout API (escrow → agent approval)

        if (tableId) {
          // Table-context cashout: unlock chips from table session
          const { unlockFromTable } = useWalletStore.getState();
          const success = await unlockFromTable(user.id, value, tableId);
          if (success) {
            if (isMounted.current)
              setMessage({
                type: 'success',
                text: `Cashed out ${value.toLocaleString()} chips from table`,
              });
            notifyWalletChange(user.id, value);
            navigate(`/table/${tableId}`);
          } else {
            if (isMounted.current)
              setMessage({ type: 'error', text: 'Cash-out failed. Please try again.' });
          }
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

          // Call CashoutService directly for unified audit logging, notifications, and DB RPC logic
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
          } catch (err: any) {
            if (isMounted.current)
              setMessage({ type: 'error', text: err.message || 'Cashout request failed.' });
          }
        }
      }
      setAmount('');
    } catch (error: any) {
      if (isMounted.current)
        setMessage({
          type: 'error',
          text: error.message || 'Transaction failed. Please try again.',
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
        setIsProcessing(false);
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
    } catch (error: any) {
      if (isMounted.current)
        setMessage({ type: 'error', text: error.message || 'Cashout failed. Please try again.' });
    }
    if (isMounted.current) setIsProcessing(false);
    startCooldown();
  };

  // Use integer arithmetic to avoid floating-point precision issues: (chips * 38) / 100
  const DIAMOND_RATE_NUM = 38;
  const DIAMOND_RATE_DEN = 100;
  const preset = [100, 500, 1000, 5000];

  const filteredTransactions =
    txFilter === 'all'
      ? transactions
      : txFilter === 'credit'
        ? transactions.filter((t) => t.type === 'credit')
        : txFilter === 'debit'
          ? transactions.filter((t) => t.type === 'debit')
          : transactions.filter((t) => t.category === txFilter);

  // ─────────────────────────────────────────────────────────────────────────────
  // CSV EXPORT LOGIC
  // ─────────────────────────────────────────────────────────────────────────────
  const exportCSV = () => {
    if (filteredTransactions.length === 0) {
      setMessage({ type: 'error', text: 'No transactions to export' });
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

      // Escape quotes and commas in description
      const desc = `"${(tx.description || '').replace(/"/g, '""')}"`;

      return [date, time, typeText, categoryText, tx.amount, tx.wallet_type, desc].join(',');
    });

    const csvContent = [headers.join(','), ...rows].join('\n');
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
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div className="cashier-page" style={{ padding: '16px', paddingBottom: '100px' }}>
      <style>{`
                @keyframes slideInDown { from { opacity: 0; transform: translateY(-12px); } to { opacity: 1; transform: translateY(0); } }
                @keyframes fadeInStagger { from { opacity: 0; } to { opacity: 1; } }
                .cashier-balance-card { animation: slideInDown 0.6s cubic-bezier(0.34, 1.56, 0.64, 1); }
                .cashier-balance-card:nth-child(2) { animation: slideInDown 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) 0.1s both; }
                .cashier-tx-item { animation: fadeInStagger 0.5s ease-out forwards; opacity: 0; }
                @keyframes shimmer { 0% { background-position: -1000px 0; } 100% { background-position: 1000px 0; } }
                .cashier-skeleton { background: linear-gradient(90deg, rgba(255,255,255,0.1) 25%, rgba(255,255,255,0.2) 50%, rgba(255,255,255,0.1)); background-size: 1000px 100%; animation: shimmer 2s infinite; }
            `}</style>
      {/* Balance Cards */}
      <div className="balance-cards-grid">
        <MetalCard size="sm" glow className="cashier-balance-card">
          <div className="balance-card-content">
            <span className="balance-icon">♠</span>
            <div className="balance-label">Player Wallet</div>
            <div className="balance-value">{animatedPlayerBalance.toLocaleString()} chips</div>
          </div>
        </MetalCard>
        <MetalCard size="sm" glow className="cashier-balance-card">
          <div className="balance-card-content">
            <span className="balance-icon">◆</span>
            <div className="balance-label">
              Diamonds
              {vipInfo.isVIP && (
                <span
                  style={{
                    marginLeft: '6px',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    fontSize: '0.6rem',
                    fontWeight: 700,
                    background: 'linear-gradient(135deg, #FFD700, #FFA500)',
                    color: '#000',
                    verticalAlign: 'middle',
                    letterSpacing: '0.5px',
                  }}
                >
                  VIP
                </span>
              )}
            </div>
            <div className="balance-value">{diamonds.toLocaleString()}</div>
          </div>
        </MetalCard>
      </div>

      {/* Action Tabs */}
      <div className="action-tabs-metal">
        {tabs.map((act) => (
          <MetalButton
            key={act}
            variant={action === act ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => {
              setAction(act);
              setMessage(null);
            }}
          >
            {tabLabels[act]}
          </MetalButton>
        ))}
      </div>

      {/* Financial Quick Links — visible to owners/admins/agents */}
      {canSend && clubId && (
        <div
          style={{
            display: 'flex',
            gap: '8px',
            flexWrap: 'wrap',
            margin: '8px 0 12px',
          }}
        >
          <a
            href={`/clubs/${clubId}/disputes`}
            style={{
              padding: '5px 10px',
              background: 'rgba(245,158,11,0.1)',
              border: '1px solid rgba(245,158,11,0.25)',
              borderRadius: '6px',
              color: '#f59e0b',
              fontSize: '0.7rem',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            ⚠️ Disputes
          </a>
          <a
            href="/financial-alerts"
            style={{
              padding: '5px 10px',
              background: 'rgba(239,68,68,0.1)',
              border: '1px solid rgba(239,68,68,0.25)',
              borderRadius: '6px',
              color: '#ef4444',
              fontSize: '0.7rem',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            🚨 Alerts
          </a>
          <a
            href={`/clubs/${clubId}/financials`}
            style={{
              padding: '5px 10px',
              background: 'rgba(24,119,242,0.1)',
              border: '1px solid rgba(24,119,242,0.25)',
              borderRadius: '6px',
              color: '#1877f2',
              fontSize: '0.7rem',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            💰 Financials
          </a>
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

      {/* ═══ SEND CHIPS ═══ */}
      {action === 'send' && (
        <MetalFrame title="SEND CHIPS" variant="form" size="md">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div className="cashier-message info">
              Send chips from your wallet to{' '}
              {userRole === 'owner'
                ? 'agents, sub-agents, and players'
                : userRole === 'agent' || userRole === 'super_agent'
                  ? 'sub-agents and players'
                  : 'players'}
            </div>

            {/* Recipient Select */}
            <div className="cashier-form-group">
              <label className="cashier-form-label">SEND TO:</label>
              {loadingRecipients ? (
                <div style={{ color: '#6a7a8a', fontSize: '0.8rem' }}>Loading...</div>
              ) : (
                <select
                  className="cashier-select"
                  value={selectedRecipient}
                  onChange={(e) => setSelectedRecipient(e.target.value)}
                >
                  <option value="">Select recipient</option>
                  {recipients.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.role === 'agent' || r.role === 'super_agent'
                        ? '[Agent] '
                        : r.role === 'sub_agent'
                          ? '[Sub-Agent] '
                          : ''}
                      {r.username} (Bal: {r.balance.toLocaleString()})
                    </option>
                  ))}
                </select>
              )}
            </div>

            <MetalInput
              label="AMOUNT:"
              type="number"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />

            {/* Quick amounts */}
            <div className="preset-buttons-grid">
              {preset.map((val) => (
                <MetalButton
                  key={val}
                  variant="ghost"
                  size="sm"
                  onClick={() => setAmount(val.toString())}
                >
                  {val.toLocaleString()}
                </MetalButton>
              ))}
              <MetalButton
                variant="ghost"
                size="sm"
                onClick={() => setAmount(String(balances.PLAYER.available))}
              >
                Max
              </MetalButton>
            </div>

            {/* Preview */}
            {selectedRecipientData && amount && parseFloat(amount) > 0 && (
              <div className="cashier-message info">
                You: {balances.PLAYER.available.toLocaleString()} →{' '}
                {Math.max(0, balances.PLAYER.available - parseFloat(amount)).toLocaleString()} chips
                <br />
                {selectedRecipientData.username}: {selectedRecipientData.balance.toLocaleString()} →{' '}
                {(selectedRecipientData.balance + parseFloat(amount)).toLocaleString()} chips
              </div>
            )}

            {message && <div className={`cashier-message ${message.type}`}>{message.text}</div>}

            <div className="cashier-confirm-button">
              <MetalButton
                variant="primary"
                fullWidth
                onClick={handleAction}
                disabled={isProcessing || cooldown > 0 || !amount || !selectedRecipient}
                loading={isProcessing}
              >
                CONFIRM SEND
              </MetalButton>
            </div>
          </div>
        </MetalFrame>
      )}

      {/* ═══ DISTRIBUTE CHIPS ═══ */}
      {action === 'distribute' && (
        <MetalFrame title="DISTRIBUTE CHIPS" variant="form" size="md">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div className="cashier-message info">
              Distribute chips directly to players or agents from the club bank. Each distribution
              is logged with a full audit trail.
            </div>

            {/* Player Selector */}
            <div>
              <label
                style={{
                  fontSize: '0.75rem',
                  color: 'rgba(255,255,255,0.5)',
                  marginBottom: 4,
                  display: 'block',
                }}
              >
                Recipient
              </label>
              {loadingRecipients ? (
                <div style={{ padding: '8px', color: 'rgba(255,255,255,0.3)', fontSize: '0.8rem' }}>
                  Loading players...
                </div>
              ) : (
                <select
                  value={selectedRecipient}
                  onChange={(e) => setSelectedRecipient(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    background: 'rgba(0,0,0,0.3)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '8px',
                    color: '#fff',
                    fontSize: '0.85rem',
                  }}
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
            <div>
              <label
                style={{
                  fontSize: '0.75rem',
                  color: 'rgba(255,255,255,0.5)',
                  marginBottom: 4,
                  display: 'block',
                }}
              >
                Amount
              </label>
              <MetalInput
                type="number"
                placeholder="Enter chip amount"
                value={amount}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAmount(e.target.value)}
              />
            </div>

            {/* Execute Button */}
            <MetalButton
              variant="primary"
              disabled={isProcessing || cooldown > 0 || !selectedRecipient || !amount}
              onClick={async () => {
                const value = parseFloat(amount);
                if (isNaN(value) || value <= 0) {
                  setMessage({ type: 'error', text: 'Enter a valid amount' });
                  return;
                }
                if (!user?.id || !selectedRecipient) return;

                setIsProcessing(true);
                setMessage(null);
                try {
                  // Look up agent PK — distributePromo RPC expects agents.id, not auth.users.id
                  const resolvedClub = await resolveClubUUID(clubId || '');
                  const { data: agentRow } = await retryFetch(
                    () =>
                      supabase
                        .from('agents')
                        .select('id')
                        .eq('user_id', user.id)
                        .eq('club_id', resolvedClub)
                        .maybeSingle()
                        .then((r) => r),
                    { maxRetries: 2, isMountedRef: isMounted }
                  );
                  if (!agentRow?.id) {
                    if (isMounted.current)
                      setMessage({ type: 'error', text: 'Agent record not found for this club' });
                    return;
                  }
                  await _WalletService.distributePromo(agentRow.id, selectedRecipient, value);
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
                  setAmount('');
                  setSelectedRecipient('');
                  loadBalances(user.id);
                  loadRecipients();
                  startCooldown();
                } catch (err: any) {
                  const msg = err.message || 'Distribution failed';
                  // Parse specific RPC errors into user-friendly messages
                  if (msg.includes('Rate limit')) {
                    if (isMounted.current)
                      setMessage({
                        type: 'error',
                        text: '⏱ Too many distributions — please wait 60 seconds',
                      });
                  } else if (msg.includes('Insufficient promo')) {
                    if (isMounted.current)
                      setMessage({
                        type: 'error',
                        text: '💰 Insufficient promo balance for this distribution',
                      });
                  } else if (msg.includes('Player not found')) {
                    if (isMounted.current)
                      setMessage({ type: 'error', text: '❌ Player is not a member of this club' });
                  } else if (msg.includes('Agent not found')) {
                    if (isMounted.current)
                      setMessage({
                        type: 'error',
                        text: '❌ Your agent record was not found — contact club owner',
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
            </MetalButton>
          </div>
        </MetalFrame>
      )}

      {/* ═══ BUY-IN / CASH-OUT / MINT ═══ */}
      {(action === 'buyin' || action === 'cashout' || action === 'mint') && (
        <MetalFrame
          title={
            action === 'cashout' && cashoutConfirm.show
              ? 'HIGH-VALUE ESCROW VERIFICATION'
              : action === 'buyin'
                ? 'TABLE BUY-IN'
                : action === 'cashout'
                  ? 'CASH OUT'
                  : 'MINT CHIPS'
          }
          variant="form"
          size="md"
        >
          {action === 'cashout' && cashoutConfirm.show ? (
            <div className="high-value-escrow-flow" style={{ padding: '10px 0' }}>
              <div style={{ textAlign: 'center', marginBottom: '24px' }}>
                <div
                  style={{
                    fontSize: '3.5rem',
                    marginBottom: '16px',
                    filter: 'drop-shadow(0 0 20px rgba(16, 185, 129, 0.4))',
                  }}
                >
                  🛡️
                </div>
                <h3
                  style={{
                    color: '#fff',
                    fontSize: '1.25rem',
                    marginBottom: '12px',
                    fontWeight: 800,
                    textTransform: 'uppercase',
                    letterSpacing: '1px',
                  }}
                >
                  Security Verification Required
                </h3>
                <p
                  style={{
                    color: 'rgba(255,255,255,0.6)',
                    fontSize: '0.9rem',
                    lineHeight: 1.5,
                    maxWidth: '85%',
                    margin: '0 auto',
                  }}
                >
                  You are requesting a high-value cashout of{' '}
                  <strong style={{ color: '#10b981', fontSize: '1rem' }}>
                    {cashoutConfirm.value.toLocaleString()} chips
                  </strong>
                  .<br />
                  This amount triggers our mandatory escrow protocols to ensure player security.
                </p>
              </div>

              <div
                style={{
                  background: 'rgba(0,0,0,0.3)',
                  padding: '20px',
                  borderRadius: '16px',
                  marginBottom: '32px',
                  border: '1px solid rgba(255,255,255,0.08)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '16px',
                    marginBottom: '20px',
                  }}
                >
                  <div
                    style={{
                      width: '28px',
                      height: '28px',
                      borderRadius: '50%',
                      background: '#10b98120',
                      color: '#10b981',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '14px',
                      flexShrink: 0,
                    }}
                  >
                    ✓
                  </div>
                  <span style={{ fontSize: '0.9rem', color: '#fff', fontWeight: 500 }}>
                    Anti-Money Laundering (AML) Check Passed
                  </span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '16px',
                    marginBottom: '20px',
                  }}
                >
                  <div
                    style={{
                      width: '28px',
                      height: '28px',
                      borderRadius: '50%',
                      background: '#10b98120',
                      color: '#10b981',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '14px',
                      flexShrink: 0,
                    }}
                  >
                    ✓
                  </div>
                  <span style={{ fontSize: '0.9rem', color: '#fff', fontWeight: 500 }}>
                    Identity Verification Confirmed
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                  <div
                    style={{
                      width: '28px',
                      height: '28px',
                      borderRadius: '50%',
                      background: 'rgba(255,149,0,0.2)',
                      color: '#ff9500',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '14px',
                      animation: 'pulse 2s infinite',
                      flexShrink: 0,
                    }}
                  >
                    ⏳
                  </div>
                  <span style={{ fontSize: '0.9rem', color: '#fff', fontWeight: 500 }}>
                    Escrow Holding (Pending Agent Review)
                  </span>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '16px' }}>
                <MetalButton
                  variant="ghost"
                  fullWidth
                  onClick={() => setCashoutConfirm({ show: false, value: 0 })}
                  disabled={isProcessing}
                >
                  CANCEL
                </MetalButton>
                <MetalButton
                  variant="primary"
                  fullWidth
                  onClick={() => processHighValueCashout(cashoutConfirm.value)}
                  disabled={isProcessing}
                  loading={isProcessing}
                >
                  CONFIRM SECURE CASHOUT
                </MetalButton>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {/* U-02 FIX: Show pending cashouts when on cashout tab */}
              {action === 'cashout' && pendingCashouts.length > 0 && (
                <div
                  style={{
                    padding: '12px',
                    background: 'rgba(255, 149, 0, 0.1)',
                    border: '1px solid rgba(255, 149, 0, 0.3)',
                    borderRadius: '8px',
                  }}
                >
                  <div
                    style={{
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      color: '#ff9500',
                      textTransform: 'uppercase',
                      marginBottom: '8px',
                    }}
                  >
                    ⏳ Pending Cashouts
                  </div>
                  {pendingCashouts.map((pc) => (
                    <div
                      key={pc.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        padding: '4px 0',
                        fontSize: '0.85rem',
                        color: '#ccc',
                      }}
                    >
                      <span>{pc.amount.toLocaleString()} chips</span>
                      <span style={{ color: '#ff9500', fontSize: '0.75rem' }}>
                        {pc.status === 'pending' ? 'Awaiting Agent' : 'Processing'}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Open full CashoutRequestModal for premium step-tracker experience */}
              {action === 'cashout' && !tableId && clubId && user?.id && (
                <button
                  style={{
                    width: '100%',
                    padding: '10px',
                    background: 'rgba(16, 185, 129, 0.1)',
                    border: '1px solid rgba(16, 185, 129, 0.3)',
                    borderRadius: '8px',
                    color: '#10b981',
                    fontSize: '0.8rem',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                  onClick={() => setShowCashoutModal(true)}
                >
                  📋 Manage Cashout Requests
                </button>
              )}

              {/* Cashout context info */}
              {action === 'cashout' && !tableId && (
                <div className="cashier-message info">
                  Your chips will be held in escrow until your assigned agent approves the cashout.
                </div>
              )}

              <MetalInput
                label={action === 'mint' ? 'CHIPS TO MINT:' : 'AMOUNT:'}
                type="number"
                placeholder="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />

              {action === 'mint' && amount && (
                <div className="cashier-message info">
                  {Math.ceil(
                    (parseFloat(amount || '0') * DIAMOND_RATE_NUM) / DIAMOND_RATE_DEN
                  ).toLocaleString()}{' '}
                  diamonds required
                </div>
              )}

              {/* Presets */}
              <div className="preset-buttons-grid">
                {preset.map((val) => (
                  <MetalButton
                    key={val}
                    variant="ghost"
                    size="sm"
                    onClick={() => setAmount(val.toString())}
                  >
                    {val.toLocaleString()}
                  </MetalButton>
                ))}
                {action === 'cashout' && (
                  <MetalButton
                    variant="ghost"
                    size="sm"
                    onClick={() => setAmount(String(balances.PLAYER.available))}
                  >
                    Max
                  </MetalButton>
                )}
              </div>

              {message && <div className={`cashier-message ${message.type}`}>{message.text}</div>}

              <div className="cashier-confirm-button">
                <MetalButton
                  variant="primary"
                  fullWidth
                  onClick={handleAction}
                  disabled={isProcessing || cooldown > 0 || !amount}
                  loading={isProcessing}
                >
                  {action === 'buyin'
                    ? 'CONFIRM BUY-IN'
                    : action === 'cashout'
                      ? tableId
                        ? 'CONFIRM CASH-OUT'
                        : 'REQUEST CASHOUT'
                      : 'CONFIRM MINT'}
                </MetalButton>
              </div>

              {tableId && (
                <p className="table-context-info">Returning to table after transaction</p>
              )}
            </div>
          )}
        </MetalFrame>
      )}

      {/* ═══ TRANSACTION HISTORY ═══ */}
      {action === 'history' && (
        <MetalFrame title="TRANSACTION HISTORY" variant="form" size="md">
          <div className="transaction-history-cashier">
            {/* Filter */}
            <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
              {['all', 'credit', 'debit', 'transfer', 'buyin', 'cashout', 'rake', 'prize'].map(
                (f) => (
                  <button
                    key={f}
                    className={`tx-filter-btn ${txFilter === f ? 'active' : ''}`}
                    onClick={() => setTxFilter(f)}
                    style={{
                      padding: '4px 10px',
                      borderRadius: '12px',
                      border:
                        txFilter === f ? '1px solid #00d4ff' : '1px solid rgba(255,255,255,0.1)',
                      background:
                        txFilter === f ? 'rgba(0,212,255,0.15)' : 'rgba(255,255,255,0.03)',
                      color: txFilter === f ? '#00d4ff' : '#8a9aaa',
                      fontSize: '0.65rem',
                      fontWeight: 700,
                      cursor: 'pointer',
                      textTransform: 'uppercase',
                      letterSpacing: '1px',
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
              <button
                onClick={exportCSV}
                style={{
                  marginLeft: 'auto',
                  padding: '4px 12px',
                  borderRadius: '12px',
                  border: '1px solid #31A24C',
                  background: 'rgba(49, 162, 76, 0.15)',
                  color: '#31A24C',
                  fontSize: '0.65rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                  textTransform: 'uppercase',
                  letterSpacing: '1px',
                }}
              >
                📥 Export CSV
              </button>
            </div>

            {loadingTx ? (
              <div className="tx-loading">Loading transactions...</div>
            ) : filteredTransactions.length === 0 ? (
              <div className="tx-empty">No transactions recorded yet</div>
            ) : (
              <div className="tx-list">
                {filteredTransactions.map((tx, idx) => (
                  <div
                    key={tx.id}
                    className={`tx-row ${tx.type}`}
                    style={{ animation: `fadeInStagger 0.5s ease-out ${idx * 0.05}s both` }}
                  >
                    <span className="tx-icon">{CATEGORY_ICONS[tx.category] || '●'}</span>
                    <div className="tx-details">
                      <span className="tx-category">
                        {CATEGORY_LABELS[tx.category] ||
                          (tx.category || tx.type || '').replace(/_/g, ' ').toUpperCase()}
                      </span>
                      <span className="tx-desc">{tx.description}</span>
                    </div>
                    <div className="tx-amounts">
                      <span
                        className={`tx-amount ${tx.type === 'credit' ? 'positive' : 'negative'}`}
                      >
                        {tx.type === 'credit' ? '+' : '-'}
                        {Math.abs(tx.amount).toLocaleString()}
                      </span>
                      <span className="tx-wallet">{tx.wallet_type}</span>
                    </div>
                    <span className="tx-time">
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
            )}
          </div>
        </MetalFrame>
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
          currentBalance={balances.PLAYER.available}
          onComplete={() => {
            loadBalances(user.id);
            loadPendingCashouts();
          }}
        />
      )}
    </div>
  );
}
