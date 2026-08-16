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
  onAutoPostChange?: (enabled: boolean) => void;
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
  autoPostBlinds?: boolean;
  tableName?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function SitOutModal({
  isOpen,
  onClose,
  onReturn,
  onLeaveTable,
  onAutoPostChange,
  sitOutSince,
  autoPostBlinds = true,
  tableName,
}: SitOutModalProps) {
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  // Count UP from when sit-out began. One interval for the lifetime of the
  // open modal — the old countdown listed `displayTime` in its own dependency
  // array, so it tore down and recreated the interval on every single tick.
  useEffect(() => {
    if (!isOpen) return;
    const since = sitOutSince ?? Date.now();
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - since) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [isOpen, sitOutSince]);

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
        {/* Header */}
        <div className="sitout-modal__header">
          <h2 className="sitout-modal__title">You're Sitting Out</h2>
          {tableName && <span className="sitout-modal__table">{tableName}</span>}
        </div>

        {/* Elapsed sit-out time. The ring is a full, static ring now: there is
            no deadline for it to deplete towards. */}
        <div className="sitout-modal__timer">
          <svg className="sitout-modal__progress" viewBox="0 0 100 100">
            <circle className="sitout-modal__progress-bg" cx="50" cy="50" r="45" />
            <circle
              className="sitout-modal__progress-fill"
              cx="50"
              cy="50"
              r="45"
              strokeDasharray="283 283"
            />
          </svg>
          <div className="sitout-modal__timer-content">
            <span className="sitout-modal__time">{formatTime(elapsed)}</span>
            <span className="sitout-modal__time-label">sitting out</span>
          </div>
        </div>

        {/* What is actually true: the seat and the stack are held. */}
        <div className="sitout-modal__note">
          Your seat and chips are held while you are sitting out. Return whenever
          you are ready.
        </div>

        {/* Auto-Post Toggle */}
        {onAutoPostChange && (
          <label className="sitout-modal__toggle">
            <input
              type="checkbox"
              checked={autoPostBlinds}
              onChange={(e) => onAutoPostChange(e.target.checked)}
            />
            <span className="sitout-modal__toggle-slider" />
            <span className="sitout-modal__toggle-label">Post blinds when returning</span>
          </label>
        )}

        {/* Actions */}
        <div className="sitout-modal__actions">
          {!showLeaveConfirm ? (
            <>
              <button
                className="sitout-modal__return-btn"
                onClick={() => {
                  haptic.light();
                  handleReturn();
                }}
              >
                Return to Game
              </button>
              <button className="sitout-modal__leave-btn" onClick={() => setShowLeaveConfirm(true)}>
                Leave Table
              </button>
            </>
          ) : (
            <div className="sitout-modal__confirm">
              <span>Leave and cash out your chips?</span>
              <div className="sitout-modal__confirm-actions">
                <button
                  className="sitout-modal__confirm-no"
                  onClick={() => setShowLeaveConfirm(false)}
                >
                  Cancel
                </button>
                <button className="sitout-modal__confirm-yes" onClick={handleLeave}>
                  Leave
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default SitOutModal;
