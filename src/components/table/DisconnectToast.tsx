/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DisconnectToast — the hero's own seat-presence line, ON THE FELT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Consumes the `disconnect_states` map the engine emits (Phase 1.2 PR-F):
 * the engine's verdict on whether it can still hear THIS player. MISSING is
 * "no heartbeat, the auto-action clock is running", DISCONNECTED is "that
 * clock ran out". CONNECTED / SAT_OUT / no entry render nothing.
 *
 * Rewritten 2026-09-04 (Dan): "I should never have to 'refresh' after I
 * disconnected and auto reconnected. The page should 'auto refresh for me'.
 * And all disconnection, reconnecting messages should be on the table, not
 * at the top of the page."
 *
 * What it used to be, and why each part was wrong:
 *
 *   - `position: fixed; top: 0` over the page chrome. Every other connection
 *     message lives on the felt (TableConnectionBanner, the seat overlays);
 *     this one alone floated over the tab bar, and with no `isActive` gate the
 *     tile view could show four of them. It is `position: absolute` inside
 *     `.table-surface` now, on the wordmark like its sibling, and gated.
 *
 *   - "Session Lost. Refresh To Rejoin The Table." A refresh was never
 *     needed: the engine clears DISCONNECTED on the very next heartbeat or
 *     socket (DisconnectEngine.heartbeat), and TablePage now treats the
 *     socket coming back as an event that re-sends that heartbeat, resets the
 *     circuit breaker and re-arms the hole-card read. Telling a player to
 *     refresh mid-hand is the one thing the felt banner exists to prevent.
 *
 *   - It read a map that only a LIVE snapshot can update, so once the socket
 *     died the last verdict stuck on screen forever (a countdown parked at
 *     0s). While the socket is anything but connected the map is stale by
 *     construction and TableConnectionBanner is already saying so, so this
 *     defers to it; it speaks only when the socket is up and the engine still
 *     cannot hear the player - which is a real state (heartbeats failing
 *     behind a working socket) and the only one this line is for.
 *
 * The timer is deadline-based (graceDeadlineMs from the engine), not
 * setInterval + local math, so it survives OS-clock skew and tab-wake
 * from background. It hides itself at zero rather than parking there.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { DisconnectFsmEntry } from '../../utils/mapEngineSnapshot';
import { formatPopupText } from '../../utils/popupStyle';
import { serverNow } from '../../utils/serverClock';
import './DisconnectToast.css';

export interface DisconnectToastProps {
  heroUserId: string | null | undefined;
  disconnectStates: Record<string, DisconnectFsmEntry>;
  /** The engine socket. Anything but 'connected' means the map is stale. */
  socketStatus: string;
  /** False for a backgrounded tab in the multi-table view. */
  isActive?: boolean;
  /**
   * The tournament moved the hero INTO this table at this instant (epoch ms,
   * this device's clock): a table break or a balance move. See MOVED_HERE_MS.
   */
  movedHereAtMs?: number;
  /** The table's display name, for the moved line. */
  tableName?: string;
}

/**
 * ─── A MOVED SEAT IS NOT A RECONNECTING SEAT (Dan 2026-10-04) ─────────────────
 *
 * "WHEN A TABLE BREAKS AND YOU ARE MOVED TO A NEW TABLE AND SEAT, IT DISPLAYS
 *  THE 'RECONNECTING YOUR SEAT' INSTEAD OF 'YOU'VE BEEN MOVED TO TABLE XXX'."
 *
 * The engine seats a moved player at the destination before that player's
 * browser has opened the destination's socket and sent its first heartbeat,
 * so for the first moments the destination's presence map can read the hero
 * as MISSING. That reading is true and the old line was still the wrong thing
 * to say: nothing is being reconnected, the player was carried here. For the
 * hand-over the felt says what happened.
 *
 * It is a bounded window, not a mute: if the engine STILL cannot hear the
 * player once it has passed, that is a real presence problem and the ordinary
 * line (with its auto-action countdown) takes over.
 */
export const MOVED_HERE_MS = 10_000;
/** How long after a move a slow-connecting socket may still open the window. */
export const MOVED_HERE_MAX_WAIT_MS = 60_000;

