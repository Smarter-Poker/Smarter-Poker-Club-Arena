/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 💰 BAD BEAT JACKPOT — Jackpot Display & Trigger
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Displays the current Bad Beat Jackpot amount.
 * - Live ticker update
 * - Qualifying hand info
 * - "Jackpot Hit" celebration animation
 */

import React, { useState, useEffect } from 'react';
import './BadBeatJackpot.css';

export interface BadBeatJackpotProps {
    amount: number;
    currency?: string;
    qualifyingHand: string; // e.g., "Quad 8s or better"
    isHit?: boolean; // Trigger for the hit animation
    onClaimed?: () => void;
}

export function BadBeatJackpot({
    amount,
    currency = '$',
    qualifyingHand,
    isHit = false,
}: BadBeatJackpotProps) {
    const [showInfo, setShowInfo] = useState(false);
    const [displayAmount, setDisplayAmount] = useState(amount);

    // Smooth ticker effect for amount changes
    useEffect(() => {
        if (amount === displayAmount) return;

        // Simple lerp for visual effect (or direct set if preferring instant)
        const diff = amount - displayAmount;
        const step = diff / 20; // 20 frames to reach target

        const interval = setInterval(() => {
            setDisplayAmount(prev => {
                const next = prev + step;
                if ((step > 0 && next >= amount) || (step < 0 && next <= amount)) {
                    clearInterval(interval);
                    return amount;
                }
                return next;
            });
        }, 50);

        return () => clearInterval(interval);
    }, [amount]);

    return (
        <>
            {/* Table Widget */}
            <div
                className="bbj-widget"
                onMouseEnter={() => setShowInfo(true)}
                onMouseLeave={() => setShowInfo(false)}
            >
                <div className="bbj-widget__label">BAD BEAT JACKPOT</div>
                <div className="bbj-widget__amount">
                    {currency}{Math.floor(displayAmount).toLocaleString()}
                </div>

                {/* Info Popover */}
                {showInfo && (
                    <div className="bbj-info">
                        <h4 className="bbj-info__title">Qualifying Hand</h4>
                        <p className="bbj-info__rule">{qualifyingHand}</p>
                        <p className="bbj-info__sub">Both hole cards must play.</p>
                    </div>
                )}
            </div>

            {/* Hit Animation Overlay */}
            {isHit && (
                <div className="bbj-hit-overlay">
                    <div className="bbj-hit-content">
                        <div className="bbj-hit__title">BAD BEAT JACKPOT</div>
                        <div className="bbj-hit__subtitle">HIT!</div>
                        <div className="bbj-hit__amount">
                            {currency}{amount.toLocaleString()}
                        </div>
                        <div className="bbj-hit__particles">
                            {/* CSS particles handled in stylesheet */}
                            {[...Array(20)].map((_, i) => (
                                <div key={i} className="bbj-particle" />
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

export default BadBeatJackpot;
