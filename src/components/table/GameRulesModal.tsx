/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 📜 GAME RULES MODAL — Table Rules & Info
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Displays detailed information about the current table:
 * - Game Variant & Stakes
 * - Rake Structure
 * - Buy-in Limits
 * - Special Rules (Bomb pots, 7-2 game, etc.)
 */

import React from 'react';
import './GameRulesModal.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TableRule {
    label: string;
    value: string;
    description?: string;
}

export interface GameRulesModalProps {
    isOpen: boolean;
    onClose: () => void;
    variant: string;
    stakes: string;
    minBuyIn: number;
    maxBuyIn: number;
    rakePercentage: number;
    rakeCap: number;
    isStraddleEnabled?: boolean;
    isRunItTwiceEnabled?: boolean;
    isInsuranceEnabled?: boolean;
    ante?: number;
    currency?: string;
    customRules?: TableRule[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function GameRulesModal({
    isOpen,
    onClose,
    variant,
    stakes,
    minBuyIn,
    maxBuyIn,
    rakePercentage,
    rakeCap,
    isStraddleEnabled = false,
    isRunItTwiceEnabled = false,
    isInsuranceEnabled = false,
    ante = 0,
    currency = '$',
    customRules = [],
}: GameRulesModalProps) {
    if (!isOpen) return null;

    return (
        <div className="rules-overlay" onClick={onClose}>
            <div className="rules-modal" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="rules-modal__header">
                    <div className="rules-modal__title-row">
                        <span className="rules-modal__icon">📜</span>
                        <div className="rules-modal__title-group">
                            <h2 className="rules-modal__title">Table Rules</h2>
                            <span className="rules-modal__subtitle">{variant} • {stakes}</span>
                        </div>
                    </div>
                    <button className="rules-modal__close" onClick={onClose}>×</button>
                </div>

                <div className="rules-modal__content">
                    {/* Financials Section */}
                    <div className="rules-modal__section">
                        <h3 className="rules-modal__section-title">Financials</h3>
                        <div className="rules-modal__grid">
                            <div className="rules-modal__item">
                                <span className="rules-modal__label">Blinds</span>
                                <span className="rules-modal__value">{stakes}</span>
                            </div>
                            {ante > 0 && (
                                <div className="rules-modal__item">
                                    <span className="rules-modal__label">Ante</span>
                                    <span className="rules-modal__value">{currency}{ante}</span>
                                </div>
                            )}
                            <div className="rules-modal__item">
                                <span className="rules-modal__label">Min Buy-in</span>
                                <span className="rules-modal__value">{currency}{minBuyIn.toLocaleString()}</span>
                            </div>
                            <div className="rules-modal__item">
                                <span className="rules-modal__label">Max Buy-in</span>
                                <span className="rules-modal__value">{currency}{maxBuyIn.toLocaleString()}</span>
                            </div>
                            <div className="rules-modal__item">
                                <span className="rules-modal__label">Rake</span>
                                <span className="rules-modal__value">{rakePercentage}% (Cap {currency}{rakeCap})</span>
                            </div>
                        </div>
                    </div>

                    {/* Features Section */}
                    <div className="rules-modal__section">
                        <h3 className="rules-modal__section-title">Table Features</h3>
                        <div className="rules-modal__features">
                            <div className={`rules-modal__feature ${isStraddleEnabled ? 'rules-modal__feature--active' : ''}`}>
                                <span className="rules-modal__feature-icon">{isStraddleEnabled ? '✅' : '❌'}</span>
                                <span className="rules-modal__feature-text">Straddle</span>
                            </div>
                            <div className={`rules-modal__feature ${isRunItTwiceEnabled ? 'rules-modal__feature--active' : ''}`}>
                                <span className="rules-modal__feature-icon">{isRunItTwiceEnabled ? '✅' : '❌'}</span>
                                <span className="rules-modal__feature-text">Run it Twice</span>
                            </div>
                            <div className={`rules-modal__feature ${isInsuranceEnabled ? 'rules-modal__feature--active' : ''}`}>
                                <span className="rules-modal__feature-icon">{isInsuranceEnabled ? '✅' : '❌'}</span>
                                <span className="rules-modal__feature-text">Insurance</span>
                            </div>
                        </div>
                    </div>

                    {/* Custom Rules Section */}
                    {customRules.length > 0 && (
                        <div className="rules-modal__section">
                            <h3 className="rules-modal__section-title">House Rules</h3>
                            <div className="rules-modal__custom-list">
                                {customRules.map((rule, idx) => (
                                    <div key={idx} className="rules-modal__custom-item">
                                        <div className="rules-modal__custom-header">
                                            <span className="rules-modal__custom-label">{rule.label}</span>
                                            <span className="rules-modal__custom-value">{rule.value}</span>
                                        </div>
                                        {rule.description && (
                                            <p className="rules-modal__custom-desc">{rule.description}</p>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

export default GameRulesModal;
