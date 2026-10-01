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
 * Without an intent for this table it does nothing at all, which is every
 * table in production today.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
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
}

export function useLightningAnchorHandoff(input: {
  tableId: string | undefined;
  /** This room is already a pool session: nothing to hand off. */
  isPoolSession: boolean;
  /** The hero holds a seat with chips at this table (the buy-in landed). */
  heroBoughtIn: boolean;
  /** Re-point this tab at the pool-session room. */
  follow: (poolSessionId: string) => void;
}): LightningAnchorHandoff {
  const { tableId, isPoolSession, heroBoughtIn } = input;
  /* Read at hand-off time: the navigate inside it changes identity on every
     route change, and a new closure each render must not restart the poll. */
  const followRef = useRef(input.follow);
  followRef.current = input.follow;
  const [joining, setJoining] = useState(false);
  /* Bumped by cancel(): the effect below re-runs, finds no intent, and stops. */
  const [cancelled, setCancelled] = useState(0);
  const cancel = useCallback(() => {
    if (tableId) clearLightningEntryIntent(tableId);
    setJoining(false);
    setCancelled((n) => n + 1);
  }, [tableId]);

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
          let meta: LightningClusterMeta | null = null;
          try {
            meta = await fetchLightningClusterMeta(clusterId);
          } catch (err) {
            reportError(err, 'lightning.handoff_meta_read_failed', { clusterId });
          }
          if (stopped) return;
          registerLightningPoolSession({ poolSessionId: session.poolSessionId, clusterId, meta });
          finish();
          followRef.current(session.poolSessionId);
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

  return { joining, cancel };
}
