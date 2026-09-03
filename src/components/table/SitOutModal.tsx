/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🚶 SIT OUT MODAL — Sit-Out Timer and Controls
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Modal for managing sit-out status:
 * - Time remaining display
 * - Return to game button
 * - Auto-post blinds toggle
 * - Leave table option
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { haptic } from '../../services/SoundService';
import { sitOutMsRemaining, formatSitOutRemaining, isSitOutUrgent } from '../../lib/sitOutDeadline';
import './SitOutModal.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface SitOutModalProps {
  isOpen: boolean;
  onClose: () => void;
  onReturn: () => void;
  onLeaveTable: () => void;
  /**
   * Epoch ms of when sit-out began, or null if that is not known.
   *
   * HISTORY, because this prop has been wrong in both directions.
   *
   * It began as `timeRemaining` — "seconds until auto-kicked", counting down
   * from 300 beside the warning "You will be removed from the table if you
   * don't return". On 2026-08-16 that was found to be an invention: there was
   * NO sit-out deadline in the system at the time, no server timer, no sweeper,
   * no seat-reclaim rule, and the value was hard-wired to 300 with no setter
   * anywhere in the repo. The modal threatened a player with losing a seat that
   * was never at risk, about a table their money was sitting on. Rightly
   * removed.
   *
   * The prop that replaced it was then never rendered — this component
   * destructured `sitOutSince` and dropped it on the floor, so the readout was
   * gone and nothing took its place.
   *
   * THE DEADLINE IS REAL NOW (Dan 2026-08-28: "A USER CAN ONLY SIT OUT FOR 5
   * MINUTES BEFORE GETTING BOOTED IN A CASH GAME"), enforced from
   * `table_seats.sit_out_at`. So the countdown is owed again — but as an UPPER
   * BOUND, because the rule is "2 orbits or 5 minutes, whichever comes first"
   * and the orbit half is engine state a client cannot see. See
   * src/lib/sitOutDeadline.ts.
   */
  sitOutSince: number | null;
  /**
   * False for cash. Tournaments (spins included — a spin is a tournament) may
   * sit out indefinitely and are blinded off instead, so they get no countdown
   * at all rather than one that never fires.
   *
   * NOT heads-up cash: there is no heads-up table type, and both client and
   * server give a heads-up cash table the ordinary five-minute clock. See the
   * note in src/lib/sitOutDeadline.ts.
   */
  isTournament?: boolean;
  /* `tableName` REMOVED 2026-08-29: accepted, destructured and passed in by
     TableModalsLayer, and rendered by nothing. */
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Milliseconds left on the sit-out clock, re-read once a second.
 *
 * Returns `null` whenever no deadline applies — closed modal, tournament/spin/
 * a tournament table, or an unknown start time — and starts no interval then,
 * so the common tournament path costs exactly one comparison.
 *
 * Recomputed from `Date.now()` on every tick rather than decremented, so a
 * backgrounded tab (where browsers throttle timers to once a minute) shows the
 * true remaining time the moment it comes back rather than a figure that has
 * drifted by however long it was hidden.
 */
