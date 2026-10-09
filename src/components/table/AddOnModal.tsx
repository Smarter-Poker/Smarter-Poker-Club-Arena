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
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useFitText } from '../lobby/game-cards/useFitText';
import './AddOnModal.css';
import { haptic, soundService } from '../../services/SoundService';

// Whole-number tournament money (Dan 2026-08-20).
import { money, moneyExact } from '../../utils/buyIn';
import DiamondsToChipsButton from '../games/DiamondsToChipsButton';
import { TournamentPurchaseNotSubmittedError } from '../../services/TournamentPurchaseIntent';

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
   * Resolve TRUE only for a confirmed receipt. FALSE is unconfirmed, not
   * proof that the wallet was not charged. Before 2026-08-20 this was `Promise<void>` and the parent
   * swallowed its own errors, so the modal announced "Add-On Accepted — +N
   * chips added" on every failed add-on. Required boolean, not `boolean | void`,
   * so reverting the parent to a void handler fails the build.
   */
  onAccept: () => Promise<boolean>;
  onDecline: () => void;
  /**
   * The club whose host runs the Diamond Games (Dan 2026-09-10: a player who
   * cannot cover the add-on is offered the diamonds-to-chips door). Omitted,
   * the door is not offered.
   */
  diamondGamesClubId?: string | null;
  onPlayDiamonds?: (path: string) => void;
}

function secondsUntilAddOnDeadline(endsAtMs: number | null, fallbackSeconds: number): number {
  return Number.isFinite(endsAtMs)
    ? Math.max(0, Math.ceil(((endsAtMs as number) - Date.now()) / 1000))
    : Math.max(0, Math.ceil(fallbackSeconds));
}

