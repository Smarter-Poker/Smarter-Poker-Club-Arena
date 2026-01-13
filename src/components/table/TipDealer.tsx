/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 💸 TIP DEALER — Tipping Component
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Allows player to tip the dealer:
 * - Quick tip amounts
 * - Custom amount input
 * - Flying chip animation trigger
 */

import React, { useState } from 'react';
import './TipDealer.css';

export interface TipDealerProps {
    isOpen: boolean;
    onClose: () => void;
    onTip: (amount: number) => void;
    currency?: string;
    defaultAmounts?: number[];
    balance: number;
}

export function TipDealer({
    isOpen,
    onClose,
    onTip,
    currency = '$',
    defaultAmounts = [1, 5, 25, 100],
    balance,
}: TipDealerProps) {
    const [customAmount, setCustomAmount] = useState('');

    if (!isOpen) return null;

    const handleTip = (amount: number) => {
        if (amount > 0 && amount <= balance) {
            onTip(amount);
            onClose();
        }
    };

    const handleCustomSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const amount = parseFloat(customAmount);
        if (!isNaN(amount)) {
            handleTip(amount);
        }
    };

    return (
        <div className="tip-overlay" onClick={onClose}>
            <div className="tip-modal" onClick={(e) => e.stopPropagation()}>
                <div className="tip-modal__header">
                    <span className="tip-modal__icon">💸</span>
                    <h3 className="tip-modal__title">Tip Dealer</h3>
                    <button className="tip-modal__close" onClick={onClose}>×</button>
                </div>

                <div className="tip-modal__presets">
                    {defaultAmounts.map((amount) => (
                        <button
                            key={amount}
                            className="tip-modal__preset-btn"
                            onClick={() => handleTip(amount)}
                            disabled={amount > balance}
                        >
                            <span className="tip-modal__chip">
                                {amount}
                            </span>
                            <span className="tip-modal__chip-label">{currency}{amount}</span>
                        </button>
                    ))}
                </div>

                <form onSubmit={handleCustomSubmit} className="tip-modal__custom">
                    <input
                        type="number"
                        className="tip-modal__input"
                        placeholder="Custom Amount"
                        value={customAmount}
                        onChange={(e) => setCustomAmount(e.target.value)}
                        min="0"
                        max={balance}
                    />
                    <button
                        type="submit"
                        className="tip-modal__submit"
                        disabled={!customAmount || parseFloat(customAmount) > balance}
                    >
                        Tip
                    </button>
                </form>

                <p className="tip-modal__balance">
                    Available: {currency}{balance.toLocaleString()}
                </p>
            </div>
        </div>
    );
}

export default TipDealer;
