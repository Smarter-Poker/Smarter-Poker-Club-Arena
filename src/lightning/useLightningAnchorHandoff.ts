/**
 * LIGHTNING PHASE 6: FROM THE BUY-IN TO THE STREAM.
 *
 * JOIN LIGHTNING takes the player through the Cluster's own door and the
 * table's own buy-in. Once the chips are down, the database puts the player
 * in the Cluster's pool and hands them a pool session. This hook, mounted by
 * the table view, notices that for the ONE anchor table where the player asked
 * for Lightning, and carries this same tab on to the pool-session room: the
 * player's chair moved into the pool at their own request, the way a
 * must-move re-points a tab (MultiTablePage `movedToTableId`), and no other
 * tab is touched.
 *
 * It does not give up. The pool session can take longer to appear than any
 * fixed count of polls allows, and a hand-off that quietly stopped left the
 * player on an anchor table that will never deal them a hand. So it asks again
 * with a growing wait (capped) for as long as the table is open, and while it
 * waits the table says "Joining Lightning..." instead of showing a dead felt.
 * It stops when the pool session appears, when the table unmounts, when the
 * player cancels, or when the Cluster is no longer Lightning at all (there is
 * then no pool session to wait for).
 *
 * An existing seated player whose game converts receives an explicit View
 * Game notice the moment the conversion commits (the commit signals the
 * player privately); their tab stays put until they choose it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { masterBus } from '../core/MasterBus';
import { reportError } from '../utils/errorReporter';
import {
  clearLightningEntryIntent,
  fetchLightningClusterMeta,
  fetchMyLightningSession,
  getLightningEntryIntent,
  hasLightningRoom,
  registerLightningPoolSession,
  type LightningClusterMeta,
} from './lightningSession';

/** The first wait between asks, how much each wait grows, and its ceiling. */
export const LIGHTNING_HANDOFF_POLL_MS = 1500;
export const LIGHTNING_HANDOFF_BACKOFF = 1.5;
export const LIGHTNING_HANDOFF_MAX_WAIT_MS = 10_000;

/**
 * The bus event a seated player's tab waits on for the conversion notice. It is
 * relayed from the owner-only `profile-account:<user>` Broadcast topic, which
 * the pool-session transaction writes (20261025025154).
 */
export const LIGHTNING_ROOM_OPENED_EVENT = 'LIGHTNING_ROOM_OPENED' as const;

/** What the table says while the hand-off is waiting. */
export const LIGHTNING_JOINING_TEXT = 'Joining Lightning...';

/** The wait after ask number `n` (1-based) before the next one. */
export function lightningHandoffDelay(n: number): number {
  const grown = LIGHTNING_HANDOFF_POLL_MS * Math.pow(LIGHTNING_HANDOFF_BACKOFF, Math.max(0, n - 1));
  return Math.min(LIGHTNING_HANDOFF_MAX_WAIT_MS, Math.round(grown));
}

/**
 * Cluster modes in which a pool session may still be on its way. Anything else
 * (must_move, paused, frozen, dead, on the way out) means the wait is over.
 */
function poolSessionMayAppear(mode: string | null | undefined): boolean {
  return mode === null || mode === undefined || mode === 'lightning' || mode === 'pending_on';
}

export interface LightningAnchorHandoff {
  /** The buy-in landed and the tab is waiting for the pool session. */
  joining: boolean;
  /** Stop waiting: the intent is forgotten and the table is left as it is. */
  cancel: () => void;
  readyPoolSessionId: string | null;
  viewReady: () => void;
}

