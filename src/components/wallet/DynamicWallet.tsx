/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DYNAMIC WALLET — Compact PokerBros-Style Inline Display
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Compact wallet display positioned below the club card.
 * Shows BBJ banner + role-specific wallet balance rows with action buttons.
 *
 * Three variants auto-detected from role:
 *   'player' — Chip Balance, Agent Wallet, Promo Wallet
 *   'owner'  — Club Bank, Agent Wallet, Promo Wallet
 *   'union'  — Union Bank, Clubs Wallet, Promo Wallet, Backup BBJ
 *
 * All variants: Diamond Balance (+buy), BBJ main pool
 *
 * Real-time data flow:
 *   1. Initial fetch via Supabase REST
 *   2. Supabase Realtime subscriptions on profiles, club_members, bbj_pools,
 *      agents, clubs, union_wallets
 *   3. MasterBus subscriptions: BALANCE_UPDATED, DIAMOND_BALANCE_CHANGED,
 *      WALLET_REFRESHED, CHIPS_ADDED, CHIPS_DISTRIBUTED, CHIPS_WITHDRAWN,
 *      CLUB_UPDATED, SETTLEMENT_COMPLETED, COMMISSION_PAID
 *
 * Improvements (v2):
 *   - Loading skeleton (shimmer) instead of flash-of-zeros
 *   - Error state with retry button
 *   - RT channel reconnect with exponential backoff
 *   - union_wallets RT channel for instant union bank updates
 *   - Accessibility: keyboard handlers, focus indicators, aria-live
 *   - Mint button gated to owner/union only
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useMasterBusSubscriptions } from '../../hooks/useMasterBusSubscription';
import { supabase } from '../../lib/supabase';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import './DynamicWallet.css';

// All bus events that should trigger a wallet refresh
const WALLET_BUS_EVENTS = [
  'BALANCE_UPDATED',
  'DIAMOND_BALANCE_CHANGED',
  'WALLET_REFRESHED',
  'CHIPS_ADDED',
  'CHIPS_WITHDRAWN',
  'CHIPS_DISTRIBUTED',
  'CLUB_UPDATED',
  'SETTLEMENT_COMPLETED',
  'COMMISSION_PAID',
] as const;

// Reconnect backoff delays (ms)
const BACKOFF_DELAYS = [2000, 4000, 8000, 16000, 30000];

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

type WalletVariant = 'player' | 'owner' | 'union';

interface DynamicWalletProps {
  userId: string;
  clubId: string;
  variant?: WalletVariant;
  onBuyDiamonds?: () => void;
  onMintChips?: () => void;
  onOpenBBJ?: () => void;
}

interface WalletData {
  diamonds: number;
  bbjPool: number;
  chipBalance: number;
  clubBank: number;
  agentBalance: number;
  promoBalance: number;
  unionBank: number;
  backupBBJ: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANIMATED COUNTER — preserves fractional precision (2 decimal places)
// ═══════════════════════════════════════════════════════════════════════════════

function useAnimatedCounter(target: number, duration = 400): number {
  const [value, setValue] = useState(target);
  const rafId = useRef<number | null>(null);
  const currentValueRef = useRef(value);
  currentValueRef.current = value;

  useEffect(() => {
    const start = currentValueRef.current;
    const diff = target - start;
    if (Math.abs(diff) < 0.01) {
      setValue(target);
      return;
    }

    const startTime = performance.now();
    const animate = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      // Preserve 2-decimal precision instead of Math.round (which loses cents)
      const interpolated = start + diff * eased;
      setValue(Math.round(interpolated * 100) / 100);
      if (progress < 1) rafId.current = requestAnimationFrame(animate);
    };
    rafId.current = requestAnimationFrame(animate);
    return () => {
      if (rafId.current) cancelAnimationFrame(rafId.current);
    };
  }, [target, duration]);

