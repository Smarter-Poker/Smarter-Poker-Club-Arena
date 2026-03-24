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
import { useStaggerAnimation } from '../../hooks/useStaggerAnimation';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
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
  const [txPage, setTxPage] = useState(1);
  const TX_PAGE_SIZE = 25;
  const isMounted = useIsMounted();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRef = useRef<() => void>(() => {});

  // Stagger animation for transaction list
  const { style: txStyle } = useStaggerAnimation(transactions.length);

  useEffect(() => {
    if (user?.id || walletId) {
      loadTransactions();
    }
  }, [user?.id, walletId]);

  // Bus listeners: auto-refresh on wallet events
  const debouncedRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      if (isMounted.current) loadRef.current();
    }, 500);
  }, [isMounted]);

  useMasterBusSubscription('BALANCE_UPDATED', debouncedRefresh);
  useMasterBusSubscription('WALLET_REFRESHED', debouncedRefresh);
  useMasterBusSubscription('CHIPS_DISTRIBUTED', debouncedRefresh);

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

  // Paginate: show txPage * TX_PAGE_SIZE items
  const visibleTransactions = filteredTransactions.slice(0, txPage * TX_PAGE_SIZE);
  const hasMore = filteredTransactions.length > visibleTransactions.length;

  if (loading) {
    return <div className="transaction-history loading">Loading...</div>;
  }

  return (
    <div className="transaction-history">
      <div className="transaction-history__header">
        <h3> Transaction History</h3>
        <select value={filter} onChange={(e) => { setFilter(e.target.value); setTxPage(1); }}>
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
          {visibleTransactions.map((tx, i) => (
            <div key={tx.id} className={`transaction-row ${tx.type}`} style={txStyle(i)}>
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
          {hasMore && (
            <button
              onClick={() => setTxPage((p) => p + 1)}
              style={{
                width: '100%',
                padding: '10px',
                marginTop: '8px',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '8px',
                color: '#94a3b8',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Load More ({filteredTransactions.length - visibleTransactions.length} remaining)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const TransactionHistory = memo(TransactionHistoryInner);
export { TransactionHistory };
export default TransactionHistory;
