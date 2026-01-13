/**
 * ♠ CLUB ARENA — Action Panel Component
 * PokerBros-style action buttons: Fold, Check/Call, Raise
 */

import { useState } from 'react';
import './ActionPanel.css';

interface ActionPanelProps {
    canFold: boolean;
    canCheck: boolean;
    canCall: boolean;
    canRaise: boolean;
    canAllIn: boolean;
    callAmount: number;
    minRaise: number;
    maxRaise: number;
    pot: number;
    bigBlind: number;
    onAction: (action: 'fold' | 'check' | 'call' | 'raise', amount?: number) => void;
}

export default function ActionPanel({
    canFold,
    canCheck,
    canCall,
    canRaise,
    canAllIn,
    callAmount,
    minRaise,
    maxRaise,
    pot,
    bigBlind,
    onAction,
}: ActionPanelProps) {
    const [isRaiseMode, setIsRaiseMode] = useState(false);
    const [raiseAmount, setRaiseAmount] = useState(minRaise);

    // Preset raise multipliers
    const presets = [
        { label: '2X', value: bigBlind * 2 },
        { label: '3X', value: bigBlind * 3 },
        { label: '4X', value: bigBlind * 4 },
        { label: 'POT', value: pot },
    ];

    const handleRaiseClick = () => {
        if (!canRaise) return;
        setIsRaiseMode(true);
        setRaiseAmount(minRaise);
    };

    const handleConfirmRaise = () => {
        onAction('raise', raiseAmount);
        setIsRaiseMode(false);
    };

    const handleCancelRaise = () => {
        setIsRaiseMode(false);
    };

    const adjustRaise = (delta: number) => {
        const newAmount = Math.max(minRaise, Math.min(maxRaise, raiseAmount + delta));
        setRaiseAmount(newAmount);
    };

    const setPreset = (value: number) => {
        const clamped = Math.max(minRaise, Math.min(maxRaise, value));
        setRaiseAmount(clamped);
    };

    // Raise Mode UI
    if (isRaiseMode) {
        return (
            <div className="action-panel raise-mode">
                {/* Amount Display */}
                <div className="raise-display">
                    <button className="adjust-btn minus" onClick={() => adjustRaise(-bigBlind)}>
                        <span>−</span>
                    </button>
                    <div className="raise-amount">
                        <span className="amount-value">{raiseAmount.toLocaleString()}</span>
                    </div>
                    <button className="adjust-btn plus" onClick={() => adjustRaise(bigBlind)}>
                        <span>+</span>
                    </button>
                </div>

                {/* Slider */}
                <div className="raise-slider-container">
                    <input
                        type="range"
                        className="raise-slider"
                        min={minRaise}
                        max={maxRaise}
                        value={raiseAmount}
                        onChange={(e) => setRaiseAmount(Number(e.target.value))}
                    />
                </div>

                {/* Presets */}
                <div className="action-buttons">
                    {presets.map((preset) => (
                        <button
                            key={preset.label}
                            className="action-btn preset"
                            onClick={() => setPreset(preset.value)}
                            disabled={preset.value > maxRaise}
                        >
                            {preset.label}
                        </button>
                    ))}
                    {canAllIn && (
                        <button
                            className="action-btn allin"
                            onClick={() => setRaiseAmount(maxRaise)}
                        >
                            ALL IN
                        </button>
                    )}
                    <button className="action-btn confirm" onClick={handleConfirmRaise}>
                        Confirm
                    </button>
                </div>
            </div>
        );
    }

    // Standard Action UI
    return (
        <div className="action-panel">
            <div className="action-buttons">
                {/* Fold */}
                <button
                    className="action-btn fold"
                    onClick={() => onAction('fold')}
                    disabled={!canFold}
                >
                    Fold
                </button>

                {/* Check or Call */}
                {canCheck ? (
                    <button
                        className="action-btn check"
                        onClick={() => onAction('check')}
                    >
                        Check
                    </button>
                ) : canCall ? (
                    <button
                        className="action-btn call"
                        onClick={() => onAction('call')}
                    >
                        Call {callAmount}
                    </button>
                ) : null}

                {/* Raise */}
                <button
                    className="action-btn raise"
                    onClick={handleRaiseClick}
                    disabled={!canRaise}
                >
                    Raise
                </button>
            </div>
        </div>
    );
}

export { ActionPanel };
