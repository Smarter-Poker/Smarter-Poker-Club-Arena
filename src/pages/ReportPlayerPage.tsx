/**
 *  REPORT PLAYER PAGE
 */

import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { sanitizeInput } from '../utils/sanitizeInput';
import './ReportPlayerPage.css';
import { reportError } from '../utils/errorReporter';

import { safeErrorMessage } from '../utils/safeErrorMessage';
const reportSectionAnimationStyle = (index: number) => ({
  opacity: 0,
  transform: 'translateY(8px)',
  animation: `fadeInUp 0.5s ease-out ${index * 70}ms forwards`,
});

type ReportReason = 'collusion' | 'abuse' | 'cheating' | 'harassment' | 'other';

interface ReportForm {
  reason: ReportReason;
  description: string;
  hand_id?: string;
  include_chat_logs: boolean;
}

export default function ReportPlayerPage() {
  const navigate = useNavigate();
  const { playerId } = useParams();
  const { user } = useAuthUser();

  const [form, setForm] = useState<ReportForm>({
    reason: 'abuse',
    description: '',
    include_chat_logs: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!form.description.trim()) {
      setError('Please describe the issue');
      return;
    }
    if (!playerId || !user?.id) return;

    setSubmitting(true);
    setError(null);
    try {
      // Canonical table is user_reports (reporter_id, reported_user_id, reason, details,
      // status). hand_id + chat-log preference are folded into the details text since
      // user_reports has no dedicated columns for them.
      const detailParts = [sanitizeInput(form.description)];
      if (form.hand_id) detailParts.push(`Hand: ${sanitizeInput(form.hand_id)}`);
      if (form.include_chat_logs) detailParts.push('(reporter requested chat logs be reviewed)');
      const { error: submitError } = await supabase.from('user_reports').insert({
        reporter_id: user.id,
        reported_user_id: playerId,
        reason: form.reason,
        details: detailParts.join('\n'),
        status: 'pending',
      });

      if (submitError) throw submitError;
      setSubmitted(true);
    } catch (err: any) {
      reportError(err, 'ReportPlayerPage.Failed_to_submit_report');
      setError(safeErrorMessage(err, 'Failed to submit report'));
    }
    setSubmitting(false);
  };

  const reasonOptions: { value: ReportReason; label: string; icon: string }[] = [
    { value: 'collusion', label: 'Collusion', icon: '' },
    { value: 'cheating', label: 'Cheating', icon: '' },
    { value: 'abuse', label: 'Abusive Behavior', icon: '' },
    { value: 'harassment', label: 'Harassment', icon: '' },
    { value: 'other', label: 'Other', icon: '' },
  ];

  if (submitted) {
    return (
      <div className="report-page">
        <div className="success-state">
          <span className="success-icon"></span>
          <h2>Report Submitted</h2>
          <p>
            Thank You For Helping Keep Our Community Safe. Our Team Will Review Your Report Within
            24 Hours.
          </p>
          <button className="btn btn-primary" onClick={() => navigate(-1)}>
            Go Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="report-page">
      <div className="report-content">
        {error && <div className="error-message">{error}</div>}

        <div className="report-warning" style={reportSectionAnimationStyle(0)}>
          <span className="warning-icon"></span>
          <p>
            False Reports May Result In Account Suspension. Please Only Report Genuine Violations.
          </p>
        </div>

        <section className="report-section" style={reportSectionAnimationStyle(1)}>
          <h3>Reason For Report</h3>
          <div className="reason-options">
            {reasonOptions.map((opt) => (
              <button
                key={opt.value}
                className={`reason-btn ${form.reason === opt.value ? 'active' : ''}`}
                onClick={() => setForm((prev) => ({ ...prev, reason: opt.value }))}
              >
                <span className="reason-icon">{opt.icon}</span>
                <span className="reason-label">{opt.label}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="report-section" style={reportSectionAnimationStyle(2)}>
          <h3>Description</h3>
          <textarea
            placeholder="Please Describe What Happened In Detail..."
            value={form.description}
            onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
            rows={5}
          />
        </section>

        <section className="report-section" style={reportSectionAnimationStyle(3)}>
          <h3>Hand ID (Optional)</h3>
          <input
            type="text"
            placeholder="Enter Hand ID If Applicable..."
            value={form.hand_id || ''}
            onChange={(e) => setForm((prev) => ({ ...prev, hand_id: e.target.value }))}
          />
        </section>

        <section className="report-section" style={reportSectionAnimationStyle(4)}>
          <div className="checkbox-row">
            <input
              type="checkbox"
              id="include-chat"
              checked={form.include_chat_logs}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, include_chat_logs: e.target.checked }))
              }
            />
            <label htmlFor="include-chat">Include Recent Chat Logs With This Player</label>
          </div>
        </section>

        <button
          className="btn btn-danger submit-btn"
          onClick={handleSubmit}
          disabled={submitting || !form.description.trim()}
        >
          {submitting ? 'Submitting...' : 'Submit Report'}
        </button>
      </div>
    </div>
  );
}
