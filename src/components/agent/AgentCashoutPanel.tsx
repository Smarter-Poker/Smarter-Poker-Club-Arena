/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AGENT CASHOUT PANEL — Manage Player Cashout Requests
 * ═══════════════════════════════════════════════════════════════════════════════
 * Component for agents to view and process pending cashout requests
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { cashoutService, CashoutRequest } from '../../services/CashoutService';
import { useAuthUser } from '../../hooks/useAuthUser';
import { masterBus } from '../../core/MasterBus';
import { checkSettlementLock } from '../../utils/settlementLock';
import { formatRelativeShort as formatTime } from '@/lib/date';
import './AgentCashoutPanel.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';

interface AgentCashoutPanelProps {
  clubId?: string;
  onCashoutProcessed?: () => void;
}

export default function AgentCashoutPanel({ clubId, onCashoutProcessed }: AgentCashoutPanelProps) {
  const isMounted = useIsMounted();
  const { user } = useAuthUser();
  const [cashouts, setCashouts] = useState<CashoutRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Load pending cashouts
  const loadCashouts = useCallback(async () => {
    if (!user?.id) return;

    setLoading(true);
    try {
      const pending = await cashoutService.getAgentPendingCashouts(user.id, clubId);
      if (!isMounted.current) return;
      setCashouts(pending);
      setVisibleItems(new Set());
      // Clear previous stagger timers
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
      staggerTimersRef.current = pending.map((_, i) =>
        setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
      );
    } catch (err) {
      console.error('Failed to load cashouts:', err);
    }
    if (isMounted.current) setLoading(false);
  }, [user?.id, clubId]);

  useEffect(() => {
    loadCashouts();

    // Bus listener: instant refresh when any balance changes (cashout requested/cancelled)
    const unsubBalance = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      () => {
        loadCashouts();
      },
      500
    );

    // Bus listener: refresh when data mutations occur (replaces 30s polling)
    const unsubMutation = masterBus.subscribeDebounced(
      'DATA_MUTATED',
      () => {
        loadCashouts();
      },
      500
    );

    // Supabase real-time via masterBus channel manager: instant refresh on cashout_requests changes
    const channelKey = `agent-cashouts-${user?.id || 'anon'}`;
    const channel = masterBus
      .getOrCreateChannel(channelKey)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cashout_requests' }, () => {
        loadCashouts();
      })
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          console.error('[AgentCashoutPanel] ❌ Realtime channel error:', err?.message || err);
        }
        if (status === 'TIMED_OUT') {
          console.warn('[AgentCashoutPanel] ⏱️ Realtime channel timed out');
        }
      });

    return () => {
      unsubBalance();
      unsubMutation();
      masterBus.removeRegisteredChannel(channelKey);
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
      staggerTimersRef.current = [];
    };
  }, [loadCashouts, user?.id]);

  const handleApprove = async (cashout: CashoutRequest) => {
    if (!user?.id) return;

    setProcessing(cashout.id);
    setError(null);

    // SETTLEMENT FREEZE CHECK
    try {
      const lockResult = await checkSettlementLock(clubId || '');
      if (lockResult.locked) {
        if (isMounted.current) setError('🔒 Settlement in progress — cashout actions frozen');
        if (isMounted.current) setProcessing(null);
        return;
      }
    } catch {
      // Fail-open
    }

    try {
      await cashoutService.approveCashout(cashout.id, user.id);
      await cashoutService.completeCashout(cashout.id, user.id);
      loadCashouts();
      onCashoutProcessed?.();
      // Emit bus event so DynamicWallet and CashierPage refresh
      masterBus.emit('BALANCE_UPDATED', { source: 'cashout_approved', playerId: cashout.playerId });
    } catch (err: any) {
      if (isMounted.current) setError(err.message || 'Failed to approve cashout');
    }
    if (isMounted.current) setProcessing(null);
  };

  const handleReject = async (cashout: CashoutRequest, reason?: string) => {
    if (!user?.id) return;

    setProcessing(cashout.id);
    setError(null);

    // SETTLEMENT FREEZE CHECK
    try {
      const lockResult = await checkSettlementLock(clubId || '');
      if (lockResult.locked) {
        if (isMounted.current) setError('🔒 Settlement in progress — cashout actions frozen');
        if (isMounted.current) setProcessing(null);
        return;
      }
    } catch {
      // Fail-open
    }

    try {
      await cashoutService.rejectCashout(cashout.id, user.id, reason);
      loadCashouts();
      onCashoutProcessed?.();
      // Emit bus event so DynamicWallet and CashierPage refresh
      masterBus.emit('BALANCE_UPDATED', { source: 'cashout_rejected', playerId: cashout.playerId });
    } catch (err: any) {
      if (isMounted.current) setError(err.message || 'Failed to reject cashout');
    }
    if (isMounted.current) setProcessing(null);
  };

  if (loading) {
    return (
      <div className="agent-cashout-panel">
        <div className="panel-header">
          <h3> Pending Cashouts</h3>
        </div>
        <div style={{ padding: '12px' }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '12px',
                marginBottom: '8px',
                borderRadius: '8px',
                background: 'rgba(255,255,255,0.02)',
                animation: `shimmerFade 1.4s ease-in-out ${i * 0.1}s infinite`,
              }}
            >
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '50%',
                  background: 'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 75%)',
                  backgroundSize: '200px 100%',
                  animation: 'shimmerSlide 1.4s ease-in-out infinite',
                  flexShrink: 0,
                }}
              />
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    width: `${50 + Math.random() * 30}%`,
                    height: '12px',
                    borderRadius: '4px',
                    background: 'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 75%)',
                    backgroundSize: '200px 100%',
                    animation: 'shimmerSlide 1.4s ease-in-out infinite',
                    marginBottom: '6px',
                  }}
                />
                <div
                  style={{
                    width: '40%',
                    height: '10px',
                    borderRadius: '4px',
                    background: 'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 75%)',
                    backgroundSize: '200px 100%',
                    animation: 'shimmerSlide 1.4s ease-in-out infinite',
                  }}
                />
              </div>
            </div>
          ))}
        </div>
        <style>{`
          @keyframes shimmerSlide { 0% { background-position: -200px 0; } 100% { background-position: 200px 0; } }
          @keyframes shimmerFade { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
        `}</style>
      </div>
    );
  }

  if (error && cashouts.length === 0) {
    return (
      <div className="agent-cashout-panel">
        <div className="panel-header">
          <h3> Pending Cashouts</h3>
        </div>
        <div style={{ textAlign: 'center', padding: '24px 16px', color: '#94a3b8' }}>
          <div style={{ fontSize: '24px', marginBottom: '8px' }}>⚠️</div>
          <p style={{ margin: '0 0 12px', fontSize: '13px' }}>Failed to load cashout requests</p>
          <button
            onClick={loadCashouts}
            style={{
              padding: '8px 20px',
              background: 'rgba(59,130,246,0.15)',
              border: '1px solid rgba(59,130,246,0.3)',
              borderRadius: '8px',
              color: '#60a5fa',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            ↻ Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-cashout-panel">
      <div className="panel-header">
        <h3> Pending Cashouts</h3>
        <span className="count-badge">{cashouts.length}</span>
        <button className="refresh-btn" onClick={loadCashouts} title="Refresh">
          ↻
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {cashouts.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">◉</span>
          <p>No pending cashout requests</p>
        </div>
      ) : (
        <div className="cashout-list">
          {cashouts.map((cashout, i) => (
            <div
              key={cashout.id}
              className="cashout-card"
              style={{
                opacity: visibleItems.has(i) ? 1 : 0,
                transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <div className="cashout-header">
                <div className="player-info">
                  <img
                    loading="lazy"
                    decoding="async"
                    src={cashout.playerAvatar || generateDefaultAvatar()}
                    alt=""
                    className="player-avatar"
                  />
                  <div className="player-details">
                    <span className="player-name">{cashout.playerName || 'Player'}</span>
                    <span className="request-time">{formatTime(cashout.createdAt)}</span>
                  </div>
                </div>
                <div className="cashout-amount">
                  <span className="amount-value">{cashout.amount.toLocaleString()}</span>
                  <span className="amount-label">chips</span>
                </div>
              </div>

              {cashout.playerNote && <div className="player-note">"{cashout.playerNote}"</div>}

              <div className="cashout-actions">
                <button
                  className="action-btn approve"
                  onClick={() => handleApprove(cashout)}
                  disabled={processing === cashout.id}
                >
                  {processing === cashout.id ? '...' : ' Approve & Complete'}
                </button>
                <button
                  className="action-btn reject"
                  onClick={() => handleReject(cashout, 'Request declined')}
                  disabled={processing === cashout.id}
                >
                  {processing === cashout.id ? '...' : ' Reject'}
                </button>
              </div>

              <div className="escrow-notice">
                Chips are locked in escrow. Approving will complete the cashout.
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
