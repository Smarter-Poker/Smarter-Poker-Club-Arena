/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🚪 LEAVE TABLE CONFIRM — Confirmation Dialog Before Leaving Table
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Prevents accidental leaves during intense hands by showing the current
 * stack size and asking for confirmation before executing the cashout.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import './LeaveTableConfirm.css';

interface LeaveTableConfirmProps {
  isOpen: boolean;
  currentStack: number;
  tableName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function LeaveTableConfirm({
  isOpen,
  currentStack,
  tableName,
  onConfirm,
  onCancel,
}: LeaveTableConfirmProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [isOpen, onCancel]);

  const handleConfirm = useCallback(() => {
    onConfirm();
  }, [onConfirm]);

  if (!isOpen) return null;

  return (
    <div className="leave-confirm__backdrop" onClick={onCancel}>
      <div
        className="leave-confirm__dialog"
        ref={dialogRef}
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
          Leave Table?
        </h3>
        <p id="leave-confirm-desc" className="leave-confirm__desc">
          You have{' '}
          <strong>
            {currentStack.toLocaleString('en-US', {
              minimumFractionDigits: 0,
              maximumFractionDigits: 0,
            })}
          </strong>{' '}
          chips at <strong>{tableName}</strong>. Your chips will be returned to your wallet.
        </p>
        <div className="leave-confirm__actions">
          <button className="leave-confirm__btn leave-confirm__btn--cancel" onClick={onCancel}>
            Stay
          </button>
          <button
            className="leave-confirm__btn leave-confirm__btn--confirm"
            onClick={handleConfirm}
          >
            Leave Table
          </button>
        </div>
      </div>
    </div>
  );
}
