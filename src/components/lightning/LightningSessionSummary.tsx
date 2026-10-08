/**
 * LIGHTNING PHASE 8: THE SESSION SUMMARY.
 *
 * Shown when a player leaves Lightning (over the lobby they land in, by the
 * app-root host below) and inside the notice a room shows when Lightning has
 * ended for its Cluster. The numbers are fn_lightning_session_summary's: hands,
 * duration, hands per hour, starting and ending stack, net, BB/100, VPIP and
 * PFR when known, LIGHTNING FOLD count and showdowns.
 *
 * VIEW SESSION opens this session's hands (Recent Hands, filtered to it).
 * PLAY AGAIN goes back to the Cluster's Lightning entry, where JOIN LIGHTNING
 * and the existing buy-in confirmation still stand between the player and
 * any chip: nothing here spends.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  fetchLightningSessionSummary,
  lightningChipsText,
  type LightningSessionSummary as Summary,
} from '../../lightning/lightningSessionApi';
import { SpadeConsole } from '../console/SpadeConsole';
import {
  closeLightningSessionSummary,
  useLightningSummaryRequest,
} from '../../lightning/lightningSummaryStore';
import { lightningRoute } from '../../lightning/lightningLobby';
import { writeLightningPrefs } from '../../lightning/lightningPrefs';
import { reportError } from '../../utils/errorReporter';
import LightningStatsGrid from './LightningStatsGrid';
import LightningRecentHands from './LightningRecentHands';
import './LightningSession.css';

export function useLightningSessionSummary(poolSessionId: string | null): {
  summary: Summary | null;
  failed: boolean;
} {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!poolSessionId) return;
    let live = true;
    setSummary(null);
    setFailed(false);
    fetchLightningSessionSummary(poolSessionId)
      .then((s) => {
        if (!live) return;
        setSummary(s);
        if (!s) setFailed(true);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setFailed(true);
        reportError(err, 'LightningSession.summary_read_failed', { poolSessionId });
      });
    return () => {
      live = false;
    };
  }, [poolSessionId]);
  return { summary, failed };
}

export interface LightningSessionSummaryCardProps {
  poolSessionId: string;
  clusterId: string;
  name?: string | null;
  /** PLAY AGAIN is offered (not on a Cluster that has gone back to MUST MOVE). */
  offerPlayAgain?: boolean;
  onPlayAgain?: () => void;
}

/** The summary's body: the numbers, VIEW SESSION and PLAY AGAIN. */
export function LightningSessionSummaryCard({
  poolSessionId,
  clusterId,
  name = null,
  offerPlayAgain = true,
  onPlayAgain,
}: LightningSessionSummaryCardProps) {
  const { summary, failed } = useLightningSessionSummary(poolSessionId);
  const [viewing, setViewing] = useState(false);
  return (
    <div className="lightning-summary" data-testid="lightning-summary" data-cluster={clusterId}>
      <p className="lightning-summary__eyebrow">Lightning</p>
      <p className="lightning-summary__title">{name ? `${name} Session` : 'Session'}</p>
      {summary ? (
        <LightningStatsGrid stats={summary} mode="summary" />
      ) : (
        <p className="lightning-sheet__quiet">
          {failed ? 'We Could Not Load This Session Right Now.' : 'One Moment...'}
        </p>
      )}
      <div className="lightning-summary__actions">
        <button
          type="button"
          className="lightning-summary__btn"
          data-testid="lightning-summary-view-session"
          aria-pressed={viewing}
          onClick={() => setViewing((v) => !v)}
        >
          VIEW SESSION
        </button>
        {offerPlayAgain && onPlayAgain ? (
          <button
            type="button"
            className="lightning-summary__btn lightning-summary__btn--primary"
            data-testid="lightning-summary-play-again"
            onClick={onPlayAgain}
          >
            PLAY AGAIN
          </button>
        ) : null}
      </div>
      {viewing ? <LightningRecentHands poolSessionId={poolSessionId} sessionOnly /> : null}
    </div>
  );
}

/** Mounted once at the app root, beside the cash Session Complete host. */
export function LightningSessionSummaryHost() {
  const req = useLightningSummaryRequest();
  const navigate = useNavigate();
  const [viewing, setViewing] = useState(false);
  const poolSessionId = req?.poolSessionId ?? null;
  const { summary, failed } = useLightningSessionSummary(poolSessionId);
  useEffect(() => {
    setViewing(false);
  }, [poolSessionId]);
  useEffect(() => {
    if (!req) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeLightningSessionSummary();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req]);
  if (!req) return null;
  const net = summary?.net ?? null;
  const body = (
    <div
      className="lightning-sheet__overlay"
      data-testid="lightning-summary-host"
      onClick={closeLightningSessionSummary}
    >
      <div
        className="lightning-summary-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lightning-summary-title"
        onClick={(e) => e.stopPropagation()}
      >
        <SpadeConsole
          eyebrow="Lightning"
          title={req.name ? `${req.name} Session` : 'Session'}
          titleId="lightning-summary-title"
          pill={net === null ? 'Session' : lightningChipsText(net, true)}
          pillInk={net === null || net === 0 ? 'muted' : net > 0 ? 'green' : 'red'}
          crest="flat"
          onClose={closeLightningSessionSummary}
          plates={{
            secondary: {
              label: 'VIEW SESSION',
              type: 'button',
              onClick: () => setViewing((v) => !v),
            },
            primary: {
              label: 'PLAY AGAIN',
              type: 'button',
              onClick: () => {
                writeLightningPrefs({ lastClusterId: req.clusterId, lastClusterName: req.name });
                closeLightningSessionSummary();
                navigate(lightningRoute(req.clusterId));
              },
              ink: 'white',
            },
          }}
        >
          <div
            className="lightning-summary"
            data-testid="lightning-summary"
            data-cluster={req.clusterId}
          >
            {summary ? (
              <LightningStatsGrid stats={summary} mode="summary" />
            ) : (
              <p className="lightning-sheet__quiet">
                {failed ? 'We Could Not Load This Session Right Now.' : 'One Moment...'}
              </p>
            )}
            {viewing ? (
              <LightningRecentHands poolSessionId={req.poolSessionId} sessionOnly />
            ) : null}
          </div>
        </SpadeConsole>
      </div>
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(body, document.body) : body;
}

export default LightningSessionSummaryHost;
