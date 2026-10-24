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
 *   - LIGHTNING PHASE 7: the Cluster is back in MUST MOVE and the caller
 *     already holds a seat in it. Their table is offered (VIEW GAME), never a
 *     second join; the player goes there by the button (CLAUDE.md 10.6).
 *
 * There is no table list and no seat choice on this page: a Lightning player
 * never picks either.
 *
 *   - LIGHTNING PHASE 8: a player may play Lightning in several Clusters at
 *     once, up to their device's limit (desktop 4, tablet 3, phone 2 by
 *     default). The entry lists the ones they already play (VIEW GAME), the
 *     pool's health, and the last Cluster they played; at the limit, JOIN
 *     LIGHTNING is not offered and the page says why. Every join still goes
 *     through the table's own buy-in confirmation.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { clusterModeDisplay } from '../lightning/lightningLobby';
import {
  LIGHTNING_ENDED_EYEBROW,
  LIGHTNING_ENDED_TEXT,
  LIGHTNING_RETURN_LABEL,
  lightningReturnPath,
} from '../lightning/lightningReversion';
import { joinCashGame, joinGameRefusalText, waitlistedText } from '../services/cashGameLobby';
import { warmTable } from '../services/tableWarmup';
import { isUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import { lightningMultiTableLimit } from '../lightning/lightningCapabilities';
import { lightningDeviceNow } from '../lightning/lightningDeviceReport';
import { writeLightningPrefs } from '../lightning/lightningPrefs';
import {
  lightningJoinWithinLimit,
  useLightningMySessions,
} from '../components/lightning/LightningMySessions';
import LightningCashEntryCard from '../components/lightning/LightningCashEntryCard';
import { useLightningPoolHealth } from '../components/lightning/useLightningSessionData';
import './LightningEntryPage.css';

/** What the device allows, in the page's words. */
export const LIGHTNING_LIMIT_TEXT =
  'You Are Playing The Most Lightning Tables This Device Allows. Leave One To Join Another.';

/**
 * LIGHTNING PHASE 13: an operator has stopped new players entering this
 * Cluster's pool (fn_lightning_pool_status joins_enabled false). Players
 * already in it play on; JOIN LIGHTNING is shown, and not offered.
 */
export const LIGHTNING_JOINS_CLOSED_TEXT = 'Lightning Is Not Taking New Players Right Now.';

/** Mode guidance uses the actual cluster metadata, never inferred population. */
export const MUST_MOVE_ENTRY_TEXT =
  'This Game Uses Regular Tables And The Normal Buy-In. Lightning Is Not Active Here. Lightning Hands Require Enough Eligible Players.';
export const REGULAR_ENTRY_TEXT = 'Join Game Opens The Normal Table Buy-In.';

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
  const routeGeneration = useRef(0);
  const activeJoin = useRef<{ generation: number } | null>(null);
  useLayoutEffect(() => {
    routeGeneration.current += 1;
    activeJoin.current = null;
    setJoining(false);
    return () => {
      // A route change does not cancel the backend join, only its obsolete UI result.
      routeGeneration.current += 1;
      activeJoin.current = null;
    };
  }, [clusterId]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const validId = Boolean(clusterId && isUUID(clusterId));
  /* LIGHTNING PHASE 8: the player's other Lightning tables and the device limit. */
  const mine = useLightningMySessions(clusterId ?? null, validId);

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
        if (decision.kind === 'entry' && meta?.clusterId !== clusterId) {
          throw new Error('Game Metadata Unavailable');
        }
        if (decision.kind === 'open') {
          writeLightningPrefs({
            lastClusterId: clusterId,
            lastClusterName: meta?.name ?? null,
            lastStakes:
              meta && meta.smallBlind > 0 && meta.bigBlind > 0
                ? `${Number(meta.smallBlind)}/${Number(meta.bigBlind)}`
                : null,
          });
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

  const joinsLightning =
    phase.kind === 'entry' && phase.decision.kind === 'entry' ? phase.decision.lightning : false;
  const poolHealth = useLightningPoolHealth(clusterId ?? null, joinsLightning);
  /* The Cluster's configured limit when fn_lightning_pool_status carries one
     (multi_table_limit); the 4/3/2 default until it does, or on an old
     payload that has none. */
  const tableLimit = lightningMultiTableLimit(
    lightningDeviceNow(),
    poolHealth?.multiTableLimit ?? null
  );
  const withinLimit = clusterId ? lightningJoinWithinLimit(mine.rows, clusterId, tableLimit) : true;
  const join = useCallback(async () => {
    if (!clusterId || joining || activeJoin.current) return;
    const operation = { generation: routeGeneration.current };
    activeJoin.current = operation;
    const ownsPage = () =>
      mounted.current &&
      operation.generation === routeGeneration.current &&
      activeJoin.current === operation;
    setJoining(true);
    try {
      const r = await joinCashGame(clusterId);
      if (!ownsPage()) return;
      if (r.action === 'waitlisted' || !r.table_id) {
        toast.info(waitlistedText(r));
        return;
      }
      /* The table's own buy-in takes it from here. The intent lets that table
         carry this tab on to the pool-session room once the buy-in lands. It
         is set only for JOIN LIGHTNING: a JOIN GAME seat is an ordinary seat,
         and the table must not wait for a pool session that will never come. */
      if (joinsLightning) {
        setLightningEntryIntent(r.table_id, clusterId);
        /* Warm resume: where the player went, never what they spent. */
        const meta = phase.kind === 'entry' ? phase.meta : null;
        writeLightningPrefs({
          lastClusterId: clusterId,
          lastClusterName: meta?.name ?? null,
          lastStakes:
            meta && meta.smallBlind > 0 && meta.bigBlind > 0
              ? `${Number(meta.smallBlind)}/${Number(meta.bigBlind)}`
              : null,
          tableCount: Math.min(4, (mine.rows?.length ?? 0) + 1),
        });
      }
      warmTable(r.table_id);
      /* The join door has already HELD a chair for this player (60 s), so the
         table opens straight onto the buy-in. Without ?buyin=1 the sheet only
         appeared if the realtime offer listener happened to see the hold row;
         a slow or dropped socket left the player a spectator to tap a seat,
         and Lightning never asks anyone to choose a seat (Dan 2026-10-24). */
      navigate(`/table/${r.table_id}?buyin=1`);
    } catch (err) {
      if (!ownsPage()) return;
      reportError(err, 'LightningEntryPage.join_failed', { clusterId });
      toast.warning(joinGameRefusalText(err));
    } finally {
      if (ownsPage()) {
        activeJoin.current = null;
        setJoining(false);
      }
    }
  }, [clusterId, joining, joinsLightning, navigate, toast, phase, mine.rows]);

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
  if (decision.kind === 'seat') {
    const seatTableId = decision.seatTableId;
    return (
      <div className="lightning-entry" data-testid="lightning-entry">
        <EmptyState
          eyebrow={LIGHTNING_ENDED_EYEBROW}
          title={meta?.name ?? 'Lightning'}
          description={LIGHTNING_ENDED_TEXT}
          action={{
            label: LIGHTNING_RETURN_LABEL,
            onClick: () => {
              warmTable(seatTableId);
              navigate(lightningReturnPath(seatTableId));
            },
          }}
          secondaryAction={{ label: 'Return To Lobby', onClick: () => navigate('/') }}
        />
      </div>
    );
  }
  const joinLabel = decision.kind === 'entry' ? decision.joinLabel : 'Join Game';
  const lightning = decision.kind === 'entry' && decision.lightning;
  /* A paused, frozen or dead Cluster offers no door at all, and says so in the
     board's own words; a disabled one is closed as before. The database's own
     verdict (fn_lightning_pool_status.joinable, where pool_status's
     cluster_mode was read before) closes the door too; an old payload or no
     read yet decides nothing. The lobby label keeps its own cluster_mode
     source from the lobby feed. */
  const modeDisplay = clusterModeDisplay(meta?.clusterMode ?? null);
  const closed =
    meta?.enabled === false ||
    modeDisplay.closedLabel !== null ||
    (lightning && poolHealth?.joinable === false);
  /* LIGHTNING PHASE 13: joins stopped by an operator. Said in its own words,
     ahead of the generic closed line the joinable verdict would give. */
  const joinsClosed =
    lightning &&
    meta?.enabled !== false &&
    modeDisplay.closedLabel === null &&
    poolHealth?.joinsEnabled === false;
  /* At the device's limit, another Cluster's JOIN LIGHTNING is not offered. */
  const atLimit = lightning && !closed && !withinLimit;
  return (
    <div className="lightning-entry" data-testid="lightning-entry">
      <LightningCashEntryCard
        title={meta?.name ?? 'Lightning'}
        variant={meta?.variant ?? 'NLH'}
        stakes={meta ? `${meta.smallBlind}/${meta.bigBlind}` : ''}
        players={poolHealth?.players}
        buyIn={
          meta?.minBuyIn != null && meta.maxBuyIn != null
            ? `${meta.minBuyIn.toLocaleString()} - ${meta.maxBuyIn.toLocaleString()}`
            : undefined
        }
        status={
          joining
            ? 'Joining'
            : joinsClosed || closed
              ? (modeDisplay.closedLabel ?? 'Closed')
              : atLimit
                ? 'Limit'
                : 'Running'
        }
        primaryTestId={joinsClosed ? 'lightning-entry-join-closed' : undefined}
        actions={{
          primaryLabel: joining ? 'Joining...' : joinLabel,
          primaryDisabled: joining || closed || joinsClosed || atLimit,
          onPrimary: () => void join(),
          secondaryLabel: 'Return To Lobby',
          onSecondary: () => navigate('/'),
        }}
      />
    </div>
  );
}