function AddOnText({ children }: { children: string }) {
  const ref = useFitText<HTMLSpanElement>(children, 1, 0.5);
  return (
    <span ref={ref} className="addon-console__fit">
      {children}
    </span>
  );
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
  diamondGamesClubId,
  onPlayDiamonds,
}: AddOnModalProps) {
  const dialogRef = useFocusTrap(isVisible, '#addon-title');
  const [countdown, setCountdown] = useState(() =>
    secondsUntilAddOnDeadline(endsAtMs, initialTime)
  );
  const [processing, setProcessing] = useState(false);
  const [decided, setDecided] = useState(false);
  const [result, setResult] = useState<'accepted' | 'declined' | 'unknown' | null>(null);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const processingRef = useRef(false);
  const confirmationNeededRef = useRef(false);
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
      confirmationNeededRef.current = false;
      setProcessing(false);
      return;
    }

    const tick = () => {
      const remaining = secondsUntilAddOnDeadline(endsAtMs, initialTime);
      setCountdown(remaining);
      if (
        remaining > 0 ||
        decidedRef.current ||
        processingRef.current ||
        confirmationNeededRef.current
      )
        return;

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
    const retrying = confirmationNeededRef.current;
    // The confirm sound used to fire BEFORE this guard, so a locked-out or
    // double tap still played "purchase confirmed" at the player.
    if (
      processingRef.current ||
      processing ||
      (!retrying &&
        (decided || !canAfford || secondsUntilAddOnDeadline(endsAtMs, initialTime) <= 0))
    )
      return;
    processingRef.current = true;
    confirmationNeededRef.current = true;
    setFailureMessage(null);
    soundService.playBuyInConfirm();
    haptic.medium();
    setProcessing(true);
    try {
      const ok = (await onAccept()) === true;
      if (timerRef.current) clearInterval(timerRef.current);
      decidedRef.current = true;
      setDecided(true);
      confirmationNeededRef.current = !ok;
      setResult(ok ? 'accepted' : 'unknown');
      if (!ok) {
        setFailureMessage('The Purchase May Have Completed. Retry To Confirm The Same Purchase.');
      }
    } catch (error) {
      if (error instanceof TournamentPurchaseNotSubmittedError) {
        confirmationNeededRef.current = false;
        decidedRef.current = false;
        setDecided(false);
        setResult(null);
        setFailureMessage('The Purchase Was Not Submitted. Please Try Again.');
        return;
      }
      if (timerRef.current) clearInterval(timerRef.current);
      decidedRef.current = true;
      setDecided(true);
      setResult('unknown');
      setFailureMessage('The Purchase May Have Completed. Retry To Confirm The Same Purchase.');
    } finally {
      processingRef.current = false;
      setProcessing(false);
    }
  };

  const handleDecline = () => {
    if (processingRef.current || processing || (decided && !confirmationNeededRef.current)) return;
    haptic.light();
    if (confirmationNeededRef.current) {
      // Closing an unknown result is only presentation dismissal, not a
      // refusal or proof that the original purchase did not complete.
      onDecline();
      return;
    }
    setDecided(true);
    setResult('declined');
    if (timerRef.current) clearInterval(timerRef.current);
    onDecline();
  };

  if (!isVisible) return null;

  const unknown = result === 'unknown';
  const primaryLabel = processing
    ? 'Processing...'
    : unknown
      ? 'Retry Confirmation'
      : priceKnown
        ? `Accept For ${money(totalCost)}`
        : 'Accept Add-On';
  return (
    <div className="addon-console__overlay">
      <section
        ref={dialogRef}
        className="addon-console"
        role="dialog"
        aria-modal="true"
        aria-labelledby="addon-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') handleDecline();
        }}
      >
        <div className="addon-console__canvas">
          <img
            className="addon-console__art"
            alt=""
            aria-hidden="true"
            draggable={false}
            src={`${import.meta.env.BASE_URL}assets/club-buttons/popups/add-on-v2/chassis.png`}
          />
          <button
            type="button"
            className="addon-console__close"
            aria-label="Close Add-On"
            disabled={processing}
            onClick={handleDecline}
          />
          <h2 id="addon-title" tabIndex={-1} className="addon-console__title">
            <AddOnText>Add-On Available</AddOnText>
          </h2>
          <p className="addon-console__subtitle">One Add-On Per Player</p>
          <div className={`addon-console__timer${countdown <= 10 ? ' is-expiring' : ''}`}>
            <strong>{countdown}s</strong>
            <span>Time Remaining</span>
          </div>
          <div className="addon-console__row addon-console__row--cost">
            <span>Add-On Cost</span>
            <strong>
              <AddOnText>{`${moneyExact(addOnCost)} Chips`}</AddOnText>
            </strong>
            {addOnFee > 0 && <small>House Fee: {moneyExact(addOnFee)} Chips</small>}
            <small>Total Charged: {money(totalCost)} Chips</small>
          </div>
          <div className="addon-console__row addon-console__row--chips">
            <span>Chips Received</span>
            <strong>
              <AddOnText>{`+${addOnChips.toLocaleString()} Chips`}</AddOnText>
            </strong>
          </div>
          <div
            className={`addon-console__row addon-console__row--balance${canAfford ? '' : ' is-poor'}`}
          >
            <span>Your Balance</span>
            <strong>
              <AddOnText>{`${money(walletBalance)} Chips`}</AddOnText>
            </strong>
          </div>
          <button
            type="button"
            className="addon-console__plate addon-console__plate--secondary"
            onClick={handleDecline}
            disabled={processing}
          >
            <AddOnText>{unknown || decided ? 'Close' : 'Decline'}</AddOnText>
          </button>
          <button
            type="button"
            className="addon-console__plate addon-console__plate--primary"
            onClick={handleAccept}
            disabled={processing || (unknown ? false : decided || !canAccept)}
          >
            <AddOnText>{primaryLabel}</AddOnText>
          </button>
        </div>
        <div className="addon-console__messages" aria-live="polite">
          {result === 'accepted' && (
            <p>Add-On Accepted - +{addOnChips.toLocaleString()} Chips Added</p>
          )}
          {failureMessage && (
            <p role="alert">
              {unknown && <strong>Add-On Not Confirmed</strong>}
              {failureMessage}
            </p>
          )}
          {!decided && !priceKnown && (
            <p role="alert">Add-On Price Unavailable - Cannot Purchase Right Now</p>
          )}
          {!decided && priceKnown && !canAfford && (
            <p role="alert">Insufficient Balance - You Need {totalCost.toLocaleString()} Chips</p>
          )}
          {!decided && priceKnown && !canAfford && onPlayDiamonds && (
            <DiamondsToChipsButton
              clubId={diamondGamesClubId}
              enabled={isVisible}
              size="compact"
              onGo={onPlayDiamonds}
            />
          )}
        </div>
      </section>
    </div>
  );
}
