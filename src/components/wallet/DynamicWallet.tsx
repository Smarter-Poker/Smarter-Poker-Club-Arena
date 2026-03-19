/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DYNAMIC WALLET — Metal Panel UI with Background Images
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Uses the exact user-provided metal panel images as backgrounds.
 * Dynamic balance values are overlaid on the black LCD display areas.
 *
 * Three variants auto-detected from role:
 *   'player' — Chip Wallet, Agent Wallet, Promo Wallet
 *   'owner'  — Club Bank, Agent Wallet, Promo Wallet
 *   'union'  — Union Bank, Clubs Wallet, Promo Wallet, Backup BBJ
 *
 * All variants: Diamond Balance (+buy), BBJ main pool
 *
 * Real-time data flow:
 *   1. Initial fetch via Supabase REST
 *   2. Supabase Realtime subscriptions on profiles, club_members, bbj_pools, agents
 *   3. MasterBus subscriptions: BALANCE_UPDATED, DIAMOND_BALANCE_CHANGED,
 *      WALLET_REFRESHED, CHIPS_ADDED, CHIPS_DISTRIBUTED, CHIPS_WITHDRAWN
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useMasterBusSubscriptions } from '../../hooks/useMasterBusSubscription';
import { supabase } from '../../lib/supabase';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import './DynamicWallet.css';

// Panel background images — use BASE_URL prefix for production serving
const BASE = import.meta.env.BASE_URL || '/hub/club-arena/';
const PANEL_IMAGES: Record<string, string> = {
  player: `${BASE}images/wallet-panel-player.png`,
  owner: `${BASE}images/wallet-panel-owner.png`,
  union: `${BASE}images/wallet-panel-union.png`,
};

// All bus events that should trigger a wallet refresh
const WALLET_BUS_EVENTS = [
  'BALANCE_UPDATED',
  'DIAMOND_BALANCE_CHANGED',
  'WALLET_REFRESHED',
  'CHIPS_ADDED',
  'CHIPS_WITHDRAWN',
  'CHIPS_DISTRIBUTED',
] as const;

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
  const isMounted = useIsMounted();

  // Resolved UUID — DynamicWallet now handles resolution internally
  // This ensures correct Supabase queries regardless of whether clubId is
  // a short numeric ID or a full UUID.
  const [resolvedId, setResolvedId] = useState<string | null>(null);

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

  // Animated values
  const animDiamonds = useAnimatedCounter(data.diamonds);
  const animBBJ = useAnimatedCounter(data.bbjPool);
  const animRow1 = useAnimatedCounter(
    variant === 'union' ? data.unionBank : variant === 'owner' ? data.clubBank : data.chipBalance
  );
  const animRow2 = useAnimatedCounter(variant === 'union' ? data.clubBank : data.agentBalance);
  const animRow3 = useAnimatedCounter(data.promoBalance);
  const animBackupBBJ = useAnimatedCounter(data.backupBBJ);

  // ── Fetch data — uses resolvedId (UUID) for all Supabase queries ───────────
  const fetchData = useCallback(async () => {
    if (!userId || !resolvedId) return;

    try {
      const [profileRes, memberRes, bbjRes, agentRes, clubAgentsRes] = await Promise.all([
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
        supabase
          .from('agents')
          .select('agent_wallet_balance')
          .eq('club_id', resolvedId)
          .eq('status', 'active'),
      ]);

      if (isMounted.current) {
        setData({
          diamonds: Number(profileRes.data?.diamonds) || 0,
          chipBalance: Number(memberRes.data?.chip_balance) || 0,
          promoBalance: Number(agentRes.data?.promo_wallet_balance) || 0,
          bbjPool: Number(bbjRes.data?.main_balance) || 0,
          backupBBJ: Number(bbjRes.data?.backup_balance) || 0,
          agentBalance: Number(agentRes.data?.agent_wallet_balance) || 0,
          clubBank: Array.isArray(clubAgentsRes.data)
            ? clubAgentsRes.data.reduce(
                (sum: number, a: { agent_wallet_balance: number | null }) =>
                  sum + (Number(a.agent_wallet_balance) || 0),
                0
              )
            : 0,
          unionBank: 0,
        });
        setLoading(false);
      }
    } catch (err) {
      console.error('[DynamicWallet] Fetch error:', err);
      if (isMounted.current) setLoading(false);
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

  // ── Realtime subscriptions — profiles, club_members, bbj_pools, agents ─────
  useEffect(() => {
    if (!userId || !resolvedId) return;

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
        if (status === 'CHANNEL_ERROR') {
          console.error('[DynamicWallet] ❌ Realtime channel error:', err?.message || err);
        }
        if (status === 'TIMED_OUT') {
          console.warn('[DynamicWallet] ⏱️ Realtime channel timed out');
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, resolvedId]);

  if (loading) {
    return <div className="dynamic-wallet dynamic-wallet--loading">Loading balances...</div>;
  }

  const panelClass = `dynamic-wallet__panel dynamic-wallet__panel--${variant}`;

  return (
    <div className="dynamic-wallet">
      <div className={panelClass} onClick={onOpenBBJ}>
        {/* Metal panel background image */}
        <img
          src={PANEL_IMAGES[variant]}
          alt={`${variant} wallet panel`}
          className="dynamic-wallet__panel-bg"
          draggable={false}
        />

        {/* Overlay: Dynamic values positioned over the black LCD areas */}
        <div className="dynamic-wallet__overlay">
          {/* Diamond Balance — top LCD */}
          <div className="dynamic-wallet__diamond-display">
            <span className="dynamic-wallet__diamond-value">💎 {formatBalance(animDiamonds)}</span>
          </div>

          {/* BBJ Amount — second LCD */}
          <div className="dynamic-wallet__bbj-display">
            <span className="dynamic-wallet__bbj-value">
              {animBBJ === 0 ? '—' : formatBalance(animBBJ)}
            </span>
          </div>

          {/* Row 1: Chip Wallet / Club Bank / Union Bank */}
          <div className="dynamic-wallet__row-1">
            <span className="dynamic-wallet__row-value">{formatBalance(animRow1)}</span>
          </div>

          {/* Row 2: Agent Wallet / Clubs Wallet */}
          <div className="dynamic-wallet__row-2">
            <span className="dynamic-wallet__row-value">{formatBalance(animRow2)}</span>
          </div>

          {/* Row 3: Promo Wallet */}
          <div className="dynamic-wallet__row-3">
            <span className="dynamic-wallet__row-value">{formatBalance(animRow3)}</span>
          </div>

          {/* Row 4: Backup BBJ (Union only) */}
          {variant === 'union' && (
            <div className="dynamic-wallet__row-4">
              <span className="dynamic-wallet__row-value">
                {animBackupBBJ === 0 ? '—' : formatBalance(animBackupBBJ)}
              </span>
            </div>
          )}

          {/* Interactive + buttons */}
          {onBuyDiamonds && variant === 'union' && (
            <button
              className="dynamic-wallet__plus-btn dynamic-wallet__plus-btn--diamond"
              onClick={(e) => {
                e.stopPropagation();
                onBuyDiamonds();
              }}
              aria-label="Buy Diamonds"
            />
          )}
          {onMintChips && variant === 'union' && (
            <button
              className="dynamic-wallet__plus-btn dynamic-wallet__plus-btn--row1"
              onClick={(e) => {
                e.stopPropagation();
                onMintChips();
              }}
              aria-label="Mint Chips"
            />
          )}
        </div>
      </div>
    </div>
  );
}
