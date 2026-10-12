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
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useDialogEscape } from '../../hooks/useDialogEscape';
import { SpadeConsole } from '../console/SpadeConsole';
import styles from './DisputeSubmitModal.module.css';

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

  const dialogRef = useFocusTrap<HTMLDivElement>(isOpen, '#dispute-type');
  useDialogEscape(isOpen, () => {
    if (!submitLockRef.current) onClose();
  });
  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

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
    <div
      className={styles.overlay}
      onClick={closeIfIdle}
      role="dialog"
      aria-modal="true"
      aria-label="Submit A Dispute"
      aria-labelledby="dispute-title"
    >
      <div ref={dialogRef} className={styles.modal} onClick={(event) => event.stopPropagation()}>
        <SpadeConsole
          title="Submit A Dispute"
          titleId="dispute-title"
          eyebrow="Club Support"
          pill={submitting ? 'Submitting' : 'Draft'}
          onClose={closeIfIdle}
          plates={{
            secondary: { label: 'Cancel', onClick: closeIfIdle, disabled: submitting },
            primary: {
              label: submitting ? 'Submitting...' : 'Submit Dispute',
              onClick: handleSubmit,
              disabled: submitting || !reason.trim() || !amount,
            },
          }}
        >
          <div className={styles.fields}>
            <label className={styles.field} htmlFor="dispute-type">
              <span className="sc-label">Dispute Type</span>
              <select
                id="dispute-type"
                value={targetType}
                onChange={(event) => setTargetType(event.target.value as DisputeTarget)}
                className={styles.input}
                disabled={submitting}
              >
                <option value="agent_settlement">Settlement Payout</option>
                <option value="cashout_request">Cashout Request</option>
                <option value="credit_invoice">Credit Invoice</option>
                <option value="commission_payout">Commission Payout</option>
              </select>
            </label>
            <label className={styles.field} htmlFor="dispute-reference">
              <span className="sc-label">Reference ID (Optional)</span>
              <input
                id="dispute-reference"
                type="text"
                placeholder="Transaction Or Settlement ID"
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
                className={styles.input}
                disabled={submitting}
              />
            </label>
            <label className={styles.field} htmlFor="dispute-amount">
              <span className="sc-label">Disputed Amount (Chips)</span>
              <input
                id="dispute-amount"
                type="number"
                inputMode="decimal"
                placeholder="0"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className={styles.input}
                disabled={submitting}
              />
            </label>
            <label className={styles.field} htmlFor="dispute-reason">
              <span className="sc-label">Reason</span>
              <textarea
                id="dispute-reason"
                placeholder="Describe The Issue..."
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                className={styles.input}
                disabled={submitting}
              />
            </label>
          </div>
        </SpadeConsole>
      </div>
    </div>
  );
}
