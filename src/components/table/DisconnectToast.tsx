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
import './DisconnectToast.css';

export interface DisconnectToastProps {
  heroUserId: string | null | undefined;
  disconnectStates: Record<string, DisconnectFsmEntry>;
  /** The engine socket. Anything but 'connected' means the map is stale. */
  socketStatus: string;
  /** False for a backgrounded tab in the multi-table view. */
  isActive?: boolean;
}

export default function DisconnectToast({
  heroUserId,
  disconnectStates,
  socketStatus,
  isActive = true,
}: DisconnectToastProps): ReactElement | null {
  const entry = heroUserId ? disconnectStates[heroUserId] : undefined;
  const state = entry?.state;
  const graceDeadline = entry?.graceDeadlineMs ?? null;

  // Live countdown when MISSING. Uses the engine's absolute deadline, not
  // a local duration — no drift under clock skew or tab wake.
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
      const ms = Math.max(0, graceDeadline - Date.now());
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

  if (!entry || !isActive) return null;
  // The socket's own banner owns this moment; the map cannot be current.
  if (socketStatus !== 'connected') return null;

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
