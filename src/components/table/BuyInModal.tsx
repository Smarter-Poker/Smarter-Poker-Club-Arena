/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BUY-IN MODAL — Table Buy-In Interface
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * premium-style buy-in modal with:
 * - Min/Max slider
 * - Quick amount buttons
 * - Auto rebuy toggle
 * - Account balance display
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { haptic, soundService } from '../../services/SoundService';
import './BuyInModal.css';
import { reportError } from '../../utils/errorReporter';
import DiamondsToChipsButton from '../games/DiamondsToChipsButton';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface BuyInModalProps {
  isOpen: boolean;
  recovery?: { amount: number; seat: number } | null;
  onClose: () => void;
  onConfirm: (amount: number, autoRebuy: boolean) => boolean | void | Promise<boolean | void>;
  tableName?: string;
  minBuyIn: number;
  maxBuyIn: number;
  defaultBuyIn?: number;
  /**
   * null = "we could not find out" (Dan 2026-09-04, the bust rebuy that
   * "failed to load"). It used to be collapsed to 0 one file up, so a failed
   * read rendered as INSUFFICIENT BALANCE on a player with chips - a dialog
   * that could not be confirmed and said nothing true. Unknown says unknown,
   * and offers a retry.
   */
  accountBalance: number | null;
  /** Re-read the balance when it is unknown. */
  onRetryBalance?: () => void;
  bigBlind: number;
  currency?: string;
  countdown?: number; // Seconds remaining to buy in
  /** FIX 136: If set, player recently cashed out and must buy in for at least this amount */
  cashoutRestriction?: number;
  /** Takes the player to the cashier. Without it the "Top Up Account" button is not rendered. */
  onTopUp?: () => void;
  /**
   * The club whose host runs the Diamond Games (Dan 2026-09-10). Omitted, the
   * diamonds-to-chips door is not offered.
   */
  diamondGamesClubId?: string | null;
  onPlayDiamonds?: (path: string) => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

// EXACT precision — no abbreviations, no rounding
function formatAmount(amount: number, currency: string = ''): string {
  if (Math.abs(amount - Math.round(amount)) < 0.005) {
    return Math.round(amount).toLocaleString('en-US');
  }
  return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function BuyInModal({
  isOpen,
  recovery,
  onClose,
  onConfirm,
  tableName,
  minBuyIn,
  maxBuyIn,
  defaultBuyIn,
  accountBalance,
  bigBlind,
  currency = '',
  countdown,
  cashoutRestriction,
  onTopUp,
  diamondGamesClubId,
  onPlayDiamonds,
  onRetryBalance,
}: BuyInModalProps) {
  // State
  const wholeDiamonds = currency === 'diamonds';
  const balanceKnown = accountBalance !== null;
  // Default to MAX buy-in (capped by account balance) — Dan's directive.
  // Unknown balance: default to the table max; the confirm stays closed below.
  const effectiveDefault =
    recovery?.amount ??
    (defaultBuyIn || Math.min(maxBuyIn, balanceKnown ? accountBalance : maxBuyIn));
  const [buyInAmount, setBuyInAmount] = useState(effectiveDefault);
  // Auto-rebuy was removed on 2026-08-20 (see the note in the render below).
  // `onConfirm` keeps its second parameter so callers and the atomic_table_buyin
  // signature are untouched; it is now always false rather than a promise the
  // platform does not keep.
  const autoRebuy = false;
  const [displayAmount, setDisplayAmount] = useState(effectiveDefault);
  const [isConfirmPulsing, setIsConfirmPulsing] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const confirmInFlightRef = useRef(false);

  // 60-second kicker visual countdown
  const [timeLeft, setTimeLeft] = useState(60);

  // CHIP CONTINUITY: the server already caps the rejoin floor at max_buy_in
  // (fn_cash_effective_buyin). Mirror the cap anyway so a stale prop can never
  // push the slider's minimum above its maximum.
  const cappedCashoutRestriction = cashoutRestriction ? Math.min(cashoutRestriction, maxBuyIn) : 0;
  const effectiveMinBuyIn =
    cappedCashoutRestriction > minBuyIn ? cappedCashoutRestriction : minBuyIn;
  const animationFrameRef = useRef<number>(0);
  const countStartRef = useRef<number>(0);

  // LIVE E2E FIX 2026-08-15: the initial amount was captured by useState at
  // FIRST MOUNT, while accountBalance / blind props were still loading — the
  // modal could open showing a stale, below-minimum default (seen live:
  // 191.24 on a 200-minimum table). Re-derive and clamp the default every
  // time the modal OPENS (and if min/max settle late), from the live props.
  useEffect(() => {
    if (!isOpen) return;
    const fresh =
      recovery?.amount ??
      (defaultBuyIn || Math.min(maxBuyIn, balanceKnown ? accountBalance : maxBuyIn));
    const clamped = recovery?.amount ?? Math.max(minBuyIn, Math.min(maxBuyIn, fresh));
    if (Number.isFinite(clamped) && clamped > 0) {
      setBuyInAmount(clamped);
      setDisplayAmount(clamped);
    }
    // Intentionally NOT depending on accountBalance/defaultBuyIn: once open
    // with settled table limits, the player's own slider input must win.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, minBuyIn, maxBuyIn, recovery?.amount]);

  /* Clamp buy-in to valid range, TO THE CENT (2026-09-09).
     `CashBuyInRecovery.validIntent` refuses any amount where
     `Math.round(x*100)/100 !== x`, and TablePage surfaces that refusal as
     "Unable To Start Your Buy-In. Please Try Again." The 33%/66% presets
     below are `min + (max - min) * 0.33`, which on ordinary stakes is a
     float artifact (min 40 / max 137.50 -> 72.17500000000001), so pressing
     the 66BB button could not seat the player at all, repeatably. Rounding
     here covers the presets, the slider and the typed value in one place -
     which is what the comment beside the bust rebuy already claimed was
     true of this component. */
  const clampedBuyIn = useMemo(() => {
    const raw = recovery?.amount ?? Math.max(effectiveMinBuyIn, Math.min(maxBuyIn, buyInAmount));
    return recovery ? raw : wholeDiamonds ? Math.round(raw) : Math.round(raw * 100) / 100;
  }, [buyInAmount, effectiveMinBuyIn, maxBuyIn, recovery?.amount, wholeDiamonds]);

  // Calculate slider percentage
  const sliderPercent = useMemo(() => {
    const range = maxBuyIn - effectiveMinBuyIn;
    return range > 0 ? ((clampedBuyIn - effectiveMinBuyIn) / range) * 100 : 0;
  }, [clampedBuyIn, effectiveMinBuyIn, maxBuyIn]);

  // Check if user has enough balance. Unknown is not enough - and not "insufficient".
  const hasEnoughBalance = balanceKnown && accountBalance >= clampedBuyIn;
  const canConfirm =
    (!!recovery || hasEnoughBalance) && (!wholeDiamonds || Number.isSafeInteger(clampedBuyIn));

  // Animate amount counter when buyInAmount changes
  useEffect(() => {
    if (!isOpen) return;

    if (recovery) {
      setDisplayAmount(recovery.amount);
      return;
    }
    countStartRef.current = displayAmount;
    const startTime = Date.now();
    const duration = 400;

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(1, elapsed / duration);

      // Easing function for smooth spring-like animation
      const easeOut = 1 - Math.pow(1 - progress, 3);
      const current = countStartRef.current + (clampedBuyIn - countStartRef.current) * easeOut;

      setDisplayAmount(current);

      if (progress < 1) {
        animationFrameRef.current = requestAnimationFrame(animate);
      }
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [clampedBuyIn, isOpen, recovery?.amount]);

  // Pulse confirm button when ready
  useEffect(() => {
    if (hasEnoughBalance) {
      setIsConfirmPulsing(true);
      const timer = setTimeout(() => setIsConfirmPulsing(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [hasEnoughBalance]);

  /**
   * ESCAPE CLOSES THE SHEET (2026-08-28). Before this, the ONLY way out was
   * clicking the backdrop — unreachable by keyboard, and easy to miss on a
   * phone where the sheet fills the screen. Attached only while open so it
   * cannot swallow Escape for whatever is behind it, and it does not fire
   * mid-buy-in: a confirm already in flight must not be abandoned halfway.
   */
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (isProcessing) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, isProcessing, onClose]);

  /**
   * 2026-08-20: the MAX BUY-IN was not reachable by dragging.
   *
   * `<input type="range">` only emits values on the grid `min + n*step`, and
   * this slider is `min={minBuyIn} max={maxBuyIn} step={bigBlind}`. A table's
   * min/max are whole multiples of the blind, so on paper the grid lands
   * exactly on max — but `maxBuyIn` is routinely NOT the table maximum: it is
   * clamped to what the player can actually afford. A balance of 137.50 at a
   * 1/2 table gives max 137.50 against min 40, and the slider tops out at
   * 136 — the player cannot buy in for everything they have, and the label
   * right above the slider says 137.50.
   *
   * Same fix as the raise slider: keep the step grid, and treat the last grid
   * position as the true maximum.
   */
  const sliderGridMax = useMemo(() => {
    const step = bigBlind || 1;
    if (!(maxBuyIn > effectiveMinBuyIn)) return maxBuyIn;
    const steps = Math.floor((maxBuyIn - effectiveMinBuyIn) / step);
    return Math.round((effectiveMinBuyIn + steps * step) * 100) / 100;
  }, [effectiveMinBuyIn, maxBuyIn, bigBlind]);

  const handleSliderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = Number(e.target.value);
      setBuyInAmount(raw >= sliderGridMax ? maxBuyIn : raw);
    },
    [sliderGridMax, maxBuyIn]
  );

  // Handle confirm
  const handleConfirm = useCallback(async () => {
    if (!canConfirm || isProcessing) return;
    if (confirmInFlightRef.current) return;
    confirmInFlightRef.current = true;
    setConfirmError(null);
    setIsProcessing(true);
    try {
      try {
        soundService.playBuyInConfirm();
      } catch (audioError) {
        reportError(audioError, 'BuyInModal.confirm_sound_failed');
      }
      const confirmed = await onConfirm(clampedBuyIn, autoRebuy);
      if (confirmed === false) {
        setConfirmError('Buy-In Not Yet Confirmed.');
      }
    } catch (err) {
      reportError(err, 'BuyInModal.onConfirm_threw');
      setConfirmError('Unable To Confirm Your Buy-In. Please Check Your Connection And Try Again.');
    } finally {
      confirmInFlightRef.current = false;
      setIsProcessing(false);
    }
  }, [clampedBuyIn, autoRebuy, canConfirm, isProcessing, onConfirm]);

  if (!isOpen) return null;

  return (
    /**
     * ACCESSIBILITY 2026-08-28. This is the modal every player passes through
     * to sit down, and it had no dialog semantics at all: no role, no
     * aria-modal, no accessible name, and no Escape handler — the backdrop
     * click was the only way out, which is not reachable by keyboard. The
     * overlay must not be aria-hidden: that would hide the dialog and its
     * error messages from assistive technology too.
     */
    <div
      className="buy-in-modal__overlay"
      onClick={() => {
        if (!confirmInFlightRef.current) onClose();
      }}
    >
      <div
        className="buy-in-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="buy-in-modal-title"
      >
        {/* Header */}
        <div className="buy-in-modal__header">
          {countdown !== undefined && (
            <span className="buy-in-modal__countdown">{countdown}s (Close)</span>
          )}
          <h2 className="buy-in-modal__title" id="buy-in-modal-title">
            BUY-IN
          </h2>
          <button
            className="buy-in-modal__close"
            disabled={isProcessing}
            onClick={() => {
              if (!confirmInFlightRef.current) onClose();
            }}
            aria-label="Close Buy-In"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        {/* CHIP CONTINUITY (OPORD 1.3 section 6.1): when a rejoin floor applies
            the minimum is simply higher. No notice, no paragraph about why. */}

        {/**
         * THE SLIDER GOES UP AND DOWN (Dan 2026-09-05)
         *
         * "THE SLIDER FOR ADJUSTING YOUR 'BUY IN' NEEDS TO GO UP AND DOWN, NOT
         * SIDE TO SIDE. (SIDE TO SIDE SWIPES THE PAGE) REDESIGN THIS PLEASE."
         *
         * A horizontal drag inside a table is a table-switch gesture, so the
         * one control a player MUST use to sit down was competing with the
         * navigation for every touch - and losing, because a swipe that starts
         * on a 6px-high track is a swipe long before it is a drag. Turning the
         * track vertical takes the control out of that axis entirely, which is
         * a fix by construction rather than by tuning a threshold.
         *
         * `touch-action: none` on the input (CSS) is the other half: it stops
         * the browser handing the vertical drag to the sheet as a scroll.
         *
         * The min and max were labels either side of the amount and the words
         * "Min"/"Max" under the track - four things saying two. They are the
         * ends of the track now: max at the top where the thumb reaches it,
         * min at the bottom. Nothing about the value, the step grid or the
         * MAX-is-reachable fix above changes.
         */}
        <div className="buy-in-modal__stage">
          <div className="buy-in-modal__current-amount">
            <span className="buy-in-modal__amount-value">
              {displayAmount.toLocaleString('en-US', {
                minimumFractionDigits: wholeDiamonds ? 0 : 2,
                maximumFractionDigits: wholeDiamonds ? 0 : 2,
              })}
            </span>
          </div>

          {!recovery && (
            <div className="buy-in-modal__slider-container">
              <span className="buy-in-modal__slider-cap">{formatAmount(maxBuyIn, currency)}</span>
              <input
                type="range"
                className="buy-in-modal__slider"
                min={effectiveMinBuyIn}
                max={maxBuyIn}
                value={clampedBuyIn}
                onChange={handleSliderChange}
                step={bigBlind}
                aria-label="Buy-In Amount"
                aria-orientation="vertical"
                style={
                  {
                    '--slider-percent': `${sliderPercent}%`,
                  } as React.CSSProperties
                }
              />
              <span className="buy-in-modal__slider-cap">
                {formatAmount(effectiveMinBuyIn, currency)}
              </span>
            </div>
          )}
        </div>
            {!recovery && !hasEnoughBalance && balanceKnown && onPlayDiamonds && (
              <div className="buy-in-modal__diamonds-door">
                <DiamondsToChipsButton
                  clubId={diamondGamesClubId}
                  enabled={isOpen && !isProcessing}
                  size="compact"
                  onGo={onPlayDiamonds}
                />
              </div>
            )}

        {/* Quick Amounts dynamically scale the interval between min and max */}
        {!recovery && (
          <div className="buy-in-modal__quick-amounts">
            <button
              className="buy-in-modal__quick-btn"
              onClick={() => setBuyInAmount(effectiveMinBuyIn)}
            >
              {Math.round(effectiveMinBuyIn / bigBlind)}BB
            </button>
            {maxBuyIn > effectiveMinBuyIn && (
              <>
                {Math.round(
                  (effectiveMinBuyIn + (maxBuyIn - effectiveMinBuyIn) * 0.33) / bigBlind
                ) !== Math.round(effectiveMinBuyIn / bigBlind) && (
                  <button
                    className="buy-in-modal__quick-btn"
                    onClick={() =>
                      setBuyInAmount(effectiveMinBuyIn + (maxBuyIn - effectiveMinBuyIn) * 0.33)
                    }
                  >
                    {Math.round(
                      (effectiveMinBuyIn + (maxBuyIn - effectiveMinBuyIn) * 0.33) / bigBlind
                    )}
                    BB
                  </button>
                )}
                {Math.round(
                  (effectiveMinBuyIn + (maxBuyIn - effectiveMinBuyIn) * 0.66) / bigBlind
                ) !== Math.round(maxBuyIn / bigBlind) && (
                  <button
                    className="buy-in-modal__quick-btn"
                    onClick={() =>
                      setBuyInAmount(effectiveMinBuyIn + (maxBuyIn - effectiveMinBuyIn) * 0.66)
                    }
                  >
                    {Math.round(
                      (effectiveMinBuyIn + (maxBuyIn - effectiveMinBuyIn) * 0.66) / bigBlind
                    )}
                    BB
                  </button>
                )}
              </>
            )}
            <button
              className="buy-in-modal__quick-btn buy-in-modal__quick-btn--max"
              onClick={() => setBuyInAmount(maxBuyIn)}
            >
              MAX
            </button>
          </div>
        )}

        {recovery && !isProcessing && (
          <p role="status">
            Your {formatAmount(recovery.amount)} Chip Buy-In For Seat {recovery.seat} Needs
            Confirmation. We Will Check It Before Retrying The Same Buy-In.
          </p>
        )}

        {/* Balance Display */}
        <div className="buy-in-modal__balance">
          <span className="buy-in-modal__balance-label">
            {wholeDiamonds ? '( Available Diamonds:' : '( Account Balance:'}
          </span>
          <span
            className={`buy-in-modal__balance-value ${balanceKnown && !hasEnoughBalance ? 'buy-in-modal__balance-value--insufficient' : ''}`}
          >
            {balanceKnown ? formatAmount(accountBalance, currency) : 'Unavailable'}
          </span>
          <span className="buy-in-modal__balance-label">)</span>
          {!balanceKnown && onRetryBalance && (
            <button type="button" className="buy-in-modal__balance-retry" onClick={onRetryBalance}>
              Retry
            </button>
          )}
        </div>

        {/* AUTO REBUY REMOVED 2026-08-20.
            The checkbox told the player: "When your stack drops to 50% of the
            initial buy-in, it will be automatically replenished." Nothing
            implemented that. `atomic_table_buyin` writes `table_seats.auto_rebuy`
            and NO code anywhere — SQL function, engine, or client — ever reads
            the column back; verified in production, 0 of 38,390 seat rows had it
            set. The one server-side auto-rebuy path is horse-only and its body is
            an explicit no-op. The threshold was a hardcoded `50` whose setter had
            no call sites.
            So a player could tick it, bust, and sit at zero waiting for a top-up
            that was never coming. Promising to protect someone's seat and then
            not doing it is worse than not offering it. If this is wanted, it
            needs a real server-side implementation and a product decision about
            automatically spending a player's wallet while they are away. */}

        {confirmError && !recovery && (
          <p role="alert" className="buy-in-modal__balance-value--insufficient">
            {confirmError}
          </p>
        )}

        {/* Confirm Button */}
        <button
          className={`buy-in-modal__confirm ${!canConfirm ? 'buy-in-modal__confirm--disabled' : ''} ${isConfirmPulsing ? 'buy-in-modal__confirm--pulse' : ''} ${isProcessing ? 'buy-in-modal__confirm--processing' : ''}`}
          onClick={handleConfirm}
          disabled={!canConfirm || isProcessing}
        >
          {isProcessing
            ? 'Joining...'
            : recovery
              ? 'Retry Original Buy-In'
              : hasEnoughBalance
                ? wholeDiamonds
                  ? 'Buy In With Diamonds'
                  : 'Buy Chips'
                : balanceKnown
                  ? 'Insufficient Balance'
                  : 'Balance Unavailable'}
        </button>

        {/* Top Up Link.
            2026-08-20: this had no onClick at all. It only renders when the
            player has too little to sit down, so the single moment they need to
            add funds was the one moment the button was inert — and the modal's
            own container calls stopPropagation, so nothing bubbled either. */}
        {!recovery && !hasEnoughBalance && onTopUp && (
          <button className="buy-in-modal__top-up" onClick={onTopUp}>
            Top Up Account
          </button>
        )}
      </div>
    </div>
  );
}

export default BuyInModal;
