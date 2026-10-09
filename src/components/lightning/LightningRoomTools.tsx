/**
 * LIGHTNING PHASE 8: THE ROOM'S OWN TOOLS.
 *
 * A quiet strip on the left of a Lightning room, opposite the LIGHTNING FOLD
 * strip: the pool's health (BUILDING / ACTIVE / HOT / THIN), and three
 * words. Session opens the running numbers for this pool session (the
 * player's choice is remembered on this device). Recent Hands opens the last
 * 50 Lightning hands. Previous Hand opens the last one in the existing
 * replay. Every panel is read-only; nothing here acts in a hand, spends, or
 * moves the view.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  LIGHTNING_STOP_FINISHING_TEXT,
  LIGHTNING_STOP_PLAYING_LABEL,
  LIGHTNING_STOP_STOPPING_TEXT,
  LIGHTNING_STOP_UNAVAILABLE_TEXT,
  fetchLightningRecentHands,
  lightningAutoRebuyText,
  stopLightningPlaying,
} from '../../lightning/lightningSessionApi';
import {
  lightningHandVolumeText,
  useLightningHandVolume,
} from '../../lightning/lightningSessionMetrics';
import { readLightningPrefs, writeLightningPrefs } from '../../lightning/lightningPrefs';
import { useToast } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';
import LightningPoolBadge from './LightningPoolBadge';
import LightningStatsGrid from './LightningStatsGrid';
import LightningRecentHands from './LightningRecentHands';
import LightningHandReplayModal from './LightningHandReplayModal';
import {
  useLightningAutoRebuyStatus,
  useLightningPoolHealth,
  useLightningSessionStats,
} from './useLightningSessionData';
import LightningCloseX from './LightningCloseX';
import './LightningSession.css';

export interface LightningRoomToolsProps {
  poolSessionId: string;
  clusterId: string;
  /** The hand on the felt (engine hand id or number); a change refreshes the numbers. */
  handKey: string | null;
  /** The room is on screen (its tab is shown and the layer is not hidden). */
  visible: boolean;
}

