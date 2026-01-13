/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🔘 STRADDLE TOGGLE — UTG Option
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Toggle switch for UTG player to enable/disable straddle:
 * - Shows cost (2x BB)
 * - Visual on/off state
 */

import React from 'react';
import './StraddleToggle.css';

export interface StraddleToggleProps {
    isEnabled: boolean;
    onToggle: (enabled: boolean) => void;
    amount: number;
    currency?: string;
    isAvailable: boolean; // only available to UTG before cards dealt
}

export function StraddleToggle({
    isEnabled,
    onToggle,
    amount,
    currency = '$',
    isAvailable,
}: StraddleToggleProps) {
    if (!isAvailable) return null;

    return (
        <div className="straddle-toggle">
            <label className="straddle-toggle__wrapper">
                <input
                    type="checkbox"
                    checked={isEnabled}
                    onChange={(e) => onToggle(e.target.checked)}
                    className="straddle-toggle__input"
                />
                <div className="straddle-toggle__switch">
                    <span className="straddle-toggle__knob" />
                </div>
                <div className="straddle-toggle__info">
                    <span className="straddle-toggle__label">STRADDLE</span>
                    <span className="straddle-toggle__amount">{currency}{amount}</span>
                </div>
            </label>
        </div>
    );
}

export default StraddleToggle;
