/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT ADD-ON MODAL - Persisted Add-On Window
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Displays to all tournament players when the add-on period starts
 * after re-entry closes (or from sit-down for Free Buy events).
 * Shows add-on cost, chips received, wallet balance, and countdown timer.
 */

import { useState, useEffect, useRef } from 'react';
import { haptic, soundService } from '../../services/SoundService';

import { safeErrorMessage } from '../../utils/safeErrorMessage';
// Whole-number tournament money (Dan 2026-08-20).
import { money, moneyExact } from '../../utils/buyIn';
import { SpadeConsole, type ConsoleBay } from '../console/SpadeConsole';
import './AddOnModal.css';

interface AddOnModalProps {
  isVisible: boolean;
  /** Base add-on cost — the part that feeds the prize pool. */
  addOnCost: number;
  /**
   * House fee charged ON TOP of addOnCost (10% by default). The modal used to
   * be unaware of it and quoted the base only, while processAddOn debits
   * base + fee.
   */
  addOnFee?: number;
  addOnChips: number;
  walletBalance: number;
  /** Absolute server-persisted deadline, in epoch milliseconds. */
  endsAtMs?: number | null;
  timeRemaining: number; // seconds
  /**
   * Resolve TRUE when the chips were actually added, FALSE when the purchase
   * was refused. Before 2026-08-20 this was `Promise<void>` and the parent
   * swallowed its own errors, so the modal announced "Add-On Accepted — +N
   * chips added" on every failed add-on. Required boolean, not `boolean | void`,
   * so reverting the parent to a void handler fails the build.
   */
  onAccept: () => Promise<boolean>;
  onDecline: () => void;
}

function secondsUntilAddOnDeadline(endsAtMs: number | null, fallbackSeconds: number): number {
  return Number.isFinite(endsAtMs)
    ? Math.max(0, Math.ceil(((endsAtMs as number) - Date.now()) / 1000))
    : Math.max(0, Math.ceil(fallbackSeconds));
}

