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
 * Without an intent for this table it does nothing at all, which is every
 * table in production today.
 */
import { useEffect, useRef } from 'react';
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

/** How often the table asks whether the pool session exists yet, and for how long. */
export const LIGHTNING_HANDOFF_POLL_MS = 1500;
export const LIGHTNING_HANDOFF_MAX_POLLS = 40;

export function useLightningAnchorHandoff(input: {
  tableId: string | undefined;
  /** This room is already a pool session: nothing to hand off. */
  isPoolSession: boolean;
  /** The hero holds a seat with chips at this table (the buy-in landed). */
  heroBoughtIn: boolean;
  /** Re-point this tab at the pool-session room. */
  follow: (poolSessionId: string) => void;
}): void {
  const { tableId, isPoolSession, heroBoughtIn } = input;
  /* Read at hand-off time: the navigate inside it changes identity on every
     route change, and a new closure each render must not restart the poll. */
  const followRef = useRef(input.follow);
  followRef.current = input.follow;
  useEffect(() => {
    if (!tableId || isPoolSession || !heroBoughtIn) return;
    const clusterId = getLightningEntryIntent(tableId);
    if (!clusterId) return;
    let cancelled = false;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ask = async () => {
      polls += 1;
      try {
        const session = await fetchMyLightningSession(clusterId);
        if (cancelled) return;
        if (hasLightningRoom(session) && session.poolSessionId) {
          let meta: LightningClusterMeta | null = null;
          try {
            meta = await fetchLightningClusterMeta(clusterId);
          } catch (err) {
            reportError(err, 'lightning.handoff_meta_read_failed', { clusterId });
          }
          if (cancelled) return;
          registerLightningPoolSession({ poolSessionId: session.poolSessionId, clusterId, meta });
          clearLightningEntryIntent(tableId);
          followRef.current(session.poolSessionId);
          return;
        }
      } catch (err) {
        reportError(err, 'lightning.handoff_session_read_failed', { clusterId, tableId });
      }
      if (cancelled) return;
      if (polls >= LIGHTNING_HANDOFF_MAX_POLLS) {
        clearLightningEntryIntent(tableId);
        return;
      }
      timer = setTimeout(() => void ask(), LIGHTNING_HANDOFF_POLL_MS);
    };
    void ask();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [tableId, isPoolSession, heroBoughtIn]);
}
