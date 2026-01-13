/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 💰 JACKPOT HISTORY — Big Wins
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * List of recent Bad Beat Jackpot hits.
 * - Winner info
 * - Hand details
 * - Payout amounts
 * - Replay link
 */

import React from 'react';
import './JackpotHistory.css';

export interface JackpotHit {
    id: string;
    date: string;
    winnerName: string;
    loserName: string; // The person who had the bad beat (main winner)
    hand: string; // e.g. "Quad Aces vs Royal Flush"
    totalJackpot: number;
    winnerShare: number;
    tableShare: number;
}

export interface JackpotHistoryProps {
    isOpen: boolean;
    onClose: () => void;
    hits: JackpotHit[];
    currency?: string;
    onReplay: (id: string) => void;
}

export function JackpotHistory({
    isOpen,
    onClose,
    hits,
    currency = '💎',
    onReplay,
}: JackpotHistoryProps) {
    if (!isOpen) return null;

    return (
        <div className="jackpot-overlay" onClick={onClose}>
            <div className="jackpot-modal" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="jackpot-header">
                    <div className="jackpot-title-group">
                        <span className="jackpot-icon">🎰</span>
                        <h2 className="jackpot-title">Jackpot History</h2>
                    </div>
                    <button className="jackpot-close" onClick={onClose}>×</button>
                </div>

                {/* Content */}
                <div className="jackpot-content">
                    <table className="jackpot-table">
                        <thead>
                            <tr>
                                <th>Date</th>
                                <th>Bad Beat Winner</th>
                                <th>Winning Hand</th>
                                <th>Hand Matchup</th>
                                <th>Total Pool</th>
                                <th>Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            {hits.length > 0 ? (
                                hits.map((hit) => (
                                    <tr key={hit.id}>
                                        <td className="col-date">{hit.date}</td>
                                        <td className="col-player">
                                            <span className="player-highlight">{hit.loserName}</span>
                                            <span className="sub-text">won {currency}{hit.winnerShare.toLocaleString()}</span>
                                        </td>
                                        <td className="col-player">
                                            <span>{hit.winnerName}</span>
                                        </td>
                                        <td className="col-hand">{hit.hand}</td>
                                        <td className="col-amount">{currency}{hit.totalJackpot.toLocaleString()}</td>
                                        <td>
                                            <button className="replay-btn" onClick={() => onReplay(hit.id)}>
                                                ▶ Replay
                                            </button>
                                        </td>
                                    </tr>
                                ))
                            ) : (
                                <tr>
                                    <td colSpan={6} className="table-empty">No jackpot hits yet. Keep grinding!</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}

export default JackpotHistory;