  return value;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FORMAT NUMBER
// ═══════════════════════════════════════════════════════════════════════════════

function formatBalance(num: number): string {
  return Math.abs(num).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function DynamicWallet({
  userId,
  clubId,
  variant = 'player',
  onBuyDiamonds,
  onMintChips,
  onOpenBBJ,
}: DynamicWalletProps) {
  const [data, setData] = useState<WalletData>({
    diamonds: 0,
    bbjPool: 0,
    chipBalance: 0,
    clubBank: 0,
    agentBalance: 0,
    promoBalance: 0,
    unionBank: 0,
    backupBBJ: 0,
  });
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [isClubInUnion, setIsClubInUnion] = useState(false);
  const isMounted = useIsMounted();

  // Resolved UUID — DynamicWallet now handles resolution internally
  const [resolvedId, setResolvedId] = useState<string | null>(null);
  // Fetch version counter to discard stale responses on rapid club switching
  const fetchVersionRef = useRef(0);
  // Tracked union_id for union_wallets RT channel
  const currentUnionIdRef = useRef<string | null>(null);
  // Reconnect tracking
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);

  useEffect(() => {
    if (!clubId) {
      setResolvedId(null);
      return;
    }
    resolveClubUUID(clubId)
      .then((uuid) => {
        if (isMounted.current) setResolvedId(uuid);
      })
      .catch((err) => {
        console.warn('[DynamicWallet] Failed to resolve clubId:', err);
        // Fallback: use raw clubId (it might already be a UUID)
        if (isMounted.current) setResolvedId(clubId);
      });
  }, [clubId]);

  // Auto-detect effective variant: if the club is in a union AND parent passed 'owner',
  // auto-upgrade to 'union' so the wallet always shows correct labels.
  const effectiveVariant: WalletVariant = isClubInUnion && variant === 'owner' ? 'union' : variant;

  // Animated values
  const animDiamonds = useAnimatedCounter(data.diamonds);
  const animBBJ = useAnimatedCounter(data.bbjPool);
  const animRow1 = useAnimatedCounter(
    effectiveVariant === 'union'
      ? data.unionBank
      : effectiveVariant === 'owner'
        ? data.clubBank
        : data.chipBalance
  );
  const animRow2 = useAnimatedCounter(
    effectiveVariant === 'union' ? data.clubBank : data.agentBalance
  );
  const animRow3 = useAnimatedCounter(data.promoBalance);
  const animBackupBBJ = useAnimatedCounter(data.backupBBJ);

  // ── Fetch data — uses resolvedId (UUID) for all Supabase queries ───────────
  const fetchData = useCallback(async () => {
    if (!userId || !resolvedId) return;

    // Increment version — any in-flight fetch with a lower version is stale
    const thisVersion = ++fetchVersionRef.current;

    try {
      const [profileRes, memberRes, bbjRes, agentRes, clubRes] = await Promise.all([
        supabase.from('profiles').select('diamonds').eq('id', userId).maybeSingle(),
        supabase
          .from('club_members')
          .select('chip_balance')
          .eq('club_id', resolvedId)
          .eq('user_id', userId)
          .maybeSingle(),
        supabase
          .from('bbj_pools')
          .select('main_balance, backup_balance')
          .eq('club_id', resolvedId)
          .maybeSingle(),
        supabase
          .from('agents')
          .select('agent_wallet_balance, promo_wallet_balance')
          .eq('club_id', resolvedId)
          .eq('user_id', userId)
          .maybeSingle(),
        // Club treasury for owner variant
        supabase.from('clubs').select('chip_treasury, union_id').eq('id', resolvedId).maybeSingle(),
      ]);

      // Discard stale response if a newer fetch has started
      if (thisVersion !== fetchVersionRef.current) return;

      // Fetch union bank balance when the club is in a union
      let unionBankBalance = 0;
      const unionId = clubRes.data?.union_id;
      if (unionId) {
        const { data: uwData } = await supabase
          .from('union_wallets')
          .select('chip_balance')
          .eq('union_id', unionId)
          .maybeSingle();
        unionBankBalance = Number(uwData?.chip_balance) || 0;
      }

      // Double-check version after second await + isMounted
      if (thisVersion !== fetchVersionRef.current || !isMounted.current) return;

      // Track union_id for union_wallets RT channel
      currentUnionIdRef.current = unionId || null;

      setData({
        diamonds: Number(profileRes.data?.diamonds) || 0,
        chipBalance: Number(memberRes.data?.chip_balance) || 0,
        promoBalance: Number(agentRes.data?.promo_wallet_balance) || 0,
        bbjPool: Number(bbjRes.data?.main_balance) || 0,
        backupBBJ: Number(bbjRes.data?.backup_balance) || 0,
        agentBalance: Number(agentRes.data?.agent_wallet_balance) || 0,
        clubBank: Number(clubRes.data?.chip_treasury) || 0,
        unionBank: unionBankBalance,
      });
      // Auto-detect union membership from clubs.union_id
      setIsClubInUnion(!!unionId);
      setFetchError(false);
      setLoading(false);
    } catch (err) {
      console.error('[DynamicWallet] Fetch error:', err);
      if (thisVersion === fetchVersionRef.current && isMounted.current) {
        setFetchError(true);
        setLoading(false);
      }
    }
  }, [userId, resolvedId]);

  useEffect(() => {
    if (resolvedId) fetchData();
  }, [fetchData, resolvedId]);

  // ── MasterBus: Refresh on ALL balance-related events (debounced 500ms) ─────
  useMasterBusSubscriptions(
    [...WALLET_BUS_EVENTS],
    () => {
      fetchData();
    },
    { debounce: 500 }
  );

  // ── Channel reconnect helper ──────────────────────────────────────────────
  const scheduleReconnect = useCallback(() => {
    if (!isMounted.current) return;
    const delay = BACKOFF_DELAYS[Math.min(retryCountRef.current, BACKOFF_DELAYS.length - 1)];
    console.warn(
      `[DynamicWallet] Scheduling reconnect in ${delay}ms (attempt ${retryCountRef.current + 1})`
    );
    reconnectTimerRef.current = setTimeout(() => {
      if (!isMounted.current) return;
      retryCountRef.current++;
      fetchData(); // Full refetch as reconnection fallback
    }, delay);
  }, [fetchData]);

  // Clean up reconnect timer on unmount
  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, []);