export function useLightningAnchorHandoff(input: {
  tableId: string | undefined;
  clusterId?: string | null;
  userId?: string | null;
  /** This room is already a pool session: nothing to hand off. */
  isPoolSession: boolean;
  /** The hero holds a seat with chips at this table (the buy-in landed). */
  heroBoughtIn: boolean;
  /** Original seat lookup, independent of the public hand roster. */
  existingAnchorFunded?: boolean;
  /** Re-point this tab at the pool-session room. */
  follow: (poolSessionId: string) => void;
}): LightningAnchorHandoff {
  const { tableId, isPoolSession, heroBoughtIn } = input;
  const conversionFunded = input.existingAnchorFunded ?? heroBoughtIn;
  /* Read at hand-off time: the navigate inside it changes identity on every
     route change, and a new closure each render must not restart the poll. */
  const followRef = useRef(input.follow);
  followRef.current = input.follow;
  const [joining, setJoining] = useState(false);
  const identity = `${tableId ?? ''}:${input.clusterId ?? ''}:${input.userId ?? ''}:${isPoolSession}:${conversionFunded}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [readySession, setReadySession] = useState<{ identity: string; id: string } | null>(null);
  const readyPoolSessionId = readySession?.identity === identity ? readySession.id : null;
  /* Bumped by cancel(): the effect below re-runs, finds no intent, and stops. */
  const [cancelled, setCancelled] = useState(0);
  const cancel = useCallback(() => {
    if (tableId) clearLightningEntryIntent(tableId);
    setJoining(false);
    setCancelled((n) => n + 1);
  }, [tableId]);

  // A seated player can enter Lightning when their existing game converts,
  // without ever having clicked Join Lightning. Read their pool session and
  // offer View Game; never switch the tab for them.
  //
  // THE TRANSACTION THAT OPENS THE ROOM SAYS SO (20261025025154). This first
  // waited for a realtime UPDATE on `cash_games`, which is not in the
  // supabase_realtime publication and must not be (19.7M updates on 266 rows),
  // so it never fired; then it re-read every 30 s, which only guessed when the
  // room might exist. Now the database transaction that opens a player's pool
  // session (fn_cash_cluster_commit_lightning, fn_lightning_pool_enter) sends
  // one private signal on the owner-only `profile-account:<user>` topic, which
  // ProfileAccountSync already holds and relays as LIGHTNING_ROOM_OPENED. The
  // hook reads fn_lightning_my_session on mount, when that event names this
  // Cluster (or, with no Cluster, when the carrier rejoined after a possible
  // miss), and when a hidden tab with an unread signal becomes visible. No
  // timer, no channel of its own, and it writes nothing.
  useEffect(() => {
    setReadySession(null);
    const clusterId = input.clusterId;
    if (!tableId || !clusterId || !input.userId || isPoolSession || !conversionFunded) return;
    let stopped = false;
    let readVersion = 0;
    /** Reads the session; true when the room is ready (the reads can stop). */
    const read = async (): Promise<boolean> => {
      const version = ++readVersion;
      try {
        const session = await fetchMyLightningSession(clusterId);
        if (stopped || version !== readVersion || identityRef.current !== identity) return false;
        const ready =
          hasLightningRoom(session) && session.anchorTableId === tableId && session.poolSessionId
            ? { identity, id: session.poolSessionId }
            : null;
        setReadySession(ready);
        return ready !== null;
      } catch (err) {
        if (!stopped)
          reportError(err, 'lightning.conversion_session_read_failed', { clusterId, tableId });
        return false;
      }
    };
    const userId = input.userId;
    let found = false;
    /* A signal that arrived while the tab was hidden is read when it shows. */
    let unread = false;
    const readNow = () => {
      if (stopped || found) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        unread = true;
        return;
      }
      unread = false;
      void read().then((ready) => {
        if (ready) found = true;
      });
    };
    const stopSignal = masterBus.subscribe(LIGHTNING_ROOM_OPENED_EVENT, (event) => {
      const { userId: owner, clusterId: signalled } = event.payload;
      if (owner !== userId) return;
      if (signalled !== undefined && signalled !== clusterId) return;
      readNow();
    });
    const onVisible = () => {
      if (unread && typeof document !== 'undefined' && document.visibilityState === 'visible')
        readNow();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    void read().then((ready) => {
      if (ready) found = true;
    });
    return () => {
      stopped = true;
      stopSignal();
      if (typeof document !== 'undefined')
        document.removeEventListener('visibilitychange', onVisible);
    };
  }, [tableId, input.clusterId, input.userId, isPoolSession, conversionFunded, identity]);

  const viewReady = useCallback(() => {
    if (!readyPoolSessionId || !input.clusterId || identityRef.current !== identity) return;
    registerLightningPoolSession({
      poolSessionId: readyPoolSessionId,
      clusterId: input.clusterId,
      meta: null,
    });
    followRef.current(readyPoolSessionId);
  }, [readyPoolSessionId, input.clusterId, identity]);

  useEffect(() => {
    if (!tableId || isPoolSession || !heroBoughtIn) {
      setJoining(false);
      return;
    }
    const clusterId = getLightningEntryIntent(tableId);
    if (!clusterId) {
      setJoining(false);
      return;
    }
    setJoining(true);
    let stopped = false;
    let asks = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      clearLightningEntryIntent(tableId);
      setJoining(false);
    };
    const ask = async () => {
      asks += 1;
      try {
        const session = await fetchMyLightningSession(clusterId);
        if (stopped) return;
        if (hasLightningRoom(session) && session.poolSessionId) {
          /* FIRST-HAND PATH (Lightning Phase 12): JOIN -> HAND with no
             avoidable round trip. The tab follows the chair the moment the
             pool session exists; the Cluster's felt metadata is not waited
             for here - the room registers without it and the room's own
             view asks for it once (TablePage), while the engine is already
             forming the first hand. */
          const poolSessionId = session.poolSessionId;
          const meta: LightningClusterMeta | null = null;
          registerLightningPoolSession({ poolSessionId, clusterId, meta });
          finish();
          followRef.current(poolSessionId);
          return;
        }
        /* No pool session yet. If the Cluster is not Lightning any more, none
           is coming: the player keeps the ordinary seat they bought. */
        let mode: string | null | undefined = session.clusterMode;
        if (mode === null) {
          try {
            mode = (await fetchLightningClusterMeta(clusterId))?.clusterMode;
          } catch {
            mode = null;
          }
          if (stopped) return;
        }
        if (!poolSessionMayAppear(mode)) {
          finish();
          return;
        }
      } catch (err) {
        if (stopped) return;
        reportError(err, 'lightning.handoff_session_read_failed', { clusterId, tableId });
      }
      if (stopped) return;
      timer = setTimeout(() => void ask(), lightningHandoffDelay(asks));
    };
    void ask();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [tableId, isPoolSession, heroBoughtIn, cancelled]);

  return { joining, cancel, readyPoolSessionId, viewReady };
}
