/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DYNAMIC WALLET — Real-Time Balance Display Widget
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Consolidated from World Hub `components/club-arena/DynamicWallet.jsx`.
 *
 * Three variants auto-detected from role:
 *   'player' — Chip Wallet, Agent Wallet (if agent), Promo Wallet
 *   'owner'  — Club Bank (treasury), Agent Wallet, Promo Wallet
 *   'union'  — Union Bank (+mint), Clubs Wallet, Promo Wallet, Backup BBJ
 *
 * All variants: Diamond Balance (+buy), BBJ main pool
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import './DynamicWallet.css';

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
// ANIMATED COUNTER
// ═══════════════════════════════════════════════════════════════════════════════

function useAnimatedCounter(target: number, duration = 400) {
  const [value, setValue] = useState(target);
  const rafId = useRef<number | null>(null);
  // Use ref to avoid stale closure capturing previous `value` on rapid target changes
  const currentValueRef = useRef(value);
  currentValueRef.current = value;

  useEffect(() => {
    const start = currentValueRef.current;
    const diff = target - start;
    if (Math.abs(diff) < 1) {
      setValue(target);
      return;
    }

    const startTime = performance.now();
    const animate = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(start + diff * eased));
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
// WALLET CARD
// ═══════════════════════════════════════════════════════════════════════════════

function WalletCard({
  label,
  value: rawValue,
  color,
  icon,
  onClick,
  actionLabel,
}: {
  label: string;
  value: number;
  color: string;
  icon: string;
  onClick?: () => void;
  actionLabel?: string;
}) {
  const display = useAnimatedCounter(rawValue);

  return (
    <div className="dynamic-wallet__card" style={{ borderColor: `${color}30` }}>
      <div className="dynamic-wallet__card-header">
        <span className="dynamic-wallet__card-icon">{icon}</span>
        <span className="dynamic-wallet__card-label">{label}</span>
      </div>
      <div className="dynamic-wallet__card-value" style={{ color }}>
        {display.toLocaleString()}
      </div>
      {onClick && (
        <button
          className="dynamic-wallet__card-action"
          style={{ borderColor: `${color}50`, color }}
          onClick={onClick}
        >
          + {actionLabel || 'Buy'}
        </button>
      )}
    </div>
  );
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

  const fetchData = useCallback(async () => {
    if (!userId || !clubId) return;
    setLoading(true);

    try {
      // Parallel fetches for all balance sources
      const [profileRes, memberRes, bbjRes, agentRes, clubRes] = await Promise.all([
        supabase.from('profiles').select('diamonds').eq('id', userId).maybeSingle(),
        supabase
          .from('club_members')
          .select('chip_balance')
          .eq('club_id', clubId)
          .eq('user_id', userId)
          .maybeSingle(),
        supabase
          .from('bbj_pools')
          .select('main_balance, backup_balance')
          .eq('club_id', clubId)
          .maybeSingle(),
        supabase
          .from('agents')
          .select('agent_wallet_balance, promo_wallet_balance')
          .eq('club_id', clubId)
          .eq('user_id', userId)
          .maybeSingle(),
        // Club bank: sum of all agent wallet balances for this club
        supabase
          .from('agents')
          .select('agent_wallet_balance')
          .eq('club_id', clubId)
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
          clubBank: Array.isArray(clubRes.data)
            ? clubRes.data.reduce(
                (sum: number, a: any) => sum + (Number(a.agent_wallet_balance) || 0),
                0
              )
            : 0,
          unionBank: 0,
        });
      }
    } catch (err) {
      console.error('[DynamicWallet] Fetch error:', err);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [userId, clubId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ── MasterBus: Refresh on balance changes ──────────────────────────────────
  useEffect(() => {
    const unsubBalance = masterBus.subscribe('BALANCE_UPDATED', () => {
      fetchData();
    });
    const unsubDiamond = masterBus.subscribe('DIAMOND_BALANCE_CHANGED', () => {
      fetchData();
    });
    return () => {
      unsubBalance();
      unsubDiamond();
    };
  }, [fetchData]);

  // ── Realtime subscriptions ─────────────────────────────────────────────────
  useEffect(() => {
    if (!userId || !clubId) return;

    const channel = supabase
      .channel(`dynamic-wallet-${clubId}-${userId}`)
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
          if (isMounted.current && p.new?.club_id === clubId) {
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
          filter: `club_id=eq.${clubId}`,
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
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, clubId]);

  if (loading) {
    return <div className="dynamic-wallet dynamic-wallet--loading">Loading balances...</div>;
  }

  return (
    <div className="dynamic-wallet">
      {/* Diamond Balance — Available for all variants */}
      <WalletCard
        label="Diamonds"
        value={data.diamonds}
        color="#00d4ff"
        icon="💎"
        onClick={onBuyDiamonds}
        actionLabel="Buy"
      />

      {/* BBJ Pool — Available for all variants */}
      <WalletCard
        label="BBJ Pool"
        value={data.bbjPool}
        color="#ffd700"
        icon="🏆"
        onClick={onOpenBBJ}
        actionLabel="Info"
      />

      {/* Player variant */}
      {variant === 'player' && (
        <>
          <WalletCard label="Chip Balance" value={data.chipBalance} color="#22c55e" icon="🪙" />
          {data.agentBalance > 0 && (
            <WalletCard label="Agent Balance" value={data.agentBalance} color="#3b82f6" icon="👤" />
          )}
          {data.promoBalance > 0 && (
            <WalletCard label="Promo Balance" value={data.promoBalance} color="#9333ea" icon="🎁" />
          )}
        </>
      )}

      {/* Owner variant */}
      {variant === 'owner' && (
        <>
          <WalletCard label="Club Bank" value={data.clubBank} color="#22c55e" icon="🏦" />
          <WalletCard label="Agent Balance" value={data.agentBalance} color="#3b82f6" icon="👤" />
          <WalletCard label="Promo Balance" value={data.promoBalance} color="#9333ea" icon="🎁" />
        </>
      )}

      {/* Union variant */}
      {variant === 'union' && (
        <>
          <WalletCard
            label="Union Bank"
            value={data.unionBank}
            color="#22c55e"
            icon="🏛️"
            onClick={onMintChips}
            actionLabel="Mint"
          />
          <WalletCard label="Club Bank" value={data.clubBank} color="#3b82f6" icon="🏦" />
          <WalletCard label="Promo Balance" value={data.promoBalance} color="#9333ea" icon="🎁" />
          <WalletCard label="Backup BBJ" value={data.backupBBJ} color="#f59e0b" icon="🛡️" />
        </>
      )}
    </div>
  );
}