export default function AddOnModal({
  isVisible,
  addOnCost,
  addOnFee = 0,
  addOnChips,
  walletBalance,
  endsAtMs = null,
  timeRemaining: initialTime,
  onAccept,
  onDecline,
}: AddOnModalProps) {
  const [countdown, setCountdown] = useState(() =>
    secondsUntilAddOnDeadline(endsAtMs, initialTime)
  );
  const [processing, setProcessing] = useState(false);
  const [decided, setDecided] = useState(false);
  const [result, setResult] = useState<'accepted' | 'declined' | 'insufficient' | 'failed' | null>(
    null
  );
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const processingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onDeclineRef = useRef(onDecline);
  onDeclineRef.current = onDecline;
  const decidedRef = useRef(false);

  // Add-ons are currently unraked, but preserve exact cents if a historical
  // row supplies a split. Adding before formatting prevents component-wise
  // rounding from inventing a higher charge.
  const totalCost = Math.round((Number(addOnCost) + Number(addOnFee)) * 100) / 100;
  // Gate on the TOTAL, and never on a zero price. `addOnCost` is fed from a
  // realtime broadcast that defaults it to 0 when the field is missing; a 0
  // price made canAfford unconditionally true and let players buy at a price
  // the modal never actually showed them.
  const priceKnown = totalCost > 0;
  const canAfford = priceKnown && walletBalance >= totalCost;
  const canAccept = canAfford && countdown > 0;

  useEffect(() => {
    if (!isVisible) {
      setDecided(false);
      decidedRef.current = false;
      setResult(null);
      setFailureMessage(null);
      processingRef.current = false;
      setProcessing(false);
      return;
    }

    decidedRef.current = false;
    const tick = () => {
      const remaining = secondsUntilAddOnDeadline(endsAtMs, initialTime);
      setCountdown(remaining);
      if (remaining > 0 || decidedRef.current) return;

      // The persisted deadline expired - auto-decline exactly once. Deriving
      // from Date.now() avoids extending the offer when browser timers were
      // throttled while the tab was in the background.
      decidedRef.current = true;
      setDecided(true);
      setResult('declined');
      if (timerRef.current) clearInterval(timerRef.current);
      onDeclineRef.current();
    };
    tick();
    if (!decidedRef.current) timerRef.current = setInterval(tick, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isVisible, initialTime, endsAtMs]);

  const handleAccept = async () => {
    // The confirm sound used to fire BEFORE this guard, so a locked-out or
    // double tap still played "purchase confirmed" at the player.
    if (
      processingRef.current ||
      processing ||
      decided ||
      !canAfford ||
      secondsUntilAddOnDeadline(endsAtMs, initialTime) <= 0
    )
      return;
    processingRef.current = true;
    soundService.playBuyInConfirm();
    haptic.medium();
    setProcessing(true);
    try {
      const ok = await onAccept();
      if (timerRef.current) clearInterval(timerRef.current);
      setDecided(true);
      setResult(ok ? 'accepted' : 'failed');
      if (!ok) {
        setFailureMessage('The add-on was not completed. Your wallet was not charged.');
      }
    } catch (err: any) {
      if (timerRef.current) clearInterval(timerRef.current);
      setDecided(true);
      if (err?.message?.includes('Insufficient')) {
        setResult('insufficient');
      } else {
        setResult('failed');
        setFailureMessage(
          safeErrorMessage(err, 'The add-on was not completed. Your wallet was not charged.')
        );
      }
    } finally {
      processingRef.current = false;
      setProcessing(false);
    }
  };

  const handleDecline = () => {
    if (processingRef.current || processing || decided) return;
    haptic.light();
    setDecided(true);
    setResult('declined');
    if (timerRef.current) clearInterval(timerRef.current);
    onDecline();
  };

  if (!isVisible) return null;

  /* #ClubArenaConsole (2026-09-14): the add-on wears the four-bay deck. Dan
     2026-09-09: the four-bay deck is the buy-in family's and nobody else's,
     and an add-on is a buy-in. Re-rendered, not rewritten: the persisted
     deadline, the once-only auto-decline, the total gate, the zero-price
     refusal, the sound-after-guard accept and the honest outcome are as they
     were. The clock prints as the pill, the chips as the figure on the glass,
     the receipt - cost, fee, total, balance - in the four bays, Decline and
     Accept on the two plates. Once a decision is in, the outcome prints on the
     glass and the Decline plate reads Close: before, a failed add-on left a
     sheet with no way out. The strings the tests read are kept: the bare
     "<n>s" clock, "Accept For <total>", "Accept Add-On", "You Need <total>
     Chips", "Price Unavailable", "Add-On Failed" as an alert, "Add-On
     Accepted". */
  const bays: ConsoleBay[] = [
    { label: 'Add-On Cost', value: priceKnown ? moneyExact(addOnCost) : '-' },
    { label: 'House Fee', value: priceKnown ? moneyExact(addOnFee) : '-' },
    { label: 'Total Charged', value: priceKnown ? money(totalCost) : '-', ink: 'white' },
    {
      label: 'Your Balance',
      value: walletBalance.toLocaleString(),
      ink: !priceKnown ? 'silver' : canAfford ? 'silver' : 'red',
    },
  ];
  const acceptLabel = processing
    ? 'Processing...'
    : priceKnown
      ? `Accept For ${totalCost.toLocaleString()}`
      : 'Accept Add-On';

  return (
    <div className="aom-overlay">
      <div
        className="aom-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-on-modal-title"
      >
        <SpadeConsole
          family="fourbay"
          eyebrow="Re-Entry Period Has Ended"
          title="Add-On"
          titleId="add-on-modal-title"
          pill={`${countdown}s`}
          pillInk={countdown <= 10 ? 'red' : 'green'}
          bays={bays}
          plates={{
            secondary: {
              label: decided ? 'Close' : 'Decline',
              onClick: decided ? onDecline : handleDecline,
              disabled: processing,
            },
            primary: {
              label: acceptLabel,
              ink: canAccept && !decided ? 'white' : 'muted',
              onClick: handleAccept,
              disabled: !canAccept || processing || decided,
            },
          }}
        >
          {!decided ? (
            <div className="aom-stage">
              <span className="sc-label sc-ink--blue">Chips Received</span>
              <span className="aom-figure">
                <span className="aom-figure__value sc-ink--green">
                  +{addOnChips.toLocaleString()}
                </span>
                <span className="aom-figure__unit sc-ink--muted">Chips</span>
              </span>
              {!priceKnown && (
                <p className="sc-copy sc-copy--center sc-ink--red aom-note">
                  Add-On Price Unavailable - Cannot Purchase Right Now
                </p>
              )}
              {priceKnown && !canAfford && (
                <p className="sc-copy sc-copy--center sc-ink--red aom-note">
                  Insufficient Balance - You Need {totalCost.toLocaleString()} Chips
                </p>
              )}
            </div>
          ) : (
            <div className="aom-stage aom-stage--result">
              {result === 'accepted' && (
                <p className="sc-copy sc-copy--center sc-ink--green aom-result">
                  Add-On Accepted - +{addOnChips.toLocaleString()} Chips Added
                </p>
              )}
              {result === 'declined' && (
                <p className="sc-copy sc-copy--center sc-ink--muted aom-result">Add-On Declined</p>
              )}
              {result === 'insufficient' && (
                <p className="sc-copy sc-copy--center sc-ink--red aom-result">
                  Insufficient Balance - Add-On Denied
                </p>
              )}
              {result === 'failed' && (
                <div className="aom-result" role="alert">
                  <p className="sc-copy sc-copy--center sc-ink--red">Add-On Failed</p>
                  {failureMessage && (
                    <p className="sc-copy sc-copy--center sc-ink--muted aom-result__detail">
                      {failureMessage}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </SpadeConsole>
      </div>
    </div>
  );
}
