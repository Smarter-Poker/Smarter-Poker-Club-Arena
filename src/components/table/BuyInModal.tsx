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

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface BuyInModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (amount: number, autoRebuy: boolean) => void;
  tableName?: string;
  minBuyIn: number;
  maxBuyIn: number;
  defaultBuyIn?: number;
  accountBalance: number;
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
}: BuyInModalProps) {
  // State
  // Default to MAX buy-in (capped by account balance) — Dan's directive
  const effectiveDefault = defaultBuyIn || Math.min(maxBuyIn, accountBalance);
  const [buyInAmount, setBuyInAmount] = useState(effectiveDefault);
  // Auto-rebuy was removed on 2026-08-20 (see the note in the render below).
  // `onConfirm` keeps its second parameter so callers and the atomic_table_buyin
  // signature are untouched; it is now always false rather than a promise the
  // platform does not keep.
  const autoRebuy = false;
  const [displayAmount, setDisplayAmount] = useState(effectiveDefault);
  const [isConfirmPulsing, setIsConfirmPulsing] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const animationFrameRef = useRef<number>(0);
  const countStartRef = useRef<number>(0);

  // LIVE E2E FIX 2026-08-15: the initial amount was captured by useState at
  // FIRST MOUNT, while accountBalance / blind props were still loading — the
  // modal could open showing a stale, below-minimum default (seen live:
  // 191.24 on a 200-minimum table). Re-derive and clamp the default every
  // time the modal OPENS (and if min/max settle late), from the live props.
  useEffect(() => {
    if (!isOpen) return;
    const fresh = defaultBuyIn || Math.min(maxBuyIn, accountBalance);
    const clamped = Math.max(minBuyIn, Math.min(maxBuyIn, fresh));
    if (Number.isFinite(clamped) && clamped > 0) {
      setBuyInAmount(clamped);
      setDisplayAmount(clamped);
    }
    // Intentionally NOT depending on accountBalance/defaultBuyIn: once open
    // with settled table limits, the player's own slider input must win.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, minBuyIn, maxBuyIn]);

  // Clamp buy-in to valid range
  const clampedBuyIn = useMemo(() => {
    return Math.max(minBuyIn, Math.min(maxBuyIn, buyInAmount));
  }, [buyInAmount, minBuyIn, maxBuyIn]);

  // Calculate slider percentage
  const sliderPercent = useMemo(() => {
    const range = maxBuyIn - minBuyIn;
    return range > 0 ? ((clampedBuyIn - minBuyIn) / range) * 100 : 0;
  }, [clampedBuyIn, minBuyIn, maxBuyIn]);

  // Check if user has enough balance
  const hasEnoughBalance = accountBalance >= clampedBuyIn;

  // Animate amount counter when buyInAmount changes
  useEffect(() => {
    if (!isOpen) return;

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
  }, [clampedBuyIn, isOpen]);

  // Pulse confirm button when ready
  useEffect(() => {
    if (hasEnoughBalance) {
      setIsConfirmPulsing(true);
      const timer = setTimeout(() => setIsConfirmPulsing(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [hasEnoughBalance]);

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
    if (!(maxBuyIn > minBuyIn)) return maxBuyIn;
    const steps = Math.floor((maxBuyIn - minBuyIn) / step);
    return Math.round((minBuyIn + steps * step) * 100) / 100;
  }, [minBuyIn, maxBuyIn, bigBlind]);

  const handleSliderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = Number(e.target.value);
      setBuyInAmount(raw >= sliderGridMax ? maxBuyIn : raw);
    },
    [sliderGridMax, maxBuyIn]
  );

  // Handle quick amount buttons
  const handleQuickAmount = useCallback(
    (multiplier: number) => {
      const amount = Math.min(minBuyIn * multiplier, maxBuyIn);
      setBuyInAmount(amount);
    },
    [minBuyIn, maxBuyIn]
  );

  // Handle confirm
  const handleConfirm = useCallback(async () => {
    if (!hasEnoughBalance || isProcessing) return;
    soundService.playBuyInConfirm();
    setIsProcessing(true);
    try {
      await onConfirm(clampedBuyIn, autoRebuy);
    } catch (err) {
      reportError(err, 'BuyInModal.onConfirm_threw');
    } finally {
      setIsProcessing(false);
    }
  }, [clampedBuyIn, autoRebuy, hasEnoughBalance, isProcessing, onConfirm]);

  if (!isOpen) return null;

  return (
    <div className="buy-in-modal__overlay" onClick={onClose}>
      <div className="buy-in-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="buy-in-modal__header">
          {countdown !== undefined && (
            <span className="buy-in-modal__countdown">{countdown}s (Close)</span>
          )}
          <h2 className="buy-in-modal__title">BUY-IN</h2>
          <button className="buy-in-modal__close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* FIX 136: 2-hour re-entry restriction notice */}
        {cashoutRestriction && cashoutRestriction > 0 && (
          <div
            className="buy-in-modal__restriction-notice"
            style={{
              background: 'rgba(255, 165, 0, 0.15)',
              border: '1px solid rgba(255, 165, 0, 0.4)',
              borderRadius: '8px',
              padding: '8px 12px',
              margin: '0 0 12px 0',
              fontSize: '12px',
              color: '#ffaa33',
              textAlign: 'center',
            }}
          >
            You Cashed Out {formatAmount(cashoutRestriction)} From This Table. Min Buy-In Is{' '}
            {formatAmount(cashoutRestriction)} For 2 Hours.
          </div>
        )}

        {/* Amount Display */}
        <div className="buy-in-modal__amount-display">
          <span className="buy-in-modal__min-label">{formatAmount(minBuyIn, currency)}</span>
          <div className="buy-in-modal__current-amount">
            <span className="buy-in-modal__amount-value">
              {displayAmount.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
          </div>
          <span className="buy-in-modal__max-label">{formatAmount(maxBuyIn, currency)}</span>
        </div>

        {/* Slider */}
        <div className="buy-in-modal__slider-container">
          <input
            type="range"
            className="buy-in-modal__slider"
            min={minBuyIn}
            max={maxBuyIn}
            value={clampedBuyIn}
            onChange={handleSliderChange}
            step={bigBlind}
            style={
              {
                '--slider-percent': `${sliderPercent}%`,
              } as React.CSSProperties
            }
          />
          <div className="buy-in-modal__slider-labels">
            <span>Min</span>
            <span>Max</span>
          </div>
        </div>

        {/* Quick Amounts — FIX 192: labels computed dynamically from actual BB count */}
        <div className="buy-in-modal__quick-amounts">
          <button className="buy-in-modal__quick-btn" onClick={() => handleQuickAmount(1)}>
            {Math.round(minBuyIn / bigBlind)}BB
          </button>
          <button className="buy-in-modal__quick-btn" onClick={() => handleQuickAmount(2)}>
            {Math.round((minBuyIn * 2) / bigBlind)}BB
          </button>
          <button className="buy-in-modal__quick-btn" onClick={() => handleQuickAmount(5)}>
            {Math.round(Math.min(minBuyIn * 5, maxBuyIn) / bigBlind)}BB
          </button>
          <button
            className="buy-in-modal__quick-btn buy-in-modal__quick-btn--max"
            onClick={() => setBuyInAmount(maxBuyIn)}
          >
            MAX
          </button>
        </div>

        {/* Balance Display */}
        <div className="buy-in-modal__balance">
          <span className="buy-in-modal__balance-label">( Account Balance:</span>
          <span
            className={`buy-in-modal__balance-value ${!hasEnoughBalance ? 'buy-in-modal__balance-value--insufficient' : ''}`}
          >
            {formatAmount(accountBalance, currency)}
          </span>
          <span className="buy-in-modal__balance-label">)</span>
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

        {/* Confirm Button */}
        <button
          className={`buy-in-modal__confirm ${!hasEnoughBalance ? 'buy-in-modal__confirm--disabled' : ''} ${isConfirmPulsing ? 'buy-in-modal__confirm--pulse' : ''} ${isProcessing ? 'buy-in-modal__confirm--processing' : ''}`}
          onClick={handleConfirm}
          disabled={!hasEnoughBalance || isProcessing}
        >
          {isProcessing ? 'Joining...' : hasEnoughBalance ? 'Buy Chips' : 'Insufficient Balance'}
        </button>

        {/* Top Up Link.
            2026-08-20: this had no onClick at all. It only renders when the
            player has too little to sit down, so the single moment they need to
            add funds was the one moment the button was inert — and the modal's
            own container calls stopPropagation, so nothing bubbled either. */}
        {!hasEnoughBalance && onTopUp && (
          <button className="buy-in-modal__top-up" onClick={onTopUp}>
            Top Up Account
          </button>
        )}
      </div>
    </div>
  );
}

export default BuyInModal;
