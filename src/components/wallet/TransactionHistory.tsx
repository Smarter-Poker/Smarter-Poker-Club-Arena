/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TRANSACTION HISTORY — Wallet Transaction Log
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import { useIsMounted } from '../../hooks/useIsMounted';
import { masterBus } from '../../core/MasterBus';
import './TransactionHistory.css';

interface TransactionHistoryProps {
  walletId?: string;
  limit?: number;
}

interface Transaction {
  id: string;
  type: 'credit' | 'debit';
  category: string;
  amount: number;
  balance: number;
  description: string;
  createdAt: Date;
  walletType: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  buyin: 'Buy-In',
  cashout: 'Cash-Out',
  rake: 'Rake',
  prize: 'Prize',
  rebuy: 'Rebuy',
  addon: 'Add-On',
  mint: 'Mint',
  settlement: 'Settlement',
  commission: 'Commission',
  TIP: 'Dealer Tip',
  INSURANCE: 'Insurance',
  funding: 'Funding',
  promotion: 'Promotion',
  promo: 'Promo Bonus',
  bbj: 'Bad Beat Jackpot',
  horse_refill: 'Auto Refill',
  transfer: 'Transfer',
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  refund: 'Refund',
  bonus: 'Bonus',
};

const CATEGORY_COLORS: Record<string, string> = {
  buyin: '#f59e0b',
  cashout: '#22c55e',
  rake: '#ef4444',
  prize: '#22c55e',
  rebuy: '#f59e0b',
  addon: '#f59e0b',
  mint: '#a855f7',
  settlement: '#3b82f6',
  commission: '#3b82f6',
  TIP: '#f59e0b',
  INSURANCE: '#f59e0b',
  funding: '#22c55e',
  transfer: '#3b82f6',
  deposit: '#22c55e',
  withdrawal: '#f59e0b',
  refund: '#22c55e',
  bonus: '#a855f7',
  promo: '#a855f7',
};

const CATEGORY_ICONS: Record<string, string> = {
  buyin: '▦',
  cashout: '◉',
  rake: '%',
  prize: '★',
  rebuy: '↺',
  addon: '⊞',
  mint: '◆',
  settlement: '≡',
  commission: '◈',
  TIP: '♥',
  INSURANCE: '⊕',
  funding: '→',
  promotion: '↑',
  promo: '★',
  bbj: '♣',
  horse_refill: '↺',
  transfer: '→',
  deposit: '+',
  withdrawal: '-',
  refund: '↻',
  bonus: '★',
};

function TransactionHistoryInner({ walletId, limit = 20 }: TransactionHistoryProps) {
  const { user } = useAuthUser();
  const toast = useToast();

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const isMounted = useIsMounted();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRef = useRef<() => void>(() => {});

  // Stagger animation for transaction list
  useEffect(() => {
    if (transactions.length === 0) return;
    setVisibleItems(new Set());
    const timers = transactions.map((_, i) =>
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
    );
    return () => timers.forEach(clearTimeout);
  }, [transactions]);

  useEffect(() => {
    if (user?.id || walletId) {
      loadTransactions();
    }
  }, [user?.id, walletId]);

  // Bus listeners: auto-refresh on wallet events
  useEffect(() => {
    const debouncedRefresh = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        if (isMounted.current) loadRef.current();
      }, 500);
    };
    const unsubs = [
      masterBus.subscribe('BALANCE_UPDATED', debouncedRefresh),
      masterBus.subscribe('WALLET_REFRESHED', debouncedRefresh),
      masterBus.subscribe('CHIPS_DISTRIBUTED', debouncedRefresh),
    ];
    return () => {
      unsubs.forEach((u) => u());
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  const loadTransactions = async () => {
    if (!user?.id && !walletId) return;
    setLoading(true);

    try {
      let query = supabase
        .from('wallet_transactions')
        .select(
          'id, type, category, amount, balance_after, description, created_at, user_id, related_entity_id, wallet_type'
        )
        .order('created_at', { ascending: false })
        .limit(limit);

      if (walletId) {
        query = query.eq('user_id', walletId);
      } else {
        query = query.eq('user_id', user?.id);
      }

      const { data, error } = await query;

      if (!error && data) {
        setTransactions(
          data.map((t) => ({
            id: t.id,
            type: t.type, // credit or debit
            category: t.category, // buyin, cashout, rake, prize, etc.
            amount: t.amount,
            balance: t.balance_after || 0,
            description: t.description || '',
            createdAt: new Date(t.created_at),
            walletType: t.wallet_type || 'PLAYER',
          }))
        );
        // We will handle stagger animation in a useEffect based on transactions change
      }
    } catch (error) {
      toast.error('Failed to load transactions');
    }
    if (isMounted.current) setLoading(false);
  };

  // Keep loadRef in sync with latest loadTransactions
  loadRef.current = loadTransactions;

  const filteredTransactions =
    filter === 'all'
      ? transactions
      : filter === 'credit'
        ? transactions.filter((t) => t.type === 'credit')
        : filter === 'debit'
          ? transactions.filter((t) => t.type === 'debit')
          : transactions.filter((t) => t.category === filter);

  if (loading) {
    return <div className="transaction-history loading">Loading...</div>;
  }

  return (
    <div className="transaction-history">
      <div className="transaction-history__header">
        <h3> Transaction History</h3>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All</option>
          <option value="credit">Credits</option>
          <option value="debit">Debits</option>
          <option value="buyin">Buy-Ins</option>
          <option value="cashout">Cash-Outs</option>
          <option value="rake">Rake</option>
          <option value="prize">Prizes</option>
          <option value="transfer">Transfers</option>
          <option value="funding">Funding</option>
          <option value="bonus">Bonuses</option>
        </select>
      </div>

      {filteredTransactions.length === 0 ? (
        <div className="empty-state">No transactions</div>
      ) : (
        <div className="transaction-list">
          {filteredTransactions.map((tx, i) => (
            <div
              key={tx.id}
              className={`transaction-row ${tx.type}`}
              style={{
                opacity: visibleItems.has(i) ? 1 : 0,
                transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <span className="icon">{CATEGORY_ICONS[tx.category] || '●'}</span>
              <div className="details">
                <span className="type" style={{ color: CATEGORY_COLORS[tx.category] || '#94a3b8' }}>
                  {CATEGORY_LABELS[tx.category] || tx.category}
                </span>
                <span className="description">{tx.description}</span>
              </div>
              <div className="amounts">
                <span className={`amount ${tx.type === 'credit' ? 'positive' : 'negative'}`}>
                  {tx.type === 'credit' ? '+' : '-'}
                  {tx.amount.toLocaleString()}
                </span>
                <span className="balance">Bal: {tx.balance.toLocaleString()}</span>
              </div>
              <span className="time">
                {tx.createdAt.toLocaleDateString()}{' '}
                {tx.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const TransactionHistory = memo(TransactionHistoryInner);
export { TransactionHistory };
export default TransactionHistory;
