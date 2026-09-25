/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CONFIRM MODAL — Reusable Confirmation Dialog
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Premium replacement for window.confirm with:
 * - Customizable title, message, and button text
 * - Danger/default variants
 * - Accessible keyboard handling
 * - Smooth animations
 */

import React, { useEffect, useCallback, useRef } from 'react';
import { formatPopupText } from '../../utils/popupStyle';
import { SpadeConsole } from '../console/SpadeConsole';
import './ConfirmModal.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ConfirmModalProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'default' | 'danger';
  loading?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function ConfirmModal({
  isOpen,
  onConfirm,
  onCancel,
  title = 'Confirm Action',
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'default',
  loading = false,
}: ConfirmModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  /** Whatever had focus when this opened, so it can be given back. */
  const returnFocusRef = useRef<Element | null>(null);

  /**
   * ESCAPE, AND A TAB THAT CANNOT LEAVE (2026-09-05).
   *
   * This carried `role="dialog"` and `aria-modal="true"` and neither of those
   * does anything on its own: aria-modal tells a screen reader the rest of the
   * page is inert, it does not make it inert. Tab walked straight out of the
   * dialog into the page behind it, and closing dropped focus on <body> so the
   * next Tab restarted at the top of the document.
   *
   * On the account-closure confirm that is the worst version of it: a keyboard
   * player tabbing past "Confirm" lands on the page they were about to delete,
   * with a live modal they can no longer see focus inside.
   */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) {
        onCancel();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) {
        // Every control is disabled (a confirm in flight). Keep focus inside.
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    },
    [onCancel, loading]
  );

  useEffect(() => {
    if (!isOpen) return undefined;
    returnFocusRef.current = document.activeElement;
    document.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';
    /* Cancel takes focus, not Confirm. The destructive button must never be
       one Enter away from a player who has not read the message yet. */
    const timer = window.setTimeout(() => cancelRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
      const back = returnFocusRef.current as HTMLElement | null;
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
    };
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  /* THE CONSOLE (2026-09-04). This was a rounded glass card with a circled
     warning glyph and two pill buttons - the one popup a player meets most
     often (Close Table, Leave, Remove) and the only surface between the lobby
     and the felt that did not look like the machine around it. It is now the
     spade console: the same master every Omaha card is drawn from, cut into
     head, rails and foot. The title is engraved in the header well, the
     eyebrow sits in the well's painted pill slot, the message prints on the
     glass, and the two actions are the plates painted into the foot - CANCEL
     on steel, the confirming action on the blue glass, or in red ink when it
     is destructive. Nothing is drawn; nothing is stuck on. The focus trap
     above is untouched: Cancel still takes focus on open. */
  return (
    <div className="confirm-modal-overlay" onClick={loading ? undefined : onCancel}>
      <div
        ref={dialogRef}
        className={`confirm-modal ac-popup ${variant === 'danger' ? 'confirm-modal--danger' : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        aria-describedby="confirm-modal-message"
        aria-busy={loading || undefined}
      >
        <SpadeConsole
          onClose={loading ? undefined : onCancel}
          as="div"
          title={formatPopupText(title)}
          titleId="confirm-modal-title"
          pill={variant === 'danger' ? 'Sure?' : 'Confirm'}
          pillInk={variant === 'danger' ? 'red' : 'blue'}
          plates={{
            secondary: {
              label: formatPopupText(cancelText),
              buttonRef: cancelRef,
              className: 'confirm-modal__btn confirm-modal__btn--cancel',
              onClick: onCancel,
              disabled: loading,
            },
            primary: {
              label: loading ? 'Working' : formatPopupText(confirmText),
              ink: variant === 'danger' ? 'red' : 'white',
              className: `confirm-modal__btn confirm-modal__btn--confirm ${
                variant === 'danger' ? 'confirm-modal__btn--danger' : ''
              }`,
              onClick: onConfirm,
              disabled: loading,
            },
          }}
        >
          <p id="confirm-modal-message" className="sc-copy sc-copy--center confirm-modal__message">
            {formatPopupText(message)}
          </p>
        </SpadeConsole>
      </div>
    </div>
  );
}

export default ConfirmModal;
