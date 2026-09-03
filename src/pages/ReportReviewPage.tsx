/** Admin review of player conduct reports. */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useParams } from 'react-router-dom';
import ClubIntegrityHeader from '../components/club/ClubIntegrityHeader';
import PageSkeleton from '../components/common/PageSkeleton';
import { useToast } from '../components/common/Toast';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import { sanitizeInput } from '../utils/sanitizeInput';
import './ReportReviewPage.css';

interface PlayerReport {
  id: string;
  reporter_id: string;
  reported_user_id: string;
  reason: string;
  details: string;
  status: 'pending' | 'reviewed' | 'actioned' | 'dismissed';
  created_at: string;
  reviewed_at?: string;
  reviewed_by?: string;
  admin_notes?: string;
  reporter_username?: string;
  reported_username?: string;
}

type ReportFilter = 'all' | 'pending' | 'reviewed';
const REPORT_FILTERS: ReportFilter[] = ['pending', 'reviewed', 'all'];

export default function ReportReviewPage() {
  const { clubId } = useParams();
  const { user } = useAuthUser();
  const toast = useToast();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [reports, setReports] = useState<PlayerReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [filter, setFilter] = useState<ReportFilter>('pending');
  const [selectedReport, setSelectedReport] = useState<PlayerReport | null>(null);
  const [adminNotes, setAdminNotes] = useState('');
  const [processing, setProcessing] = useState(false);

  const loadReports = useCallback(
    async (getIsMounted?: () => boolean) => {
      setLoading(true);
      setLoadError(false);
      try {
        // This SECURITY DEFINER RPC returns only reports the caller may moderate.
        const { data, error } = await supabase.rpc('fn_list_player_reports', { p_status: filter });
        if (getIsMounted && !getIsMounted()) return;
        if (error) throw error;
        setReports((data as PlayerReport[]) || []);
      } catch (error) {
        if (getIsMounted && !getIsMounted()) return;
        setReports([]);
        setLoadError(true);
        reportError(error, 'ReportReviewPage.Failed_to_load_reports');
        toast.error('Failed to load reports');
      } finally {
        if (!getIsMounted || getIsMounted()) setLoading(false);
      }
    },
    [filter, toast]
  );

  useEffect(() => {
    let isMounted = true;
    if (clubId) void loadReports(() => isMounted);
    return () => {
      isMounted = false;
    };
  }, [clubId, loadReports]);

  useEffect(() => {
    if (!clubId) return;
    let isMounted = true;
    const channelKey = `report-review-realtime-${clubId}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'user_reports' },
        (payload) => {
          if (!isMounted) return;
          if (payload.eventType === 'INSERT') {
            void loadReports(() => isMounted);
          } else if (payload.eventType === 'UPDATE') {
            const updated = payload.new as Partial<PlayerReport> & { id: string };
            setReports((current) =>
              current.map((report) =>
                report.id === updated.id ? { ...report, ...updated } : report
              )
            );
          }
        }
      )
      .subscribe((status: string, error?: Error) => {
        if (status === 'CHANNEL_ERROR' && error)
          reportError(error, 'ReportReviewPage.Realtime_channel_error');
        if (status === 'TIMED_OUT') console.warn('[ReportReviewPage] Realtime channel timed out');
      });
    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId, loadReports]);

  useEffect(() => {
    if (!selectedReport) return;
    closeButtonRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedReport(null);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [selectedReport]);

  const openReport = (report: PlayerReport) => {
    setSelectedReport(report);
    setAdminNotes(report.admin_notes || '');
  };

  const handleFilterKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    current: ReportFilter
  ) => {
    const currentIndex = REPORT_FILTERS.indexOf(current);
    let nextIndex = currentIndex;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % REPORT_FILTERS.length;
    else if (event.key === 'ArrowLeft')
      nextIndex = (currentIndex - 1 + REPORT_FILTERS.length) % REPORT_FILTERS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = REPORT_FILTERS.length - 1;
    else return;
    event.preventDefault();
    const next = REPORT_FILTERS[nextIndex];
    setFilter(next);
    requestAnimationFrame(() => document.getElementById(`report-filter-${next}`)?.focus());
  };

  const handleAction = (reportId: string, action: 'actioned' | 'dismissed') => {
    setProcessing(true);
    const previousReports = reports;
    const previousSelected = selectedReport;
    const previousNotes = adminNotes;
    const sanitizedNotes = sanitizeInput(adminNotes);
    setReports((current) =>
      current.map((report) =>
        report.id === reportId
          ? {
              ...report,
              status: action,
              reviewed_at: new Date().toISOString(),
              reviewed_by: user?.id,
              admin_notes: sanitizedNotes,
            }
          : report
      )
    );
    setSelectedReport(null);
    setAdminNotes('');
    toast.success(action === 'actioned' ? 'Player action taken' : 'Report dismissed');

    void Promise.resolve(
      supabase.rpc('fn_action_player_report', {
        p_report_id: reportId,
        p_status: action,
        p_admin_notes: sanitizedNotes,
      })
    )
      .then(({ data, error }) => {
        const result = data as { success?: boolean; error?: string } | null;
        if (error || result?.success === false) {
          setReports(previousReports);
          setSelectedReport(previousSelected);
          setAdminNotes(previousNotes);
          toast.error(result?.error || 'Failed to update report');
          reportError(error || result?.error, 'ReportReviewPage.Failed_to_update_report');
        }
        setProcessing(false);
      })
      .catch((error: unknown) => {
        setReports(previousReports);
        setSelectedReport(previousSelected);
        setAdminNotes(previousNotes);
        setProcessing(false);
        toast.error('Failed to update report');
        reportError(error, 'ReportReviewPage.Failed_to_update_report');
      });
  };

  const pendingCount = reports.filter((report) => report.status === 'pending').length;
  const actionedCount = reports.filter((report) => report.status === 'actioned').length;

  return (
    <div className="report-review-page">
      <ClubIntegrityHeader
        clubId={clubId}
        active="reports"
        eyebrow="Case Intake / Conduct Signals"
        title="Player Report Review"
        description="Triage Player Conduct Signals, Inspect The Evidence, And Record A Moderation Decision Without Leaving The Live Club Workflow."
        metrics={[
          { label: 'In View', value: reports.length },
          { label: 'Pending', value: pendingCount, tone: pendingCount ? 'active' : 'neutral' },
          { label: 'Actioned', value: actionedCount, tone: actionedCount ? 'risk' : 'neutral' },
        ]}
      />

      <main className="report-workspace">
        <div className="case-toolbar">
          <div>
            <p className="case-kicker">Moderation Queue</p>
            <h2>Conduct Reports</h2>
          </div>
          <div className="filter-tabs" role="tablist" aria-label="Filter Reports By Status">
            {REPORT_FILTERS.map((item) => (
              <button
                key={item}
                id={`report-filter-${item}`}
                type="button"
                role="tab"
                aria-selected={filter === item}
                aria-controls="report-case-panel"
                tabIndex={filter === item ? 0 : -1}
                className={`filter-tab ${filter === item ? 'active' : ''}`}
                onClick={() => setFilter(item)}
                onKeyDown={(event) => handleFilterKeyDown(event, item)}
              >
                {item.charAt(0).toUpperCase() + item.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div id="report-case-panel" role="tabpanel" aria-labelledby={`report-filter-${filter}`}>
          {loading ? (
            <PageSkeleton variant="list" />
          ) : loadError ? (
            <div className="report-state report-error" role="alert">
              <strong>Report Queue Unavailable</strong>
              <p>
                The Live Moderation Feed Could Not Be Loaded. Existing Case Data Was Not Changed.
              </p>
              <button type="button" onClick={() => void loadReports()}>
                Retry Report Feed
              </button>
            </div>
          ) : reports.length === 0 ? (
            <div className="report-state">
              <span className="state-signal" aria-hidden="true" />
              <strong>Queue Clear</strong>
              <p>No {filter === 'pending' ? 'Pending ' : ''}reports Match This View.</p>
            </div>
          ) : (
            <div className="reports-list">
              {reports.map((report) => (
                <button
                  key={report.id}
                  type="button"
                  className="report-card"
                  aria-haspopup="dialog"
                  onClick={() => openReport(report)}
                >
                  <span className="report-header">
                    <span className="reason-label">{report.reason}</span>
                    <span className={`status-badge status-${report.status}`}>{report.status}</span>
                  </span>
                  <span className="report-players">
                    <span>
                      <strong>Filed By</strong>
                      {report.reporter_username || 'Unknown Player'}
                    </span>
                    <span>
                      <strong>Against</strong>
                      {report.reported_username || 'Unknown Player'}
                    </span>
                  </span>
                  <span className="report-date">
                    Opened {new Date(report.created_at).toLocaleDateString()}
                  </span>
                  <span className="inspect-label">Inspect Case</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </main>

      {selectedReport && (
        <div
          className="modal-overlay"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setSelectedReport(null);
          }}
        >
          <section
            className="modal-content"
            role="dialog"
            aria-modal="true"
            aria-labelledby="report-dialog-title"
          >
            <div className="modal-header">
              <div>
                <p className="case-kicker">Conduct Case</p>
                <h2 id="report-dialog-title">Report Details</h2>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={() => setSelectedReport(null)}
                aria-label="Close Report Details"
              >
                Close
              </button>
            </div>
            <div className="modal-body">
              <dl className="case-details">
                <div>
                  <dt>Reported Player</dt>
                  <dd>{selectedReport.reported_username || 'Unknown Player'}</dd>
                </div>
                <div>
                  <dt>Reported By</dt>
                  <dd>{selectedReport.reporter_username || 'Unknown Player'}</dd>
                </div>
                <div>
                  <dt>Reason</dt>
                  <dd>{selectedReport.reason}</dd>
                </div>
                <div className="full-detail">
                  <dt>Description</dt>
                  <dd>{selectedReport.details || 'No Additional Details Supplied.'}</dd>
                </div>
              </dl>
              {selectedReport.status === 'pending' && (
                <>
                  <div className="notes-field">
                    <label htmlFor="report-admin-notes">Decision Notes</label>
                    <textarea
                      id="report-admin-notes"
                      value={adminNotes}
                      onChange={(event) => setAdminNotes(event.target.value)}
                      placeholder="Record The Evidence And Decision Rationale"
                      rows={4}
                    />
                  </div>
                  <div className="action-buttons">
                    <button
                      className="btn btn-danger"
                      type="button"
                      onClick={() => handleAction(selectedReport.id, 'actioned')}
                      disabled={processing}
                    >
                      Take Action
                    </button>
                    <button
                      className="btn btn-secondary"
                      type="button"
                      onClick={() => handleAction(selectedReport.id, 'dismissed')}
                      disabled={processing}
                    >
                      Dismiss Report
                    </button>
                  </div>
                </>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
