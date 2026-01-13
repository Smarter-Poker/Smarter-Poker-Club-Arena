/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 💵 CASHIER MODAL — Add/Withdraw Chips at Table
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Premium cashier modal for:
 * - Adding chips during play
 * - Withdrawing excess chips
 * - Balance display
 * - Transaction history
 */

import React, { useState, useMemo, useCallback } from 'react';
import './CashierModal.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type CashierTab = 'add' | 'withdraw';

export interface CashierTransaction {
    id: string;
    type: 'add' | 'withdraw';
    amount: number;
    timestamp: Date;
    balance: number;
}

export interface CashierModalProps {
    isOpen: boolean;
    onClose: () => void;
    onAddChips: (amount: number) => Promise<void>;
    onWithdrawChips: (amount: number) => Promise<void>;
    currentStack: number;
    accountBalance: number;
    minBuyIn: number;
    maxBuyIn: number;
    maxStack: number; // Max stack allowed at table
    transactions?: CashierTransaction[];
    currency?: string;
    isProcessing?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function formatAmount(amount: number, currency: string = ''): string {
    return `${currency}${amount.toLocaleString()}`;
}

function formatTime(date: Date): string {
    return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function CashierModal({
    isOpen,
    onClose,
    onAddChips,
    onWithdrawChips,
    currentStack,
    accountBalance,
    minBuyIn,
    maxBuyIn,
    maxStack,
    transactions = [],
    currency = '',
    isProcessing = false,
}: CashierModalProps) {
    const [activeTab, setActiveTab] = useState<CashierTab>('add');
    const [amount, setAmount] = useState(0);

    // Calculate limits
    const canAddAmount = useMemo(() => {
        const spaceInStack = maxStack - currentStack;
        return Math.min(spaceInStack, accountBalance, maxBuyIn);
    }, [currentStack, maxStack, accountBalance, maxBuyIn]);

    const canWithdrawAmount = useMemo(() => {
        // Can only withdraw down to min buy-in
        return Math.max(0, currentStack - minBuyIn);
    }, [currentStack, minBuyIn]);

    // Quick amount options
    const quickAmounts = useMemo(() => {
        const max = activeTab === 'add' ? canAddAmount : canWithdrawAmount;
        return [
            { label: '25%', value: Math.floor(max * 0.25) },
            { label: '50%', value: Math.floor(max * 0.5) },
            { label: '75%', value: Math.floor(max * 0.75) },
            { label: 'MAX', value: max },
        ];
    }, [activeTab, canAddAmount, canWithdrawAmount]);

    // Reset amount when switching tabs
    const handleTabChange = useCallback((tab: CashierTab) => {
        setActiveTab(tab);
        setAmount(0);
    }, []);

    // Handle confirm
    const handleConfirm = useCallback(async () => {
        if (amount <= 0 || isProcessing) return;

        try {
            if (activeTab === 'add') {
                await onAddChips(amount);
            } else {
                await onWithdrawChips(amount);
            }
            setAmount(0);
            onClose();
        } catch (error) {
            console.error('Cashier error:', error);
        }
    }, [amount, activeTab, isProcessing, onAddChips, onWithdrawChips, onClose]);

    // Validate amount
    const isValidAmount = useMemo(() => {
        if (amount <= 0) return false;
        if (activeTab === 'add') {
            return amount <= canAddAmount;
        }
        return amount <= canWithdrawAmount;
    }, [amount, activeTab, canAddAmount, canWithdrawAmount]);

    if (!isOpen) return null;

    return (
        <div className="cashier-overlay" onClick={onClose}>
            <div className="cashier-modal" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="cashier-modal__header">
                    <h2 className="cashier-modal__title">Cashier</h2>
                    <button className="cashier-modal__close" onClick={onClose}>×</button>
                </div>

                {/* Balance Summary */}
                <div className="cashier-modal__summary">
                    <div className="cashier-modal__balance-item">
                        <span className="cashier-modal__balance-label">At Table</span>
                        <span className="cashier-modal__balance-value">
                            {formatAmount(currentStack, currency)}
                        </span>
                    </div>
                    <div className="cashier-modal__balance-item">
                        <span className="cashier-modal__balance-label">Account</span>
                        <span className="cashier-modal__balance-value">
                            {formatAmount(accountBalance, currency)}
                        </span>
                    </div>
                </div>

                {/* Tabs */}
                <div className="cashier-modal__tabs">
                    <button
                        className={`cashier-modal__tab ${activeTab === 'add' ? 'cashier-modal__tab--active' : ''}`}
                        onClick={() => handleTabChange('add')}
                    >
                        Add Chips
                    </button>
                    <button
                        className={`cashier-modal__tab ${activeTab === 'withdraw' ? 'cashier-modal__tab--active' : ''}`}
                        onClick={() => handleTabChange('withdraw')}
                    >
                        Withdraw
                    </button>
                </div>

                {/* Amount Input */}
                <div className="cashier-modal__input-section">
                    <div className="cashier-modal__input-wrapper">
                        <span className="cashier-modal__currency">{currency}</span>
                        <input
                            type="number"
                            className="cashier-modal__input"
                            value={amount || ''}
                            onChange={(e) => setAmount(Math.max(0, parseInt(e.target.value) || 0))}
                            placeholder="0"
                            min={0}
                            max={activeTab === 'add' ? canAddAmount : canWithdrawAmount}
                        />
                    </div>
                    <div className="cashier-modal__limit">
                        {activeTab === 'add' ? (
                            <span>Available to add: {formatAmount(canAddAmount, currency)}</span>
                        ) : (
                            <span>Available to withdraw: {formatAmount(canWithdrawAmount, currency)}</span>
                        )}
                    </div>
                </div>

                {/* Quick Amounts */}
                <div className="cashier-modal__quick-amounts">
                    {quickAmounts.map(({ label, value }) => (
                        <button
                            key={label}
                            className={`cashier-modal__quick-btn ${amount === value ? 'cashier-modal__quick-btn--active' : ''}`}
                            onClick={() => setAmount(value)}
                            disabled={value <= 0}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                {/* New Stack Preview */}
                <div className="cashier-modal__preview">
                    <span className="cashier-modal__preview-label">New Stack:</span>
                    <span className={`cashier-modal__preview-value ${activeTab === 'add' ? 'cashier-modal__preview-value--add' : 'cashier-modal__preview-value--withdraw'}`}>
                        {formatAmount(
                            activeTab === 'add' ? currentStack + amount : currentStack - amount,
                            currency
                        )}
                    </span>
                </div>

                {/* Confirm Button */}
                <div className="cashier-modal__actions">
                    <button
                        className={`cashier-modal__confirm-btn ${!isValidAmount || isProcessing ? 'cashier-modal__confirm-btn--disabled' : ''}`}
                        onClick={handleConfirm}
                        disabled={!isValidAmount || isProcessing}
                    >
                        {isProcessing ? (
                            <>
                                <span className="cashier-modal__spinner" />
                                Processing...
                            </>
                        ) : activeTab === 'add' ? (
                            `Add ${formatAmount(amount, currency)}`
                        ) : (
                            `Withdraw ${formatAmount(amount, currency)}`
                        )}
                    </button>
                </div>

                {/* Recent Transactions */}
                {transactions.length > 0 && (
                    <div className="cashier-modal__transactions">
                        <span className="cashier-modal__transactions-title">Recent</span>
                        <div className="cashier-modal__transactions-list">
                            {transactions.slice(0, 5).map((tx) => (
                                <div key={tx.id} className="cashier-modal__transaction">
                                    <span className={`cashier-modal__tx-type cashier-modal__tx-type--${tx.type}`}>
                                        {tx.type === 'add' ? '+' : '-'}
                                        {formatAmount(tx.amount, currency)}
                                    </span>
                                    <span className="cashier-modal__tx-time">{formatTime(tx.timestamp)}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default CashierModal;
