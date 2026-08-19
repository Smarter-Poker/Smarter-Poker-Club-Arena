/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLAYER BLOCK MODAL — Confirmation for Blocking a Player
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState } from 'react';
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

  const handleConfirm = async () => {
    setSubmitting(true);
    await onConfirm(reason.trim() || undefined);
    setSubmitting(false);
  };

  return (
    <div className="block-modal-overlay" onClick={onCancel}>
      <div className="block-modal" onClick={(e) => e.stopPropagation()}>
        <div className="block-modal-header">
          <span className="block-icon">⊘</span>
          <h3>Block {playerName}?</h3>
        </div>

        <div className="block-modal-body">
          <p className="block-warning">Blocking this player will:</p>
          <ul className="block-effects">
            <li>Prevent them from messaging you</li>
            <li>Remove them from your friends list</li>
            <li>Hide them from your friend suggestions</li>
            <li>Block friend requests between you</li>
          </ul>

          <div className="block-reason-field">
            <label>Reason (optional)</label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why are you blocking this player?"
              maxLength={200}
            />
          </div>
        </div>

        <div className="block-modal-actions">
          <button className="cancel-btn" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button className="confirm-btn" onClick={handleConfirm} disabled={submitting}>
            {submitting ? 'Blocking...' : 'Block Player'}
          </button>
        </div>
      </div>
    </div>
  );
}
