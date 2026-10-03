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
import { useToast } from '../components/common/Toast';
import { SpadeConsole } from '../components/console/SpadeConsole';
import { useAuthUser } from '../hooks/useAuthUser';
import { supabase } from '../lib/supabase';
import { resolveClubUUIDStrict } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import { sanitizeInput } from '../utils/sanitizeInput';
import { titleCase } from '../utils/titleCase';
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

interface ReportScope {
  viewKey: string;
  clubUuid: string;
}

interface SelectedReport extends ReportScope {
  report: PlayerReport;
}

/** The moderation queue refreshes on this cadence while the tab is visible.
 *  See the polling effect below for why this is not a realtime subscription. */
const REPORT_POLL_MS = 45_000;

/** fn_list_player_reports returns at most this many rows, newest first, with
 *  no cursor. The list says so when it is full rather than implying the queue
 *  ends there. */
const REPORT_PAGE_SIZE = 100;

export default function ReportReviewPage() {
  const { clubId } = useParams();
  const { user } = useAuthUser();
  const toast = useToast();
  const dialogShellRef = useRef<HTMLDivElement>(null);
  const [reports, setReports] = useState<PlayerReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [filter, setFilter] = useState<ReportFilter>('pending');
  const [loadedViewKey, setLoadedViewKey] = useState<string | null>(null);
  const [listScope, setListScope] = useState<ReportScope | null>(null);
  const [selectedReport, setSelectedReport] = useState<SelectedReport | null>(null);
  const [adminNotes, setAdminNotes] = useState('');
  const [processing, setProcessing] = useState(false);
  const mountedRef = useRef(false);
  const loadRequestRef = useRef(0);
  const actionRequestRef = useRef(0);
  const listRevisionRef = useRef(0);
  const selectionRevisionRef = useRef(0);
  const viewKey = `${clubId ?? ''}:${user?.id ?? 'signed-out'}:${filter}`;
  const currentViewKeyRef = useRef(viewKey);
  currentViewKeyRef.current = viewKey;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadRequestRef.current += 1;
      actionRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    /* A route, viewer or filter change is a new moderation scope. Hide the old
       list synchronously through `loadedViewKey`, then retire every result and
       modal that was created under the previous identity. */
    loadRequestRef.current += 1;
    actionRequestRef.current += 1;
    listRevisionRef.current += 1;
    selectionRevisionRef.current += 1;
    setReports([]);
    setListScope(null);
    setLoadedViewKey(null);
    setLoadError(false);
    setLoading(Boolean(clubId));
    setSelectedReport(null);
    setAdminNotes('');
    setProcessing(false);
  }, [viewKey, clubId]);

  const loadReports = useCallback(async () => {
    if (!clubId) return;
    const requestedViewKey = `${clubId}:${user?.id ?? 'signed-out'}:${filter}`;
    const requestId = ++loadRequestRef.current;
    const isCurrent = () =>
      mountedRef.current &&
      requestId === loadRequestRef.current &&
      requestedViewKey === currentViewKeyRef.current;
    setLoading(true);
    setLoadError(false);
    try {
      /* SCOPED TO THIS CLUB (20260905194441). The RPC returns only reports
           the caller may moderate - that gate is unchanged - but it took no
           club argument, so this page pooled every club an operator runs under
           whichever club header they happened to open, and the three counts
           above described the pool. `clubId` was previously used only as an
           `if` gate before this call. */
      const resolvedForReports = await resolveClubUUIDStrict(clubId);
      if (!isCurrent()) return;
      const { data, error } = await supabase.rpc('fn_list_player_reports', {
        p_status: filter,
        p_club_id: resolvedForReports,
      });
      if (!isCurrent()) return;
      if (error) throw error;
      listRevisionRef.current += 1;
      setReports((data as PlayerReport[]) || []);
      setListScope({ viewKey: requestedViewKey, clubUuid: resolvedForReports });
      setLoadedViewKey(requestedViewKey);
    } catch (error) {
      if (!isCurrent()) return;
      listRevisionRef.current += 1;
      setReports([]);
      setListScope(null);
      setLoadedViewKey(requestedViewKey);
      setLoadError(true);
      reportError(error, 'ReportReviewPage.Failed_to_load_reports');
      toast.error('Failed to load reports');
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [filter, toast, clubId, user?.id]);

  useEffect(() => {
    if (clubId) void loadReports();
  }, [clubId, loadReports]);

  /**
   * POLLING, BECAUSE THE SUBSCRIPTION HERE WAS NEVER LIVE.
   *
   * This block used to open a postgres_changes channel on `user_reports`. Two
   * separate reasons it could not deliver anything:
   *
   *   1. `user_reports` is not in the `supabase_realtime` publication, so no
   *      change on it is ever decoded into a realtime message at all.
   *   2. Realtime applies RLS to what it sends, and the SELECT policy on that
   *      table is reporter, reported, or service_role. A moderator matches
   *      none of the three, so even if the table were published they would
   *      receive nothing.
   *
   * Adding the table to the publication is the wrong fix on this estate:
   * realtime is already the single largest consumer of the database at 17.5%
   * of all query time, with 114 tables published against 65 live
   * subscriptions. A moderation queue does not need sub-second delivery, so
   * this polls while the tab is visible and refreshes on focus instead - and
   * the list is authoritative after every action because each action reloads
   * it.
   */
  useEffect(() => {
    if (!clubId) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void loadReports();
    }, REPORT_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [clubId, loadReports]);

  const closeReport = useCallback(() => {
    selectionRevisionRef.current += 1;
    setSelectedReport(null);
    setAdminNotes('');
  }, []);

  useEffect(() => {
    if (!selectedReport) return;
    dialogShellRef.current?.querySelector<HTMLButtonElement>('[data-testid="sc-close"]')?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeReport();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [closeReport, selectedReport]);

  const openReport = (report: PlayerReport) => {
    if (!listScope || listScope.viewKey !== currentViewKeyRef.current) return;
    selectionRevisionRef.current += 1;
    setSelectedReport({ ...listScope, report });
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
    const selection = selectedReport;
    if (
      !selection ||
      selection.report.id !== reportId ||
      selection.viewKey !== currentViewKeyRef.current
    ) {
      return;
    }
    const requestId = ++actionRequestRef.current;
    const actionViewKey = selection.viewKey;
    const isCurrent = () =>
      mountedRef.current &&
      requestId === actionRequestRef.current &&
      actionViewKey === currentViewKeyRef.current;
    setProcessing(true);
    const previousReports = reports;
    const previousSelected = selectedReport;
    const previousNotes = adminNotes;
    const sanitizedNotes = sanitizeInput(adminNotes);
    const optimisticRevision = ++listRevisionRef.current;
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
    const closedSelectionRevision = ++selectionRevisionRef.current;
    setSelectedReport(null);
    setAdminNotes('');
    /* THE SUCCESS MESSAGE MOVED BELOW THE WRITE (2026-09-05 sweep). It used to
       fire here, before the RPC had even been issued, so a refusal showed the
       operator "Player action taken" and then "Failed to update report" - and
       the first one is the one they act on. The optimistic ROW update above is
       fine and stays: it is rolled back on the refusal path. A toast cannot be
       rolled back, so it waits for the answer. */

    void Promise.resolve(
      supabase.rpc('fn_action_player_report', {
        p_report_id: reportId,
        p_status: action,
        p_admin_notes: sanitizedNotes,
      })
    )
      .then(({ data, error }) => {
        if (!isCurrent()) return;
        const result = data as { success?: boolean; error?: string } | null;
        if (error || result?.success === false) {
          if (listRevisionRef.current === optimisticRevision) {
            listRevisionRef.current += 1;
            setReports(previousReports);
          }
          if (selectionRevisionRef.current === closedSelectionRevision) {
            selectionRevisionRef.current += 1;
            setSelectedReport(previousSelected);
            setAdminNotes(previousNotes);
          }
          toast.error(result?.error || 'Failed to update report');
          reportError(error || result?.error, 'ReportReviewPage.Failed_to_update_report');
        } else {
          toast.success(action === 'actioned' ? 'Player Action Taken' : 'Report Dismissed');
        }
        setProcessing(false);
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        if (listRevisionRef.current === optimisticRevision) {
          listRevisionRef.current += 1;
          setReports(previousReports);
        }
        if (selectionRevisionRef.current === closedSelectionRevision) {
          selectionRevisionRef.current += 1;
          setSelectedReport(previousSelected);
          setAdminNotes(previousNotes);
        }
        setProcessing(false);
        toast.error('Failed to update report');
        reportError(error, 'ReportReviewPage.Failed_to_update_report');
      });
  };

  const viewIsCurrent = loadedViewKey === viewKey;
  const visibleReports = viewIsCurrent ? reports : [];
  const pendingCount = visibleReports.filter((report) => report.status === 'pending').length;
  const actionedCount = visibleReports.filter((report) => report.status === 'actioned').length;

  return (
    <div className="report-review-page">
      <ClubIntegrityHeader
        clubId={clubId}
        active="reports"
        eyebrow="Case Intake / Conduct Signals"
        title="Player Report Review"
        description="Triage Player Conduct Signals, Inspect The Evidence, And Record A Moderation Decision Without Leaving The Live Club Workflow."
        metrics={[
          { label: 'In View', value: visibleReports.length },
          { label: 'Pending', value: pendingCount, tone: pendingCount ? 'active' : 'neutral' },
          { label: 'Actioned', value: actionedCount, tone: actionedCount ? 'risk' : 'neutral' },
        ]}
      />

      <main className="report-workspace">
        <SpadeConsole
          className="report-console"
          family="spade"
          crest="spade"
          eyebrow="Integrity Casework"
          title="Conduct Reports"
          pill={titleCase(filter)}
          pillInk={loadError ? 'red' : pendingCount > 0 ? 'gold' : 'blue'}
          foot="foot"
        >
          <div className="case-toolbar">
            <p className="case-kicker">Moderation Queue</p>
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
                  {titleCase(item)}
                </button>
              ))}
            </div>
          </div>

          <div id="report-case-panel" role="tabpanel" aria-labelledby={`report-filter-${filter}`}>
            {!viewIsCurrent || loading ? (
              <div
                className="report-state sc-copy sc-copy--center"
                role="status"
                aria-live="polite"
              >
                <strong className="sc-label sc-ink--blue">Loading Report Queue</strong>
                <p>Confirming The Current Club And Moderation Scope.</p>
              </div>
            ) : loadError ? (
              <div className="report-state report-error sc-copy sc-copy--center" role="alert">
                <strong className="sc-label sc-ink--red">Report Queue Unavailable</strong>
                <p>
                  The Live Moderation Feed Could Not Be Loaded. Existing Case Data Was Not Changed.
                </p>
                <button type="button" onClick={() => void loadReports()}>
                  Retry Report Feed
                </button>
              </div>
            ) : visibleReports.length === 0 ? (
              <div className="report-state sc-copy sc-copy--center">
                <strong className="sc-label sc-ink--blue">Queue Clear</strong>
                <p>No {filter === 'pending' ? 'Pending ' : ''}Reports Match This View.</p>
              </div>
            ) : (
              <div className="reports-list">
                {/* fn_list_player_reports takes the newest 100 and offers no
                  cursor. A queue that silently stops at its own ceiling looks
                  like a queue that has been worked down. */}
                {visibleReports.length >= REPORT_PAGE_SIZE && (
                  <p className="report-cap" role="status">
                    Showing The {REPORT_PAGE_SIZE} Most Recent Reports. Work This View Down To See
                    Older Cases.
                  </p>
                )}
                {visibleReports.map((report) => (
                  <button
                    key={report.id}
                    type="button"
                    className="report-card"
                    aria-haspopup="dialog"
                    onClick={() => openReport(report)}
                  >
                    <span className="report-header">
                      <span className="reason-label sc-ink--silver">
                        {titleCase(report.reason)}
                      </span>
                      <span className={`status-badge status-${report.status}`}>
                        {titleCase(report.status)}
                      </span>
                    </span>
                    <span className="report-players">
                      <span>
                        <strong>Filed By</strong>
                        {titleCase(report.reporter_username || 'Unknown Player')}
                      </span>
                      <span>
                        <strong>Against</strong>
                        {titleCase(report.reported_username || 'Unknown Player')}
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
        </SpadeConsole>
      </main>

      {selectedReport && selectedReport.viewKey === viewKey && (
        <div
          className="modal-overlay"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) closeReport();
          }}
        >
          <div className="report-dialog-shell" ref={dialogShellRef}>
            <SpadeConsole
              className="report-dialog-console"
              family="riveted"
              crest="flat"
              eyebrow="Conduct Case"
              title="Report Details"
              titleId="report-dialog-title"
              pill={titleCase(selectedReport.report.status)}
              pillInk={selectedReport.report.status === 'pending' ? 'gold' : 'blue'}
              role="dialog"
              aria-modal="true"
              aria-labelledby="report-dialog-title"
              onClose={closeReport}
              foot={selectedReport.report.status === 'pending' ? 'plates' : 'foot'}
              plates={
                selectedReport.report.status === 'pending'
                  ? {
                      secondary: {
                        label: 'Dismiss Report',
                        disabled: processing,
                        onClick: () => handleAction(selectedReport.report.id, 'dismissed'),
                      },
                      primary: {
                        label: 'Take Action',
                        ink: 'red',
                        disabled: processing,
                        onClick: () => handleAction(selectedReport.report.id, 'actioned'),
                      },
                    }
                  : undefined
              }
            >
              <div className="modal-body">
                <dl className="case-details">
                  <div>
                    <dt>Reported Player</dt>
                    <dd>
                      {titleCase(selectedReport.report.reported_username || 'Unknown Player')}
                    </dd>
                  </div>
                  <div>
                    <dt>Reported By</dt>
                    <dd>
                      {titleCase(selectedReport.report.reporter_username || 'Unknown Player')}
                    </dd>
                  </div>
                  <div>
                    <dt>Reason</dt>
                    <dd>{titleCase(selectedReport.report.reason)}</dd>
                  </div>
                  <div className="full-detail">
                    <dt>Description</dt>
                    <dd>
                      {titleCase(
                        selectedReport.report.details || 'No Additional Details Supplied.'
                      )}
                    </dd>
                  </div>
                </dl>
                {selectedReport.report.status === 'pending' && (
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
                  </>
                )}
              </div>
            </SpadeConsole>
          </div>
        </div>
      )}
    </div>
  );
}
