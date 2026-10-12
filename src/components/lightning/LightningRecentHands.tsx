/**
 * LIGHTNING PHASE 8: RECENT HANDS.
 *
 * The player's last 50 Lightning hands (fn_lightning_recent_hands), newest
 * first, with a This Session / All Lightning toggle. Each row says when, the
 * result, the pot, the seat's position and the stack before and after; a tap
 * opens that hand in the existing replay. A hand whose history row is not
 * written yet says so instead of opening an empty replay.
 */
import { useEffect, useState } from 'react';
import {
  fetchLightningRecentHands,
  lightningChipsText,
  lightningHandResultText,
  LIGHTNING_RECENT_HANDS_LIMIT,
  type LightningRecentHand,
} from '../../lightning/lightningSessionApi';
import { reportError } from '../../utils/errorReporter';
import LightningHandReplayModal from './LightningHandReplayModal';
import './LightningSession.css';

function timeText(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export default function LightningRecentHands({
  poolSessionId,
  sessionOnly: initialSessionOnly = true,
  refreshKey = null,
}: {
  /** The session the "This Session" filter means; null offers All only. */
  poolSessionId: string | null;
  sessionOnly?: boolean;
  /** Re-read when this changes (the hand on the felt). */
  refreshKey?: string | null;
}) {
  const [sessionOnly, setSessionOnly] = useState(initialSessionOnly && !!poolSessionId);
  const [hands, setHands] = useState<LightningRecentHand[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [replay, setReplay] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setFailed(false);
    fetchLightningRecentHands({
      limit: LIGHTNING_RECENT_HANDS_LIMIT,
      poolSessionId: sessionOnly ? poolSessionId : null,
    })
      .then((rows) => {
        if (live) setHands(rows);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setFailed(true);
        reportError(err, 'LightningSession.recent_hands_read_failed', { poolSessionId });
      });
    return () => {
      live = false;
    };
  }, [poolSessionId, sessionOnly, refreshKey]);

  return (
    <div className="lightning-recent" data-testid="lightning-recent-hands">
      {poolSessionId ? (
        <div className="lightning-recent__filter" role="group" aria-label="Recent Hands Filter">
          <button
            type="button"
            className="lightning-recent__chip"
            aria-pressed={sessionOnly}
            data-testid="lightning-recent-session"
            onClick={() => setSessionOnly(true)}
          >
            This Session
          </button>
          <button
            type="button"
            className="lightning-recent__chip"
            aria-pressed={!sessionOnly}
            data-testid="lightning-recent-all"
            onClick={() => setSessionOnly(false)}
          >
            All Lightning
          </button>
        </div>
      ) : null}
      {failed ? (
        <p className="lightning-sheet__quiet">We Could Not Load Your Hands Right Now.</p>
      ) : hands === null ? (
        <p className="lightning-sheet__quiet">One Moment...</p>
      ) : hands.length === 0 ? (
        <p className="lightning-sheet__quiet">No Lightning Hands Yet.</p>
      ) : (
        <ol className="lightning-recent__list">
          {hands.map((h) => {
            const net =
              h.net ??
              (h.stackBefore !== null && h.stackAfter !== null
                ? h.stackAfter - h.stackBefore
                : null);
            return (
              <li key={h.handId}>
                <button
                  type="button"
                  className="lightning-recent__row"
                  data-testid="lightning-recent-row"
                  data-hand-id={h.handId}
                  disabled={!h.handHistoryId}
                  onClick={() => h.handHistoryId && setReplay(h.handHistoryId)}
                >
                  <span className="lightning-recent__time">{timeText(h.playedAt)}</span>
                  <span className="lightning-recent__result">{lightningHandResultText(h)}</span>
                  <span
                    className={`lightning-recent__net${net === null || net === 0 ? '' : net > 0 ? ' lightning-stats__value--up' : ' lightning-stats__value--down'}`}
                  >
                    {lightningChipsText(net, true)}
                  </span>
                  <span className="lightning-recent__meta">
                    {h.position ? h.position.toUpperCase() : '-'} · Pot {lightningChipsText(h.pot)}
                    {' · '}
                    {lightningChipsText(h.stackBefore)}
                    {' \u2192 '}
                    {lightningChipsText(h.stackAfter)}
                  </span>
                  {!h.handHistoryId ? (
                    <span className="lightning-recent__pending">Replay Not Ready</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {replay ? (
        <LightningHandReplayModal handHistoryId={replay} onClose={() => setReplay(null)} />
      ) : null}
    </div>
  );
}
