/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ⏳ TIME BANK — Extra Time Component
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Visual indicator and trigger for Time Bank:
 * - Shows available time banks
 * - Progress bar / Countdown
 * - Activation button
 */

import React from 'react';
import './TimeBank.css';

export interface TimeBankProps {
    isVisible: boolean;
    isActive: boolean;
    banksRemaining: number;
    totalTime: number; // total seconds provided by one bank
    timeRemaining?: number; // current countdown if active
    onActivate: () => void;
    autoActivate?: boolean;
}

export function TimeBank({
    isVisible,
    isActive,
    banksRemaining,
    totalTime,
    timeRemaining,
    onActivate,
}: TimeBankProps) {
    if (!isVisible && banksRemaining === 0) return null;

    return (
        <div className={`time-bank ${isActive ? 'time-bank--active' : ''}`}>
            {isActive ? (
                <div className="time-bank__active-display">
                    <span className="time-bank__icon">⏳</span>
                    <div className="time-bank__progress">
                        <div
                            className="time-bank__bar"
                            style={{ width: `${((timeRemaining || 0) / totalTime) * 100}%` }}
                        />
                    </div>
                    <span className="time-bank__countdown">{timeRemaining}s</span>
                </div>
            ) : (
                <button
                    className="time-bank__trigger"
                    onClick={onActivate}
                    disabled={banksRemaining === 0}
                >
                    <span className="time-bank__label">TIME BANK</span>
                    <div className="time-bank__chips">
                        {Array.from({ length: Math.min(5, banksRemaining) }).map((_, i) => (
                            <div key={i} className="time-bank__chip" />
                        ))}
                        {banksRemaining > 5 && (
                            <span className="time-bank__count">+{banksRemaining - 5}</span>
                        )}
                    </div>
                </button>
            )}
        </div>
    );
}

export default TimeBank;
