/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CASHIER MODAL — Chip Management
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Allows players to:
 * - View current chip balance
 * - Purchase chips (via onDeposit callback)
 * - Withdraw chips (via onWithdraw callback)
 * - View transaction history
 */

import React, { useState, useEffect } from 'react';
import { masterBus } from '../../core/MasterBus';
import './CashierModal.css';

export interface Transaction {
  id: string;
  type: 'deposit' | 'withdrawal' | 'winnings' | 'rake';
  amount: number;
  date: string;
  status: 'completed' | 'pending' | 'failed';
}

export interface CashierModalProps {
  isOpen: boolean;
  onClose: () => void;
  balance: number;
  currency?: string;
  transactions?: Transaction[];
  onDeposit: (amount: number) => Promise<void>;
  onWithdraw: (amount: number) => Promise<void>;
}

export function CashierModal({
  isOpen,
  onClose,
  balance,
  currency = '',
  transactions = [],
  onDeposit,
  onWithdraw,
}: CashierModalProps) {
  const [activeTab, setActiveTab] = useState<'balance' | 'deposit' | 'withdraw' | 'history'>(
    'balance'
  );
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => setMounted(true), 50);
    } else {
      setMounted(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleAction = async () => {
    const val = parseFloat(amount);
    if (isNaN(val) || val <= 0) return;

    setLoading(true);
    try {
      if (activeTab === 'deposit') await onDeposit(val);
      if (activeTab === 'withdraw') await onWithdraw(val);
      setAmount('');
      setActiveTab('balance');
      // Emit bus event so other components (DynamicWallet, CashierPage) refresh balances
      masterBus.emit('BALANCE_UPDATED', { source: activeTab, amount: val });
    } catch (err) {
      console.error('Cashier action failed', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="cashier-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="cashier-modal-title">
      <div
        className="cashier-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        {/* Header */}
        <div className="cashier-modal__header">
          <div className="cashier-modal__title-group">
            <span className="cashier-modal__icon"></span>
            <h2 className="cashier-modal__title">Cashier</h2>
          </div>
          <button className="cashier-modal__close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Balance Card */}
        <div className="cashier-balance-card">
          <span className="cashier-balance-label">Current Balance</span>
          <span className="cashier-balance-value">{balance.toLocaleString()}</span>
        </div>

        {/* Tabs */}
        <div className="cashier-tabs">
          <button
            className={`cashier-tab ${activeTab === 'deposit' ? 'active' : ''}`}
            onClick={() => setActiveTab('deposit')}
          >
            Deposit
          </button>
          <button
            className={`cashier-tab ${activeTab === 'withdraw' ? 'active' : ''}`}
            onClick={() => setActiveTab('withdraw')}
          >
            Withdraw
          </button>
          <button
            className={`cashier-tab ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => setActiveTab('history')}
          >
            History
          </button>
        </div>

        {/* Content */}
        <div className="cashier-content">
          {(activeTab === 'deposit' || activeTab === 'withdraw') && (
            <div className="cashier-form">
              <label className="cashier-label">
                {activeTab === 'deposit' ? 'Purchase Amount' : 'Withdrawal Amount'}
              </label>
              <div className="cashier-input-wrapper">
                <span className="cashier-currency"></span>
                <input
                  type="number"
                  className="cashier-input"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  min="1"
                />
              </div>

              <div className="cashier-presets">
                {[100, 500, 1000, 5000].map((val) => (
                  <button key={val} type="button" onClick={() => setAmount(val.toString())}>
                    +{val}
                  </button>
                ))}
              </div>

              <button
                className={`cashier-submit-btn ${activeTab}`}
                onClick={handleAction}
                disabled={loading || !amount}
              >
                {loading
                  ? 'Processing...'
                  : activeTab === 'deposit'
                    ? 'Buy Chips'
                    : 'Request Withdrawal'}
              </button>

              <p className="cashier-note">
                {activeTab === 'deposit'
                  ? 'Chips are instantly credited to your account.'
                  : 'Withdrawals are processed by club admins within 24h.'}
              </p>
            </div>
          )}

          {activeTab === 'history' && (
            <div className="cashier-history">
              {transactions.length > 0 ? (
                transactions.map((tx) => (
                  <div key={tx.id} className="tx-row">
                    <div className="tx-info">
                      <span className={`tx-type tx-type--${tx.type}`}>{tx.type}</span>
                      <span className="tx-date">{tx.date}</span>
                    </div>
                    <div className="tx-amount-group">
                      <span
                        className={`tx-amount ${tx.type === 'withdrawal' || tx.type === 'rake' ? 'neg' : 'pos'}`}
                      >
                        {tx.type === 'withdrawal' || tx.type === 'rake' ? '-' : '+'}
                        {tx.amount.toLocaleString()}
                      </span>
                      <span className={`tx-status tx-status--${tx.status}`}>{tx.status}</span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="tx-empty">No transaction history found.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default CashierModal;
