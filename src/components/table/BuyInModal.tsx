/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 💰 BUY-IN MODAL — Table Buy-In Interface
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PokerBros-style buy-in modal with:
 * - Min/Max slider
 * - Quick amount buttons
 * - Auto rebuy toggle
 * - Account balance display
 */

import React, { useState, useCallback, useMemo } from 'react';
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

function formatAmount(amount: number, currency: string = ''): string {
    if (amount >= 1000) {
        return `${currency}${(amount / 1000).toFixed(1)}K`;
    }
    return `${currency}${amount.toLocaleString()}`;
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

    // Clamp buy-in to valid range
    const clampedBuyIn = useMemo(() => {
        return Math.max(minBuyIn, Math.min(maxBuyIn, buyInAmount));
    }, [buyInAmount, minBuyIn, maxBuyIn]);

    // Calculate slider percentage
    const sliderPercent = useMemo(() => {
        return ((clampedBuyIn - minBuyIn) / (maxBuyIn - minBuyIn)) * 100;
    }, [clampedBuyIn, minBuyIn, maxBuyIn]);

    // Check if user has enough balance
    const hasEnoughBalance = accountBalance >= clampedBuyIn;

    // Handle slider change
    const handleSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        setBuyInAmount(Number(e.target.value));
    }, []);

    // Handle quick amount buttons
    const handleQuickAmount = useCallback((multiplier: number) => {
        const amount = Math.min(minBuyIn * multiplier, maxBuyIn);
        setBuyInAmount(amount);
    }, [minBuyIn, maxBuyIn]);

    // Handle confirm
    const handleConfirm = useCallback(() => {
        if (hasEnoughBalance) {
            onConfirm(clampedBuyIn, autoRebuy);
        }
    }, [clampedBuyIn, autoRebuy, hasEnoughBalance, onConfirm]);

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
                        <span className="buy-in-modal__amount-value">{clampedBuyIn}</span>
                        <span className="buy-in-modal__chip-icon">🪙</span>
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
                        style={{
                            '--slider-percent': `${sliderPercent}%`,
                        } as React.CSSProperties}
                    />
                    <div className="buy-in-modal__slider-labels">
                        <span>Min</span>
                        <span>Max</span>
                    </div>
                </div>

                {/* Quick Amounts */}
                <div className="buy-in-modal__quick-amounts">
                    <button
                        className="buy-in-modal__quick-btn"
                        onClick={() => handleQuickAmount(1)}
                    >
                        20BB
                    </button>
                    <button
                        className="buy-in-modal__quick-btn"
                        onClick={() => handleQuickAmount(2)}
                    >
                        40BB
                    </button>
                    <button
                        className="buy-in-modal__quick-btn"
                        onClick={() => handleQuickAmount(5)}
                    >
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
                    <span className={`buy-in-modal__balance-value ${!hasEnoughBalance ? 'buy-in-modal__balance-value--insufficient' : ''}`}>
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
                        When your stack drops to <strong>{rebuyThreshold}%</strong> of the initial buy-in,
                        it will be automatically replenished.
                    </p>
                </div>

                {/* Confirm Button */}
                <button
                    className={`buy-in-modal__confirm ${!hasEnoughBalance ? 'buy-in-modal__confirm--disabled' : ''}`}
                    onClick={handleConfirm}
                    disabled={!hasEnoughBalance}
                >
                    {hasEnoughBalance ? 'Buy Chips' : 'Insufficient Balance'}
                </button>

                {/* Top Up Link */}
                {!hasEnoughBalance && (
                    <button className="buy-in-modal__top-up">
                        💎 Top Up Account
                    </button>
                )}
            </div>
        </div>
    );
}

export default BuyInModal;
