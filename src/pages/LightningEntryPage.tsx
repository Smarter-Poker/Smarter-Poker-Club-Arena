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
 *     Cluster runs as MUST MOVE). JOIN LIGHTNING asks one question, the
 *     buy-in amount, and then seats the player itself (Dan 2026-10-24: "YOU
 *     DON'T SELECT YOUR SEAT ... SELECT HOW MUCH YOU WANT TO BUY IN FOR, AND
 *     THEN YOU AUTO ASSIGN THEM TO A SEAT AND TABLE"): the Cluster's join door
 *     holds a chair, the cash buy-in door buys it (lightningJoinBuyIn), the
 *     database moves the seat into the pool, and the room opens.
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
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { EmptyState } from '../components/common/EmptyState';
import { useToast } from '../components/common/Toast';
import {
  fetchLightningClusterMeta,
  fetchMyLightningSession,
  lightningEntryDecision,
  lightningRoomPath,
  registerLightningPoolSession,
  type LightningClusterMeta,
  type LightningEntryDecision,
} from '../lightning/lightningSession';
import { LIGHTNING_NEXT_HAND_NOTICE_MS } from '../lightning/lightningHand';
import { clusterModeDisplay, isLightningMode } from '../lightning/lightningLobby';
import {
  LIGHTNING_ENDED_EYEBROW,
  LIGHTNING_ENDED_TEXT,
  LIGHTNING_SEAT_WAITING_EYEBROW,
  LIGHTNING_SEAT_WAITING_TEXT,
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
import { BuyInModal, type BuyInConfirmation } from '../components/table/BuyInModal';
import {
  buyIntoLightning,
  currentLightningUserId,
  readLightningBuyInContext,
  rejoinLightningSeat,
  rememberLightningBuyIn,
  rememberedLightningBuyIn,
  type LightningBuyInContext,
} from '../lightning/lightningJoinBuyIn';
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

type Phase =
  | { kind: 'resolving' }
  | { kind: 'entry'; meta: LightningClusterMeta | null; decision: LightningEntryDecision }
  | { kind: 'failed' };

export default function LightningEntryPage() {
  const { clusterId } = useParams<{ clusterId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: 'resolving' });
  const [attempt, setAttempt] = useState(0);
  const [joining, setJoining] = useState(false);
  /* JOIN LIGHTNING asks one question, the amount (Dan 2026-10-24). */
  const [buyIn, setBuyIn] = useState<(LightningBuyInContext & { userId: string }) | null>(null);
  const [slow, setSlow] = useState(false);
  const mounted = useRef(true);
  const routeGeneration = useRef(0);
  const activeJoin = useRef<{ generation: number } | null>(null);
  useLayoutEffect(() => {
    routeGeneration.current += 1;
    activeJoin.current = null;
    setJoining(false);
    setBuyIn(null);
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
  /** The Lightning door: read the price, then ask only for the amount. */
  const openLightningBuyIn = useCallback(async () => {
    if (!clusterId || joining || activeJoin.current) return;
    const operation = { generation: routeGeneration.current };
    activeJoin.current = operation;
    const ownsPage = () =>
      mounted.current &&
      operation.generation === routeGeneration.current &&
      activeJoin.current === operation;
    setJoining(true);
    try {
      const userId = await currentLightningUserId();
      if (!ownsPage()) return;
      if (!userId) {
        toast.warning('Sign In To Join A Game.');
        return;
      }
      // A funded disconnected anchor already paid. Rejoin before asking its
      // empty wallet for a second buy-in; a busted anchor is released here.
      const existing = await rejoinLightningSeat(clusterId);
      if (!ownsPage()) return;
      if (existing) {
        const meta = phase.kind === 'entry' ? phase.meta : null;
        registerLightningPoolSession({ poolSessionId: existing.poolSessionId, clusterId, meta });
        navigate(lightningRoomPath(existing.poolSessionId, meta));
        return;
      }
      const context = await readLightningBuyInContext(clusterId, userId);
      if (!ownsPage()) return;
      if (!context) {
        toast.warning('This Game Is Not Taking Players.');
        return;
      }
      setBuyIn({ ...context, userId });
    } catch (err) {
      if (!ownsPage()) return;
      reportError(err, 'LightningEntryPage.buyin_context_failed', { clusterId });
      toast.warning('We Could Not Open The Buy-In Right Now. Please Try Again.');
    } finally {
      if (ownsPage()) {
        activeJoin.current = null;
        setJoining(false);
      }
    }
  }, [clusterId, joining, toast, phase, navigate]);

  /** The amount is confirmed: hold a chair, buy it, open the room. */
  const confirmLightningBuyIn = useCallback(
    async (amount: number): Promise<BuyInConfirmation> => {
      if (!clusterId || !buyIn) return false;
      const result = await buyIntoLightning({
        clusterId,
        userId: buyIn.userId,
        amount,
        /* The wallet shown is the one the table's own door reads; the buy-in
           lets that same door choose it, so the two can never differ. */
        clubId: null,
      });
      if (!mounted.current) return result.kind === 'seated';
      if (result.kind === 'rejected') return { status: 'rejected', message: result.message };
      if (result.kind === 'seated') rememberLightningBuyIn(clusterId, amount);
      setBuyIn(null);
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
      if (result.kind === 'unconfirmed') {
        toast.warning(result.message);
        warmTable(result.tableId);
        navigate(`/table/${result.tableId}`);
        return false;
      }
      if (result.poolSessionId) {
        registerLightningPoolSession({ poolSessionId: result.poolSessionId, clusterId, meta });
        navigate(lightningRoomPath(result.poolSessionId, meta));
      } else {
        /* The pool session lands a moment after the seat; the table carries
           this tab on to the room as soon as it exists (the entry intent). */
        warmTable(result.tableId);
        navigate(`/table/${result.tableId}`);
      }
      return true;
    },
    [clusterId, buyIn, phase, mine.rows, navigate, toast]
  );

  /** JOIN GAME on a Cluster still running as MUST MOVE: the table's own door. */
  const joinGame = useCallback(async () => {
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
      warmTable(r.table_id);
      navigate(`/table/${r.table_id}`);
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
  }, [clusterId, joining, navigate, toast]);

  const join = useCallback(
    () => (joinsLightning ? openLightningBuyIn() : joinGame()),
    [joinsLightning, openLightningBuyIn, joinGame]
  );

  /* JOIN LIGHTNING TAPPED ON A LIGHTNING TABLE arrives as ?join=1: the player
     already asked to join, so the amount question opens at once, never a
     second Join button. Once per arrival, and only where the page would offer
     the door itself (open, not stopped, within the device's limit). */
  const autoJoinDone = useRef<string | null>(null);
  useEffect(() => {
    if (!clusterId || autoJoinDone.current === clusterId) return;
    if (new URLSearchParams(location.search).get('join') !== '1') return;
    if (phase.kind !== 'entry' || !joinsLightning) return;
    const meta = phase.meta;
    const open =
      meta?.enabled !== false &&
      clusterModeDisplay(meta?.clusterMode ?? null).closedLabel === null &&
      poolHealth?.joinable !== false &&
      poolHealth?.joinsEnabled !== false &&
      withinLimit;
    autoJoinDone.current = clusterId;
    navigate(location.pathname, { replace: true });
    if (open) void openLightningBuyIn();
  }, [
    clusterId,
    location.search,
    location.pathname,
    phase,
    joinsLightning,
    poolHealth,
    withinLimit,
    navigate,
    openLightningBuyIn,
  ]);

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
    const stillLightning = isLightningMode(meta?.clusterMode) && meta?.clusterMode === 'lightning';
    return (
      <div className="lightning-entry" data-testid="lightning-entry">
        <EmptyState
          eyebrow={stillLightning ? LIGHTNING_SEAT_WAITING_EYEBROW : LIGHTNING_ENDED_EYEBROW}
          title={meta?.name ?? 'Lightning'}
          description={stillLightning ? LIGHTNING_SEAT_WAITING_TEXT : LIGHTNING_ENDED_TEXT}
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
  /* LIGHTNING TRANSITION, PHASE 5: while the game is switching (starting or
     ending Lightning) this door is shown disabled with the lobby's own words,
     exactly like the lobby card, so nobody buys into a halted table. */
  const switchingLabel = modeDisplay.switching ? modeDisplay.label : null;
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
            : switchingLabel
              ? switchingLabel
              : joinsClosed || closed
                ? (modeDisplay.closedLabel ?? 'Closed')
                : atLimit
                  ? 'Limit'
                  : 'Running'
        }
        primaryTestId={joinsClosed ? 'lightning-entry-join-closed' : undefined}
        actions={{
          primaryLabel: joining ? 'Joining...' : joinLabel,
          primaryDisabled:
            joining ||
            closed ||
            joinsClosed ||
            atLimit ||
            switchingLabel !== null ||
            buyIn !== null,
          onPrimary: () => void join(),
          secondaryLabel: 'Return To Lobby',
          onSecondary: () => navigate('/'),
        }}
      />
      {/* A door that is not offered says why, in one line. */}
      {atLimit ? (
        <p className="lightning-entry__quiet" role="status" data-testid="lightning-entry-why">
          {LIGHTNING_LIMIT_TEXT}
        </p>
      ) : joinsClosed ? (
        <p className="lightning-entry__quiet" role="status" data-testid="lightning-entry-why">
          {LIGHTNING_JOINS_CLOSED_TEXT}
        </p>
      ) : null}
      {buyIn ? (
        <BuyInModal
          isOpen
          onClose={() => setBuyIn(null)}
          onConfirm={(amount) => confirmLightningBuyIn(amount)}
          tableName={meta?.name ?? 'Lightning'}
          gameType={meta?.variant ?? null}
          minBuyIn={buyIn.minBuyIn}
          maxBuyIn={buyIn.maxBuyIn}
          defaultBuyIn={clusterId ? rememberedLightningBuyIn(clusterId, buyIn) : undefined}
          accountBalance={buyIn.balance}
          bigBlind={buyIn.bigBlind || meta?.bigBlind || 0}
        />
      ) : null}
    </div>
  );
}