  // ── Realtime subscriptions — profiles, club_members, bbj_pools, agents, clubs ─
  useEffect(() => {
    if (!userId || !resolvedId) return;

    // Reset reconnect state on new subscription
    retryCountRef.current = 0;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    const channel = supabase
      .channel(`dynamic-wallet-${resolvedId}-${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'profiles',
          filter: `id=eq.${userId}`,
        },
        (p) => {
          if (isMounted.current && p.new?.diamonds !== undefined) {
            setData((prev) => ({ ...prev, diamonds: Number(p.new.diamonds) || 0 }));
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'club_members',
          filter: `user_id=eq.${userId}`,
        },
        (p) => {
          if (isMounted.current && p.new?.club_id === resolvedId) {
            setData((prev) => ({
              ...prev,
              chipBalance: Number(p.new.chip_balance) || 0,
            }));
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'bbj_pools',
          filter: `club_id=eq.${resolvedId}`,
        },
        (p) => {
          if (isMounted.current) {
            setData((prev) => ({
              ...prev,
              bbjPool: Number(p.new?.main_balance) || 0,
              backupBBJ: Number(p.new?.backup_balance) || 0,
            }));
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'agents',
          filter: `user_id=eq.${userId}`,
        },
        (p) => {
          if (isMounted.current && p.new?.club_id === resolvedId) {
            setData((prev) => ({
              ...prev,
              agentBalance: Number(p.new.agent_wallet_balance) || 0,
              promoBalance: Number(p.new.promo_wallet_balance) || 0,
            }));
          }
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'SUBSCRIBED') {
          // Reset retry count on successful subscription
          retryCountRef.current = 0;
        }
        if (status === 'CHANNEL_ERROR') {
          console.error('[DynamicWallet] ❌ Realtime channel error:', err?.message || err);
          scheduleReconnect();
        }
        if (status === 'TIMED_OUT') {
          console.warn('[DynamicWallet] ⏱️ Realtime channel timed out');
          scheduleReconnect();
        }
      });

    // ── Clubs RT channel: chip_treasury + union_id changes ──
    const clubChannel = supabase
      .channel(`dynamic-wallet-club-${resolvedId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'clubs',
          filter: `id=eq.${resolvedId}`,
        },
        (p) => {
          if (!isMounted.current) return;
          // Update club bank immediately from RT payload
          if (p.new?.chip_treasury !== undefined) {
            setData((prev) => ({
              ...prev,
              clubBank: Number(p.new.chip_treasury) || 0,
            }));
          }
          // If union_id changed (club joined or left a union), do a full refetch
          // to update unionBank and isClubInUnion
          if (p.old?.union_id !== p.new?.union_id) {
            fetchData();
          }
        }
      )
      .subscribe();

    // ── Union wallets RT channel: instant union bank balance updates ──
    // Dynamic — only created if the club is in a union.
    // Uses the unionId from the most recent fetchData to listen for changes.
    let unionWalletChannel: ReturnType<typeof supabase.channel> | null = null;
    const unionId = currentUnionIdRef.current;
    if (unionId) {
      unionWalletChannel = supabase
        .channel(`dynamic-wallet-union-${unionId}`)
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'union_wallets',
            filter: `union_id=eq.${unionId}`,
          },
          (p) => {
            if (isMounted.current && p.new?.chip_balance !== undefined) {
              setData((prev) => ({
                ...prev,
                unionBank: Number(p.new.chip_balance) || 0,
              }));
            }
          }
        )
        .subscribe();
    }

