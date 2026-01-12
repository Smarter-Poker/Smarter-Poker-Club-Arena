/**
 * ♠ CLUB ARENA — Cash Game Buy-In Modal
 * PokerBros-style buy-in with slider (PLAY CHIPS ONLY)
 */

import { useState, useEffect } from 'react';
import { useUserStore } from '../../stores/useUserStore';
import './BuyInModal.css';

interface BuyInModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (amount: number, autoRebuy: boolean) => void;
    minBuyIn: number;
    maxBuyIn: number;
    tableName: string;
    stakes: string;
}

export default function BuyInModal({
    isOpen,
    onClose,
    onConfirm,
    minBuyIn,
    maxBuyIn,
    tableName,
    stakes,
}: BuyInModalProps) {
    const { user, totalChips } = useUserStore();
    const [buyInAmount, setBuyInAmount] = useState(minBuyIn);
    const [autoRebuy, setAutoRebuy] = useState(false);
    const [countdownSeconds, setCountdownSeconds] = useState(60);

    const userBalance = totalChips || 0;
    const effectiveMax = Math.min(maxBuyIn, userBalance);

    useEffect(() => {
        if (isOpen) {
            setBuyInAmount(minBuyIn);
            setCountdownSeconds(60);

            // Start countdown
            const timer = setInterval(() => {
                setCountdownSeconds((prev) => {
                    if (prev <= 1) {
                        clearInterval(timer);
                        onClose();
                        return 0;
                    }
                    return prev - 1;
                });
            }, 1000);

            return () => clearInterval(timer);
        }
    }, [isOpen, minBuyIn, onClose]);

    const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setBuyInAmount(Number(e.target.value));
    };

    const handleConfirm = () => {
        if (buyInAmount >= minBuyIn && buyInAmount <= effectiveMax) {
            onConfirm(buyInAmount, autoRebuy);
        }
    };

    const sliderProgress = ((buyInAmount - minBuyIn) / (effectiveMax - minBuyIn)) * 100;

    if (!isOpen) return null;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="buyin-modal" onClick={(e) => e.stopPropagation()}>
                {/* Countdown Header */}
                <div className="buyin-countdown">
                    <span>{countdownSeconds}s</span>
                    <span className="countdown-label">(Close)</span>
                </div>

                {/* Title */}
                <h2 className="buyin-title">BUY-IN</h2>

                {/* Close Button */}
                <button className="modal-close" onClick={onClose}>✕</button>

                {/* Amount Display */}
                <div className="amount-display">
                    <div className="amount-min">
                        <span className="amount-value">{minBuyIn}</span>
                        <span className="amount-label">Min</span>
                    </div>
                    <div className="amount-current">
                        <span className="amount-value">{buyInAmount}</span>
                    </div>
                    <div className="amount-max">
                        <span className="amount-value">{effectiveMax}</span>
                        <span className="amount-label">Max</span>
                    </div>
                </div>

                {/* Slider */}
                <div className="buyin-slider-container">
                    <span className="slider-chip">♠</span>
                    <input
                        type="range"
                        className="buyin-slider"
                        min={minBuyIn}
                        max={effectiveMax}
                        value={buyInAmount}
                        onChange={handleSliderChange}
                        style={{ '--progress': `${sliderProgress}%` } as React.CSSProperties}
                    />
                </div>

                {/* Balance Display */}
                <div className="balance-display">
                    <span>( Account Balance: </span>
                    <span className="balance-value">{userBalance.toFixed(2)}</span>
                    <span> )</span>
                </div>

                {/* Auto Rebuy Toggle */}
                <div className="auto-rebuy">
                    <label className="toggle-label">
                        <input
                            type="checkbox"
                            checked={autoRebuy}
                            onChange={(e) => setAutoRebuy(e.target.checked)}
                        />
                        <span className="toggle-switch" />
                        <span className="toggle-text">Auto Rebuy</span>
                    </label>
                    <p className="rebuy-note">
                        When your stack drops to <span className="highlight">0%</span> of the initial buy-in,
                        it will be automatically replenished.
                    </p>
                </div>

                {/* Confirm Button */}
                <button
                    className="btn buyin-confirm"
                    onClick={handleConfirm}
                    disabled={buyInAmount < minBuyIn || buyInAmount > effectiveMax}
                >
                    Buy Chips
                </button>

                {/* Insufficient Balance Warning */}
                {userBalance < minBuyIn && (
                    <div className="insufficient-balance">
                        <p>Insufficient balance. Please add more chips.</p>
                        <button className="btn btn-add-chips">Add Chips</button>
                    </div>
                )}
            </div>
        </div>
    );
}

export { BuyInModal };