function useSitOutCountdown(
  isOpen: boolean,
  sitOutSince: number | null,
  isTournament: boolean
): number | null {
  const [msRemaining, setMsRemaining] = useState<number | null>(() =>
    sitOutMsRemaining({ sitOutSince, isTournament })
  );

  useEffect(() => {
    if (!isOpen) return;
    const read = () => setMsRemaining(sitOutMsRemaining({ sitOutSince, isTournament }));
    read();
    if (sitOutMsRemaining({ sitOutSince, isTournament }) === null) return;
    const id = setInterval(() => {
      read();
      /* STOP AT ZERO, like the seat badge. `sitOutMsRemaining` floors at 0
         rather than returning null, so without this the modal re-rendered once
         a second for however long the eviction sweep took to land — and the
         line already reads "Your Seat May Be Taken At Any Moment", which cannot
         become more urgent. */
      if (sitOutMsRemaining({ sitOutSince, isTournament }) === 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [isOpen, sitOutSince, isTournament]);

  return msRemaining;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function SitOutModal({
  isOpen,
  onClose,
  onReturn,
  onLeaveTable,
  sitOutSince,
  isTournament = false,
}: SitOutModalProps) {
  /* ── `showLeaveConfirm` REMOVED 2026-08-29 ─────────────────────────────
     Nothing ever set it TRUE and no JSX read it. The ten-line comment it
     carried described a two-step Leave confirmation ("Leave sitting exactly
     where Return to Game had been") that is not in this component — and the
     reset it guarded was triggered by `onClose`, whose only route in is the
     overlay's `onClick`, which cannot fire: `.sitout-overlay` is
     `pointer-events: none`. Dead state, guarded by a dead reset, for a UI that
     does not exist, described by a comment a reader would trust. */

  /**
   * THE COUNTDOWN, restored 2026-08-29 — and this time it ticks against a
   * deadline that exists.
   *
   * A 1 Hz interval was removed on 2026-08-26 because it set state that no JSX
   * read: it re-rendered the open modal once a second to display nothing. The
   * note left behind asked for a memoised child so the tick would not re-render
   * the body. The cheaper version of the same idea: the interval runs ONLY
   * while the modal is open AND a deadline applies, so a tournament player and
   * a closed modal both cost nothing.
   */
  const msRemaining = useSitOutCountdown(isOpen, sitOutSince, isTournament);

  // Handle return
  const handleReturn = useCallback(() => {
    onReturn();
    onClose();
  }, [onReturn, onClose]);

  // Handle leave
  const handleLeave = useCallback(() => {
    onLeaveTable();
    onClose();
  }, [onLeaveTable, onClose]);

  const [mounted, setMounted] = useState(false);
  // BUG FIX (SOM-1): track mount-animation timer so it cancels on unmount or
  // on isOpen toggle — prevents stale setState on unmounted component.
  const mountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (isOpen) {
      if (mountTimerRef.current) clearTimeout(mountTimerRef.current);
      mountTimerRef.current = setTimeout(() => {
        mountTimerRef.current = null;
        setMounted(true);
      }, 50);
    } else {
      if (mountTimerRef.current) {
        clearTimeout(mountTimerRef.current);
        mountTimerRef.current = null;
      }
      setMounted(false);
    }
    return () => {
      if (mountTimerRef.current) {
        clearTimeout(mountTimerRef.current);
        mountTimerRef.current = null;
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="sitout-overlay" onClick={onClose}>
      <div
        className="sitout-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        <span className="sitout-modal__status-label">Sitting Out</span>

        {/* THE DEADLINE, worded as the upper bound it is. The rule is "2 orbits
            or 5 minutes, whichever comes FIRST", and the orbit half is engine
            state no client can see — so a player evicted early must never be
            able to point at a countdown here that promised them longer.
            A tournament table (a spin is one) gets no line at all rather than
            a countdown that never fires. */}
        {msRemaining !== null && (
          <span
            className={`sitout-modal__deadline${
              isSitOutUrgent(msRemaining) ? ' sitout-modal__deadline--urgent' : ''
            }`}
            data-testid="sitout-deadline"
          >
            {msRemaining <= 0
              ? 'Your Seat May Be Taken At Any Moment'
              : `Your Seat Is Held For Up To ${formatSitOutRemaining(msRemaining)}`}
          </span>
        )}

        <button
          className="sitout-modal__im-back-btn"
          onClick={() => {
            haptic.light();
            handleReturn();
          }}
        >
          I'm Back
        </button>

        {/* Dan 2026-08-25: "if you are SITTING OUT but click LEAVE TABLE, it
            doesn't leave the table... LEAVE TABLE IS LIKE THE RESET BUTTON."
            This modal has ALWAYS taken an onLeaveTable prop and built a
            handleLeave for it — TableModalsLayer passes onConfirmLeaveTable in
            — and then rendered only "I'm Back". The handler was dead code, so
            the one screen a sitting-out player is looking at offered them no way
            out at all. */}
        <button
          className="sitout-modal__leave-btn"
          onClick={() => {
            haptic.light();
            handleLeave();
          }}
        >
          Leave Table
        </button>
      </div>
    </div>
  );
}

export default SitOutModal;