    return () => {
      supabase.removeChannel(channel);
      supabase.removeChannel(clubChannel);
      if (unionWalletChannel) supabase.removeChannel(unionWalletChannel);
    };
  }, [userId, resolvedId, isClubInUnion]);

  // ── Role-specific row config ───────────────────────────────────────────────
  const ROW_CONFIG: Record<WalletVariant, { label: string; icon: string; value: number }[]> = {
    player: [
      { label: 'Chip Balance', icon: '🪙', value: animRow1 },
      { label: 'Agent Wallet', icon: '🅰️', value: animRow2 },
      { label: 'Promo Wallet', icon: '🎟️', value: animRow3 },
    ],
    owner: [
      { label: 'Club Bank', icon: '🏦', value: animRow1 },
      { label: 'Agent Wallet', icon: '🅰️', value: animRow2 },
      { label: 'Promo Wallet', icon: '🎟️', value: animRow3 },
    ],
    union: [
      { label: 'Union Bank', icon: '🏦', value: animRow1 },
      { label: 'Clubs Wallet', icon: '🅰️', value: animRow2 },
      { label: 'Promo Wallet', icon: '🎟️', value: animRow3 },
    ],
  };

  const rows = ROW_CONFIG[effectiveVariant];

  // Only show mint button for owner/union variants (players should never see it)
  const showMintButton =
    onMintChips && (effectiveVariant === 'owner' || effectiveVariant === 'union');

  // ── Keyboard handler for BBJ banner (accessibility) ─────────────────────────
  const handleBbjKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpenBBJ?.();
    }
  };

  // ── Loading skeleton ───────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="dw dw--loading" aria-busy="true" aria-label="Loading wallet">
        <div className="dw__shimmer dw__shimmer--bbj" />
        <div className="dw__rows">
          <div className="dw__shimmer dw__shimmer--row" />
          <div className="dw__shimmer dw__shimmer--row" />
          <div className="dw__shimmer dw__shimmer--row" />
          <div className="dw__shimmer dw__shimmer--row" />
        </div>
      </div>
    );
  }

  return (
    <div className={`dw dw--${effectiveVariant}`} aria-label="Wallet balances">
      {/* ── Error indicator — subtle, non-blocking ──────────────────────── */}
      {fetchError && (
        <button
          className="dw__error-badge"
          onClick={() => {
            setFetchError(false);
            fetchData();
          }}
          aria-label="Retry loading wallet data"
          title="Failed to load — tap to retry"
        >
          ⚠️ Tap to retry
        </button>
      )}

      {/* ── BBJ Banner ────────────────────────────────────────────────────── */}
      <div
        className="dw__bbj"
        onClick={onOpenBBJ}
        onKeyDown={handleBbjKeyDown}
        role="button"
        tabIndex={0}
        aria-label={`Bad Beat Jackpot: ${animBBJ === 0 ? 'no pool' : formatBalance(animBBJ)}`}
      >
        <span className="dw__bbj-label">BAD BEAT JACKPOT</span>
        <span className="dw__bbj-amount">{animBBJ === 0 ? '—' : formatBalance(animBBJ)}</span>
      </div>

      {/* ── Wallet Rows ───────────────────────────────────────────────────── */}
      <div className="dw__rows" aria-live="polite">
        {/* Diamond Balance */}
        <div className="dw__row dw__row--diamond">
          <span className="dw__row-icon" aria-hidden="true">
            💎
          </span>
          <span className="dw__row-value">{formatBalance(animDiamonds)}</span>
          {onBuyDiamonds && (
            <button
              className="dw__plus"
              onClick={(e) => {
                e.stopPropagation();
                onBuyDiamonds();
              }}
              aria-label="Buy Diamonds"
            >
              +
            </button>
          )}
        </div>

        {/* Role-specific wallet rows */}
        {rows.map((row, idx) => (
          <div
            key={row.label}
            className={`dw__row dw__row--wallet${idx === 0 ? ' dw__row--primary' : ''}`}
          >
            <span className="dw__row-icon" aria-hidden="true">
              {row.icon}
            </span>
            <span className="dw__row-label">{row.label}</span>
            <span className="dw__row-value">{formatBalance(row.value)}</span>
            {idx === 0 && showMintButton && (
              <button
                className="dw__plus"
                onClick={(e) => {
                  e.stopPropagation();
                  onMintChips!();
                }}
                aria-label="Mint Chips"
              >
                +
              </button>
            )}
          </div>
        ))}

        {/* Backup BBJ (Union only) */}
        {effectiveVariant === 'union' && (
          <div className="dw__row dw__row--backup-bbj">
            <span className="dw__row-icon" aria-hidden="true">
              🛡️
            </span>
            <span className="dw__row-label">Backup BBJ</span>
            <span className="dw__row-value">
              {animBackupBBJ === 0 ? '—' : formatBalance(animBackupBBJ)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
