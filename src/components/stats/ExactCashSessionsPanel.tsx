import { useEffect, useState } from 'react';
import {
  StatsCashSessionService,
  type StatsCashSessionReport,
} from '../../services/StatsCashSessionService';
import { compactChips } from '../../utils/format';
import { titleCase } from '../../utils/titleCase';
import StatsEvidenceLink from './StatsEvidenceLink';
import { reportError } from '../../utils/errorReporter';
import './ExactCashSessionsPanel.css';
import { SpadeConsole } from '../console/SpadeConsole';
import { buildStatsSessionEvidencePath } from '../../lib/statsEvidenceNavigation';

interface Props {
  userId: string;
  clubId: string | null;
  clubLabel: string;
  days: number | null;
  timezone: string;
  asset: string;
  resetKey?: string;
}

const value = (amount: number | null, asset: string) =>
  amount === null
    ? 'Not Yet Measured'
    : `${compactChips(amount)} ${asset === 'diamonds' ? 'Diamonds' : 'Chips'}`;
const label = (text: string) => titleCase(text.split('_').join(' '));

export default function ExactCashSessionsPanel(props: Props) {
  const [report, setReport] = useState<StatsCashSessionReport | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setReport(null);
    void StatsCashSessionService.get(
      props.userId,
      props.clubId,
      props.days,
      props.timezone,
      props.asset
    )
      .then((next) => {
        if (cancelled) return;
        if (!next) throw new Error('Cash Session Report Missing');
        setReport(next);
        setState('ready');
      })
      .catch((error) => {
        if (cancelled) return;
        reportError(error, 'ExactCashSessionsPanel.load');
        setReport(null);
        setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [props.userId, props.clubId, props.days, props.timezone, props.asset, reload, props.resetKey]);

  if (state === 'loading')
    return (
      <SpadeConsole
        family="shark"
        crest="club"
        eyebrow="Cash Session Evidence"
        title="Opening Exact Session Ledger..."
        pill="Verifying"
        className="exact-session-shell is-loading"
        aria-busy="true"
      />
    );
  if (state === 'error')
    return (
      <SpadeConsole
        family="shark"
        crest="club"
        eyebrow="Cash Session Evidence"
        title="Session Evidence Could Not Be Verified"
        pill="Interrupted"
        pillInk="red"
        className="exact-session-shell is-error"
        role="alert"
      >
        <section className="exact-session-console">
          <p>No Cached Or Inferred Session Result Is Displayed.</p>
          <button
            type="button"
            className="exact-session-word-action"
            onClick={() => setReload((n) => n + 1)}
          >
            Retry Exact Read
          </button>
        </section>
      </SpadeConsole>
    );

  const sessions = report?.sessions ?? [];
  return (
    <SpadeConsole
      family="shark"
      crest="club"
      eyebrow={`Cash Session Evidence // ${label(props.clubLabel)}`}
      title="Exact Session Ledger"
      titleId="exact-session-title"
      pill={`${report?.coverage.total_sessions ?? 0} Sessions`}
      className="exact-session-shell"
      aria-labelledby="exact-session-title"
    >
      <section className="exact-session-console">
        {report?.coverage.capped && (
          <p role="status">Showing The 100 Most Recent Sessions In This Range.</p>
        )}
        {sessions.length === 0 ? (
          <p className="exact-session-empty">No Cash Sessions Were Recorded In This Scope.</p>
        ) : (
          <div className="exact-session-list">
            {sessions.map((session) => (
              <article key={session.session_id} className={`capture-${session.capture_status}`}>
                <div className="exact-session-heading">
                  <div>
                    <span>{label(session.variant ?? 'Cash Game')}</span>
                    <strong>{new Date(session.opened_at).toLocaleString()}</strong>
                  </div>
                  <b>
                    {session.capture_status === 'exact'
                      ? 'Exact Close'
                      : label(session.capture_reason ?? session.capture_status)}
                  </b>
                </div>
                <dl>
                  <div>
                    <dt>Buy-In And Rebuys</dt>
                    <dd>{value(session.buyin_and_rebuys, props.asset)}</dd>
                  </div>
                  <div>
                    <dt>Final Cashout</dt>
                    <dd>{value(session.final_cashout, props.asset)}</dd>
                  </div>
                  <div>
                    <dt>Session Result</dt>
                    <dd>{value(session.session_result, props.asset)}</dd>
                  </div>
                  <div>
                    <dt>Exact Hands</dt>
                    <dd>{session.hand_count ?? 'Not Yet Measured'}</dd>
                  </div>
                  <div>
                    <dt>Hand Net</dt>
                    <dd>{value(session.hand_net, props.asset)}</dd>
                  </div>
                  <div>
                    <dt>Duration</dt>
                    <dd>
                      {session.duration_seconds === null
                        ? 'Session Open'
                        : `${Math.floor(session.duration_seconds / 60)} Minutes`}
                    </dd>
                  </div>
                </dl>
                {session.overlap && (
                  <p className="exact-session-warning">
                    Overlapping Session Identity Detected. Hand Counts And Net Are Withheld To
                    Prevent Double Attribution.
                  </p>
                )}
                <footer>
                  <span>Evidence Session</span>
                  <code>{session.evidence.session_id}</code>
                  {!session.overlap && (
                    <StatsEvidenceLink
                      to={buildStatsSessionEvidencePath(session.session_id, {
                        clubId: session.club_id,
                        asset: props.asset === 'diamonds' ? 'diamonds' : 'chips',
                      })}
                    >
                      Open Session Hands
                    </StatsEvidenceLink>
                  )}
                </footer>
              </article>
            ))}
          </div>
        )}
      </section>
    </SpadeConsole>
  );
}
