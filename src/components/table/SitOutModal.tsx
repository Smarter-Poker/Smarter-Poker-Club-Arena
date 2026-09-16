/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SIT OUT NOTICE - what a sitting-out player is looking at, on the master
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The one surface a sitting-out player has: the state, how long the seat is
 * held, and the way off the table. It floats at the bottom right of the felt
 * over a pointer-transparent overlay, so the hand underneath stays clickable.
 *
 * #ClubArenaConsole (2026-09-14). It was a rounded translucent pill with a
 * hand-drawn red outline button: its own radius, its own border, its own
 * backdrop blur. It is now the spade master's frame, cut narrow (--sc-max)
 * because it sits in a felt corner rather than over the page: the flat crest
 * (no emblem, the rails bridged), the state engraved in the header well, the
 * clock in the header's PAINTED pill slot, and the sentence on the black
 * glass. ONE action, so the foot is the flat closing cap and Leave Table is a
 * lit word on the glass - never a second painted plate left empty.
 *
 * NOTHING HERE IS DRAWN. No radius, no gradient, no border: the frame, the
 * well and the pill are painted in the art.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { haptic } from '../../services/SoundService';
import { sitOutMsRemaining, formatSitOutRemaining, isSitOutUrgent } from '../../lib/sitOutDeadline';
import { SpadeConsole } from '../console/SpadeConsole';
import './SitOutModal.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface SitOutModalProps {
  isOpen: boolean;
  onClose: () => void;
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

  const urgent = msRemaining !== null && isSitOutUrgent(msRemaining);

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
        <SpadeConsole
          className="sitout-modal__console"
          crest="flat"
          eyebrow="At This Table"
          title="Sitting Out"
          /* The clock goes in the master's own painted pill slot, gold while
             the seat is safe and red once it is nearly gone - the same
             predicate the seat badge uses, so the two cannot disagree.

             A TOURNAMENT TABLE HAS NO DEADLINE, and the slot is painted in the
             art whether anything is printed into it or not, so it says HELD
             rather than sitting there empty - which is the one thing an
             unfilled painted control always reads as. */
          pill={
            msRemaining === null
              ? 'Held'
              : msRemaining <= 0
                ? 'Now'
                : formatSitOutRemaining(msRemaining)
          }
          pillInk={urgent ? 'red' : 'gold'}
          foot="foot"
        >
          {/* THE DEADLINE, worded as the upper bound it is. The rule is "2 orbits
            or 5 minutes, whichever comes FIRST", and the orbit half is engine
            state no client can see — so a player evicted early must never be
            able to point at a countdown here that promised them longer.
            A tournament table (a spin is one) gets no line at all rather than
            a countdown that never fires. */}
          {msRemaining !== null ? (
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
          ) : (
            /* The tournament line. It is NOT a countdown and must never read
               like one: a tournament (a spin is one) may sit out indefinitely
               and is blinded off instead. The row also has to exist, because
               without it the glass between the head and Leave Table is an
               empty engraved band - which reads as a line that failed to
               render rather than as a table with no clock. */
            <span className="sitout-modal__deadline">
              Your Seat Is Held For As Long As You Sit Out
            </span>
          )}

          {/* NO "I'M BACK" HERE (Dan 2026-09-04: "there shouldn't be two 'im
            back' buttons"). This pill floats bottom-right, over the hero's
            cards, at the same moment the footer bar below it says "You Are
            Sitting Out" with its own I'm Back - two green buttons a thumb's
            width apart doing the same thing. The bar is THE way back
            (TablePage's spectator-footer-bar, `handleSitBackIn`); this pill
            keeps what the bar does not offer: the way OFF the table. */}
          {/* Dan 2026-08-25: "if you are SITTING OUT but click LEAVE TABLE, it
            doesn't leave the table... LEAVE TABLE IS LIKE THE RESET BUTTON."
            This modal has ALWAYS taken an onLeaveTable prop and built a
            handleLeave for it — TableModalsLayer passes onConfirmLeaveTable in
            — and then rendered only "I'm Back". The handler was dead code, so
            the one screen a sitting-out player is looking at offered them no way
            out at all. */}
          {/* ONE ACTION, SO IT IS A LIT WORD, NOT A PLATE. The foot paints both
              plates or neither, and a surface with one action would leave the
              other painted and empty. */}
          <div className="sitout-modal__actions">
            <button
              type="button"
              className="sitout-modal__leave-btn sc-ink--red"
              onClick={() => {
                haptic.light();
                handleLeave();
              }}
            >
              Leave Table
            </button>
          </div>
        </SpadeConsole>
      </div>
    </div>
  );
}

export default SitOutModal;
