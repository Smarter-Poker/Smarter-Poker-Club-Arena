/**
 * ♠ CLUB ARENA — Poker Table Component
 * PokerBros-style oval table with player seats
 */

import { useState, useEffect, useRef } from 'react';
import type { SeatPlayer, Card, CardSuit } from '../../types/database.types';
import './PokerTable.css';

// Helper to convert suit name to symbol
function getSuitSymbol(suit: CardSuit): string {
    switch (suit) {
        case 'hearts': return '♥';
        case 'diamonds': return '♦';
        case 'clubs': return '♣';
        case 'spades': return '♠';
        default: return suit;
    }
}

interface PokerTableProps {
    players: SeatPlayer[];
    communityCards: Card[];
    pot: number;
    currentBet: number;
    heroSeat: number;
    currentPlayerSeat: number;
    dealerSeat: number;
    gameType: string;
    blinds: string;
    maxPlayers: 6 | 9;
    onSeatClick?: (seat: number) => void;
}

export default function PokerTable({
    players,
    communityCards,
    pot,
    currentBet,
    heroSeat,
    currentPlayerSeat,
    dealerSeat,
    gameType,
    blinds,
    maxPlayers,
    onSeatClick,
}: PokerTableProps) {
    // Calculate seat positions based on max players
    const seatPositions = getSeatPositions(maxPlayers);

    // Find player at seat number
    const getPlayerAtSeat = (seat: number) => players.find(p => p.seat === seat);

    return (
        <div className="poker-table-container">
            {/* Table Felt */}
            <div className="table-felt">
                <div className="table-rim">
                    <div className="table-surface">
                        {/* Community Cards */}
                        <div className="community-area">
                            <div className="community-cards">
                                {communityCards.map((card, i) => (
                                    <div key={i} className="community-card">
                                        <span className={`card-value ${card.suit === 'hearts' || card.suit === 'diamonds' ? 'red' : 'black'}`}>
                                            {card.rank}{getSuitSymbol(card.suit)}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Pot Display */}
                        <div className="pot-display">
                            <span className="pot-label">POT</span>
                            <span className="pot-amount">{pot.toLocaleString()}</span>
                        </div>

                        {/* Game Info */}
                        <div className="game-info">
                            <span className="game-type">{gameType}</span>
                            <span className="game-blinds">Blinds: {blinds}</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Player Seats */}
            {seatPositions.map((pos, idx) => {
                const seatNum = idx + 1;
                const player = getPlayerAtSeat(seatNum);
                const isHero = seatNum === heroSeat;
                const isActive = seatNum === currentPlayerSeat;
                const isDealer = seatNum === dealerSeat;

                return (
                    <div
                        key={seatNum}
                        className={`seat seat-${seatNum}`}
                        style={{
                            left: `${pos.x}%`,
                            top: `${pos.y}%`,
                        }}
                    >
                        {player ? (
                            <PlayerSeat
                                player={player}
                                isHero={isHero}
                                isActive={isActive}
                                isDealer={isDealer}
                                dealerSeat={dealerSeat}
                                seatNum={seatNum}
                            />
                        ) : (
                            <EmptySeat onClick={() => onSeatClick?.(seatNum)} />
                        )}
                    </div>
                );
            })}
        </div>
    );
}

// Empty Seat Component
function EmptySeat({ onClick }: { onClick?: () => void }) {
    return (
        <button className="empty-seat" onClick={onClick}>
            <span className="plus-icon">+</span>
        </button>
    );
}

// Player Seat Component
function PlayerSeat({
    player,
    isHero,
    isActive,
    isDealer,
    dealerSeat,
    seatNum,
}: {
    player: SeatPlayer;
    isHero: boolean;
    isActive: boolean;
    isDealer: boolean;
    dealerSeat: number;
    seatNum: number;
}) {
    // Determine position badge
    const getPositionBadge = () => {
        if (isDealer) return <span className="position-badge dealer">D</span>;

        // Calculate SB/BB based on dealer
        const totalSeats = 6; // TODO: pass this in
        const sbSeat = (dealerSeat % totalSeats) + 1;
        const bbSeat = (sbSeat % totalSeats) + 1;

        if (seatNum === sbSeat) return <span className="position-badge sb">SB</span>;
        if (seatNum === bbSeat) return <span className="position-badge bb">BB</span>;
        return null;
    };

    return (
        <div className={`player-seat ${isHero ? 'hero' : ''} ${isActive ? 'active' : ''} ${player.is_folded ? 'folded' : ''}`}>
            {/* Position Badge */}
            {getPositionBadge()}

            {/* Avatar */}
            <div className="player-avatar">
                <span className="avatar-emoji">👤</span>
                {player.is_folded && <div className="folded-overlay">FOLD</div>}
            </div>

            {/* Player Info */}
            <div className="player-info">
                <span className="player-name">{player.username}</span>
                <span className="player-stack">{player.stack.toLocaleString()}</span>
            </div>

            {/* Bet Amount */}
            {player.bet > 0 && (
                <div className="player-bet">
                    <div className="bet-chips">💰</div>
                    <span className="bet-amount">{player.bet}</span>
                </div>
            )}

            {/* Cards (for hero or showdown) */}
            {isHero && player.cards && player.cards.length > 0 && (
                <div className="player-cards">
                    {player.cards.map((card, i) => (
                        <div key={i} className={`hole-card ${card.suit === 'hearts' || card.suit === 'diamonds' ? 'red' : 'black'}`}>
                            {card.rank}{getSuitSymbol(card.suit)}
                        </div>
                    ))}
                </div>
            )}

            {/* "New" badge for recently joined */}
            {!player.is_folded && player.bet === 0 && (
                <span className="new-badge">New</span>
            )}

            {/* Active Timer */}
            {isActive && !player.is_folded && (
                <div className="action-timer">
                    <div className="timer-bar"></div>
                </div>
            )}
        </div>
    );
}

// Seat position calculator
function getSeatPositions(maxPlayers: 6 | 9): { x: number; y: number }[] {
    if (maxPlayers === 6) {
        return [
            { x: 50, y: 90 },   // Seat 1 (hero - bottom center)
            { x: 15, y: 70 },   // Seat 2 (bottom left)
            { x: 10, y: 35 },   // Seat 3 (left)
            { x: 50, y: 5 },    // Seat 4 (top center)
            { x: 90, y: 35 },   // Seat 5 (right)
            { x: 85, y: 70 },   // Seat 6 (bottom right)
        ];
    }

    // 9-max positions
    return [
        { x: 50, y: 92 },   // Seat 1 (hero - bottom center)
        { x: 20, y: 85 },   // Seat 2
        { x: 5, y: 60 },    // Seat 3
        { x: 5, y: 35 },    // Seat 4
        { x: 25, y: 8 },    // Seat 5
        { x: 50, y: 3 },    // Seat 6
        { x: 75, y: 8 },    // Seat 7
        { x: 95, y: 35 },   // Seat 8
        { x: 95, y: 60 },   // Seat 9
    ];
}

export { PokerTable };
