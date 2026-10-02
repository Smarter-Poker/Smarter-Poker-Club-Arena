/**
 * LIGHTNING PHASE 7: WHEN LIGHTNING ENDS, THE PLAYER'S SEAT IS AT THEIR TABLE.
 *
 * LIGHTNING -> MUST_MOVE ends every pool session of the Cluster, but only
 * after the last Lightning hand has settled: no player is ever taken out of a
 * live hand. The engine then closes each pool-session room (4404, or
 * TABLE_NOT_FOUND on the shared socket). The player's chips never left their
 * anchor seat, and that seat is dealing again at its own table.
 *
 * This hook is the room's answer to that close. It does not trust the close
 * itself - the shared socket replaces the reason with a code, and a 4404 is
 * also what a restarting engine says - so on each one it asks the database
 * (fn_lightning_my_session). Only "no pool session, Cluster MUST MOVE, a live
 * seat at table X" turns the room into the MUST MOVE notice, with one button
 * to table X.
 *
 * NEVER AN AUTOMATIC MOVE (CLAUDE.md 10.6, "YOU CAN NEVER EVER AUTO CHANGE
 * TABLES FOR A USER, THEY MUST CHANGE IT BY THEM SELF"). The law makes no
 * exception for a mode change, so the tab stays where it is until the player
 * presses the button.
 */
import { useEffect, useRef, useState } from 'react';
import { reportError } from '../utils/errorReporter';
import { fetchMyLightningSession, lightningReturnTableId } from './lightningSession';

/** The notice's heading and words. Popup text: every word capitalized, no dashes. */
export const LIGHTNING_ENDED_EYEBROW = 'Must Move';
export const LIGHTNING_ENDED_TITLE = 'Lightning Has Ended';
export const LIGHTNING_ENDED_TEXT = 'Lightning Has Ended. Your Seat Is Ready At Your Table.';
/** The one button: the player's own table. An approved term (VIEW GAME). */
export const LIGHTNING_RETURN_LABEL = 'View Game';

/** The table path a player is offered after Lightning ends. */
export function lightningReturnPath(seatTableId: string): string {
  return `/table/${seatTableId}`;
}

export interface LightningReversion {
  /** The table the player's seat is waiting at, once the database has said so. */
  seatTableId: string | null;
}

/**
 * @param clusterId the room's Cluster; null when this view is not a Lightning room.
 * @param roomClosed the latest "this room is gone" signal (a 4404 close), or
 *   null. A new value is a new close and earns a new question; the reconnect
 *   ladder keeps producing them while the room stays gone, so a read that
 *   failed is simply asked again on the next one.
 */
export function useLightningReversion(input: {
  clusterId: string | null;
  roomClosed: unknown;
}): LightningReversion {
  const { clusterId, roomClosed } = input;
  const [seatTableId, setSeatTableId] = useState<string | null>(null);
  const foundRef = useRef<string | null>(null);
  const askingRef = useRef(false);
  /* The Cluster this view is on NOW, read after the await: an answer about a
     room the view has left belongs to neither. */
  const clusterRef = useRef(clusterId);
  clusterRef.current = clusterId;

  // A different room (or no room) starts from nothing.
  useEffect(() => {
    foundRef.current = null;
    setSeatTableId(null);
  }, [clusterId]);

  useEffect(() => {
    if (!clusterId || roomClosed === null || roomClosed === undefined) return;
    if (foundRef.current || askingRef.current) return;
    askingRef.current = true;
    void (async () => {
      try {
        const session = await fetchMyLightningSession(clusterId);
        if (clusterRef.current !== clusterId) return;
        const tableId = lightningReturnTableId(session);
        if (tableId) {
          foundRef.current = tableId;
          setSeatTableId(tableId);
        }
      } catch (err) {
        reportError(err, 'lightning.reversion_session_read_failed', { clusterId });
      } finally {
        askingRef.current = false;
      }
    })();
  }, [clusterId, roomClosed]);

  return { seatTableId };
}
