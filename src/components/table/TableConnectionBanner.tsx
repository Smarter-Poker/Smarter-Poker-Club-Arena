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
  /**
   * The engine has refused this socket for AUTH during the current outage
   * (Realtime Phase 3, 2026-09-05). It is not the same story as a lost
   * connection and must not be told as one: "Connection Lost. Trying To Get
   * You Back" invites the player to check their Wi-Fi and then hard-refresh,
   * and a refresh is the one move that cannot help here - it presents the
   * same token to the same refusal, mid-hand.
   *
   * TablePage keeps this sticky for the outage because 'auth_failed' is a
   * status the client passes through in milliseconds on its way to
   * 'reconnecting'; by the time a banner could render it, the status alone
   * has already forgotten that auth was the cause.
   *
   * A session that is genuinely dead never rests on this text - it gets the
   * full-screen prompt and the redirect from lib/sessionRevoked. What is left
   * for this line to say is the other case: the session is fine and the
   * ENGINE cannot verify it, which the ladder underneath is still retrying.
   */
  authRefused?: boolean;
  /**
   * TRUE ONCE THE FELT IS ACTUALLY SHOWING A HAND (Dan 2026-09-07).
   *
   * "ALL TABLES STILL SAY CONNECTING TO THE TABLE, INSTEAD OF BEING RUNNING AT
   * ALL TIMES, AND PRE LOADED."
   *
   * He is right, and the banner was telling the truth about the wrong thing.
   * `status` describes the SOCKET, and the socket legitimately passes through
   * 'connecting' on every entry — `EngineStateClient.openOnceInner` announces
   * it at the top of every fresh open, and the mux handshake plus
   * SUBSCRIBE/SUBSCRIBED routinely takes longer than GRACE_MS. Meanwhile the
   * warm-up roster has already painted seats, stacks and a live hand. So the
   * player is looking at a running table that is announcing it is not there.
   *
   * The banner exists for the case in the header: a felt that has STOPPED
   * receiving state and is indistinguishable from a quiet one. A first connect
   * behind an already-painted table is the opposite situation and needs no
   * announcement at all — nothing is missing, and saying so is what makes
   * every table look broken on entry.
   *
   * Deliberately narrow: this suppresses 'connecting' ONLY. A painted table
   * that drops to 'reconnecting' or 'failed' is exactly the original bug and
   * still says so, because there the pixels really are stale.
   */
  hasLiveState?: boolean;
}

/**
 * 'idle' is NOT a problem state. It is what a seat-first tournament table
 * reports before the game starts and there is no socket to hold yet. Telling
 * somebody choosing a seat that they are disconnected would be a lie, and it
 * is the exact case TablePage's auto-reload failsafe already carves out.
 */
/**
 * What the player is told while the engine is refusing their sign-in. Title
 * Case and no em dashes, from the same house rule as everything else here
 * (CLAUDE.md 5.7), and deliberately in the present continuous: something is
 * still happening on their behalf, so there is nothing for them to do.
 */
export const AUTH_REFUSED_LABEL = 'The Table Cannot Verify Your Sign In. Still Trying';

export function labelFor(status: TableConnectionState, authRefused = false): string | null {
  /* An auth refusal outranks the transport words for every state that would
     otherwise blame the connection. 'connecting' and 'idle' are left alone:
     the first is a fresh attempt that may well succeed, and the second is a
     seat-first table with no socket to hold yet. */
  if (authRefused && (status === 'failed' || status === 'reconnecting' || status === 'auth_failed'))
    return AUTH_REFUSED_LABEL;
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
  authRefused = false,
  hasLiveState = false,
}: Props): React.ReactElement | null {
  const label = labelFor(status, authRefused);
  /* THE SUPPRESSION IS HERE, NOT IN labelFor (law, tests/a-reload-cannot-fix-
     a-sign-in): that function maps a status to WHAT IT IS CALLED and must stay
     a pure translation - it is read by the popup-copy laws, and a branch that
     returns null for a status that has a name would make those laws unable to
     see the name. This is a rendering decision on top of it: the label for
     'connecting' still exists and is still correct; a table already showing a
     dealt hand simply has no reason to display it. See `hasLiveState`. */
  const suppressed = status === 'connecting' && hasLiveState;
  const wantsBanner = label !== null && isActive && !suppressed;

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
