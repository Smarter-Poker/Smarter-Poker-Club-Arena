/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DISPUTE MANAGEMENT PAGE — Club Owner/Admin Dispute Dashboard
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Full dispute lifecycle management:
 * - View all disputes for the club with status filters
 * - Start review, resolve, escalate, or withdraw disputes
 * - Open count badge for unresolved disputes
 * - Real-time updates via Supabase subscription
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import ClubBottomNav from '../components/club/ClubBottomNav';
import {
  DisputeService,
  type Dispute,
  type DisputeStatus,
  type DisputeResolution,
} from '../services/DisputeService';
import './DisputeManagementPage.css';
import PageSkeleton from '../components/common/PageSkeleton';

import { useIsMounted } from '../hooks/useIsMounted';

type FilterTab = 'all' | 'open' | 'under_review' | 'resolved' | 'escalated';

export default function DisputeManagementPage() {
  const { clubId } = useParams();
  const { user } = useAuthUser();
  const toast = useToast();

  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [resolving, setResolving] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [escalating, setEscalating] = useState<string | null>(null);
  const [resolutionText, setResolutionText] = useState('');
  const [adjustmentAmount, setAdjustmentAmount] = useState('');
  const [adjustmentType, setAdjustmentType] = useState<'credit' | 'debit' | 'none'>('none');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const isMounted = useIsMounted();

  const loadDisputes = useCallback(async () => {
    setLoading(true);
    try {
      if (clubId) {
        // Club-scoped: load disputes for this club
        const data = await DisputeService.getClubDisputes(clubId);
        if (isMounted.current) setDisputes(data);
      } else if (user?.id) {
        // Global route (/disputes): load user's own disputes
        const data = await DisputeService.getMyDisputes(user.id);
        if (isMounted.current) setDisputes(data);
      }
    } catch (err) {
      console.error('[Disputes] Load failed:', err);
      if (isMounted.current) toast.error('Failed to load disputes');
    }
    if (isMounted.current) setLoading(false);
  }, [clubId, user?.id]);

  useVisibilityRefresh(() => loadDisputes());

  useEffect(() => {
    loadDisputes();
  }, [loadDisputes]);

  // Real-time subscription
  useEffect(() => {
    if (!clubId) return; // RT subscription only for club-scoped route
    const channelKey = `disputes-${clubId}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'disputes', filter: `club_id=eq.${clubId}` },
        () => loadDisputes()
      )
      .subscribe();
    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId, loadDisputes]);

  // Bus listeners: refresh when balance changes or settlements complete (may resolve disputes)
  useEffect(() => {
    const unsubBalance = masterBus.subscribeDebounced('BALANCE_UPDATED', () => loadDisputes(), 500);
    const unsubSettlement = masterBus.subscribeDebounced(
      'SETTLEMENT_COMPLETED',
      () => loadDisputes(),
      1000
    );
    return () => {
      unsubBalance();
      unsubSettlement();
    };
  }, [loadDisputes]);

  const handleStartReview = async (disputeId: string) => {
    if (!user?.id || reviewing) return;
    setReviewing(disputeId);
    try {
      await DisputeService.startReview(disputeId, user.id);
      toast.success('Dispute now under review');
      loadDisputes();
    } catch (err) {
      toast.error('Failed to start review');
    }
    setReviewing(null);
  };

  const handleResolve = async (disputeId: string) => {
    if (!resolutionText.trim()) {
      toast.error('Please enter a resolution');
      return;
    }
    setResolving(disputeId);
    try {
      const resolution: DisputeResolution = {
        resolution: resolutionText.trim(),
        adjustmentType,
        adjustmentAmount: adjustmentType !== 'none' ? parseFloat(adjustmentAmount) || 0 : undefined,
      };
      await DisputeService.resolveDispute(disputeId, user?.id || '', resolution);
      toast.success('Dispute resolved');
      setResolutionText('');
      setAdjustmentAmount('');
      setAdjustmentType('none');
      setExpandedId(null);
      loadDisputes();
    } catch (err) {
      toast.error('Failed to resolve dispute');
    }
    setResolving(null);
  };

  const handleEscalate = async (disputeId: string) => {
    if (escalating) return;
    setEscalating(disputeId);
    try {
      await DisputeService.escalateDispute(disputeId, 'Escalated by admin for further review');
      toast.success('Dispute escalated');
      loadDisputes();
    } catch (err) {
      toast.error('Failed to escalate');
    }
    setEscalating(null);
  };

  const filtered = (
    activeTab === 'all' ? disputes : disputes.filter((d) => d.status === activeTab)
  ).filter((d) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      d.submitterName.toLowerCase().includes(q) ||
      d.reason.toLowerCase().includes(q) ||
      d.targetType.toLowerCase().includes(q) ||
      d.amount.toString().includes(q)
    );
  });

  /** Returns SLA time remaining as a human-readable string (e.g., "18h left") */
  const getSlaRemaining = (createdAt: string): { text: string; urgent: boolean } | null => {
    const created = new Date(createdAt).getTime();
    const slaMs = 72 * 60 * 60 * 1000; // 72 hours
    const remaining = created + slaMs - Date.now();
    if (remaining <= 0) return { text: 'SLA breached', urgent: true };
    const hours = Math.floor(remaining / (60 * 60 * 1000));
    if (hours < 12) return { text: `${hours}h left`, urgent: true };
    return { text: `${hours}h left`, urgent: false };
  };

  const statusCounts = {
    all: disputes.length,
    open: disputes.filter((d) => d.status === 'open').length,
    under_review: disputes.filter((d) => d.status === 'under_review').length,
    resolved: disputes.filter((d) => d.status === 'resolved').length,
    escalated: disputes.filter((d) => d.status === 'escalated').length,
  };

  const getStatusBadge = (status: DisputeStatus) => {
    const map: Record<DisputeStatus, { icon: string; cls: string }> = {
      open: { icon: '⚪', cls: 'badge-open' },
      under_review: { icon: '🔵', cls: 'badge-review' },
      resolved: { icon: '✅', cls: 'badge-resolved' },
      escalated: { icon: '🔴', cls: 'badge-escalated' },
      withdrawn: { icon: '⬜', cls: 'badge-withdrawn' },
    };
    const cfg = map[status] || map.open;
    return (
      <span className={`dispute-badge ${cfg.cls}`}>
        {cfg.icon} {status.replace('_', ' ')}
      </span>
    );
  };

  return (
    <>
      <div className="dispute-management-page">
        <div className="dispute-header">
          <h2>⚖️ Dispute Management</h2>
          {statusCounts.open > 0 && (
            <span className="open-count-badge">{statusCounts.open} open</span>
          )}
        </div>

        {/* Filter Tabs */}
        <div className="dispute-tabs">
          {(['all', 'open', 'under_review', 'resolved', 'escalated'] as FilterTab[]).map((tab) => (
            <button
              key={tab}
              className={`tab-btn ${activeTab === tab ? 'active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab === 'under_review' ? 'Reviewing' : tab.charAt(0).toUpperCase() + tab.slice(1)}
              {statusCounts[tab] > 0 && <span className="tab-count">{statusCounts[tab]}</span>}
            </button>
          ))}
        </div>

        {/* Search */}
        <div style={{ marginBottom: '12px' }}>
          <input
            type="text"
            placeholder="Search by name, reason, amount..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 14px',
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '8px',
              color: '#fff',
              fontSize: '0.85rem',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Disputes List */}
        {loading ? (
          <div className="loading-state">
            <PageSkeleton variant="list" />
            <p>Loading disputes...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">◉</span>
            <p>{activeTab === 'all' ? 'No disputes filed' : `No ${activeTab} disputes`}</p>
          </div>
        ) : (
          <div className="dispute-list">
            {filtered.map((dispute) => (
              <div key={dispute.id} className={`dispute-card status-${dispute.status}`}>
                <div
                  className="dispute-card-header"
                  onClick={() => {
                    const newId = expandedId === dispute.id ? null : dispute.id;
                    setExpandedId(newId);
                    // Reset form state when switching cards to prevent stale data carry-over
                    if (newId !== expandedId) {
                      setResolutionText('');
                      setAdjustmentAmount('');
                      setAdjustmentType('none');
                    }
                  }}
                >
                  <div className="dispute-meta">
                    {getStatusBadge(dispute.status)}
                    <span className="dispute-amount">{dispute.amount.toLocaleString()} chips</span>
                  </div>
                  <div className="dispute-target">
                    <span className="target-type">{dispute.targetType.replace('_', ' ')}</span>
                    <span className="dispute-submitter">by {dispute.submitterName}</span>
                  </div>
                  <div className="dispute-date">
                    {new Date(dispute.createdAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    {(dispute.status === 'open' || dispute.status === 'under_review') &&
                      (() => {
                        const sla = getSlaRemaining(dispute.createdAt);
                        if (!sla) return null;
                        return (
                          <span
                            style={{
                              display: 'block',
                              fontSize: '0.65rem',
                              marginTop: '2px',
                              color: sla.urgent ? '#ff3b30' : 'rgba(255,255,255,0.4)',
                              fontWeight: sla.urgent ? 700 : 400,
                            }}
                          >
                            ⏱️ {sla.text}
                          </span>
                        );
                      })()}
                  </div>
                </div>

                <div className="dispute-reason">
                  <strong>Reason:</strong> {dispute.reason}
                </div>

                {dispute.resolution && (
                  <div className="dispute-resolution-text">
                    <strong>Resolution:</strong> {dispute.resolution}
                  </div>
                )}

                {/* Expanded Actions */}
                {expandedId === dispute.id &&
                  dispute.status !== 'resolved' &&
                  dispute.status !== 'withdrawn' && (
                    <div className="dispute-actions">
                      {dispute.status === 'open' && (
                        <button
                          className="action-btn review"
                          onClick={() => handleStartReview(dispute.id)}
                          disabled={reviewing === dispute.id}
                        >
                          {reviewing === dispute.id ? '🔍 Reviewing...' : '🔍 Start Review'}
                        </button>
                      )}

                      {(dispute.status === 'open' || dispute.status === 'under_review') && (
                        <>
                          <div className="resolution-form">
                            <textarea
                              placeholder="Enter resolution notes..."
                              value={resolutionText}
                              onChange={(e) => setResolutionText(e.target.value)}
                              rows={2}
                            />
                            <div className="adjustment-row">
                              <select
                                value={adjustmentType}
                                onChange={(e) => setAdjustmentType(e.target.value as any)}
                              >
                                <option value="none">No Adjustment</option>
                                <option value="credit">Credit Player</option>
                                <option value="debit">Debit Player</option>
                              </select>
                              {adjustmentType !== 'none' && (
                                <input
                                  type="number"
                                  placeholder="Amount"
                                  value={adjustmentAmount}
                                  onChange={(e) => setAdjustmentAmount(e.target.value)}
                                />
                              )}
                            </div>
                            <div className="resolution-actions">
                              <button
                                className="action-btn resolve"
                                onClick={() => handleResolve(dispute.id)}
                                disabled={resolving === dispute.id}
                              >
                                {resolving === dispute.id ? 'Resolving...' : '✓ Resolve'}
                              </button>
                              <button
                                className="action-btn escalate"
                                onClick={() => handleEscalate(dispute.id)}
                                disabled={escalating === dispute.id}
                              >
                                {escalating === dispute.id ? '🔴 Escalating...' : '🔴 Escalate'}
                              </button>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  )}
              </div>
            ))}
          </div>
        )}
      </div>
      {clubId && <ClubBottomNav clubId={clubId!} />}
    </>
  );
}
