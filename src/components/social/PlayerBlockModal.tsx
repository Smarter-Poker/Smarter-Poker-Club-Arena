/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLAYER BLOCK MODAL — Confirmation for Blocking a Player
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useId, useRef, useState } from 'react';
import './PlayerBlockModal.css';

interface PlayerBlockModalProps {
  playerName: string;
  onConfirm: (reason?: string) => void | Promise<void>;
  onCancel: () => void;
}

export default function PlayerBlockModal({
  playerName,
  onConfirm,
  onCancel,
}: PlayerBlockModalProps) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onCancelRef = useRef(onCancel);
  const submittingRef = useRef(submitting);
  const titleId = useId();
  const reasonId = useId();
  onCancelRef.current = onCancel;
  submittingRef.current = submitting;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submittingRef.current) {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleDialogKeys);
    return () => {
      document.removeEventListener('keydown', handleDialogKeys);
      previouslyFocused?.focus();
    };
  }, []);

  const handleConfirm = async () => {
    setSubmitting(true);
    setSubmitError('');
    try {
      await onConfirm(reason.trim() || undefined);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Player could not be blocked.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="block-modal-overlay" onClick={() => !submitting && onCancel()}>
      <div
        ref={dialogRef}
        className="block-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="block-modal-header">
          <span className="block-icon" aria-hidden="true">
            !
          </span>
          <h3 id={titleId}>Block {playerName}?</h3>
        </div>

        <div className="block-modal-body">
          <p className="block-warning">Blocking This Player Will:</p>
          <ul className="block-effects">
            <li>Prevent Them From Messaging You</li>
            <li>Remove Them From Your Friends List</li>
            <li>Hide Them From Your Friend Suggestions</li>
            <li>Block Friend Requests Between You</li>
          </ul>

          <div className="block-reason-field">
            <label htmlFor={reasonId}>Reason (Optional)</label>
            <input
              id={reasonId}
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why Are You Blocking This Player?"
              maxLength={200}
              autoFocus
            />
          </div>
        </div>

        <div className="block-modal-actions">
          {submitError && (
            <p className="block-modal-error" role="alert">
              {submitError}
            </p>
          )}
          <button type="button" className="cancel-btn" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="confirm-btn"
            onClick={handleConfirm}
            disabled={submitting}
          >
            {submitting ? 'Blocking...' : 'Block Player'}
          </button>
        </div>
      </div>
    </div>
  );
}
