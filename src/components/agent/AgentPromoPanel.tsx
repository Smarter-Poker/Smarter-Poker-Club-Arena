/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AgentPromoPanel — Agent Promotional Chip Distribution Panel
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Ported from World Hub → Club Arena (March 2026)
 *
 *  Shown on the Cashier page for agents. Displays promo_balance
 *  and lets agents distribute promo chips to their downline players.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { retryAsync } from '../../utils/retryAsync';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { masterBus } from '../../core/MasterBus';
import { triggerHaptic } from '../../services/HapticService';
import { resolveAvatarDisplay } from '../../utils/avatarUtils';
import { checkSettlementLock } from '../../utils/settlementLock';
import { reportError } from '../../utils/errorReporter';

const FB = {
  bg: '#18191A',
  card: '#242526',
  text: '#E4E6EB',
  dim: '#B0B3B8',
  border: '#3E4042',
  gold: '#FFD700',
  success: '#31A24C',
  danger: '#FA383E',
  promo: '#9333ea',
};

interface DownlinePlayer {
  user_id: string;
  chip_balance?: number;
  promo_balance?: number;
  profiles?: { display_name?: string; username?: string; avatar_url?: string } | null;
}

interface AgentPromoPanelProps {
  clubId: string;
  userId: string;
  role: string;
  onDistribute?: () => void;
}

