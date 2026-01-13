/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ⚡ QUICK SEAT — One-Click Buy-In Component
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PokerBros-style quick seat button for instant table join:
 * - Auto-selects default buy-in (100BB)
 * - Instant seat at first available
 * - Remembers last buy-in preference
 */

import React, { useState, useCallback } from 'react';
import './QuickSeat.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface QuickSeatProps {
    tableId: string;
    tableName: string;
    blinds: string;
    bigBlind: number;
    minBuyIn: number;
    maxBuyIn: number;
    defaultBuyIn?: number;
    availableSeats: number;
    accountBalance: number;
    onQuickSeat: (amount: number) => Promise<void>;
    onCustomBuyIn?: () => void;
    currency?: string;
    isLoading?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function formatAmount(amount: number, currency: string = ''): string {
    if (amount >= 1000) {
        return `${currency}${(amount / 1000).toFixed(0)}K`;
    }
    return `${currency}${amount.toLocaleString()}`;
}

function getBBLabel(amount: number, bigBlind: number): string {
    const bbs = amount / bigBlind;
    return `${bbs.toFixed(0)}BB`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function QuickSeat({
    tableId,
    tableName,
    blinds,
    bigBlind,
    minBuyIn,
    maxBuyIn,
    defaultBuyIn,
    availableSeats,
    accountBalance,
    onQuickSeat,
    onCustomBuyIn,
    currency = '',
    isLoading = false,
}: QuickSeatProps) {
    const [selectedAmount, setSelectedAmount] = useState(defaultBuyIn || bigBlind * 100);
    const [isProcessing, setIsProcessing] = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);

    // Quick buy-in options (in BB)
    const quickOptions = [
        { bb: 40, label: '40BB' },
        { bb: 100, label: '100BB' },
        { bb: Math.floor(maxBuyIn / bigBlind), label: 'MAX' },
    ];

    const hasBalance = accountBalance >= selectedAmount;
    const hasSeats = availableSeats > 0;
    const canJoin = hasBalance && hasSeats && !isLoading && !isProcessing;

    // Handle quick seat click
    const handleQuickSeat = useCallback(async () => {
        if (!canJoin) return;

        try {
            setIsProcessing(true);
            await onQuickSeat(selectedAmount);
        } catch (error) {
            console.error('[QuickSeat] Error:', error);
        } finally {
            setIsProcessing(false);
        }
    }, [selectedAmount, canJoin, onQuickSeat]);

    // Handle amount selection
    const handleSelectAmount = useCallback((bb: number) => {
        const amount = Math.min(bb * bigBlind, maxBuyIn);
        setSelectedAmount(amount);
    }, [bigBlind, maxBuyIn]);

    return (
        <div className="quick-seat">
            {/* Table Info */}
            <div className="quick-seat__info">
                <span className="quick-seat__blinds">{blinds}</span>
                <span className="quick-seat__seats">
                    {availableSeats > 0 ? (
                        <>{availableSeats} seat{availableSeats !== 1 ? 's' : ''} open</>
                    ) : (
                        <span className="quick-seat__seats--full">Table Full</span>
                    )}
                </span>
            </div>

            {/* Amount Options */}
            <div className="quick-seat__amounts">
                {quickOptions.map(({ bb, label }) => {
                    const amount = Math.min(bb * bigBlind, maxBuyIn);
                    const isSelected = selectedAmount === amount;
                    const isAffordable = accountBalance >= amount;

                    return (
                        <button
                            key={bb}
                            className={`quick-seat__amount-btn ${isSelected ? 'quick-seat__amount-btn--selected' : ''} ${!isAffordable ? 'quick-seat__amount-btn--disabled' : ''}`}
                            onClick={() => handleSelectAmount(bb)}
                            disabled={!isAffordable}
                        >
                            <span className="quick-seat__amount-label">{label}</span>
                            <span className="quick-seat__amount-value">{formatAmount(amount, currency)}</span>
                        </button>
                    );
                })}
            </div>

            {/* Action Buttons */}
            <div className="quick-seat__actions">
                <button
                    className={`quick-seat__main-btn ${!canJoin ? 'quick-seat__main-btn--disabled' : ''} ${isProcessing ? 'quick-seat__main-btn--loading' : ''}`}
                    onClick={handleQuickSeat}
                    disabled={!canJoin}
                >
                    {isProcessing ? (
                        <>
                            <span className="quick-seat__spinner" />
                            Joining...
                        </>
                    ) : !hasSeats ? (
                        'Table Full'
                    ) : !hasBalance ? (
                        'Insufficient Balance'
                    ) : (
                        <>
                            Quick Seat <span className="quick-seat__amount">{formatAmount(selectedAmount, currency)}</span>
                        </>
                    )}
                </button>

                {onCustomBuyIn && (
                    <button
                        className="quick-seat__custom-btn"
                        onClick={onCustomBuyIn}
                        disabled={!hasSeats || isProcessing}
                    >
                        Custom
                    </button>
                )}
            </div>

            {/* Balance Indicator */}
            <div className="quick-seat__balance">
                <span className="quick-seat__balance-label">Balance:</span>
                <span className={`quick-seat__balance-value ${!hasBalance ? 'quick-seat__balance-value--low' : ''}`}>
                    {formatAmount(accountBalance, currency)}
                </span>
            </div>
        </div>
    );
}

export default QuickSeat;
