/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BUY-IN MODAL — Table Buy-In Interface
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PokerBros-style buy-in modal with:
 * - Min/Max slider
 * - Quick amount buttons
 * - Auto rebuy toggle
 * - Account balance display
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { haptic } from '../../services/SoundService';
import './BuyInModal.css';

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
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

// EXACT precision — no abbreviations, no rounding
function formatAmount(amount: number, currency: string = ''): string {
  return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
}: BuyInModalProps) {
  // State
  const [buyInAmount, setBuyInAmount] = useState(defaultBuyIn || Math.min(minBuyIn * 2, maxBuyIn));
  const [autoRebuy, setAutoRebuy] = useState(false);
  const [rebuyThreshold, setRebuyThreshold] = useState(0);
  const [displayAmount, setDisplayAmount] = useState(
    defaultBuyIn || Math.min(minBuyIn * 2, maxBuyIn)
  );
  const [isConfirmPulsing, setIsConfirmPulsing] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const animationFrameRef = useRef<number>(0);
  const countStartRef = useRef<number>(0);

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

  // Handle slider change
  const handleSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setBuyInAmount(Number(e.target.value));
  }, []);

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
    haptic.medium();
    setIsProcessing(true);
    try {
      await onConfirm(clampedBuyIn, autoRebuy);
    } catch (err) {
      console.error('[BuyInModal] onConfirm threw:', err);
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
            <span className="buy-in-modal__chip-icon">◉</span>
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

        {/* Quick Amounts */}
        <div className="buy-in-modal__quick-amounts">
          <button className="buy-in-modal__quick-btn" onClick={() => handleQuickAmount(1)}>
            20BB
          </button>
          <button className="buy-in-modal__quick-btn" onClick={() => handleQuickAmount(2)}>
            40BB
          </button>
          <button className="buy-in-modal__quick-btn" onClick={() => handleQuickAmount(5)}>
            100BB
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

        {/* Auto Rebuy */}
        <div className="buy-in-modal__auto-rebuy">
          <label className="buy-in-modal__toggle">
            <input
              type="checkbox"
              checked={autoRebuy}
              onChange={(e) => setAutoRebuy(e.target.checked)}
            />
            <span className="buy-in-modal__toggle-slider" />
            <span className="buy-in-modal__toggle-label">Auto Rebuy</span>
          </label>
          <p className="buy-in-modal__auto-rebuy-info">
            When your stack drops to <strong>{rebuyThreshold}%</strong> of the initial buy-in, it
            will be automatically replenished.
          </p>
        </div>

        {/* Confirm Button */}
        <button
          className={`buy-in-modal__confirm ${!hasEnoughBalance ? 'buy-in-modal__confirm--disabled' : ''} ${isConfirmPulsing ? 'buy-in-modal__confirm--pulse' : ''} ${isProcessing ? 'buy-in-modal__confirm--processing' : ''}`}
          onClick={handleConfirm}
          disabled={!hasEnoughBalance || isProcessing}
        >
          {isProcessing ? 'Joining...' : hasEnoughBalance ? 'Buy Chips' : 'Insufficient Balance'}
        </button>

        {/* Top Up Link */}
        {!hasEnoughBalance && <button className="buy-in-modal__top-up">Top Up Account</button>}
      </div>
    </div>
  );
}

export default BuyInModal;
