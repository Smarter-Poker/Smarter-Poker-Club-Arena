/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 📜 HAND HISTORY — Hand Detail & Replay Component
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PokerBros-style hand history display showing:
 * - All player hands with results
 * - Pot distribution
 * - Timeline scrubber
 * - Share functionality
 */

import React, { useState, useMemo } from 'react';
import './HandHistory.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Card {
    rank: '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
    suit: 'h' | 'd' | 'c' | 's';
}

export type PositionName = 'UTG' | 'UTG+1' | 'UTG+2' | 'MP' | 'MP+1' | 'HJ' | 'CO' | 'BTN' | 'SB' | 'BB';

export interface PlayerHandResult {
    playerId: string;
    playerName: string;
    position: PositionName;
    holeCards: Card[];
    handRank?: string; // e.g., "Two Pair", "Full House"
    potContribution: number;
    result: number; // + for win, - for loss
    isWinner: boolean;
    showCards: boolean;
}

export interface HandHistoryData {
    handId: string;
    timestamp: Date;
    blinds: string;
    gameType: string;
    mainPot: number;
    sidePots?: number[];
    communityCards: Card[];
    players: PlayerHandResult[];
}

export interface HandHistoryProps {
    isOpen: boolean;
    onClose: () => void;
    hand: HandHistoryData;
    onShare?: () => void;
    onFavorite?: () => void;
    currency?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

const SUIT_CONFIG: Record<string, { symbol: string; color: string }> = {
    h: { symbol: '♥', color: '#DC143C' },
    d: { symbol: '♦', color: '#DC143C' },
    c: { symbol: '♣', color: '#1C1C1C' },
    s: { symbol: '♠', color: '#1C1C1C' },
};

const RANK_DISPLAY: Record<string, string> = {
    'T': '10', 'J': 'J', 'Q': 'Q', 'K': 'K', 'A': 'A',
    '2': '2', '3': '3', '4': '4', '5': '5', '6': '6',
    '7': '7', '8': '8', '9': '9',
};

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
    const prefix = amount >= 0 ? (amount > 0 ? '+' : '') : '';
    const formatted = Math.abs(amount).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
    return `${prefix}${currency}${formatted}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

interface MiniCardProps {
    card: Card;
}

function MiniCard({ card }: MiniCardProps) {
    const suit = SUIT_CONFIG[card.suit];
    const rank = RANK_DISPLAY[card.rank] || card.rank;

    return (
        <span className="hh-mini-card" style={{ color: suit.color }}>
            {rank}{suit.symbol}
        </span>
    );
}

interface PlayerResultRowProps {
    player: PlayerHandResult;
    currency: string;
}

function PlayerResultRow({ player, currency }: PlayerResultRowProps) {
    return (
        <div className={`hh-player-row ${player.isWinner ? 'hh-player-row--winner' : ''}`}>
            {/* Player Info */}
            <div className="hh-player-info">
                <span className="hh-player-name">{player.playerName}</span>
                <span className="hh-player-position">[{player.position}]</span>

                {/* Cards */}
                <div className="hh-player-cards">
                    {player.showCards ? (
                        player.holeCards.map((card, i) => (
                            <MiniCard key={i} card={card} />
                        ))
                    ) : (
                        <span className="hh-cards-hidden">🂠🂠</span>
                    )}
                </div>

                {/* Hand Rank */}
                {player.handRank && (
                    <span className="hh-hand-rank">{player.handRank}</span>
                )}
            </div>

            {/* Result */}
            <div className="hh-player-result">
                <span className={`hh-result-amount ${player.result >= 0 ? 'hh-result-amount--positive' : 'hh-result-amount--negative'}`}>
                    {formatAmount(player.result, currency)}
                </span>
                {player.isWinner && (
                    <span className="hh-winner-badge">✓ WINNER</span>
                )}
                <span className="hh-pot-label">Main pot</span>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function HandHistory({
    isOpen,
    onClose,
    hand,
    onShare,
    onFavorite,
    currency = '',
}: HandHistoryProps) {
    const [currentAction, setCurrentAction] = useState(1);
    const [totalActions] = useState(1); // Would be dynamic in real implementation

    // Sort players: winners first, then by position
    const sortedPlayers = useMemo(() => {
        return [...hand.players].sort((a, b) => {
            if (a.isWinner && !b.isWinner) return -1;
            if (!a.isWinner && b.isWinner) return 1;
            return b.result - a.result;
        });
    }, [hand.players]);

    // Total pot
    const totalPot = useMemo(() => {
        return hand.mainPot + (hand.sidePots?.reduce((a, b) => a + b, 0) || 0);
    }, [hand.mainPot, hand.sidePots]);

    if (!isOpen) return null;

    return (
        <div className="hh-overlay" onClick={onClose}>
            <div className="hh-panel" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="hh-header">
                    <h2 className="hh-title">HAND DETAIL</h2>
                    <div className="hh-header-actions">
                        {onFavorite && (
                            <button className="hh-action-btn" onClick={onFavorite} title="Favorite">
                                ⭐
                            </button>
                        )}
                        <button className="hh-action-btn" title="Info">
                            ℹ️
                        </button>
                        <button className="hh-action-btn" title="Copy">
                            📋
                        </button>
                    </div>
                </div>

                {/* Hand Info */}
                <div className="hh-info">
                    <div className="hh-info-left">
                        <span className="hh-timestamp">{formatDateTime(hand.timestamp)}</span>
                        <span className="hh-blinds">{hand.blinds}</span>
                    </div>
                    <div className="hh-info-right">
                        <span className="hh-hand-id">SN: {hand.handId}</span>
                        {onShare && (
                            <button className="hh-share-btn" onClick={onShare}>
                                Share 📤
                            </button>
                        )}
                    </div>
                </div>

                {/* Pot Display */}
                <div className="hh-pot-summary">
                    <span className="hh-pot-label">Main Pot:</span>
                    <span className="hh-pot-amount">{formatAmount(hand.mainPot, currency).replace('+', '')}</span>
                </div>

                {/* Community Cards */}
                <div className="hh-community">
                    {hand.communityCards.map((card, i) => (
                        <MiniCard key={i} card={card} />
                    ))}
                </div>

                {/* Player Results */}
                <div className="hh-players">
                    {sortedPlayers.map((player) => (
                        <PlayerResultRow
                            key={player.playerId}
                            player={player}
                            currency={currency}
                        />
                    ))}
                </div>

                {/* Timeline Scrubber */}
                <div className="hh-timeline">
                    <span className="hh-timeline-counter">{currentAction}/{totalActions}</span>
                    <div className="hh-timeline-controls">
                        <button className="hh-timeline-btn" disabled={currentAction <= 1}>◀</button>
                        <input
                            type="range"
                            className="hh-timeline-slider"
                            min={1}
                            max={totalActions}
                            value={currentAction}
                            onChange={(e) => setCurrentAction(Number(e.target.value))}
                        />
                        <button className="hh-timeline-btn" disabled={currentAction >= totalActions}>▶</button>
                    </div>
                    <button className="hh-chat-btn" title="Chat">💬</button>
                </div>

                {/* Footer Tabs */}
                <div className="hh-footer">
                    <button className="hh-tab hh-tab--active">Hand Summary</button>
                    <button className="hh-tab">Hand Detail</button>
                    <button className="hh-tab hh-tab--small">all my</button>
                </div>
            </div>
        </div>
    );
}

export default HandHistory;
