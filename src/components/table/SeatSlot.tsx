/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🪑 SEAT SLOT — Individual Player Seat Component
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Renders a single seat at the poker table with:
 * - Player avatar and name
 * - Stack size display
 * - Hole cards (when visible)
 * - Action timer bar
 * - Status indicators (dealer, BB, SB, active)
 * - Action badges (fold, check, call, raise amount)
 */

import React, { useMemo } from 'react';
import './SeatSlot.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Card {
    rank: '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
    suit: 'h' | 'd' | 'c' | 's';
}

export type PlayerStatus = 'active' | 'away' | 'sitting_out' | 'folded' | 'all_in';
export type PositionBadge = 'D' | 'SB' | 'BB' | null;
export type LastAction = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all_in' | null;

export interface SeatPlayer {
    id: string;
    name: string;
    avatar?: string;
    stack: number;
    status: PlayerStatus;
    holeCards?: Card[];
    showCards: boolean;
    isHero: boolean;
}

export interface SeatSlotProps {
    seatNumber: number;
    player: SeatPlayer | null;
    position: PositionBadge;
    isActive: boolean;
    lastAction: LastAction;
    lastBetAmount?: number;
    timerProgress?: number; // 0-100
    onSit?: () => void;
    onAction?: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

const SUIT_SYMBOLS: Record<string, { symbol: string; color: string }> = {
    h: { symbol: '♥', color: '#DC143C' },
    d: { symbol: '♦', color: '#DC143C' },
    c: { symbol: '♣', color: '#1C1C1C' },
    s: { symbol: '♠', color: '#1C1C1C' },
};

const RANK_DISPLAY: Record<string, string> = {
    T: '10',
    J: 'J',
    Q: 'Q',
    K: 'K',
    A: 'A',
};

function formatStack(amount: number): string {
    if (amount >= 1000000) {
        return (amount / 1000000).toFixed(1) + 'M';
    }
    if (amount >= 1000) {
        return (amount / 1000).toFixed(1) + 'K';
    }
    return amount.toLocaleString();
}

function getActionLabel(action: LastAction, amount?: number): string {
    switch (action) {
        case 'fold': return 'FOLD';
        case 'check': return 'CHECK';
        case 'call': return amount ? `CALL ${formatStack(amount)}` : 'CALL';
        case 'bet': return amount ? `BET ${formatStack(amount)}` : 'BET';
        case 'raise': return amount ? `RAISE ${formatStack(amount)}` : 'RAISE';
        case 'all_in': return 'ALL IN';
        default: return '';
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

interface HoleCardProps {
    card?: Card;
    hidden?: boolean;
    index: number;
}

function HoleCard({ card, hidden = false, index }: HoleCardProps) {
    if (hidden || !card) {
        return (
            <div
                className="seat-slot__card seat-slot__card--hidden"
                style={{ transform: `rotate(${index === 0 ? -8 : 8}deg)` }}
            >
                <div className="seat-slot__card-back">
                    <span className="seat-slot__card-pattern">♠</span>
                </div>
            </div>
        );
    }

    const suit = SUIT_SYMBOLS[card.suit];
    const rank = RANK_DISPLAY[card.rank] || card.rank;

    return (
        <div
            className="seat-slot__card"
            style={{
                transform: `rotate(${index === 0 ? -8 : 8}deg)`,
                color: suit.color
            }}
        >
            <span className="seat-slot__card-rank">{rank}</span>
            <span className="seat-slot__card-suit">{suit.symbol}</span>
        </div>
    );
}

interface PositionChipProps {
    position: PositionBadge;
}

function PositionChip({ position }: PositionChipProps) {
    if (!position) return null;

    const colorMap: Record<string, string> = {
        D: '#FFFFFF',
        SB: '#4169E1',
        BB: '#FFD700',
    };

    return (
        <div
            className="seat-slot__position-chip"
            style={{ backgroundColor: colorMap[position] || '#FFFFFF' }}
        >
            {position}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function SeatSlot({
    seatNumber,
    player,
    position,
    isActive,
    lastAction,
    lastBetAmount,
    timerProgress,
    onSit,
    onAction,
}: SeatSlotProps) {

    // Memoize classes
    const containerClasses = useMemo(() => {
        const classes = ['seat-slot'];

        if (!player) {
            classes.push('seat-slot--empty');
        } else {
            classes.push(`seat-slot--${player.status}`);
            if (player.isHero) classes.push('seat-slot--hero');
            if (isActive) classes.push('seat-slot--active');
        }

        if (lastAction === 'fold') {
            classes.push('seat-slot--folded');
        }

        return classes.join(' ');
    }, [player, isActive, lastAction]);

    // ─────────────────────────────────────────────────────────────────────────────
    // EMPTY SEAT
    // ─────────────────────────────────────────────────────────────────────────────

    if (!player) {
        return (
            <div className={containerClasses} onClick={onSit}>
                <div className="seat-slot__empty-marker">
                    <span className="seat-slot__seat-number">Seat {seatNumber}</span>
                    <button className="seat-slot__sit-button">SIT</button>
                </div>
            </div>
        );
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // OCCUPIED SEAT
    // ─────────────────────────────────────────────────────────────────────────────

    return (
        <div className={containerClasses} onClick={onAction}>
            {/* Timer Bar */}
            {isActive && timerProgress !== undefined && (
                <div className="seat-slot__timer-bar">
                    <div
                        className="seat-slot__timer-fill"
                        style={{ width: `${timerProgress}%` }}
                    />
                </div>
            )}

            {/* Active Glow */}
            {isActive && <div className="seat-slot__active-glow" />}

            {/* Main Content */}
            <div className="seat-slot__content">
                {/* Avatar */}
                <div className="seat-slot__avatar-container">
                    {player.avatar ? (
                        <img
                            src={player.avatar}
                            alt={player.name}
                            className="seat-slot__avatar"
                        />
                    ) : (
                        <div className="seat-slot__avatar seat-slot__avatar--default">
                            {player.name.charAt(0).toUpperCase()}
                        </div>
                    )}

                    {/* Status Indicator */}
                    {player.status !== 'active' && player.status !== 'folded' && (
                        <div className={`seat-slot__status-dot seat-slot__status-dot--${player.status}`} />
                    )}
                </div>

                {/* Player Info */}
                <div className="seat-slot__info">
                    <span className="seat-slot__name">{player.name}</span>
                    <span className="seat-slot__stack">{formatStack(player.stack)}</span>
                </div>

                {/* Position Chip */}
                <PositionChip position={position} />
            </div>

            {/* Hole Cards */}
            {player.holeCards && player.holeCards.length > 0 && (
                <div className="seat-slot__cards">
                    {player.holeCards.map((card, i) => (
                        <HoleCard
                            key={i}
                            card={card}
                            hidden={!player.showCards && !player.isHero}
                            index={i}
                        />
                    ))}
                </div>
            )}

            {/* Last Action Badge */}
            {lastAction && (
                <div className={`seat-slot__action-badge seat-slot__action-badge--${lastAction}`}>
                    {getActionLabel(lastAction, lastBetAmount)}
                </div>
            )}

            {/* All-In Indicator */}
            {player.status === 'all_in' && (
                <div className="seat-slot__all-in-badge">ALL IN</div>
            )}
        </div>
    );
}

export default SeatSlot;
