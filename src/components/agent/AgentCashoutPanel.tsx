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
import { supabase } from '../../lib/supabase';
import './AgentCashoutPanel.css';

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

    // Poll for updates every 30s as fallback
    const interval = setInterval(loadCashouts, 30000);

    // Bus listener: instant refresh when any balance changes (cashout requested/cancelled)
    const unsubBalance = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      () => {
        loadCashouts();
      },
      500
    );

    // Supabase real-time: instant refresh on cashout_requests changes (cross-device)
    const channelKey = `agent-cashouts-${user?.id || 'anon'}`;
    const channel = supabase
      .channel(channelKey)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cashout_requests' }, () => {
        loadCashouts();
      })
      .subscribe();

    return () => {
      clearInterval(interval);
      unsubBalance();
      supabase.removeChannel(channel);
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
      staggerTimersRef.current = [];
    };
  }, [loadCashouts, user?.id]);

  const handleApprove = async (cashout: CashoutRequest) => {
    if (!user?.id) return;

    setProcessing(cashout.id);
    setError(null);

    try {
      await cashoutService.approveCashout(cashout.id, user.id);
      await cashoutService.completeCashout(cashout.id, user.id);
      loadCashouts();
      onCashoutProcessed?.();
    } catch (err: any) {
      if (isMounted.current) setError(err.message || 'Failed to approve cashout');
    }
    setProcessing(null);
  };

  const handleReject = async (cashout: CashoutRequest, reason?: string) => {
    if (!user?.id) return;

    setProcessing(cashout.id);
    setError(null);

    try {
      await cashoutService.rejectCashout(cashout.id, user.id, reason);
      loadCashouts();
      onCashoutProcessed?.();
    } catch (err: any) {
      if (isMounted.current) setError(err.message || 'Failed to reject cashout');
    }
    setProcessing(null);
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  if (loading) {
    return (
      <div className="agent-cashout-panel">
        <div className="panel-header">
          <h3> Pending Cashouts</h3>
        </div>
        <div className="loading-state">
          <div className="spinner" />
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
                    src={cashout.playerAvatar || '/default-avatar.png'}
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
