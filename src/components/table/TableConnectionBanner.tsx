/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  TABLE CONNECTION BANNER — say it on the table, not inside a menu
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-30, from a live tournament seat: "I had to hard refresh to get
 * the tournament seat, but its not displaying, there are no animations, no
 * chips in the boxes, everything is white... if its 'reconnecting' it should
 * say that as a pop up on the table."
 *
 * WHAT HE WAS LOOKING AT. When the engine socket is not connected the felt
 * still renders, from whatever snapshot the client last held: seats and their
 * badges paint, but stacks and the pot are absent and nothing animates,
 * because no new snapshot is arriving to animate between. A table that has
 * stopped receiving state is visually almost identical to a table that is
 * simply quiet, and nothing on screen distinguished them.
 *
 * The status was already known. `useEngineTableState` has exposed
 * 'connecting' | 'reconnecting' | 'failed' | 'auth_failed' the whole time, and
 * TablePage already passed it down -- to `TableMenu`, which renders
 * "Reconnecting…" in the DRAWER HEADER. A player has to open the hamburger
 * menu to find out why their table is blank. That is the one moment nobody
 * opens a menu.
 *
 * So this is not new state, it is the existing state finally said out loud, on
 * the felt, where the player is already looking.
 *
 * WHY THE DELAY. A socket that blips and recovers in 300ms is normal and must
 * not strobe a banner across the table mid-hand. Nothing appears until the
 * disconnected state has held for GRACE_MS; once shown it stays for at least
 * MIN_VISIBLE_MS so a recovery cannot flash it out instantly. The result is
 * that a healthy table never sees this, and a wedged one always does.
 *
 * WHY IT IS NOT A TOAST. Club Arena's house rule routes popup COPY through the
 * Toast layer, and `formatPopupText` below is exactly that rule (Title Case, no
 * em dashes) applied here, from the same central transform. But a toast
 * expires and de-duplicates, and this has to persist for as long as the
 * condition does. A status that vanishes after four seconds would put the
 * player back in the silence this exists to end.
 *
 * `pointer-events: none` in the stylesheet: it must never intercept a tap on
 * the felt or on an action button.
 */
import React, { useEffect, useRef, useState } from 'react';
import { formatPopupText } from '../../utils/popupStyle';
import './TableConnectionBanner.css';

/** Mirrors EngineConnectionStatus from services/EngineStateClient. */
export type TableConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'auth_failed';

/** How long a bad state must persist before the player is told. */
export const GRACE_MS = 1200;
/** Once shown, stay up at least this long so a recovery cannot flash it away. */
export const MIN_VISIBLE_MS = 700;

interface Props {
  status: TableConnectionState;
  /** False for a backgrounded tab in the multi-table view. */
  isActive?: boolean;
}

/**
 * 'idle' is NOT a problem state. It is what a seat-first tournament table
 * reports before the game starts and there is no socket to hold yet. Telling
 * somebody choosing a seat that they are disconnected would be a lie, and it
 * is the exact case TablePage's auto-reload failsafe already carves out.
 */
function labelFor(status: TableConnectionState): string | null {
  switch (status) {
    case 'connecting':
      return 'Connecting To The Table';
    case 'reconnecting':
      return 'Reconnecting To The Table';
    case 'failed':
      // Say what happens next. "Disconnected" alone invites a hard refresh,
      // which is what Dan reached for, and a refresh mid-hand is the worst
      // available move.
      return 'Connection Lost. Trying To Get You Back';
    case 'auth_failed':
      // 2026-09-04: this said "Signing You In Again" through a 22-hour outage
      // in which nobody was being signed in. It now says what is happening:
      // the client is asking whether the session is still alive. A dead one
      // gets its own full-screen prompt (lib/sessionRevoked.announceSessionEnded).
      return 'Checking Your Sign-In';
    case 'idle':
    case 'connected':
    default:
      return null;
  }
}

export function TableConnectionBanner({
  status,
  isActive = true,
}: Props): React.ReactElement | null {
  const label = labelFor(status);
  const wantsBanner = label !== null && isActive;

  const [visible, setVisible] = useState(false);
  const shownAtRef = useRef<number>(0);

  useEffect(() => {
    let graceTimer: number | undefined;
    let hideTimer: number | undefined;

    if (wantsBanner) {
      if (visible) return;
      graceTimer = window.setTimeout(() => {
        shownAtRef.current = Date.now();
        setVisible(true);
      }, GRACE_MS);
    } else if (visible) {
      const heldFor = Date.now() - shownAtRef.current;
      const remaining = Math.max(0, MIN_VISIBLE_MS - heldFor);
      hideTimer = window.setTimeout(() => setVisible(false), remaining);
    }

    return () => {
      if (graceTimer) window.clearTimeout(graceTimer);
      if (hideTimer) window.clearTimeout(hideTimer);
    };
  }, [wantsBanner, visible]);

  if (!visible || !label) return null;

  return (
    <div
      className={`table-conn-banner table-conn-banner--${status}`}
      // aria-live so a screen reader announces the drop without stealing focus
      // from the action buttons, which may still be mid-hand.
      role="status"
      aria-live="polite"
      data-testid="table-connection-banner"
    >
      <span className="table-conn-banner__dot" aria-hidden="true" />
      <span className="table-conn-banner__label">{formatPopupText(label)}</span>
    </div>
  );
}

export default TableConnectionBanner;
