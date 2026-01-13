/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 📊 REAL-TIME RESULTS — Session Stats Panel
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PokerBros-style real-time results panel showing:
 * - Session duration
 * - Table info
 * - Buy-in and winnings
 * - VPIP stats
 * - Observer list
 */

import React, { useState, useMemo } from 'react';
import './RealTimeResults.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TableInfo {
    id: string;
    name: string;
    gameType: 'NLH' | 'PLO4' | 'PLO5' | 'PLO6' | 'PLO8';
    blinds: string;
    restriction?: string;
    createdAt: Date;
}

export interface SessionStats {
    buyIn: number;
    winnings: number;
    handsPlayed: number;
    vpip: number; // 0-100
    pfr: number;  // 0-100
    sessionStart: Date;
}

export interface Observer {
    id: string;
    name: string;
    avatar?: string;
}

export interface RealTimeResultsProps {
    isOpen: boolean;
    onClose: () => void;
    tableInfo: TableInfo;
    sessionStats: SessionStats;
    observers: Observer[];
    currency?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function formatDuration(start: Date): string {
    const diff = Date.now() - start.getTime();
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function formatDateTime(date: Date): string {
    return date.toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

function formatAmount(amount: number, currency: string = ''): string {
    const formatted = amount.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
    return `${currency}${formatted}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function RealTimeResults({
    isOpen,
    onClose,
    tableInfo,
    sessionStats,
    observers,
    currency = '',
}: RealTimeResultsProps) {
    const [sessionDuration, setSessionDuration] = useState('00:00:00');

    // Update session duration every second
    React.useEffect(() => {
        const timer = setInterval(() => {
            setSessionDuration(formatDuration(sessionStats.sessionStart));
        }, 1000);
        return () => clearInterval(timer);
    }, [sessionStats.sessionStart]);

    // Calculate profit/loss
    const profitLoss = useMemo(() => {
        return sessionStats.winnings - sessionStats.buyIn;
    }, [sessionStats.winnings, sessionStats.buyIn]);

    if (!isOpen) return null;

    return (
        <div className="rtr-overlay" onClick={onClose}>
            <div className="rtr-panel" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="rtr-header">
                    <span className="rtr-duration">{sessionDuration}</span>
                    <h2 className="rtr-title">REAL TIME RESULT</h2>
                    <button className="rtr-close" onClick={onClose}>×</button>
                </div>

                {/* Table Info Section */}
                <div className="rtr-section">
                    <div className="rtr-row">
                        <span className="rtr-label">Game Name:</span>
                        <span className="rtr-value rtr-value--truncate">{tableInfo.name}</span>
                    </div>
                    <div className="rtr-row">
                        <span className="rtr-label">Game ID:</span>
                        <span className="rtr-value rtr-value--mono">{tableInfo.id}</span>
                    </div>
                    <div className="rtr-row">
                        <span className="rtr-label">Table Creation:</span>
                        <span className="rtr-value">{formatDateTime(tableInfo.createdAt)}</span>
                    </div>
                    <div className="rtr-row">
                        <span className="rtr-label">Table:</span>
                        <span className="rtr-value">{tableInfo.gameType}</span>
                    </div>
                    <div className="rtr-row">
                        <span className="rtr-label">Blinds:</span>
                        <span className="rtr-value">{tableInfo.blinds}</span>
                    </div>
                    {tableInfo.restriction && (
                        <div className="rtr-row">
                            <span className="rtr-label">Restriction:</span>
                            <span className="rtr-value rtr-value--badge">{tableInfo.restriction}</span>
                        </div>
                    )}
                </div>

                {/* Profile Data Section */}
                <div className="rtr-section">
                    <div className="rtr-section-header">Profile Data</div>
                    <div className="rtr-row">
                        <span className="rtr-label">Buy-in:</span>
                        <span className="rtr-value">{formatAmount(sessionStats.buyIn, currency)}</span>
                    </div>
                    <div className="rtr-row">
                        <span className="rtr-label">Winnings:</span>
                        <span className={`rtr-value ${profitLoss >= 0 ? 'rtr-value--positive' : 'rtr-value--negative'}`}>
                            {formatAmount(sessionStats.winnings, currency)}
                        </span>
                    </div>
                    <div className="rtr-row">
                        <span className="rtr-label">Current Table VPIP:</span>
                        <span className="rtr-value">
                            {sessionStats.vpip > 0 ? `${sessionStats.vpip.toFixed(0)}%` : '-%'}
                        </span>
                    </div>
                    <div className="rtr-row">
                        <span className="rtr-label">Hands Played:</span>
                        <span className="rtr-value">{sessionStats.handsPlayed}</span>
                    </div>
                </div>

                {/* Profit/Loss Summary */}
                <div className="rtr-summary">
                    <span className="rtr-summary-label">Net P/L:</span>
                    <span className={`rtr-summary-value ${profitLoss >= 0 ? 'rtr-summary-value--positive' : 'rtr-summary-value--negative'}`}>
                        {profitLoss >= 0 ? '+' : ''}{formatAmount(profitLoss, currency)}
                    </span>
                </div>

                {/* Observers Section */}
                <div className="rtr-section rtr-section--observers">
                    <div className="rtr-section-header">
                        Observers ({observers.length})
                    </div>
                    <div className="rtr-observers">
                        {observers.length === 0 ? (
                            <span className="rtr-no-observers">No observers</span>
                        ) : (
                            observers.map((observer) => (
                                <div key={observer.id} className="rtr-observer">
                                    <div className="rtr-observer-avatar">
                                        {observer.avatar ? (
                                            <img src={observer.avatar} alt={observer.name} />
                                        ) : (
                                            <span>{observer.name.charAt(0).toUpperCase()}</span>
                                        )}
                                    </div>
                                    <span className="rtr-observer-name">{observer.name}</span>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default RealTimeResults;
