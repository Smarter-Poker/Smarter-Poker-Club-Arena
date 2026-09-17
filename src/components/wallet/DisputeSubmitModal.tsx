/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DISPUTE SUBMIT MODAL — Player-facing Dispute Submission
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef } from 'react';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useToast } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';
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
  const isMounted = useIsMounted();

  const [targetType, setTargetType] = useState<DisputeTarget>(
    defaultTargetType || 'agent_settlement'
  );
  const [targetId, setTargetId] = useState(defaultTargetId || '');
  const [amount, setAmount] = useState(defaultAmount?.toString() || '');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  /** Same synchronous double-tap guard as the cashout sheet. */
  const submitLockRef = useRef(false);

  /**
   * THE FORM WAS STICKY ACROSS OPENS.
   *
   * These four pieces of state are seeded from props ONCE, at first mount, and
   * the component is kept mounted between opens (`isOpen` only short-circuits
   * the render). So launching the dispute sheet from transaction A, closing it,
   * and launching it from transaction B showed A's reference id and A's amount
   * over B's dispute - and a successful submit left the old reason sitting in
   * the box for whatever the player disputed next. Re-seeding on the opening
   * edge is what makes the props mean what they say.
   */
  useEffect(() => {
    if (!isOpen) return;
    setTargetType(defaultTargetType || 'agent_settlement');
    setTargetId(defaultTargetId || '');
    setAmount(defaultAmount?.toString() || '');
    setReason('');
    setSubmitting(false);
    submitLockRef.current = false;
  }, [isOpen, defaultTargetType, defaultTargetId, defaultAmount]);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    if (submitLockRef.current) return;
    if (!user?.id) {
      toast.error('Please log in to submit a dispute');
      return;
    }
    if (!reason.trim()) {
      toast.error('Please provide a reason for the dispute');
      return;
    }
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      toast.error('Please enter a valid amount');
      return;
    }

    submitLockRef.current = true;
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
      // The failure used to be swallowed entirely: the player got a friendly
      // line and nobody, in error reporting or anywhere else, ever learned that disputes
      // were failing to file.
      reportError(err, 'DisputeSubmitModal.handleSubmit', { clubId, targetType });
      toast.error('Failed to submit dispute. Please try again.');
    }
    submitLockRef.current = false;
    if (isMounted.current) setSubmitting(false);
  };

  /** Closing mid-submit hides the outcome without stopping it. */
  const closeIfIdle = () => {
    if (submitLockRef.current) return;
    onClose();
  };

  return (
    /**
     * THE OVERLAY LAYOUT IS PINNED INLINE ON PURPOSE.
     *
     * This component imports no stylesheet of its own, so `.modal-overlay`
     * resolved to whichever definition happened to be in the bundle:
     * common/Modal.css says `position: absolute` with no centering, because it
     * is designed to sit inside a `.modal-portal` that this component does not
     * have; wallet/CashoutRequestModal.css says `position: fixed` with
     * `align-items: flex-end`, which turns this dialog into a bottom sheet.
     * Whether a dispute appeared centred, at the bottom, or glued to some
     * ancestor's box depended on which OTHER component's CSS had been loaded.
     *
     * Inline styles beat both, so the layout is now the same every time. The
     * class name stays for any global z-index or backdrop rule that keys off it.
     */
    <div
      className="modal-overlay"
      onClick={closeIfIdle}
      role="dialog"
      aria-modal="true"
      aria-label="Submit A Dispute"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
        background: 'rgba(0,0,0,0.72)',
        zIndex: 1000,
      }}
    >
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
          // Four fields plus a textarea plus two buttons does not fit a 375px
          // phone in landscape, and the panel had no scroll of its own: the
          // Submit button simply sat below the fold with nothing to scroll.
          maxHeight: '90vh',
          overflowY: 'auto',
          boxSizing: 'border-box',
        }}
      >
        <h3 style={{ margin: '0 0 16px', fontSize: '1.1rem', color: 'var(--text-primary, #fff)' }}>
          ⚠ Submit A Dispute
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
            Reference ID <span style={{ opacity: 0.5 }}>(Optional)</span>
          </label>
          <input
            type="text"
            placeholder="Transaction Or Settlement ID"
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
            Disputed Amount (Chips)
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
            placeholder="Describe The Issue..."
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
            onClick={closeIfIdle}
            disabled={submitting}
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
