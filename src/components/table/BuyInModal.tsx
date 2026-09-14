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
import { SpadeConsole } from '../console/SpadeConsole';
import type { ConsoleBay } from '../console/SpadeConsole';
import './BuyInModal.css';
import { reportError } from '../../utils/errorReporter';

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

  /* REBUILT ON THE FOUR-BAY DECK 2026-09-14 (#ClubArenaConsole). Dan
     2026-09-09: the four-bay deck is the buy-in family's and nobody else's.
     Re-rendered, not rewritten: everything above this line - the default to
     max, the cent-exact clamp, the whole-Diamond rule, the reachable-max
     slider grid, the count-up, the confirm guard and its error copy, the
     recovery path, the Escape handler - is untouched. The amount and the
     vertical slider print in the well; Min, Max, the chosen buy-in and its
     size in blinds print in the four bays; Close and the confirm sit on the
     two plates. The accessible names and literals the tests read are kept:
     role="dialog", aria-modal="true", aria-labelledby="buy-in-modal-title",
     id="buy-in-modal-title", "Buy-In Amount", "Close Buy-In", "( Account
     Balance:", "Retry", "Buy Chips", "Buy In With Diamonds", "Insufficient
     Balance", "Balance Unavailable", "Retry Original Buy-In". */
  const primaryLabel = isProcessing
    ? 'Joining...'
    : recovery
      ? 'Retry Original Buy-In'
      : hasEnoughBalance
        ? wholeDiamonds
          ? 'Buy In With Diamonds'
          : 'Buy Chips'
        : balanceKnown
          ? 'Insufficient Balance'
          : 'Balance Unavailable';
  const primaryDisabled = !canConfirm || isProcessing;
  const bays: ConsoleBay[] = [
    { label: 'Min', value: formatAmount(effectiveMinBuyIn, currency) },
    { label: 'Max', value: formatAmount(maxBuyIn, currency) },
    {
      label: 'Buy-In',
      value: formatAmount(clampedBuyIn, currency),
      ink: recovery ? 'silver' : hasEnoughBalance ? 'green' : balanceKnown ? 'red' : 'muted',
    },
    { label: 'In Blinds', value: bigBlind > 0 ? `${Math.round(clampedBuyIn / bigBlind)}BB` : '' },
  ];
  const quick: { label: string; value: number }[] = [];
  if (!recovery) {
    quick.push({
      label: `${Math.round(effectiveMinBuyIn / bigBlind)}BB`,
      value: effectiveMinBuyIn,
    });
    if (maxBuyIn > effectiveMinBuyIn) {
      const third = effectiveMinBuyIn + (maxBuyIn - effectiveMinBuyIn) * 0.33;
      const twoThirds = effectiveMinBuyIn + (maxBuyIn - effectiveMinBuyIn) * 0.66;
      if (Math.round(third / bigBlind) !== Math.round(effectiveMinBuyIn / bigBlind))
        quick.push({ label: `${Math.round(third / bigBlind)}BB`, value: third });
      if (Math.round(twoThirds / bigBlind) !== Math.round(maxBuyIn / bigBlind))
        quick.push({ label: `${Math.round(twoThirds / bigBlind)}BB`, value: twoThirds });
    }
    quick.push({ label: 'MAX', value: maxBuyIn });
  }

  return (
    <div
      className="bim-overlay"
      onClick={() => {
        if (!confirmInFlightRef.current) onClose();
      }}
    >
      <div
        className="bim-dialog sc-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="buy-in-modal-title"
      >
        {/* The dialog's name, as a literal the felt-reachability test reads. */}
        <h2 id="buy-in-modal-title" className="bim-sr">
          Buy-In
        </h2>
        <SpadeConsole
          as="section"
          family="fourbay"
          eyebrow={tableName || (wholeDiamonds ? 'Diamond Seat' : 'Cash Game')}
          title="Buy-In"
          pill={countdown !== undefined ? `Closes ${countdown}s` : undefined}
          pillInk={countdown !== undefined && countdown <= 10 ? 'red' : 'gold'}
          bays={bays}
          plates={{
            secondary: {
              label: 'Close',
              ink: 'silver',
              disabled: isProcessing,
              'aria-label': 'Close Buy-In',
              onClick: () => {
                if (!confirmInFlightRef.current) onClose();
              },
            },
            primary: {
              label: primaryLabel,
              ink: primaryDisabled ? 'muted' : 'white',
              disabled: primaryDisabled,
              onClick: handleConfirm,
              className: isConfirmPulsing ? 'bim-plate--pulse' : undefined,
            },
          }}
        >
          {/* THE SLIDER GOES UP AND DOWN (Dan 2026-09-05): a horizontal drag inside
              a table is the table-switch gesture. Max at the top, min at the
              bottom, touch-action none so the sheet does not take the drag as a
              scroll. The slider is the one drawn control here: the art paints
              no slider. */}
          <div className="bim-stage">
            <div className="bim-amount">
              <span className="sc-label sc-ink--blue">
                {recovery ? 'Original Buy-In' : 'Buy In For'}
              </span>
              <span className="bim-amount__value sc-ink--silver">
                {displayAmount.toLocaleString('en-US', {
                  minimumFractionDigits: wholeDiamonds ? 0 : 2,
                  maximumFractionDigits: wholeDiamonds ? 0 : 2,
                })}
              </span>
              {!recovery && (
                <div className="bim-quick" role="group" aria-label="Quick Amounts">
                  {quick.map((q) => (
                    <button
                      key={q.label}
                      type="button"
                      className={`bim-quick__word ${clampedBuyIn === q.value ? 'sc-ink--white' : 'sc-ink--muted'}`}
                      onClick={() => setBuyInAmount(q.value)}
                    >
                      {q.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {!recovery && (
              <div className="bim-slider">
                <span className="bim-slider__cap sc-ink--blue">
                  {formatAmount(maxBuyIn, currency)}
                </span>
                <input
                  type="range"
                  className="bim-slider__input"
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
                <span className="bim-slider__cap sc-ink--blue">
                  {formatAmount(effectiveMinBuyIn, currency)}
                </span>
              </div>
            )}
          </div>

          {recovery && !isProcessing && (
            <p role="status" className="sc-copy sc-ink--muted">
              Your {formatAmount(recovery.amount)} Chip Buy-In For Seat {recovery.seat} Needs
              Confirmation. We Will Check It Before Retrying The Same Buy-In.
            </p>
          )}

          {/* Balance Display - the literals are the ones the tests read. */}
          <div className="bim-balance">
            <span className="bim-balance__label sc-ink--muted">
              {wholeDiamonds ? '( Available Diamonds:' : '( Account Balance:'}
            </span>
            <span
              className={`bim-balance__value ${balanceKnown && !hasEnoughBalance ? 'sc-ink--red' : 'sc-ink--silver'}`}
            >
              {balanceKnown ? formatAmount(accountBalance, currency) : 'Unavailable'}
            </span>
            <span className="bim-balance__label sc-ink--muted">)</span>
            {!balanceKnown && onRetryBalance && (
              <button type="button" className="bim-word sc-ink--blue" onClick={onRetryBalance}>
                Retry
              </button>
            )}
          </div>

          {confirmError && !recovery && (
            <p role="alert" className="sc-copy sc-copy--center sc-ink--red">
              {confirmError}
            </p>
          )}

          {/* Top Up: rendered only when the player cannot afford the buy-in, so it
              is the one moment they need it. 2026-08-20: it used to have no onClick. */}
          {!recovery && !hasEnoughBalance && onTopUp && (
            <button
              type="button"
              className="bim-word bim-word--topup sc-ink--blue"
              onClick={onTopUp}
            >
              Top Up Account
            </button>
          )}
        </SpadeConsole>
      </div>
    </div>
  );
}

export default BuyInModal;
