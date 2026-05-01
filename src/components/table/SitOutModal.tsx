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
  timeRemaining: number; // seconds until auto-kicked
  maxSitOutTime: number; // total allowed sit-out time
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
  timeRemaining,
  maxSitOutTime,
  autoPostBlinds = true,
  tableName,
}: SitOutModalProps) {
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [displayTime, setDisplayTime] = useState(timeRemaining);

  // Update countdown
  useEffect(() => {
    setDisplayTime(timeRemaining);
  }, [timeRemaining]);

  useEffect(() => {
    if (!isOpen || displayTime <= 0) return;

    const timer = setInterval(() => {
      setDisplayTime((t) => Math.max(0, t - 1));
    }, 1000);

    return () => clearInterval(timer);
  }, [isOpen, displayTime]);

  // Progress percentage
  const progress = (displayTime / maxSitOutTime) * 100;
  const isUrgent = displayTime <= 60;

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

        {/* Timer Circle */}
        <div className={`sitout-modal__timer ${isUrgent ? 'sitout-modal__timer--urgent' : ''}`}>
          <svg className="sitout-modal__progress" viewBox="0 0 100 100">
            <circle className="sitout-modal__progress-bg" cx="50" cy="50" r="45" />
            <circle
              className="sitout-modal__progress-fill"
              cx="50"
              cy="50"
              r="45"
              strokeDasharray={`${progress * 2.83} 283`}
            />
          </svg>
          <div className="sitout-modal__timer-content">
            <span className="sitout-modal__time">{formatTime(displayTime)}</span>
            <span className="sitout-modal__time-label">remaining</span>
          </div>
        </div>

        {/* Warning */}
        {isUrgent && (
          <div className="sitout-modal__warning">
            You will be removed from the table if you don't return
          </div>
        )}

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