export default function AgentPromoPanel({
  clubId,
  userId,
  role,
  onDistribute,
}: AgentPromoPanelProps) {
  const [promoBalance, setPromoBalance] = useState(0);
  const [agentPkId, setAgentPkId] = useState<string | null>(null);
  const [downline, setDownline] = useState<DownlinePlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPlayer, setSelectedPlayer] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [distributing, setDistributing] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const isMounted = useIsMounted();
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Rate limit: 10s between distributions
  const lastDistributeRef = useRef(0);
  const DISTRIBUTE_RATE_LIMIT_MS = 10_000;

  const isAgent = ['agent', 'sub_agent', 'super_agent'].includes(role);

  const showToast = (msg: string, type = 'success') => {
    if (!isMounted.current) return;
    setToast({ msg, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => {
      if (isMounted.current) setToast(null);
    }, 3000);
  };

  const loadData = useCallback(async () => {
    if (!clubId || !userId || !isAgent) return;
    setLoading(true);
    try {
      const { data: agent } = await supabase
        .from('agents')
        .select('id, promo_wallet_balance')
        .eq('club_id', clubId)
        .eq('user_id', userId)
        .maybeSingle();
      if (!isMounted.current) return;
      setPromoBalance(Number(agent?.promo_wallet_balance) || 0);
      setAgentPkId(agent?.id || null);

      const { data: players } = await supabase
        .from('club_members')
        .select('user_id, chip_balance')
        .eq('club_id', clubId)
        .eq('agent_id', userId)
        .eq('role', 'player')
        .order('chip_balance', { ascending: false })
        .limit(1000);
      // Batch-fetch profiles (no FK between club_members → profiles)
      const playerProfileMap: Record<string, any> = {};
      if (players && players.length > 0) {
        const pIds = players.map((p: any) => p.user_id);
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, display_name, username, avatar_url')
          .in('id', pIds);
        if (profiles) {
          for (const pr of profiles) playerProfileMap[pr.id] = pr;
        }
      }
      const downlineData = (players || []).map((p: any) => ({
        ...p,
        profiles: playerProfileMap[p.user_id] || {
          display_name: null,
          username: 'Unknown',
          avatar_url: null,
        },
      }));
      if (isMounted.current) setDownline(downlineData as DownlinePlayer[]);
    } catch (e) {
      reportError(e, 'AgentPromoPanel.Load_error');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [clubId, userId, isAgent]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // MasterBus: Auto-refresh on local data mutations
  useMasterBusSubscription('DATA_MUTATED', (payload) => {
    const relevant = ['promo_distributed', 'promo_granted', 'chips_distributed', 'chips_minted'];
    const action = String(payload?.action || '');
    if (relevant.includes(action)) loadData();
  });

  // Realtime Sync: Listen for REMOTE balance changes (via masterBus channel manager)
  useEffect(() => {
    if (!clubId || !userId || !isAgent) return;
    const channelKey = `agent-promo-${clubId}-${userId}`;
    const channel = masterBus
      .getOrCreateChannel(channelKey)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'agents', filter: `user_id=eq.${userId}` },
        (payload) => {
          if (payload.new?.club_id === clubId && isMounted.current)
            setPromoBalance(Number(payload.new?.promo_wallet_balance) || 0);
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'club_members', filter: `agent_id=eq.${userId}` },
        () => {
          if (isMounted.current) loadData();
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'AgentPromoPanel._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[AgentPromoPanel] ⏱️ Realtime channel timed out');
        }
      });

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId, userId, isAgent, loadData]);

  const handleDistribute = async () => {
    if (!selectedPlayer || !amount) return;
    const amt = Math.floor(Number(amount));
    if (!amt || !Number.isFinite(amt) || amt <= 0) {
      showToast('Enter a positive amount', 'error');
      return;
    }
    if (amt > promoBalance) {
      showToast('Insufficient promo balance', 'error');
      return;
    }

    setDistributing(true);
    triggerHaptic('medium');

    // RATE LIMIT — 10s between distributions
    const now = Date.now();
    const elapsed = now - lastDistributeRef.current;
    if (elapsed < DISTRIBUTE_RATE_LIMIT_MS) {
      const waitSec = Math.ceil((DISTRIBUTE_RATE_LIMIT_MS - elapsed) / 1000);
      showToast(`⏱ Please wait ${waitSec}s before distributing again`, 'error');
      setDistributing(false);
      return;
    }

    // SETTLEMENT FREEZE CHECK — block during active settlements
    try {
      const lockResult = await checkSettlementLock(clubId);
      if (lockResult.locked) {
        showToast('🔒 Settlement in progress — distributions frozen', 'error');
        if (isMounted.current) setDistributing(false);
        return;
      }
    } catch (e) {
      reportError(e, 'AgentPromoPanel');
      // Fail-open: allow distribution if settlement check fails
    }

    try {
      if (!agentPkId) {
        showToast('Agent record not found', 'error');
        setDistributing(false);
        return;
      }
      // Direct Supabase RPC for distribution — p_agent_id is agents.id PK, NOT auth.users.id
      const { error } = await retryAsync(
        () =>
          supabase.rpc('distribute_promo_chips', {
            p_agent_id: agentPkId,
            p_player_id: selectedPlayer,
            p_amount: amt,
          }),
        3
      );
      if (error) throw error;

      showToast(`🎉 ${amt.toLocaleString()} promo chips sent!`);
      masterBus.emit('DATA_MUTATED', { table: 'agents', action: 'promo_distributed' });
      masterBus.emit('BALANCE_UPDATED', { source: 'promo_distributed', userId: selectedPlayer });
      if (isMounted.current) {
        setAmount('');
        setSelectedPlayer(null);
        loadData();
        onDistribute?.();
        lastDistributeRef.current = Date.now();
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Distribution failed';
      showToast(msg, 'error');
    } finally {
      if (isMounted.current) setDistributing(false);
    }
  };

  if (!isAgent) return null;
  const PRESETS = [100, 500, 1000, 2500];

  return (
    <div
      style={{
        background: FB.card,
        borderRadius: 12,
        padding: 16,
        border: `1px solid ${FB.border}`,
        marginBottom: 16,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: FB.text }}>🎁 Promo Wallet</div>
          <div style={{ fontSize: 11, color: FB.dim }}>
            Distribute promotional chips to your players
          </div>
        </div>
        <div
          style={{
            background: `${FB.promo}20`,
            border: `1px solid ${FB.promo}60`,
            borderRadius: 8,
            padding: '4px 12px',
          }}
        >
          <div style={{ fontSize: 10, color: FB.promo, fontWeight: 600 }}>PROMO BALANCE</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: FB.promo }}>
            {promoBalance.toLocaleString()}
          </div>
        </div>
      </div>

      {toast && (
        <div
          style={{
            padding: '8px 12px',
            borderRadius: 8,
            marginBottom: 10,
            background: toast.type === 'error' ? '#dc262620' : '#31A24C20',
            color: toast.type === 'error' ? FB.danger : FB.success,
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {toast.msg}
        </div>
      )}

      {loading ? (
        <div style={{ padding: '12px 0' }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 0',
                animation: `shimmerFade 1.4s ease-in-out ${i * 0.1}s infinite`,
              }}
            >
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  background:
                    'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 75%)',
                  backgroundSize: '200px 100%',
                  animation: 'shimmerSlide 1.4s ease-in-out infinite',
                  flexShrink: 0,
                }}
              />
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    width: `${50 + i * 10}%`,
                    height: 12,
                    borderRadius: 4,
                    background:
                      'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 75%)',
                    backgroundSize: '200px 100%',
                    animation: 'shimmerSlide 1.4s ease-in-out infinite',
                    marginBottom: 5,
                  }}
                />
                <div
                  style={{
                    width: '40%',
                    height: 10,
                    borderRadius: 4,
                    background:
                      'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 75%)',
                    backgroundSize: '200px 100%',
                    animation: 'shimmerSlide 1.4s ease-in-out infinite',
                  }}
                />
              </div>
            </div>
          ))}
          <style>{`
            @keyframes shimmerSlide { 0% { background-position: -200px 0; } 100% { background-position: 200px 0; } }
            @keyframes shimmerFade { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
          `}</style>
        </div>
      ) : promoBalance <= 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: '16px 12px',
            background: `${FB.promo}08`,
            borderRadius: 8,
            border: `1px solid ${FB.border}`,
          }}
        >
          <div style={{ fontSize: 24, marginBottom: 6 }}>🎁</div>
          <div style={{ fontSize: 13, color: FB.dim, fontWeight: 600 }}>
            No promo chips available
          </div>
          <div style={{ fontSize: 11, color: FB.dim, marginTop: 4 }}>
            Ask your club owner to grant promo chips from the Admin panel.
          </div>
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 10 }}>
            <label
              style={{
                fontSize: 11,
                color: FB.dim,
                fontWeight: 600,
                marginBottom: 4,
                display: 'block',
              }}
            >
              Select Player ({downline.length} in your downline)
            </label>
            {downline.length === 0 ? (
              <div style={{ fontSize: 12, color: FB.dim, padding: '8px 0' }}>
                No players assigned to you yet.
              </div>
            ) : (
              <select
                value={selectedPlayer || ''}
                onChange={(e) => setSelectedPlayer(e.target.value)}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  background: FB.bg,
                  color: FB.text,
                  border: `1px solid ${FB.border}`,
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                <option value="">Choose a player...</option>
                {downline.map((p) => (
                  <option key={p.user_id} value={p.user_id}>
                    {p.profiles?.display_name || p.profiles?.username || p.user_id.slice(0, 8)}
                    {' — '}Chips: {(p.chip_balance || 0).toLocaleString()}
                  </option>
                ))}
              </select>
            )}
          </div>

          {selectedPlayer && (
            <>
              <div style={{ marginBottom: 8 }}>
                <label
                  style={{
                    fontSize: 11,
                    color: FB.dim,
                    fontWeight: 600,
                    marginBottom: 4,
                    display: 'block',
                  }}
                >
                  Amount
                </label>
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="Enter promo chip amount"
                  min="1"
                  max={promoBalance}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    background: FB.bg,
                    color: FB.text,
                    border: `1px solid ${FB.border}`,
                    borderRadius: 8,
                    fontSize: 15,
                    fontWeight: 700,
                    boxSizing: 'border-box',
                  }}
                />
              </div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
                {PRESETS.filter((p) => p <= promoBalance).map((p) => (
                  <button
                    key={p}
                    onClick={() => setAmount(String(p))}
                    style={{
                      padding: '6px 14px',
                      borderRadius: 6,
                      background: amount === String(p) ? FB.promo : FB.bg,
                      color: amount === String(p) ? '#fff' : FB.dim,
                      border: `1px solid ${FB.border}`,
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    {p.toLocaleString()}
                  </button>
                ))}
                <button
                  onClick={() => setAmount(String(promoBalance))}
                  style={{
                    padding: '6px 14px',
                    borderRadius: 6,
                    background: amount === String(promoBalance) ? FB.promo : FB.bg,
                    color: amount === String(promoBalance) ? '#fff' : FB.dim,
                    border: `1px solid ${FB.border}`,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  ALL
                </button>
              </div>
              <button
                onClick={handleDistribute}
                disabled={distributing || !amount || Math.floor(Number(amount)) <= 0}
                style={{
                  width: '100%',
                  padding: '12px 0',
                  background: distributing
                    ? FB.dim
                    : `linear-gradient(135deg, ${FB.promo}, #7c3aed)`,
                  color: '#fff',
                  border: 'none',
                  borderRadius: 10,
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: distributing ? 'not-allowed' : 'pointer',
                  opacity: distributing ? 0.7 : 1,
                  boxShadow: `0 4px 16px ${FB.promo}40`,
                }}
              >
                {distributing
                  ? 'Sending...'
                  : `🎁 Send ${amount && Math.floor(Number(amount)) > 0 ? Math.floor(Number(amount)).toLocaleString() : '0'} Promo Chips`}
              </button>
            </>
          )}

          {downline.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: FB.dim, marginBottom: 6 }}>
                Your Players
              </div>
              {downline.slice(0, 10).map((p) => {
                const name =
                  p.profiles?.display_name || p.profiles?.username || p.user_id.slice(0, 8);
                return (
                  <div
                    key={p.user_id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 0',
                      borderBottom: `1px solid ${FB.border}20`,
                    }}
                  >
                    <img
                      src={resolveAvatarDisplay(p.profiles?.avatar_url, p.user_id)}
                      alt=""
                      loading="lazy"
                      style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: FB.text,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {name}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 11, color: FB.text, fontWeight: 700 }}>
                        {(p.chip_balance || 0).toLocaleString()}
                      </div>
                    </div>
                  </div>
                );
              })}
              {downline.length > 10 && (
                <div style={{ fontSize: 11, color: FB.dim, textAlign: 'center', padding: 6 }}>
                  +{downline.length - 10} more players
                </div>
              )}
            </div>
          )}
        </>
      )}

      <div
        style={{
          marginTop: 12,
          padding: '8px 10px',
          borderRadius: 6,
          background: 'rgba(147,51,234,0.06)',
          border: `1px solid ${FB.promo}20`,
          fontSize: 10,
          color: FB.dim,
          lineHeight: 1.5,
        }}
      >
        ⓘ Promo chips are non-transferable between agents. They can only be distributed to your
        assigned players. Promo chips do not count as settlement debt.
      </div>
    </div>
  );
}
