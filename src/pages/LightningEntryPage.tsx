/**
 * LIGHTNING PHASE 6: /lightning/:clusterId, THE ONE DOOR TO A LIGHTNING CLUSTER.
 *
 * Asks the database whether the caller already holds a pool session in this
 * Cluster (fn_lightning_my_session).
 *
 *   - Yes: the room whose id is that pool session opens in the table view, in
 *     the player's current tab. Every hand of the session arrives in that one
 *     room, so the view never has to change rooms again.
 *   - No: the Cluster's entry, with JOIN LIGHTNING (JOIN GAME while the
 *     Cluster runs as MUST MOVE). The join is the Cluster's existing door and
 *     the table's existing buy-in; nothing about money is decided here. The
 *     database moves a player who buys in at a Lightning Cluster into its pool,
 *     and the table view carries that tab on to the pool-session room.
 *
 * There is no table list and no seat choice on this page: a Lightning player
 * never picks either.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { EmptyState } from '../components/common/EmptyState';
import { useToast } from '../components/common/Toast';
import {
  fetchLightningClusterMeta,
  fetchMyLightningSession,
  lightningEntryDecision,
  lightningRoomPath,
  registerLightningPoolSession,
  setLightningEntryIntent,
  type LightningClusterMeta,
  type LightningEntryDecision,
} from '../lightning/lightningSession';
import { LIGHTNING_NEXT_HAND_NOTICE_MS } from '../lightning/lightningHand';
import { joinCashGame, joinGameRefusalText, waitlistedText } from '../services/cashGameLobby';
import { warmTable } from '../services/tableWarmup';
import { isUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import './LightningEntryPage.css';

type Phase =
  | { kind: 'resolving' }
  | { kind: 'entry'; meta: LightningClusterMeta | null; decision: LightningEntryDecision }
  | { kind: 'failed' };

export default function LightningEntryPage() {
  const { clusterId } = useParams<{ clusterId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: 'resolving' });
  const [attempt, setAttempt] = useState(0);
  const [joining, setJoining] = useState(false);
  const [slow, setSlow] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const validId = Boolean(clusterId && isUUID(clusterId));

  useEffect(() => {
    if (!validId || !clusterId) return;
    let live = true;
    setPhase({ kind: 'resolving' });
    setSlow(false);
    /* Nothing is printed while the answer is quick. Only a real delay earns a
       neutral line, never a description of what the machinery is doing. */
    const slowTimer = setTimeout(() => {
      if (live) setSlow(true);
    }, LIGHTNING_NEXT_HAND_NOTICE_MS);
    void (async () => {
      try {
        const [session, meta] = await Promise.all([
          fetchMyLightningSession(clusterId),
          fetchLightningClusterMeta(clusterId).catch((err: unknown) => {
            reportError(err, 'LightningEntryPage.meta_read_failed', { clusterId });
            return null;
          }),
        ]);
        if (!live) return;
        const decision = lightningEntryDecision(session, meta);
        if (decision.kind === 'open') {
          registerLightningPoolSession({ poolSessionId: decision.poolSessionId, clusterId, meta });
          navigate(lightningRoomPath(decision.poolSessionId, meta), { replace: true });
          return;
        }
        setPhase({ kind: 'entry', meta, decision });
      } catch (err) {
        if (!live) return;
        reportError(err, 'LightningEntryPage.session_read_failed', { clusterId });
        setPhase({ kind: 'failed' });
      } finally {
        clearTimeout(slowTimer);
      }
    })();
    return () => {
      live = false;
      clearTimeout(slowTimer);
    };
  }, [clusterId, validId, attempt, navigate]);

  const join = useCallback(async () => {
    if (!clusterId || joining) return;
    setJoining(true);
    try {
      const r = await joinCashGame(clusterId);
      if (!mounted.current) return;
      if (r.action === 'waitlisted' || !r.table_id) {
        toast.info(waitlistedText(r));
        return;
      }
      /* The table's own buy-in takes it from here. The intent lets that table
         carry this tab on to the pool-session room once the buy-in lands. */
      setLightningEntryIntent(r.table_id, clusterId);
      warmTable(r.table_id);
      navigate(`/table/${r.table_id}`);
    } catch (err) {
      if (!mounted.current) return;
      reportError(err, 'LightningEntryPage.join_failed', { clusterId });
      toast.warning(joinGameRefusalText(err));
    } finally {
      if (mounted.current) setJoining(false);
    }
  }, [clusterId, joining, navigate, toast]);

  if (!validId) {
    return (
      <div className="lightning-entry" data-testid="lightning-entry">
        <EmptyState
          tone="error"
          eyebrow="Lightning"
          title="Game Unavailable"
          description="This Game Link Is Invalid. Open A Game From The Lobby."
          action={{ label: 'Return To Lobby', onClick: () => navigate('/') }}
        />
      </div>
    );
  }

  if (phase.kind === 'resolving') {
    return (
      <div className="lightning-entry" data-testid="lightning-entry" aria-busy="true">
        {slow ? <p className="lightning-entry__quiet">One Moment...</p> : null}
      </div>
    );
  }

  if (phase.kind === 'failed') {
    return (
      <div className="lightning-entry" data-testid="lightning-entry">
        <EmptyState
          tone="error"
          eyebrow="Lightning"
          title="Game Unavailable"
          description="We Could Not Open This Game Right Now."
          action={{ label: 'Try Again', onClick: () => setAttempt((n) => n + 1) }}
          secondaryAction={{ label: 'Return To Lobby', onClick: () => navigate('/') }}
        />
      </div>
    );
  }

  const { meta, decision } = phase;
  const joinLabel = decision.kind === 'entry' ? decision.joinLabel : 'Join Game';
  const lightning = decision.kind === 'entry' && decision.lightning;
  const stakes =
    meta && meta.smallBlind > 0 && meta.bigBlind > 0
      ? `Blinds ${Number(meta.smallBlind)}/${Number(meta.bigBlind)}`
      : '';
  const closed = meta?.enabled === false;
  return (
    <div className="lightning-entry" data-testid="lightning-entry">
      <EmptyState
        eyebrow={lightning ? 'Lightning' : 'Must Move'}
        title={meta?.name ?? 'Lightning'}
        description={
          closed
            ? 'This Game Is Not Taking Players.'
            : [stakes, 'Buy In Once And Play One Stream Of Hands.'].filter(Boolean).join('. ')
        }
        action={
          closed
            ? undefined
            : { label: joining ? 'Joining...' : joinLabel, onClick: () => void join() }
        }
        secondaryAction={{ label: 'Return To Lobby', onClick: () => navigate('/') }}
      />
    </div>
  );
}
