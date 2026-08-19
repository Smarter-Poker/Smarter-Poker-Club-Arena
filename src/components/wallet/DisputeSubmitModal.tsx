/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DISPUTE SUBMIT MODAL — Player-facing Dispute Submission
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState } from 'react';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import { DisputeService, type DisputeTarget } from '../../services/DisputeService';

interface DisputeSubmitModalProps {
  isOpen: boolean;
  onClose: () => void;
  clubId: string;
  /** Pre-fill dispute target if launched from a specific transaction */
  defaultTargetType?: DisputeTarget;
  defaultTargetId?: string;
  defaultAmount?: number;
}

export default function DisputeSubmitModal({
  isOpen,
  onClose,
  clubId,
  defaultTargetType,
  defaultTargetId,
  defaultAmount,
}: DisputeSubmitModalProps) {
  const { user } = useAuthUser();
  const toast = useToast();

  const [targetType, setTargetType] = useState<DisputeTarget>(
    defaultTargetType || 'agent_settlement'
  );
  const [targetId, setTargetId] = useState(defaultTargetId || '');
  const [amount, setAmount] = useState(defaultAmount?.toString() || '');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    if (!user?.id) {
      toast.error('Please log in to submit a dispute');
      return;
    }
    if (!reason.trim()) {
      toast.error('Please provide a reason for the dispute');
      return;
    }
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      toast.error('Please enter a valid amount');
      return;
    }

    setSubmitting(true);
    try {
      await DisputeService.submitDispute(user.id, {
        targetType,
        targetId: targetId || 'general',
        clubId,
        amount: parsedAmount,
        reason: reason.trim(),
      });
      toast.success('Dispute submitted! The club owner will review it.');
      onClose();
    } catch (err) {
      toast.error('Failed to submit dispute. Please try again.');
    }
    setSubmitting(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content dispute-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-primary, #111)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '16px',
          padding: '24px',
          maxWidth: '420px',
          width: '92%',
          margin: '0 auto',
        }}
      >
        <h3 style={{ margin: '0 0 16px', fontSize: '1.1rem', color: 'var(--text-primary, #fff)' }}>
          ⚠ Submit a Dispute
        </h3>

        {/* Target Type */}
        <div style={{ marginBottom: '12px' }}>
          <label
            style={{ display: 'block', fontSize: '0.8rem', color: '#888', marginBottom: '4px' }}
          >
            Dispute Type
          </label>
          <select
            value={targetType}
            onChange={(e) => setTargetType(e.target.value as DisputeTarget)}
            style={{
              width: '100%',
              padding: '10px',
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '8px',
              color: '#fff',
              fontSize: '0.85rem',
            }}
          >
            <option value="agent_settlement">Settlement Payout</option>
            <option value="cashout_request">Cashout Request</option>
            <option value="credit_invoice">Credit Invoice</option>
            <option value="commission_payout">Commission Payout</option>
          </select>
        </div>

        {/* Reference ID (optional) */}
        <div style={{ marginBottom: '12px' }}>
          <label
            style={{ display: 'block', fontSize: '0.8rem', color: '#888', marginBottom: '4px' }}
          >
            Reference ID <span style={{ opacity: 0.5 }}>(optional)</span>
          </label>
          <input
            type="text"
            placeholder="Transaction or settlement ID"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            style={{
              width: '100%',
              padding: '10px',
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '8px',
              color: '#fff',
              fontSize: '0.85rem',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Amount */}
        <div style={{ marginBottom: '12px' }}>
          <label
            style={{ display: 'block', fontSize: '0.8rem', color: '#888', marginBottom: '4px' }}
          >
            Disputed Amount (chips)
          </label>
          <input
            type="number"
            placeholder="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            style={{
              width: '100%',
              padding: '10px',
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '8px',
              color: '#fff',
              fontSize: '0.85rem',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Reason */}
        <div style={{ marginBottom: '16px' }}>
          <label
            style={{ display: 'block', fontSize: '0.8rem', color: '#888', marginBottom: '4px' }}
          >
            Reason
          </label>
          <textarea
            placeholder="Describe the issue..."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            style={{
              width: '100%',
              padding: '10px',
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '8px',
              color: '#fff',
              fontSize: '0.85rem',
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={onClose}
            style={{
              flex: 1,
              padding: '10px',
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '8px',
              color: '#aaa',
              fontWeight: 700,
              fontSize: '0.85rem',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !reason.trim() || !amount}
            style={{
              flex: 1,
              padding: '10px',
              background: submitting ? 'rgba(255,167,38,0.1)' : 'rgba(255,167,38,0.15)',
              border: '1px solid rgba(255,167,38,0.3)',
              borderRadius: '8px',
              color: '#ffa726',
              fontWeight: 700,
              fontSize: '0.85rem',
              cursor: submitting ? 'wait' : 'pointer',
              opacity: submitting || !reason.trim() || !amount ? 0.5 : 1,
            }}
          >
            {submitting ? 'Submitting...' : 'Submit Dispute'}
          </button>
        </div>
      </div>
    </div>
  );
}
