/**
 *  REPORT PLAYER PAGE - on the spade console (#ClubArenaConsole)
 *
 *  One flow, one console: the reason as lit words, the description and the
 *  hand id printed on the glass between engraved rules, Cancel and Submit
 *  Report on the two painted plates. The success state closes flat, with
 *  Go Back as a lit word. Every handler, guard and string of the generic
 *  page is kept; only the paint changed.
 */

import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { sanitizeInput } from '../utils/sanitizeInput';
import { SpadeConsole } from '../components/console/SpadeConsole';
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

  const reasonOptions: { value: ReportReason; label: string }[] = [
    { value: 'collusion', label: 'Collusion' },
    { value: 'cheating', label: 'Cheating' },
    { value: 'abuse', label: 'Abusive Behavior' },
    { value: 'harassment', label: 'Harassment' },
    { value: 'other', label: 'Other' },
  ];

  if (submitted) {
    return (
      <div className="report-page">
        <SpadeConsole
          className="rpc__console"
          eyebrow="Player Safety"
          title="Report Submitted"
          titleId="report-player-title"
          pill="Sent"
          pillInk="green"
          foot="foot"
        >
          <p className="sc-copy sc-copy--center rpc__success-body">
            Thank You For Helping Keep Our Community Safe. Our Team Will Review Your Report Within
            24 Hours.
          </p>
          <div className="rpc__actions">
            <button type="button" className="rpc-word sc-ink--white" onClick={() => navigate(-1)}>
              Go Back
            </button>
          </div>
        </SpadeConsole>
      </div>
    );
  }

  return (
    <div className="report-page">
      <SpadeConsole
        className="rpc__console"
        eyebrow="Player Safety"
        title="Report Player"
        titleId="report-player-title"
        pill="Private"
        pillInk="muted"
        plates={{
          secondary: { label: 'Cancel', onClick: () => navigate(-1) },
          primary: {
            label: submitting ? 'Submitting...' : 'Submit Report',
            ink: 'red',
            onClick: handleSubmit,
            disabled: submitting || !form.description.trim(),
          },
        }}
      >
        {error && (
          <p className="sc-copy rpc__error sc-ink--red" role="alert">
            {error}
          </p>
        )}

        <p className="sc-copy rpc__warning" style={reportSectionAnimationStyle(0)}>
          False Reports May Result In Account Suspension. Please Only Report Genuine Violations.
        </p>

        <section className="rpc__section" style={reportSectionAnimationStyle(1)}>
          <h3 className="rpc__section-title sc-label sc-ink--blue">Reason For Report</h3>
          <div className="rpc__reasons" role="group" aria-label="Reason For Report">
            {reasonOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`rpc-word rpc__reason ${form.reason === opt.value ? 'sc-ink--white is-active' : 'sc-ink--muted'}`}
                aria-pressed={form.reason === opt.value}
                onClick={() => setForm((prev) => ({ ...prev, reason: opt.value }))}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </section>

        <section className="rpc__section" style={reportSectionAnimationStyle(2)}>
          <h3 className="rpc__section-title sc-label sc-ink--blue">
            <label htmlFor="report-description">Description</label>
          </h3>
          <textarea
            id="report-description"
            className="rpc__field rpc__field--area"
            placeholder="Please Describe What Happened In Detail..."
            value={form.description}
            onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
            rows={5}
          />
        </section>

        <section className="rpc__section" style={reportSectionAnimationStyle(3)}>
          <h3 className="rpc__section-title sc-label sc-ink--blue">
            <label htmlFor="report-hand-id">Hand ID (Optional)</label>
          </h3>
          <input
            id="report-hand-id"
            type="text"
            className="rpc__field"
            placeholder="Enter Hand ID If Applicable..."
            value={form.hand_id || ''}
            onChange={(e) => setForm((prev) => ({ ...prev, hand_id: e.target.value }))}
          />
        </section>

        <section
          className="rpc__section rpc__section--check"
          style={reportSectionAnimationStyle(4)}
        >
          <input
            type="checkbox"
            id="include-chat"
            className="rpc__check"
            checked={form.include_chat_logs}
            onChange={(e) => setForm((prev) => ({ ...prev, include_chat_logs: e.target.checked }))}
          />
          <label htmlFor="include-chat" className="sc-copy rpc__check-label">
            Include Recent Chat Logs With This Player
          </label>
        </section>
      </SpadeConsole>
    </div>
  );
}
