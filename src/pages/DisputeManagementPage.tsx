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

import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useParams } from 'react-router-dom';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import ClubIntegrityHeader from '../components/club/ClubIntegrityHeader';
import {
  DisputeService,
  type Dispute,
  type DisputeStatus,
  type DisputeResolution,
} from '../services/DisputeService';
import './DisputeManagementPage.css';
import PageSkeleton from '../components/common/PageSkeleton';
import { resolveClubUUID } from '../utils/clubIdResolver';

import { useIsMounted } from '../hooks/useIsMounted';
import { reportError } from '../utils/errorReporter';

type FilterTab = 'all' | 'open' | 'under_review' | 'resolved' | 'escalated';
const FILTER_TABS: FilterTab[] = ['all', 'open', 'under_review', 'resolved', 'escalated'];

export default function DisputeManagementPage() {
  const { clubId } = useParams();
  const { user } = useAuthUser();
  const toast = useToast();

  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
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

  const loadingRef = useRef(false);

  // ── CRITICAL: Reset per-club state when navigating between clubs ──
  useEffect(() => {
    setActiveTab('all');
    setResolving(null);
    setReviewing(null);
    setEscalating(null);
    setResolutionText('');
    setAdjustmentAmount('');
    setAdjustmentType('none');
    setExpandedId(null);
    setSearchQuery('');
    loadingRef.current = false;
    setLoadError(false);
  }, [clubId]);

  const loadDisputes = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setLoadError(false);
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
      reportError(err, 'DisputeManagementPage.Load_failed');
      if (isMounted.current) {
        setDisputes([]);
        setLoadError(true);
        toast.error('Failed to load disputes');
      }
    } finally {
      loadingRef.current = false;
      if (isMounted.current) setLoading(false);
    }
  }, [clubId, isMounted, toast, user?.id]);

  useVisibilityRefresh(() => loadDisputes());

  useEffect(() => {
    loadDisputes();
  }, [loadDisputes]);

  // Real-time subscription
  useEffect(() => {
    if (!clubId) return; // RT subscription only for club-scoped route
    let isMounted = true;
    const channelKey = `disputes-${clubId}`;

    const setupRealtime = async () => {
      const resolvedId = await resolveClubUUID(clubId);
      if (!isMounted) return;

      const channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'disputes', filter: `club_id=eq.${resolvedId}` },
          () => loadDisputes()
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            if (err)
              reportError(err?.message || err, 'DisputeManagementPage._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[DisputeManagementPage] Realtime channel timed out');
          }
        });
    };

    setupRealtime().catch((e) => console.warn('[DisputeManagementPage] Realtime setup failed:', e));

    return () => {
      isMounted = false;
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
      reportError(err, 'DisputeManagementPage.Start_review_failed');
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
      reportError(err, 'DisputeManagementPage.Resolve_failed');
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
      reportError(err, 'DisputeManagementPage.Escalate_failed');
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
      (d.submitterName || '').toLowerCase().includes(q) ||
      (d.reason || '').toLowerCase().includes(q) ||
      (d.targetType || '').toLowerCase().includes(q) ||
      String(d.amount || 0).includes(q)
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
    const map: Record<DisputeStatus, string> = {
      open: 'badge-open',
      under_review: 'badge-review',
      resolved: 'badge-resolved',
      escalated: 'badge-escalated',
      withdrawn: 'badge-withdrawn',
    };
    const badgeClass = map[status] || map.open;
    return <span className={`dispute-badge ${badgeClass}`}>{status.replace('_', ' ')}</span>;
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, current: FilterTab) => {
    const currentIndex = FILTER_TABS.indexOf(current);
    let nextIndex = currentIndex;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % FILTER_TABS.length;
    else if (event.key === 'ArrowLeft')
      nextIndex = (currentIndex - 1 + FILTER_TABS.length) % FILTER_TABS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = FILTER_TABS.length - 1;
    else return;
    event.preventDefault();
    const next = FILTER_TABS[nextIndex];
    setActiveTab(next);
    requestAnimationFrame(() => document.getElementById(`dispute-filter-${next}`)?.focus());
  };

  return (
    <>
      <ClubIntegrityHeader
        clubId={clubId}
        active="disputes"
        eyebrow={clubId ? 'Case investigation / financial integrity' : 'Personal casework'}
        title={clubId ? 'Dispute Resolution Desk' : 'My Disputes'}
        description={
          clubId
            ? 'Investigate club transaction disputes, monitor the 72-hour service window, and record a defensible resolution.'
            : 'Track the status, evidence, and resolution of disputes filed from your account.'
        }
        metrics={[
          {
            label: 'Open',
            value: statusCounts.open,
            tone: statusCounts.open ? 'active' : 'neutral',
          },
          { label: 'Reviewing', value: statusCounts.under_review },
          {
            label: 'Escalated',
            value: statusCounts.escalated,
            tone: statusCounts.escalated ? 'risk' : 'neutral',
          },
        ]}
      />
      <div className="dispute-management-page">
        <div className="dispute-header">
          <div>
            <p className="dispute-kicker">Live Case Docket</p>
            <h2>{clubId ? 'Club transaction disputes' : 'Account disputes'}</h2>
          </div>
          {statusCounts.open > 0 && (
            <span className="open-count-badge">{statusCounts.open} Open</span>
          )}
        </div>

        {/* Filter Tabs */}
        <div className="dispute-tabs" role="tablist" aria-label="Filter Disputes By Status">
          {FILTER_TABS.map((tab) => (
            <button
              key={tab}
              id={`dispute-filter-${tab}`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              aria-controls="dispute-case-panel"
              tabIndex={activeTab === tab ? 0 : -1}
              className={`tab-btn ${activeTab === tab ? 'active' : ''}`}
              onClick={() => setActiveTab(tab)}
              onKeyDown={(event) => handleTabKeyDown(event, tab)}
            >
              {tab === 'under_review' ? 'Reviewing' : tab.charAt(0).toUpperCase() + tab.slice(1)}
              {statusCounts[tab] > 0 && <span className="tab-count">{statusCounts[tab]}</span>}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="dispute-search">
          <label htmlFor="dispute-search">Search Cases</label>
          <input
            id="dispute-search"
            type="text"
            placeholder="Player, Reason, Target, Or Amount"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Disputes List */}
        <div
          id="dispute-case-panel"
          role="tabpanel"
          aria-labelledby={`dispute-filter-${activeTab}`}
        >
          {loading ? (
            <div className="loading-state">
              <PageSkeleton variant="list" />
              <p>Loading Disputes…</p>
            </div>
          ) : loadError ? (
            <div className="dispute-state dispute-error" role="alert">
              <strong>Dispute Docket Unavailable</strong>
              <p>The Live Case Feed Could Not Be Loaded. No Dispute Records Were Changed.</p>
              <button type="button" onClick={() => void loadDisputes()}>
                Retry Case Feed
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty-state">
              <span className="empty-signal" aria-hidden="true" />
              <strong>Docket Clear</strong>
              <p>
                {activeTab === 'all'
                  ? 'No disputes have been filed.'
                  : `No ${activeTab.replace('_', ' ')} disputes match this view.`}
              </p>
            </div>
          ) : (
            <div className="dispute-list">
              {filtered.map((dispute) => (
                <div key={dispute.id} className={`dispute-card status-${dispute.status}`}>
                  <button
                    type="button"
                    className="dispute-card-header"
                    aria-expanded={expandedId === dispute.id}
                    aria-controls={`dispute-case-${dispute.id}`}
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
                      <span className="dispute-amount">
                        {dispute.amount.toLocaleString()} Chips
                      </span>
                    </div>
                    <div className="dispute-target">
                      <span className="target-type">{dispute.targetType.replace('_', ' ')}</span>
                      <span className="dispute-submitter">By {dispute.submitterName}</span>
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
                            <span className={sla.urgent ? 'sla-time sla-urgent' : 'sla-time'}>
                              {sla.text}
                            </span>
                          );
                        })()}
                    </div>
                  </button>

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
                      <div className="dispute-actions" id={`dispute-case-${dispute.id}`}>
                        {dispute.status === 'open' && (
                          <button
                            className="action-btn review"
                            onClick={() => handleStartReview(dispute.id)}
                            disabled={reviewing === dispute.id}
                          >
                            {reviewing === dispute.id ? 'Reviewing...' : 'Start Review'}
                          </button>
                        )}

                        {(dispute.status === 'open' || dispute.status === 'under_review') && (
                          <>
                            <div className="resolution-form">
                              <textarea
                                aria-label="Resolution Notes"
                                placeholder="Enter Resolution Notes..."
                                value={resolutionText}
                                onChange={(e) => setResolutionText(e.target.value)}
                                rows={2}
                              />
                              <div className="adjustment-row">
                                <select
                                  aria-label="Balance Adjustment Type"
                                  value={adjustmentType}
                                  onChange={(e) => setAdjustmentType(e.target.value as any)}
                                >
                                  <option value="none">No Adjustment</option>
                                  <option value="credit">Credit Player</option>
                                  <option value="debit">Debit Player</option>
                                </select>
                                {adjustmentType !== 'none' && (
                                  <input
                                    aria-label="Balance Adjustment Amount"
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
                                  {resolving === dispute.id ? 'Resolving...' : 'Resolve dispute'}
                                </button>
                                <button
                                  className="action-btn escalate"
                                  onClick={() => handleEscalate(dispute.id)}
                                  disabled={escalating === dispute.id}
                                >
                                  {escalating === dispute.id ? 'Escalating...' : 'Escalate'}
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
      </div>
    </>
  );
}
