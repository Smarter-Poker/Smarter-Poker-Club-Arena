/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 💰 CASH TABLE LIST — Available Cash Games Display
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Premium lobby table list with:
 * - Sortable columns
 * - Live player counts
 * - Wait list indicators
 * - Direct join buttons
 */

import React, { useState, useMemo, useCallback } from 'react';
import './CashTableList.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type SortField = 'name' | 'stakes' | 'players' | 'avgPot' | 'waitList';
export type SortDirection = 'asc' | 'desc';

export interface CashTable {
    id: string;
    name: string;
    variant: 'NLH' | 'PLO4' | 'PLO5' | 'PLO6' | 'PLO8';
    blinds: string;
    smallBlind: number;
    bigBlind: number;
    minBuyIn: number;
    maxBuyIn: number;
    maxSeats: number;
    seatedPlayers: number;
    waitListCount: number;
    avgPot: number;
    handsPerHour: number;
    isRunning: boolean;
    isPrivate: boolean;
    clubName?: string;
}

export interface CashTableListProps {
    tables: CashTable[];
    onJoinTable: (tableId: string) => void;
    onViewTable: (tableId: string) => void;
    onJoinWaitList: (tableId: string) => void;
    isLoading?: boolean;
    currency?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function formatAmount(amount: number, currency: string = ''): string {
    if (amount >= 1000) {
        return `${currency}${(amount / 1000).toFixed(1)}K`;
    }
    return `${currency}${amount.toLocaleString()}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

interface TableRowProps {
    table: CashTable;
    onJoin: () => void;
    onView: () => void;
    onWaitList: () => void;
    currency: string;
}

function TableRow({ table, onJoin, onView, onWaitList, currency }: TableRowProps) {
    const isFull = table.seatedPlayers >= table.maxSeats;
    const hasSeats = table.seatedPlayers < table.maxSeats;
    const seatRatio = table.seatedPlayers / table.maxSeats;

    // Seat indicator color
    const seatColor = seatRatio >= 0.9 ? '#F85149' : seatRatio >= 0.6 ? '#FFB800' : '#3FB950';

    return (
        <div className={`cash-table-row ${!table.isRunning ? 'cash-table-row--inactive' : ''}`}>
            {/* Table Info */}
            <div className="cash-table-row__info">
                <div className="cash-table-row__header">
                    <span className={`cash-table-row__variant cash-table-row__variant--${table.variant.toLowerCase()}`}>
                        {table.variant}
                    </span>
                    <span className="cash-table-row__name">{table.name}</span>
                    {table.isPrivate && <span className="cash-table-row__private">🔒</span>}
                </div>
                {table.clubName && (
                    <span className="cash-table-row__club">{table.clubName}</span>
                )}
            </div>

            {/* Stakes */}
            <div className="cash-table-row__stakes">
                <span className="cash-table-row__blinds">{table.blinds}</span>
                <span className="cash-table-row__buyin">
                    {formatAmount(table.minBuyIn, currency)}-{formatAmount(table.maxBuyIn, currency)}
                </span>
            </div>

            {/* Players */}
            <div className="cash-table-row__players">
                <div className="cash-table-row__seat-count" style={{ '--seat-color': seatColor } as React.CSSProperties}>
                    <span className="cash-table-row__seated">{table.seatedPlayers}</span>
                    <span className="cash-table-row__max">/{table.maxSeats}</span>
                </div>
                {table.waitListCount > 0 && (
                    <span className="cash-table-row__waitlist">+{table.waitListCount} waiting</span>
                )}
            </div>

            {/* Stats */}
            <div className="cash-table-row__stats">
                <div className="cash-table-row__stat">
                    <span className="cash-table-row__stat-value">{formatAmount(table.avgPot, currency)}</span>
                    <span className="cash-table-row__stat-label">Avg Pot</span>
                </div>
                <div className="cash-table-row__stat">
                    <span className="cash-table-row__stat-value">{table.handsPerHour}</span>
                    <span className="cash-table-row__stat-label">H/hr</span>
                </div>
            </div>

            {/* Actions */}
            <div className="cash-table-row__actions">
                <button className="cash-table-row__view-btn" onClick={onView}>
                    👁️
                </button>
                {hasSeats ? (
                    <button className="cash-table-row__join-btn" onClick={onJoin}>
                        Join
                    </button>
                ) : (
                    <button className="cash-table-row__waitlist-btn" onClick={onWaitList}>
                        Wait List
                    </button>
                )}
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function CashTableList({
    tables,
    onJoinTable,
    onViewTable,
    onJoinWaitList,
    isLoading = false,
    currency = '',
}: CashTableListProps) {
    const [sortField, setSortField] = useState<SortField>('players');
    const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

    // Handle sort toggle
    const handleSort = useCallback((field: SortField) => {
        if (sortField === field) {
            setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
        } else {
            setSortField(field);
            setSortDirection('desc');
        }
    }, [sortField]);

    // Sort tables
    const sortedTables = useMemo(() => {
        const sorted = [...tables].sort((a, b) => {
            let comparison = 0;
            switch (sortField) {
                case 'name':
                    comparison = a.name.localeCompare(b.name);
                    break;
                case 'stakes':
                    comparison = a.bigBlind - b.bigBlind;
                    break;
                case 'players':
                    comparison = a.seatedPlayers - b.seatedPlayers;
                    break;
                case 'avgPot':
                    comparison = a.avgPot - b.avgPot;
                    break;
                case 'waitList':
                    comparison = a.waitListCount - b.waitListCount;
                    break;
            }
            return sortDirection === 'asc' ? comparison : -comparison;
        });
        return sorted;
    }, [tables, sortField, sortDirection]);

    // Render sort indicator
    const renderSortIndicator = (field: SortField) => {
        if (sortField !== field) return null;
        return <span className="cash-table-list__sort-arrow">{sortDirection === 'asc' ? '▲' : '▼'}</span>;
    };

    if (isLoading) {
        return (
            <div className="cash-table-list cash-table-list--loading">
                <div className="cash-table-list__skeleton">
                    {[...Array(5)].map((_, i) => (
                        <div key={i} className="cash-table-list__skeleton-row" />
                    ))}
                </div>
            </div>
        );
    }

    if (tables.length === 0) {
        return (
            <div className="cash-table-list cash-table-list--empty">
                <div className="cash-table-list__empty-state">
                    <span className="cash-table-list__empty-icon">🎰</span>
                    <span className="cash-table-list__empty-text">No tables available</span>
                    <span className="cash-table-list__empty-hint">Try adjusting your filters or check back later</span>
                </div>
            </div>
        );
    }

    return (
        <div className="cash-table-list">
            {/* Header */}
            <div className="cash-table-list__header">
                <button
                    className={`cash-table-list__column cash-table-list__column--name ${sortField === 'name' ? 'cash-table-list__column--active' : ''}`}
                    onClick={() => handleSort('name')}
                >
                    Table {renderSortIndicator('name')}
                </button>
                <button
                    className={`cash-table-list__column cash-table-list__column--stakes ${sortField === 'stakes' ? 'cash-table-list__column--active' : ''}`}
                    onClick={() => handleSort('stakes')}
                >
                    Stakes {renderSortIndicator('stakes')}
                </button>
                <button
                    className={`cash-table-list__column cash-table-list__column--players ${sortField === 'players' ? 'cash-table-list__column--active' : ''}`}
                    onClick={() => handleSort('players')}
                >
                    Players {renderSortIndicator('players')}
                </button>
                <button
                    className={`cash-table-list__column cash-table-list__column--stats ${sortField === 'avgPot' ? 'cash-table-list__column--active' : ''}`}
                    onClick={() => handleSort('avgPot')}
                >
                    Stats {renderSortIndicator('avgPot')}
                </button>
                <div className="cash-table-list__column cash-table-list__column--actions">
                    Actions
                </div>
            </div>

            {/* Table Rows */}
            <div className="cash-table-list__body">
                {sortedTables.map((table) => (
                    <TableRow
                        key={table.id}
                        table={table}
                        onJoin={() => onJoinTable(table.id)}
                        onView={() => onViewTable(table.id)}
                        onWaitList={() => onJoinWaitList(table.id)}
                        currency={currency}
                    />
                ))}
            </div>

            {/* Footer */}
            <div className="cash-table-list__footer">
                <span className="cash-table-list__count">
                    {tables.length} table{tables.length !== 1 ? 's' : ''} • {tables.reduce((sum, t) => sum + t.seatedPlayers, 0)} players
                </span>
            </div>
        </div>
    );
}

export default CashTableList;
