/**
 * ♠ CLUB ARENA — Transaction History Component
 * Reusable chip transaction ledger display
 */

import { useState, useEffect } from 'react';
import { agentService } from '../services/AgentService';
import type { ChipTransaction } from '../types/database.types';
import './TransactionHistory.css';

interface TransactionHistoryProps {
    clubId: string;
    userId?: string;
    limit?: number;
    compact?: boolean;
}

export default function TransactionHistory({
    clubId,
    userId,
    limit = 20,
    compact = false
}: TransactionHistoryProps) {
    const [transactions, setTransactions] = useState<ChipTransaction[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        async function loadTransactions() {
            setIsLoading(true);
            try {
                const data = await agentService.getTransactionHistory(clubId, userId, limit);
                setTransactions(data);
            } catch (error) {
                console.error('Failed to load transactions:', error);
            }
            setIsLoading(false);
        }
        loadTransactions();
    }, [clubId, userId, limit]);

    if (isLoading) {
        return <div className="tx-loading">Loading transactions...</div>;
    }

    if (transactions.length === 0) {
        return (
            <div className="tx-empty">
                <span className="tx-empty-icon">📋</span>
                <p>No transactions yet</p>
            </div>
        );
    }

    return (
        <div className={`transaction-history ${compact ? 'compact' : ''}`}>
            <table className="tx-table">
                <thead>
                    <tr>
                        <th>Type</th>
                        <th>Amount</th>
                        {!compact && <th>From/To</th>}
                        {!compact && <th>Notes</th>}
                        <th>Date</th>
                    </tr>
                </thead>
                <tbody>
                    {transactions.map(tx => (
                        <tr key={tx.id} className={`tx-row ${tx.type}`}>
                            <td>
                                <span className="tx-type-badge">
                                    {getTypeIcon(tx.type)} {formatType(tx.type)}
                                </span>
                            </td>
                            <td>
                                <span className={`tx-amount ${isPositive(tx.type, userId) ? 'positive' : 'negative'}`}>
                                    {isPositive(tx.type, userId) ? '+' : '-'}${tx.amount.toLocaleString()}
                                </span>
                            </td>
                            {!compact && (
                                <td className="tx-parties">
                                    {tx.from_user_id || 'Club'} → {tx.to_user_id || 'Club'}
                                </td>
                            )}
                            {!compact && (
                                <td className="tx-notes">{tx.notes || '-'}</td>
                            )}
                            <td className="tx-date">
                                {formatDate(tx.created_at)}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function getTypeIcon(type: string): string {
    const icons: Record<string, string> = {
        deposit: '📥',
        withdrawal: '📤',
        buy_in: '🎰',
        cash_out: '💵',
        agent_transfer: '👔',
        rake: '🏦',
        bonus: '🎁',
        refund: '↩️',
    };
    return icons[type] || '💳';
}

function formatType(type: string): string {
    return type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

function isPositive(type: string, userId?: string): boolean {
    const positiveTypes = ['deposit', 'cash_out', 'bonus', 'refund'];
    return positiveTypes.includes(type);
}

function formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
}
