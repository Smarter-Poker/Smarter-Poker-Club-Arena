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
 *
 * #ClubArenaConsole: the shared integrity header stays (it carries its own
 * approved club art and the section navigation); the docket beneath it is one
 * console - the status filters as lit words, the search printed on the glass,
 * every case a row between engraved rules, and the review / resolve /
 * escalate controls as lit words inside the expanded case. Every loader
 * guard, realtime channel, bus listener, keyboard handler and aria contract of
 * the generic page is kept; only the paint changed.
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
import { SpadeConsole } from '../components/console/SpadeConsole';
import { titleCase } from '../utils/titleCase';
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

  // Balance changes may resolve disputes; the database subscription also refreshes.
  useEffect(() => {
    const unsubBalance = masterBus.subscribeDebounced('BALANCE_UPDATED', () => loadDisputes(), 500);
    return () => {
      unsubBalance();
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
    if (remaining <= 0) return { text: 'SLA Breached', urgent: true };
    const hours = Math.floor(remaining / (60 * 60 * 1000));
    if (hours < 12) return { text: `${hours}h Left`, urgent: true };
    return { text: `${hours}h Left`, urgent: false };
  };

  const statusCounts = {
    all: disputes.length,
    open: disputes.filter((d) => d.status === 'open').length,
    under_review: disputes.filter((d) => d.status === 'under_review').length,
    resolved: disputes.filter((d) => d.status === 'resolved').length,
    escalated: disputes.filter((d) => d.status === 'escalated').length,
  };

  /* The status prints in the master's own ink rather than in a drawn badge:
     gold while it waits, blue under review, green once resolved, red when
     escalated, muted when withdrawn. */
  const getStatusBadge = (status: DisputeStatus) => {
    const map: Record<DisputeStatus, string> = {
      open: 'sc-ink--gold',
      under_review: 'sc-ink--blue',
      resolved: 'sc-ink--green',
      escalated: 'sc-ink--red',
      withdrawn: 'sc-ink--muted',
    };
    const ink = map[status] || map.open;
    return <span className={`dmp__status ${ink}`}>{titleCase(status.replace('_', ' '))}</span>;
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
        eyebrow={clubId ? 'Case Investigation / Financial Integrity' : 'Personal Casework'}
        title={clubId ? 'Dispute Resolution Desk' : 'My Disputes'}
        description={
          clubId
            ? 'Investigate Club Transaction Disputes, Monitor The 72-Hour Service Window, And Record A Defensible Resolution.'
            : 'Track The Status, Evidence, And Resolution Of Disputes Filed From Your Account.'
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
        <SpadeConsole
          className="dmp__console"
          eyebrow="Live Case Docket"
          title={clubId ? 'Club Disputes' : 'Account Disputes'}
          titleId="dispute-docket-title"
          pill={statusCounts.open > 0 ? `${statusCounts.open} Open` : 'Clear'}
          pillInk={statusCounts.open > 0 ? 'gold' : 'green'}
          foot="foot"
        >
          {/* Filter Tabs */}
          <div className="dmp__tabs" role="tablist" aria-label="Filter Disputes By Status">
            {FILTER_TABS.map((tab) => (
              <button
                key={tab}
                id={`dispute-filter-${tab}`}
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                aria-controls="dispute-case-panel"
                tabIndex={activeTab === tab ? 0 : -1}
                className={`dmp-word dmp__tab ${activeTab === tab ? 'sc-ink--white' : 'sc-ink--muted'}`}
                onClick={() => setActiveTab(tab)}
                onKeyDown={(event) => handleTabKeyDown(event, tab)}
              >
                {tab === 'under_review' ? 'Reviewing' : tab.charAt(0).toUpperCase() + tab.slice(1)}
                {statusCounts[tab] > 0 && (
                  <span className="dmp__tab-count sc-ink--blue">{statusCounts[tab]}</span>
                )}
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="dmp__search">
            <label htmlFor="dispute-search" className="dmp__search-label sc-label sc-ink--blue">
              Search Cases
            </label>
            <input
              id="dispute-search"
              type="text"
              className="dmp__field"
              placeholder="Player, Reason, Target, Or Amount"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {/* Disputes List */}
          <div
            id="dispute-case-panel"
            className="dmp__panel"
            role="tabpanel"
            aria-labelledby={`dispute-filter-${activeTab}`}
          >
            {loading ? (
              <p className="sc-copy sc-copy--center dmp__state" aria-busy="true">
                Loading Disputes...
              </p>
            ) : loadError ? (
              <div className="dmp__state" role="alert">
                <strong className="dmp__state-title sc-ink--red">Dispute Docket Unavailable</strong>
                <p className="sc-copy">
                  The Live Case Feed Could Not Be Loaded. No Dispute Records Were Changed.
                </p>
                <button
                  type="button"
                  className="dmp-word sc-ink--white"
                  onClick={() => void loadDisputes()}
                >
                  Retry Case Feed
                </button>
              </div>
            ) : filtered.length === 0 ? (
              <div className="dmp__state">
                <strong className="dmp__state-title sc-ink--green">Docket Clear</strong>
                <p className="sc-copy sc-copy--center">
                  {activeTab === 'all'
                    ? 'No Disputes Have Been Filed.'
                    : titleCase(`No ${activeTab.replace('_', ' ')} Disputes Match This View.`)}
                </p>
              </div>
            ) : (
              <ul className="dmp__list">
                {filtered.map((dispute) => (
                  <li key={dispute.id} className="dmp__case">
                    <button
                      type="button"
                      className="dmp__case-head"
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
                      <span className="dmp__case-meta">
                        {getStatusBadge(dispute.status)}
                        {/* The disputed sum is a term of the case a staff member
                            rules on to the chip: exact, never compacted. */}
                        <span className="dmp__amount sc-ink--silver">
                          {dispute.amount.toLocaleString()} Chips
                        </span>
                      </span>
                      <span className="dmp__case-target">
                        <span className="dmp__target-type sc-ink--blue">
                          {titleCase(dispute.targetType.replace('_', ' '))}
                        </span>
                        <span className="dmp__submitter sc-ink--muted">
                          By {titleCase(dispute.submitterName)}
                        </span>
                      </span>
                      <span className="dmp__case-date sc-ink--muted">
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
                                className={`dmp__sla ${sla.urgent ? 'sc-ink--red' : 'sc-ink--gold'}`}
                              >
                                {sla.text}
                              </span>
                            );
                          })()}
                      </span>
                    </button>

                    <p className="sc-copy dmp__reason">
                      <span className="dmp__reason-label sc-ink--blue">Reason:</span>{' '}
                      {titleCase(dispute.reason)}
                    </p>

                    {dispute.resolution && (
                      <p className="sc-copy dmp__reason">
                        <span className="dmp__reason-label sc-ink--green">Resolution:</span>{' '}
                        {titleCase(dispute.resolution)}
                      </p>
                    )}

                    {/* Expanded Actions */}
                    {expandedId === dispute.id &&
                      dispute.status !== 'resolved' &&
                      dispute.status !== 'withdrawn' && (
                        <div className="dmp__actions" id={`dispute-case-${dispute.id}`}>
                          {dispute.status === 'open' && (
                            <button
                              type="button"
                              className="dmp-word sc-ink--white"
                              onClick={() => handleStartReview(dispute.id)}
                              disabled={reviewing === dispute.id}
                            >
                              {reviewing === dispute.id ? 'Reviewing...' : 'Start Review'}
                            </button>
                          )}

                          {(dispute.status === 'open' || dispute.status === 'under_review') && (
                            <div className="dmp__form">
                              <textarea
                                className="dmp__field dmp__field--area"
                                aria-label="Resolution Notes"
                                placeholder="Enter Resolution Notes..."
                                value={resolutionText}
                                onChange={(e) => setResolutionText(e.target.value)}
                                rows={2}
                              />
                              <div className="dmp__adjust">
                                <select
                                  className="dmp__field dmp__field--select"
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
                                    className="dmp__field"
                                    aria-label="Balance Adjustment Amount"
                                    type="number"
                                    placeholder="Amount"
                                    value={adjustmentAmount}
                                    onChange={(e) => setAdjustmentAmount(e.target.value)}
                                  />
                                )}
                              </div>
                              <div className="dmp__form-actions">
                                <button
                                  type="button"
                                  className="dmp-word sc-ink--green"
                                  onClick={() => handleResolve(dispute.id)}
                                  disabled={resolving === dispute.id}
                                >
                                  {resolving === dispute.id ? 'Resolving...' : 'Resolve Dispute'}
                                </button>
                                <button
                                  type="button"
                                  className="dmp-word sc-ink--red"
                                  onClick={() => handleEscalate(dispute.id)}
                                  disabled={escalating === dispute.id}
                                >
                                  {escalating === dispute.id ? 'Escalating...' : 'Escalate'}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SpadeConsole>
      </div>
    </>
  );
}