export default function DisconnectToast({
  heroUserId,
  disconnectStates,
  socketStatus,
  isActive = true,
  movedHereAtMs,
  tableName,
}: DisconnectToastProps): ReactElement | null {
  const entry = heroUserId ? disconnectStates[heroUserId] : undefined;
  const state = entry?.state;
  const graceDeadline = entry?.graceDeadlineMs ?? null;

  // Live countdown when MISSING. Uses the engine's absolute deadline AND the
  // engine's clock (serverNow) - no drift under clock skew or tab wake. It
  // said "no drift under clock skew" while subtracting the device clock
  // until 2026-09-06.
  const [remainingSec, setRemainingSec] = useState<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (state !== 'MISSING' || !graceDeadline) {
      setRemainingSec(null);
      return;
    }
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      const ms = Math.max(0, graceDeadline - serverNow());
      setRemainingSec(Math.ceil(ms / 1000));
      if (ms > 0) {
        rafRef.current = window.setTimeout(tick, 250) as unknown as number;
      }
    };
    tick();
    return () => {
      stopped = true;
      if (rafRef.current !== null) {
        window.clearTimeout(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [state, graceDeadline]);

  /* The arrival window. One timeout to its end, so the line leaves on time
     even on a table where nothing else is re-rendering this component.

     It starts when the player can SEE it (2026-10-05). The line only shows on
     a connected socket, and the new table's socket can take longer than the
     whole window to connect after a move; timed from the move alone, the line
     was never shown at all. A move first seen on a connected socket is timed
     from the move itself, as before. One first seen while the socket is still
     coming up is timed from the moment it connects, provided that is within
     MOVED_HERE_MAX_WAIT_MS of the move (an old move never resurfaces). */
  const connected = socketStatus === 'connected';
  const windowRef = useRef<{ moveAt: number; startAt: number | null } | null>(null);
  const windowStart = (now: number): number | null => {
    if (movedHereAtMs === undefined) return null;
    if (windowRef.current?.moveAt !== movedHereAtMs) {
      windowRef.current = { moveAt: movedHereAtMs, startAt: connected ? movedHereAtMs : null };
    }
    const w = windowRef.current;
    if (w.startAt === null && connected && now - movedHereAtMs < MOVED_HERE_MAX_WAIT_MS) {
      w.startAt = now;
    }
    return w.startAt;
  };
  const [movedHere, setMovedHere] = useState(() => {
    const now = Date.now();
    const start = windowStart(now);
    return start !== null && now - start < MOVED_HERE_MS;
  });
  useEffect(() => {
    const now = Date.now();
    const start = windowStart(now);
    if (start === null) {
      setMovedHere(false);
      return;
    }
    const left = start + MOVED_HERE_MS - now;
    if (left <= 0) {
      setMovedHere(false);
      return;
    }
    setMovedHere(true);
    const t = window.setTimeout(() => setMovedHere(false), left);
    return () => window.clearTimeout(t);
    // windowStart reads only movedHereAtMs and connected, both listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movedHereAtMs, connected]);

  if (!isActive) return null;
  // The socket's own banner owns this moment; the map cannot be current.
  if (socketStatus !== 'connected') return null;

  if (movedHere) {
    return (
      <div className="disconnect-toast disconnect-toast--moved" role="status" aria-live="polite">
        <span>{formatPopupText(`You've Been Moved To ${tableName || 'A New Table'}`)}</span>
      </div>
    );
  }
  if (!entry) return null;

  if (state === 'MISSING') {
    // At zero the engine has already acted; the DISCONNECTED verdict (or a
    // CONNECTED one, if the heartbeat landed) is in the next snapshot.
    if (remainingSec !== null && remainingSec <= 0) return null;
    return (
      <div className="disconnect-toast disconnect-toast--missing" role="status" aria-live="polite">
        <span className="disconnect-toast__spinner" aria-hidden="true" />
        <span>
          {formatPopupText(`Reconnecting Your Seat, ${remainingSec ?? '...'}s Until Auto Action`)}
        </span>
      </div>
    );
  }

  if (state === 'DISCONNECTED') {
    return (
      <div
        className="disconnect-toast disconnect-toast--disconnected"
        role="status"
        aria-live="polite"
      >
        <span className="disconnect-toast__spinner" aria-hidden="true" />
        <span>{formatPopupText('Reconnecting Your Seat, Your Chips Are Safe On The Server')}</span>
      </div>
    );
  }

  return null;
}
