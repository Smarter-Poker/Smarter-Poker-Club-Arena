/**
 *  REPORT REVIEW PAGE — Admin Review of Player Reports
 */

import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { sanitizeInput } from '../utils/sanitizeInput';
import PageSkeleton from '../components/common/PageSkeleton';
import ClubBottomNav from '../components/club/ClubBottomNav';
import './ReportReviewPage.css';

const reportCardAnimationStyle = (index: number) => ({
  opacity: 0,
  transform: 'translateY(8px)',
  animation: `fadeInUp 0.5s ease-out ${index * 60}ms forwards`,
});

interface PlayerReport {
  id: string;
  reporter_id: string;
  reported_player_id: string;
  reason: string;
  description: string;
  hand_id?: string;
  status: 'pending' | 'reviewed' | 'actioned' | 'dismissed';
  created_at: string;
  reviewed_at?: string;
  admin_notes?: string;
  reporter?: { username: string };
  reported_player?: { username: string };
}

export default function ReportReviewPage() {
  const { clubId } = useParams();
  const { user } = useAuthUser();
  const toast = useToast();

  const [reports, setReports] = useState<PlayerReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending' | 'reviewed'>('pending');
  const [selectedReport, setSelectedReport] = useState<PlayerReport | null>(null);
  const [adminNotes, setAdminNotes] = useState('');
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    let isMounted = true;
    if (clubId) loadReports(() => isMounted);
    return () => {
      isMounted = false;
    };
  }, [clubId, filter]);

  // ── Realtime: live updates for new/updated reports ──
  useEffect(() => {
    let isMounted = true;
    const channelKey = 'report-review-realtime';

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'player_reports',
        },
        (payload) => {
          if (!isMounted) return;
          if (payload.eventType === 'INSERT') {
            // New report — reload to get joined profile data
            loadReports(() => isMounted);
          } else if (payload.eventType === 'UPDATE') {
            const updated = payload.new as any;
            setReports((prev) => prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)));
          }
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          console.error('[ReportReviewPage] ❌ Realtime channel error:', err?.message || err);
        }
        if (status === 'TIMED_OUT') {
          console.warn('[ReportReviewPage] ⏱️ Realtime channel timed out');
        }
      });

    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId, filter]);

  const loadReports = async (getIsMounted?: () => boolean) => {
    setLoading(true);
    try {
      let query = supabase
        .from('player_reports')
        .select(
          `
                    *,
                    reporter:profiles!reporter_id(username),
                    reported_player:profiles!reported_player_id(username)
                `
        )
        .order('created_at', { ascending: false });

      if (filter === 'pending') {
        query = query.eq('status', 'pending');
      } else if (filter === 'reviewed') {
        query = query.neq('status', 'pending');
      }

      const { data, error } = await query.limit(50);

      if (getIsMounted && !getIsMounted()) return;
      if (error) throw error;
      setReports(data || []);
    } catch (error) {
      if (getIsMounted && !getIsMounted()) return;
      console.error('Failed to load reports:', error);
      toast.error('Failed to load reports');
    }
    if (getIsMounted && !getIsMounted()) return;
    setLoading(false);
  };

  const handleAction = async (reportId: string, action: 'actioned' | 'dismissed') => {
    setProcessing(true);
    try {
      const { error } = await supabase
        .from('player_reports')
        .update({
          status: action,
          reviewed_at: new Date().toISOString(),
          reviewed_by: user?.id,
          admin_notes: sanitizeInput(adminNotes),
        })
        .eq('id', reportId);

      if (error) throw error;

      toast.success(action === 'actioned' ? 'Player action taken' : 'Report dismissed');
      setSelectedReport(null);
      setAdminNotes('');
      loadReports();
    } catch (error) {
      toast.error('Failed to update report');
    }
    setProcessing(false);
  };

  const getReasonIcon = (reason: string) => {
    const icons: Record<string, string> = {
      collusion: '↔',
      cheating: '✗',
      abuse: '!',
      harassment: '⚠',
      other: '●',
    };
    return icons[reason] || '●';
  };

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      pending: '#f59e0b',
      reviewed: '#3b82f6',
      actioned: '#ef4444',
      dismissed: '#6b7280',
    };
    return (
      <span className="status-badge" style={{ backgroundColor: colors[status] }}>
        {status}
      </span>
    );
  };

  return (
    <div className="report-review-page">
      {/* Filter Tabs */}
      <div className="filter-tabs">
        {(['pending', 'reviewed', 'all'] as const).map((f) => (
          <button
            key={f}
            className={`filter-tab ${filter === f ? 'active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {loading ? (
        <PageSkeleton variant="list" />
      ) : reports.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">⚠</span>
          <p>No {filter === 'pending' ? 'pending' : ''} reports</p>
        </div>
      ) : (
        <div className="reports-list">
          {reports.map((report, idx) => (
            <div
              key={report.id}
              style={reportCardAnimationStyle(idx)}
              className={`report-card ${selectedReport?.id === report.id ? 'selected' : ''}`}
              onClick={() => {
                setSelectedReport(report);
                setAdminNotes(report.admin_notes || '');
              }}
            >
              <div className="report-header">
                <span className="reason-icon">{getReasonIcon(report.reason)}</span>
                <span className="reason-label">{report.reason}</span>
                {getStatusBadge(report.status)}
              </div>
              <div className="report-players">
                <span className="reporter">
                  <strong>By:</strong> {report.reporter?.username || 'Unknown'}
                </span>
                <span className="reported">
                  <strong>Against:</strong> {report.reported_player?.username || 'Unknown'}
                </span>
              </div>
              <div className="report-date">{new Date(report.created_at).toLocaleDateString()}</div>
            </div>
          ))}
        </div>
      )}

      {/* Report Detail Modal */}
      {selectedReport && (
        <div className="modal-overlay" onClick={() => setSelectedReport(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{getReasonIcon(selectedReport.reason)} Report Details</h3>
              <button onClick={() => setSelectedReport(null)} aria-label="Close report details">
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="detail-row">
                <label>Reported Player:</label>
                <span>{selectedReport.reported_player?.username}</span>
              </div>
              <div className="detail-row">
                <label>Reported By:</label>
                <span>{selectedReport.reporter?.username}</span>
              </div>
              <div className="detail-row">
                <label>Reason:</label>
                <span>{selectedReport.reason}</span>
              </div>
              {selectedReport.hand_id && (
                <div className="detail-row">
                  <label>Hand ID:</label>
                  <Link to={`/share/hand/${selectedReport.hand_id}`}>{selectedReport.hand_id}</Link>
                </div>
              )}
              <div className="detail-row full">
                <label>Description:</label>
                <p className="description">{selectedReport.description}</p>
              </div>

              {selectedReport.status === 'pending' && (
                <>
                  <div className="detail-row full">
                    <label>Admin Notes:</label>
                    <textarea
                      value={adminNotes}
                      onChange={(e) => setAdminNotes(e.target.value)}
                      placeholder="Add notes about your decision..."
                      rows={3}
                    />
                  </div>
                  <div className="action-buttons">
                    <button
                      className="btn btn-danger"
                      onClick={() => handleAction(selectedReport.id, 'actioned')}
                      disabled={processing}
                    >
                      Take Action
                    </button>
                    <button
                      className="btn btn-secondary"
                      onClick={() => handleAction(selectedReport.id, 'dismissed')}
                      disabled={processing}
                    >
                      Dismiss
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Bottom Navigation */}
      {clubId && <ClubBottomNav clubId={clubId} />}
    </div>
  );
}
