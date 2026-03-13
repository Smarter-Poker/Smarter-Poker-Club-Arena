/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AGENT PROMO PANEL — Promo Chip Distribution Dashboard
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Consolidated from World Hub `components/club-arena/AgentPromoPanel.jsx`.
 *
 * Shown on the Cashier page for agents. Displays their promo_balance
 * and lets them distribute promo chips to their downline players.
 *
 * Features:
 *   - Real-time promo balance from `agents` table
 *   - Downline player list with chip + promo balances
 *   - Quick-amount presets (100, 500, 1000, 2500, ALL)
 *   - Supabase Realtime sync for balance updates
 *   - MasterBus integration for cross-component refresh
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { retryAsync } from '../../utils/retryAsync';
import './AgentPromoPanel.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface AgentPromoPanelProps {
  clubId: string;
  userId: string;
  role: string;
  onDistribute?: () => void;
}

interface DownlinePlayer {
  user_id: string;
  chip_balance: number;
  promo_balance: number;
  profiles?: {
    display_name?: string;
    username?: string;
    avatar_url?: string;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

const PRESETS = [100, 500, 1000, 2500];

export default function AgentPromoPanel({
  clubId,
  userId,
  role,
  onDistribute,
}: AgentPromoPanelProps) {
  const [promoBalance, setPromoBalance] = useState(0);
  const [downline, setDownline] = useState<DownlinePlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPlayer, setSelectedPlayer] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [distributing, setDistributing] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const isMounted = useRef(true);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const isAgent = ['agent', 'sub_agent', 'super_agent'].includes(role);

  const showToast = (msg: string, type = 'success') => {
    if (!isMounted.current) return;
    setToast({ msg, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => {
      if (isMounted.current) setToast(null);
    }, 3000);
  };

  // ── Load agent promo balance + downline players ─────────────────────────────
  const loadData = useCallback(async () => {
    if (!clubId || !userId || !isAgent) return;
    setLoading(true);
    try {
      // Fetch agent's promo balance
      const { data: agent } = await supabase
        .from('agents')
        .select('promo_balance')
        .eq('club_id', clubId)
        .eq('user_id', userId)
        .maybeSingle();

      if (isMounted.current) setPromoBalance(Number(agent?.promo_balance) || 0);

      // Fetch downline players (assigned to this agent)
      const { data: players } = await supabase
        .from('club_members')
        .select(
          'user_id, chip_balance, promo_balance, profiles(display_name, username, avatar_url)'
        )
        .eq('club_id', clubId)
        .eq('agent_id', userId)
        .eq('role', 'player')
        .order('chip_balance', { ascending: false })
        .limit(1000);

      if (isMounted.current) setDownline((players as DownlinePlayer[]) || []);
    } catch (e) {
      console.error('[AgentPromoPanel] Load error:', e);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [clubId, userId, isAgent]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ── MasterBus: Auto-refresh on financial events ─────────────────────────────
  useEffect(() => {
    const handler = () => {
      loadData();
    };
    masterBus.on('BALANCE_UPDATED', handler);
    masterBus.on('PROMO_DISTRIBUTED', handler);
    return () => {
      masterBus.off('BALANCE_UPDATED', handler);
      masterBus.off('PROMO_DISTRIBUTED', handler);
    };
  }, [loadData]);

  // ── Realtime Sync ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!clubId || !userId || !isAgent) return;

    const channel = supabase
      .channel(`agent-promo-${clubId}-${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'agents',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          if (payload.new?.club_id === clubId && isMounted.current) {
            setPromoBalance(Number(payload.new.promo_balance) || 0);
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'club_members',
          filter: `agent_id=eq.${userId}`,
        },
        () => {
          if (isMounted.current) loadData();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [clubId, userId, isAgent, loadData]);

  // ── Distribute promo chips ──────────────────────────────────────────────────
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
    try {
      const { error } = await retryAsync(
        () =>
          supabase.rpc('distribute_promo_chips', {
            p_agent_id: userId,
            p_player_id: selectedPlayer,
            p_amount: amt,
            p_club_id: clubId,
          }),
        3
      );

      if (error) throw error;

      showToast(`🎉 ${amt.toLocaleString()} promo chips sent!`);
      masterBus.emit('BALANCE_UPDATED', { source: 'promo_distributed', userId: selectedPlayer });
      masterBus.emit('PROMO_DISTRIBUTED', {
        agentId: userId,
        playerId: selectedPlayer,
        amount: amt,
      });

      if (isMounted.current) {
        setAmount('');
        setSelectedPlayer(null);
      }
      loadData();
      onDistribute?.();
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Distribution failed', 'error');
    } finally {
      if (isMounted.current) setDistributing(false);
    }
  };

  if (!isAgent) return null;

  return (
    <div className="agent-promo-panel">
      {/* Header */}
      <div className="agent-promo-panel__header">
        <div>
          <div className="agent-promo-panel__title">🎁 Promo Wallet</div>
          <div className="agent-promo-panel__subtitle">
            Distribute promotional chips to your players
          </div>
        </div>
        <div className="agent-promo-panel__balance-badge">
          <div className="agent-promo-panel__balance-label">PROMO BALANCE</div>
          <div className="agent-promo-panel__balance-value">{promoBalance.toLocaleString()}</div>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className={`agent-promo-panel__toast agent-promo-panel__toast--${toast.type}`}>
          {toast.msg}
        </div>
      )}

      {loading ? (
        <div className="agent-promo-panel__loading">Loading...</div>
      ) : promoBalance <= 0 ? (
        <div className="agent-promo-panel__empty">
          <div className="agent-promo-panel__empty-icon">🎁</div>
          <div className="agent-promo-panel__empty-title">No promo chips available</div>
          <div className="agent-promo-panel__empty-hint">
            Ask your club owner to grant promo chips from the Admin panel.
          </div>
        </div>
      ) : (
        <>
          {/* Player selector */}
          <div className="agent-promo-panel__field">
            <label className="agent-promo-panel__label">
              Select Player ({downline.length} in your downline)
            </label>
            {downline.length === 0 ? (
              <div className="agent-promo-panel__no-players">No players assigned to you yet.</div>
            ) : (
              <select
                className="agent-promo-panel__select"
                value={selectedPlayer || ''}
                onChange={(e) => setSelectedPlayer(e.target.value || null)}
              >
                <option value="">Choose a player...</option>
                {downline.map((p) => (
                  <option key={p.user_id} value={p.user_id}>
                    {p.profiles?.display_name || p.profiles?.username || p.user_id.slice(0, 8)}
                    {' — '}Promo: {(p.promo_balance || 0).toLocaleString()}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Amount input + presets */}
          {selectedPlayer && (
            <>
              <div className="agent-promo-panel__field">
                <label className="agent-promo-panel__label">Amount</label>
                <input
                  className="agent-promo-panel__input"
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="Enter promo chip amount"
                  min="1"
                  max={promoBalance}
                />
              </div>
              <div className="agent-promo-panel__presets">
                {PRESETS.filter((p) => p <= promoBalance).map((p) => (
                  <button
                    key={p}
                    className={`agent-promo-panel__preset ${amount === String(p) ? 'agent-promo-panel__preset--active' : ''}`}
                    onClick={() => setAmount(String(p))}
                  >
                    {p.toLocaleString()}
                  </button>
                ))}
                <button
                  className={`agent-promo-panel__preset ${amount === String(promoBalance) ? 'agent-promo-panel__preset--active' : ''}`}
                  onClick={() => setAmount(String(promoBalance))}
                >
                  ALL
                </button>
              </div>

              {/* Send button */}
              <button
                className="agent-promo-panel__send"
                onClick={handleDistribute}
                disabled={distributing || !amount || Math.floor(Number(amount)) <= 0}
              >
                {distributing
                  ? 'Sending...'
                  : `🎁 Send ${amount && Math.floor(Number(amount)) > 0 ? Math.floor(Number(amount)).toLocaleString() : '0'} Promo Chips`}
              </button>
            </>
          )}

          {/* Downline overview */}
          {downline.length > 0 && (
            <div className="agent-promo-panel__downline">
              <div className="agent-promo-panel__downline-title">Your Players</div>
              {downline.slice(0, 10).map((p) => {
                const name =
                  p.profiles?.display_name || p.profiles?.username || p.user_id.slice(0, 8);
                return (
                  <div key={p.user_id} className="agent-promo-panel__player-row">
                    <img
                      src={p.profiles?.avatar_url || '/images/default-avatar.png'}
                      alt=""
                      loading="lazy"
                      className="agent-promo-panel__player-avatar"
                    />
                    <div className="agent-promo-panel__player-name">{name}</div>
                    <div className="agent-promo-panel__player-chips">
                      <div className="agent-promo-panel__player-balance">
                        {(p.chip_balance || 0).toLocaleString()}
                      </div>
                      {(p.promo_balance || 0) > 0 && (
                        <div className="agent-promo-panel__player-promo">
                          +{(p.promo_balance || 0).toLocaleString()} promo
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {downline.length > 10 && (
                <div className="agent-promo-panel__more">+{downline.length - 10} more players</div>
              )}
            </div>
          )}
        </>
      )}

      {/* Non-transferable notice */}
      <div className="agent-promo-panel__notice">
        ⓘ Promo chips are non-transferable between agents. They can only be distributed to your
        assigned players. Promo chips do not count as settlement debt.
      </div>
    </div>
  );
}
