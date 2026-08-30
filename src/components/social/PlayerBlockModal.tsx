/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLAYER BLOCK MODAL — Confirmation for Blocking a Player
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useId, useState } from 'react';
import './PlayerBlockModal.css';

interface PlayerBlockModalProps {
  playerName: string;
  onConfirm: (reason?: string) => void;
  onCancel: () => void;
}

export default function PlayerBlockModal({
  playerName,
  onConfirm,
  onCancel,
}: PlayerBlockModalProps) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const titleId = useId();
  const reasonId = useId();

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onCancel();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onCancel, submitting]);

  const handleConfirm = async () => {
    setSubmitting(true);
    await onConfirm(reason.trim() || undefined);
    setSubmitting(false);
  };

  return (
    <div className="block-modal-overlay" onClick={onCancel}>
      <div
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
