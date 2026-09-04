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
  /**
   * CHIP CONTINUITY: "Leave Available In M:SS" while the stay clock has time
   * left. When set, the confirm button shows it and is disabled - the server
   * would refuse the leave anyway.
   */
  lockedLabel?: string | null;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export default function LeaveTableConfirm({
  isOpen,
  currentStack,
  tableName,
  isTournament = false,
  lockedLabel = null,
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
    /* Dan 2026-08-25: "LEAVE TABLE FROM THE HAMBURGER MENU DOESN'T WORK AT ALL."
       It worked. Nobody could see it.

       These two class names were `leave-confirm-overlay` and `leave-confirm`,
       and LeaveTableConfirm.css defines neither — it only has the BEM pair
       `__backdrop` and `__dialog`, which every CHILD element here already uses.
       The only `.leave-confirm-overlay` rule in the repo lives in
       QuickLeaveButton.css, a component nothing imports, so that stylesheet is
       not even in the bundle.

       With no rule matching, the overlay lost `position: fixed`, `inset: 0` and
       its z-index, and the dialog lost its background and sizing. It rendered as
       a plain static flex child appended after `.table-page` — which is
       `position: fixed; inset: 0; overflow: hidden` — so it was clipped out of
       existence. State flipped, React rendered, and nothing appeared. Every
       entry point that routes through this confirm (the tab-bar hamburger, the
       in-table HUD hamburger, the header back arrow, and Leave while sitting
       out) looked like a dead button. The paths that DID work — the tab X and
       long-press — are exactly the ones that skip this dialog. */
    <div className="leave-confirm__backdrop" onClick={leaving ? undefined : onCancel}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="leave-confirm__dialog"
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
            disabled={leaving || !!lockedLabel}
            aria-disabled={!!lockedLabel}
          >
            {lockedLabel ? lockedLabel : leaving ? 'Leaving…' : 'Leave Table'}
          </button>
        </div>
      </div>
    </div>
  );
}
