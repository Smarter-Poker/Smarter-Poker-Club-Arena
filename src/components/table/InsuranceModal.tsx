/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🛡️ INSURANCE MODAL — All-In Insurance Options
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * All-in insurance system:
 * - Calculate equity and insurance cost
 * - Slider for coverage amount
 * - Premium display
 * - Accept/decline
 */

import React, { useState, useMemo, useCallback } from 'react';
import './InsuranceModal.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface InsuranceOffer {
    maxCoverage: number; // Maximum amount you can insure
    equityPercent: number; // Your current equity (0-100)
    premiumRate: number; // Premium as percentage of coverage (e.g., 0.05 = 5%)
    potAmount: number;
    yourStack: number;
    opponentStack: number;
    yourCards: { rank: string; suit: 'h' | 'd' | 'c' | 's' }[];
    opponentCards?: { rank: string; suit: 'h' | 'd' | 'c' | 's' }[];
    board: { rank: string; suit: 'h' | 'd' | 'c' | 's' }[];
}

export interface InsuranceModalProps {
    isOpen: boolean;
    onClose: () => void;
    onAccept: (coverageAmount: number) => void;
    onDecline: () => void;
    offer: InsuranceOffer;
    timeRemaining?: number;
    currency?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

const SUIT_SYMBOLS: Record<string, string> = {
    h: '♥',
    d: '♦',
    c: '♣',
    s: '♠',
};

const SUIT_COLORS: Record<string, string> = {
    h: '#F85149',
    d: '#1877F2',
    c: '#3FB950',
    s: '#E4E6EB',
};

function formatCard(card: { rank: string; suit: string }): string {
    return `${card.rank}${SUIT_SYMBOLS[card.suit]}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function InsuranceModal({
    isOpen,
    onClose,
    onAccept,
    onDecline,
    offer,
    timeRemaining = 15,
    currency = '$',
}: InsuranceModalProps) {
    const [coverageAmount, setCoverageAmount] = useState(offer.maxCoverage);

    // Calculate premium
    const premium = useMemo(() => {
        return Math.round(coverageAmount * offer.premiumRate);
    }, [coverageAmount, offer.premiumRate]);

    // Payout if you lose
    const payout = useMemo(() => {
        return coverageAmount - premium;
    }, [coverageAmount, premium]);

    // Handle accept
    const handleAccept = useCallback(() => {
        onAccept(coverageAmount);
    }, [coverageAmount, onAccept]);

    // Slider presets
    const presets = useMemo(() => [
        { label: '25%', value: Math.round(offer.maxCoverage * 0.25) },
        { label: '50%', value: Math.round(offer.maxCoverage * 0.5) },
        { label: '75%', value: Math.round(offer.maxCoverage * 0.75) },
        { label: 'MAX', value: offer.maxCoverage },
    ], [offer.maxCoverage]);

    if (!isOpen) return null;

    return (
        <div className="insurance-overlay">
            <div className="insurance-modal">
                {/* Header */}
                <div className="insurance-modal__header">
                    <div className="insurance-modal__title-row">
                        <span className="insurance-modal__icon">🛡️</span>
                        <h2 className="insurance-modal__title">Insurance</h2>
                    </div>
                    {timeRemaining !== undefined && (
                        <span className="insurance-modal__timer">{timeRemaining}s</span>
                    )}
                </div>

                {/* Cards Display */}
                <div className="insurance-modal__cards">
                    <div className="insurance-modal__hand">
                        <span className="insurance-modal__hand-label">Your Hand</span>
                        <div className="insurance-modal__hand-cards">
                            {offer.yourCards.map((card, i) => (
                                <span key={i} className="insurance-modal__card" style={{ color: SUIT_COLORS[card.suit] }}>
                                    {formatCard(card)}
                                </span>
                            ))}
                        </div>
                    </div>

                    <div className="insurance-modal__vs">vs</div>

                    <div className="insurance-modal__hand">
                        <span className="insurance-modal__hand-label">Opponent</span>
                        <div className="insurance-modal__hand-cards">
                            {offer.opponentCards ? (
                                offer.opponentCards.map((card, i) => (
                                    <span key={i} className="insurance-modal__card" style={{ color: SUIT_COLORS[card.suit] }}>
                                        {formatCard(card)}
                                    </span>
                                ))
                            ) : (
                                <>
                                    <span className="insurance-modal__card insurance-modal__card--hidden">?</span>
                                    <span className="insurance-modal__card insurance-modal__card--hidden">?</span>
                                </>
                            )}
                        </div>
                    </div>
                </div>

                {/* Board */}
                <div className="insurance-modal__board">
                    {offer.board.map((card, i) => (
                        <span key={i} className="insurance-modal__board-card" style={{ color: SUIT_COLORS[card.suit] }}>
                            {formatCard(card)}
                        </span>
                    ))}
                </div>

                {/* Equity Bar */}
                <div className="insurance-modal__equity">
                    <div className="insurance-modal__equity-bar">
                        <div
                            className="insurance-modal__equity-fill"
                            style={{ width: `${offer.equityPercent}%` }}
                        />
                    </div>
                    <span className="insurance-modal__equity-text">
                        Your Equity: {offer.equityPercent.toFixed(1)}%
                    </span>
                </div>

                {/* Coverage Slider */}
                <div className="insurance-modal__coverage">
                    <span className="insurance-modal__coverage-label">Coverage Amount</span>
                    <input
                        type="range"
                        className="insurance-modal__slider"
                        min={0}
                        max={offer.maxCoverage}
                        step={Math.max(1, Math.floor(offer.maxCoverage / 100))}
                        value={coverageAmount}
                        onChange={(e) => setCoverageAmount(parseInt(e.target.value))}
                    />
                    <div className="insurance-modal__presets">
                        {presets.map((preset) => (
                            <button
                                key={preset.label}
                                className={`insurance-modal__preset ${coverageAmount === preset.value ? 'insurance-modal__preset--active' : ''}`}
                                onClick={() => setCoverageAmount(preset.value)}
                            >
                                {preset.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Summary */}
                <div className="insurance-modal__summary">
                    <div className="insurance-modal__summary-row">
                        <span className="insurance-modal__summary-label">Coverage</span>
                        <span className="insurance-modal__summary-value">{currency}{coverageAmount.toLocaleString()}</span>
                    </div>
                    <div className="insurance-modal__summary-row">
                        <span className="insurance-modal__summary-label">Premium ({(offer.premiumRate * 100).toFixed(1)}%)</span>
                        <span className="insurance-modal__summary-value insurance-modal__summary-value--negative">
                            -{currency}{premium.toLocaleString()}
                        </span>
                    </div>
                    <div className="insurance-modal__summary-row insurance-modal__summary-row--total">
                        <span className="insurance-modal__summary-label">If you lose, receive</span>
                        <span className="insurance-modal__summary-value insurance-modal__summary-value--highlight">
                            {currency}{payout.toLocaleString()}
                        </span>
                    </div>
                </div>

                {/* Actions */}
                <div className="insurance-modal__actions">
                    <button className="insurance-modal__btn insurance-modal__btn--decline" onClick={onDecline}>
                        No Insurance
                    </button>
                    <button className="insurance-modal__btn insurance-modal__btn--accept" onClick={handleAccept}>
                        Buy Insurance
                    </button>
                </div>
            </div>
        </div>
    );
}

export default InsuranceModal;
