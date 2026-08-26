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

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { haptic } from '../../services/SoundService';
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
   * HONESTY FIX 2026-08-16: this used to be `timeRemaining` — "seconds until
   * auto-kicked" — counting down from 300, alongside the warning "You will be
   * removed from the table if you don't return".
   *
   * None of that was true. There is NO sit-out deadline anywhere in the
   * system: no server timer, no sweeper, no cron, no seat-reclaim rule. A
   * player may sit out indefinitely and keeps their seat and their stack. The
   * only real rule is the opposite direction — repeated action timeouts PUT
   * you into sit-out (DisconnectEngine.recordConnectedTimeout, capped by
   * maxConsecutiveTimeouts) — and it never removes you afterwards.
   *
   * Worse, `timeRemaining` was hard-wired to 300 and never updated: the state
   * behind it had no setter call anywhere in the repo. So the modal invented a
   * countdown, reset it every time you reopened it, threatened the player with
   * losing a seat that was never at risk, and did it about a table their money
   * was sitting on.
   *
   * Now it reports the truth: how long you have actually been sitting out.
   * Epoch ms of when sit-out began, or null if that is not known.
   */
  sitOutSince: number | null;
  tableName?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function SitOutModal({
  isOpen,
  onClose,
  onReturn,
  onLeaveTable,
  sitOutSince,
  tableName,
}: SitOutModalProps) {
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);

  // Reset the destructive confirm on every close.
  //
  // The overlay dismisses via onClose without touching `showLeaveConfirm`, so
  // a player who tapped "Leave Table", thought better of it and tapped outside
  // reopened the modal straight into the confirm step — with "Leave" sitting
  // exactly where "Return to Game" had been the moment before. One tap cashed
  // them out of the table.
  useEffect(() => {
    if (!isOpen) setShowLeaveConfirm(false);
  }, [isOpen]);

  // REMOVED 2026-08-26: a 1 Hz setInterval that set `elapsed`, which appeared
  // nowhere in this component's JSX, alongside a `formatTime` helper nothing
  // called. It re-rendered the open modal once a second to display nothing.
  // If a sit-out duration readout is wanted, render it from `sitOutSince` in a
  // memoised child so the tick does not re-render the modal body.

  // Handle return
  const handleReturn = useCallback(() => {
    onReturn();
    onClose();
  }, [onReturn, onClose]);

  // Handle leave
  const handleLeave = useCallback(() => {
    onLeaveTable();
    setShowLeaveConfirm(false);
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