export default function LightningRoomTools({
  poolSessionId,
  clusterId,
  handKey,
  visible,
}: LightningRoomToolsProps) {
  const toast = useToast();
  const [statsOpen, setStatsOpen] = useState(() => readLightningPrefs().statsVisible);
  const [recentOpen, setRecentOpen] = useState(false);
  const [replay, setReplay] = useState<string | null>(null);
  const [previousBusy, setPreviousBusy] = useState(false);
  /* The numbers refresh once per hand: when a NEW hand reaches the felt (the
     one before it has settled by then). The idle gap between hands, when the
     key is null, asks nothing. */
  const [refreshKey, setRefreshKey] = useState<string | null>(handKey);
  useEffect(() => {
    if (handKey) setRefreshKey(handKey);
  }, [handKey]);
  const health = useLightningPoolHealth(clusterId, visible);
  const { stats, failed } = useLightningSessionStats(
    poolSessionId,
    refreshKey,
    statsOpen && visible
  );
  /* LIGHTNING PHASE 10: hand volume always on screen - the session's hands,
     clock and rate, ticked locally and reconciled by the panel's own read. */
  const volume = useLightningHandVolume(poolSessionId, handKey, visible, stats);
  /* The operator's auto-rebuy configuration and the player's own use of it,
     read-only, from fn_lightning_pool_status when the panel opens (Lightning
     Phase 12). Shown only while auto-rebuy is ON; unreadable shows nothing. */
  const autoRebuy = useLightningAutoRebuyStatus(clusterId, statsOpen && visible);
  /* STOP PLAYING (spec Phase 16): one tap asks fn_lightning_stop_playing;
     the database refuses new hands at once and ends the session when the
     live hand settles. While that hand finishes, the control says so. The
     room's close then brings the Phase 9 ended notice - nothing here
     navigates (CLAUDE.md 10.6). */
  const [stopping, setStopping] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);
  const stopPlaying = useCallback(async () => {
    if (stopBusy || stopping) return;
    setStopBusy(true);
    try {
      const out = await stopLightningPlaying(clusterId);
      if (out === null) {
        toast.info(LIGHTNING_STOP_UNAVAILABLE_TEXT);
        return;
      }
      if (out.stopping) setStopping(true);
      else toast.warning('We Could Not Stop Your Session Right Now.');
    } catch (err) {
      reportError(err, 'LightningSession.stop_playing_failed', { clusterId });
      toast.warning('We Could Not Stop Your Session Right Now.');
    } finally {
      setStopBusy(false);
    }
  }, [clusterId, stopBusy, stopping, toast]);

  const toggleStats = useCallback(() => {
    setStatsOpen((open) => {
      writeLightningPrefs({ statsVisible: !open });
      return !open;
    });
  }, []);

  const openPrevious = useCallback(async () => {
    if (previousBusy) return;
    setPreviousBusy(true);
    try {
      const [last] = await fetchLightningRecentHands({ limit: 1, poolSessionId });
      if (last?.handHistoryId) setReplay(last.handHistoryId);
      else toast.info(last ? 'That Hand Is Still Being Recorded' : 'No Previous Hand Yet');
    } catch (err) {
      reportError(err, 'LightningSession.previous_hand_read_failed', { poolSessionId });
      toast.warning('We Could Not Open The Previous Hand');
    } finally {
      setPreviousBusy(false);
    }
  }, [poolSessionId, previousBusy, toast]);

  return (
    <>
      <div className="lightning-room-tools" data-testid="lightning-room-tools">
        <LightningPoolBadge status={health?.status ?? null} players={health?.players ?? null} />
        <span className="lightning-room-tools__volume" data-testid="lightning-hand-volume">
          {lightningHandVolumeText(volume)}
        </span>
        <button
          type="button"
          className="lightning-room-tools__btn"
          aria-pressed={statsOpen}
          data-testid="lightning-session-toggle"
          onClick={toggleStats}
        >
          Session
        </button>
        <button
          type="button"
          className="lightning-room-tools__btn"
          aria-pressed={recentOpen}
          data-testid="lightning-recent-toggle"
          onClick={() => setRecentOpen((o) => !o)}
        >
          Recent Hands
        </button>
        <button
          type="button"
          className="lightning-room-tools__btn"
          data-testid="lightning-previous-hand"
          disabled={previousBusy}
          onClick={() => void openPrevious()}
        >
          Previous Hand
        </button>
        <button
          type="button"
          className="lightning-room-tools__btn lightning-room-tools__btn--stop"
          data-testid="lightning-stop-playing"
          aria-live="polite"
          disabled={stopBusy || stopping}
          onClick={() => void stopPlaying()}
        >
          {stopping
            ? handKey
              ? LIGHTNING_STOP_FINISHING_TEXT
              : LIGHTNING_STOP_STOPPING_TEXT
            : LIGHTNING_STOP_PLAYING_LABEL}
        </button>
      </div>
      {statsOpen ? (
        <section
          className="lightning-panel lightning-panel--stats"
          aria-label="Session"
          data-testid="lightning-session-panel"
        >
          <header className="lightning-panel__head">
            <span className="lightning-panel__title">Session</span>
            <LightningCloseX onClick={toggleStats} testId="lightning-session-close" />
          </header>
          {stats ? (
            <LightningStatsGrid stats={stats} mode="session" />
          ) : (
            <p className="lightning-sheet__quiet">
              {failed ? 'We Could Not Load Your Session Right Now.' : 'One Moment...'}
            </p>
          )}
          {autoRebuy?.enabled ? (
            <p className="lightning-panel__note" data-testid="lightning-auto-rebuy-status">
              {lightningAutoRebuyText(autoRebuy)}
            </p>
          ) : null}
        </section>
      ) : null}
      {recentOpen ? (
        <section
          className="lightning-panel lightning-panel--recent"
          aria-label="Recent Hands"
          data-testid="lightning-recent-panel"
        >
          <header className="lightning-panel__head">
            <span className="lightning-panel__title">Recent Hands</span>
            <LightningCloseX onClick={() => setRecentOpen(false)} testId="lightning-recent-close" />
          </header>
          <LightningRecentHands poolSessionId={poolSessionId} refreshKey={refreshKey} />
        </section>
      ) : null}
      {replay ? (
        <LightningHandReplayModal handHistoryId={replay} onClose={() => setReplay(null)} />
      ) : null}
    </>
  );
}
