/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🚪 LEAVE TABLE CONFIRM — Confirmation Dialog Before Leaving Table
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Prevents accidental leaves during intense hands by showing the current
 * stack size and asking for confirmation before executing the cashout.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import './LeaveTableConfirm.css';

interface LeaveTableConfirmProps {
  isOpen: boolean;
  currentStack: number;
  tableName: string;
  isTournament?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export default function LeaveTableConfirm({
  isOpen,
  currentStack,
  tableName,
  isTournament = false,
  onConfirm,
  onCancel,
}: LeaveTableConfirmProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // In-flight guard. Leaving a table cashes the stack out; `onConfirm` does a
  // round trip, and until now nothing stopped a second tap during it from
  // firing a second cash-out.
  const [leaving, setLeaving] = useState(false);
  const leavingRef = useRef(false);

  useEffect(() => {
    if (!isOpen) {
      leavingRef.current = false;
      setLeaving(false);
    }
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !leavingRef.current) {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, onCancel]);

  // Trap focus & lock body scroll
  useEffect(() => {
    if (!isOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen]);

  const handleConfirm = async () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    try {
      await onConfirm();
    } finally {
      // In normal operation onConfirm unmounts this whole tree on navigation.
      // If it throws or no-ops, unlock so the player is not trapped.
      leavingRef.current = false;
      setLeaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="leave-confirm-overlay" onClick={leaving ? undefined : onCancel}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="leave-confirm"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-labelledby="leave-confirm-title"
        aria-describedby="leave-confirm-desc"
      >
        <div className="leave-confirm__icon">
          <svg width="32" height="32" viewBox="0 0 18 18" fill="none">
            <path
              d="M6 3h7a2 2 0 012 2v8a2 2 0 01-2 2H6"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <path
              d="M10 9H2M2 9l2.5-2.5M2 9l2.5 2.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <h3 id="leave-confirm-title" className="leave-confirm__title">
          {isTournament ? 'Leave Tournament Table?' : 'Leave Table?'}
        </h3>
        <p id="leave-confirm-desc" className="leave-confirm__desc">
          {isTournament ? (
            <>
              You Have{' '}
              <strong>
                {currentStack.toLocaleString('en-US', {
                  minimumFractionDigits: 0,
                  maximumFractionDigits: 0,
                })}
              </strong>{' '}
              Tournament Chips At <strong>{tableName}</strong>. In Tournaments, Leaving The Table
              Places You On Sit-Out (Blinded Out / Auto-Folded). You Can Return Anytime Until
              Eliminated.
            </>
          ) : (
            <>
              You Have{' '}
              <strong>
                {currentStack.toLocaleString('en-US', {
                  minimumFractionDigits: 0,
                  maximumFractionDigits: 0,
                })}
              </strong>{' '}
              Chips At <strong>{tableName}</strong>. Your Chips Will Be Returned To Your Wallet.
            </>
          )}
        </p>
        <div className="leave-confirm__actions">
          <button
            type="button"
            className="leave-confirm__btn leave-confirm__btn--cancel"
            onClick={onCancel}
            disabled={leaving}
            autoFocus
          >
            Stay
          </button>
          <button
            type="button"
            className="leave-confirm__btn leave-confirm__btn--confirm"
            onClick={() => void handleConfirm()}
            disabled={leaving}
          >
            {leaving ? 'Leaving…' : 'Leave Table'}
          </button>
        </div>
      </div>
    </div>
  );
}
