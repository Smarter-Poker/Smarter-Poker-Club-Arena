/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 📜 HAND HISTORY MODAL — Detailed Hand Viewer
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Detailed history of played hands:
 * - List of recent hands with summary
 * - Detailed "Text View" (PokerStars format)
 * - "Replay" action integration
 * - Copy/Share functionality
 */

import React, { useState } from 'react';
import './HandHistoryModal.css';

export interface HistoricalHand {
    id: string;
    handNumber: string;
    timestamp: string;
    variant: string;
    stakes: string;
    winner: string;
    potSize: number;
    holeCards: string[]; // e.g. ["Ah", "Kd"]
    board: string[];
    netResult: number; // e.g. +50 or -100
}

export interface HandHistoryModalProps {
    isOpen: boolean;
    onClose: () => void;
    hands: HistoricalHand[];
    currency?: string;
    onReplay: (handId: string) => void;
    onShare: (handId: string) => void;
}

export function HandHistoryModal({
    isOpen,
    onClose,
    hands,
    currency = '$',
    onReplay,
    onShare,
}: HandHistoryModalProps) {
    const [selectedHandId, setSelectedHandId] = useState<string | null>(null);

    if (!isOpen) return null;

    const selectedHand = hands.find((h) => h.id === selectedHandId) || hands[0];

    return (
        <div className="history-overlay" onClick={onClose}>
            <div className="history-modal" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="history-modal__header">
                    <div className="history-modal__title-group">
                        <span className="history-modal__icon">📜</span>
                        <h2 className="history-modal__title">Hand History</h2>
                    </div>
                    <button className="history-modal__close" onClick={onClose}>×</button>
                </div>

                <div className="history-layout">
                    {/* Sidebar: List of Hands */}
                    <div className="history-sidebar">
                        {hands.map((hand) => (
                            <div
                                key={hand.id}
                                className={`history-item ${selectedHand?.id === hand.id ? 'active' : ''}`}
                                onClick={() => setSelectedHandId(hand.id)}
                            >
                                <div className="history-item__top">
                                    <span className="history-item__id">#{hand.handNumber}</span>
                                    <span className="history-item__time">{hand.timestamp}</span>
                                </div>
                                <div className="history-item__mid">
                                    <div className="history-cards">
                                        {hand.holeCards.map((card, i) => (
                                            <span key={i} className={`card-mini card-${card[1]}`}>{card}</span>
                                        ))}
                                    </div>
                                    <span className={`history-result ${hand.netResult >= 0 ? 'pos' : 'neg'}`}>
                                        {hand.netResult >= 0 ? '+' : ''}{currency}{Math.abs(hand.netResult)}
                                    </span>
                                </div>
                                <div className="history-item__bot">
                                    <span className="history-winner">Winner: {hand.winner}</span>
                                    <span className="history-pot">Pot: {currency}{hand.potSize}</span>
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Main Content: Details */}
                    <div className="history-detail">
                        {selectedHand ? (
                            <>
                                <div className="detail-header">
                                    <div className="detail-info">
                                        <h3 className="detail-variant">{selectedHand.variant} - {selectedHand.stakes}</h3>
                                        <span className="detail-id">Hand #{selectedHand.handNumber}</span>
                                    </div>
                                    <div className="detail-actions">
                                        <button className="action-btn" onClick={() => onReplay(selectedHand.id)}>
                                            ▶️ Replay
                                        </button>
                                        <button className="action-btn" onClick={() => onShare(selectedHand.id)}>
                                            🔗 Share
                                        </button>
                                    </div>
                                </div>

                                <div className="detail-board">
                                    <span className="board-label">Community Cards</span>
                                    <div className="board-cards">
                                        {selectedHand.board.length > 0 ? (
                                            selectedHand.board.map((card, i) => (
                                                <div key={i} className={`playing-card card-${card[1]}`}>
                                                    {card}
                                                </div>
                                            ))
                                        ) : (
                                            <span className="no-board">No Flop</span>
                                        )}
                                    </div>
                                </div>

                                <div className="detail-summary">
                                    <div className="summary-row">
                                        <span>Winner</span>
                                        <strong>{selectedHand.winner}</strong>
                                    </div>
                                    <div className="summary-row">
                                        <span>Total Pot</span>
                                        <strong>{currency}{selectedHand.potSize}</strong>
                                    </div>
                                    <div className="summary-row">
                                        <span>Your Net</span>
                                        <strong className={selectedHand.netResult >= 0 ? 'pos' : 'neg'}>
                                            {selectedHand.netResult >= 0 ? '+' : ''}{currency}{selectedHand.netResult}
                                        </strong>
                                    </div>
                                </div>

                                {/* Placeholder for raw text history */}
                                <div className="detail-raw">
                                    <pre className="raw-text">
                                        {`PokerStars Hand #${selectedHand.handNumber}: ${selectedHand.variant} (${selectedHand.stakes}) - ${selectedHand.timestamp}
Table '${selectedHand.variant}' 6-max Seat #1 is the button
Seat 1: Player1 ($100 in chips)
Seat 2: Player2 ($120 in chips)
...
*** HOLE CARDS ***
Dealt to Hero [${selectedHand.holeCards.join(' ')}]
...
*** SUMMARY ***
Total pot ${currency}${selectedHand.potSize} | Rake ${currency}2.00
Board [${selectedHand.board.join(' ')}]
Seat 1: Player1 won (${currency}${selectedHand.potSize})`}
                                    </pre>
                                </div>
                            </>
                        ) : (
                            <div className="detail-empty">Select a hand to view details</div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default HandHistoryModal;
