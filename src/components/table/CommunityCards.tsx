/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🃏 COMMUNITY CARDS — Flop/Turn/River Display
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Displays the community cards on the poker table with:
 * - Animated card deal effects
 * - Stage-based progressive reveal
 * - Card highlighting for winning hands
 */

import React, { useMemo } from 'react';
import './CommunityCards.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Card {
    rank: '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
    suit: 'h' | 'd' | 'c' | 's';
}

export type BoardStage = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

export interface CommunityCardsProps {
    cards: Card[];
    stage: BoardStage;
    highlightedIndices?: number[];
    isDealing?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

const SUIT_CONFIG: Record<string, { symbol: string; color: string; name: string }> = {
    h: { symbol: '♥', color: '#DC143C', name: 'hearts' },
    d: { symbol: '♦', color: '#DC143C', name: 'diamonds' },
    c: { symbol: '♣', color: '#1C1C1C', name: 'clubs' },
    s: { symbol: '♠', color: '#1C1C1C', name: 'spades' },
};

const RANK_DISPLAY: Record<string, string> = {
    '2': '2', '3': '3', '4': '4', '5': '5', '6': '6',
    '7': '7', '8': '8', '9': '9',
    'T': '10',
    'J': 'J', 'Q': 'Q', 'K': 'K', 'A': 'A',
};

function getVisibleCardCount(stage: BoardStage): number {
    switch (stage) {
        case 'preflop': return 0;
        case 'flop': return 3;
        case 'turn': return 4;
        case 'river':
        case 'showdown': return 5;
        default: return 0;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

interface CardFaceProps {
    card: Card;
    index: number;
    isHighlighted: boolean;
    isDealing: boolean;
}

function CardFace({ card, index, isHighlighted, isDealing }: CardFaceProps) {
    const suit = SUIT_CONFIG[card.suit];
    const rank = RANK_DISPLAY[card.rank];

    return (
        <div
            className={`community-cards__card ${isHighlighted ? 'community-cards__card--highlighted' : ''} ${isDealing ? 'community-cards__card--dealing' : ''}`}
            style={{
                animationDelay: `${index * 100}ms`,
                '--card-color': suit.color,
            } as React.CSSProperties}
        >
            <div className="community-cards__card-inner">
                {/* Top Left Corner */}
                <div className="community-cards__corner community-cards__corner--top">
                    <span className="community-cards__corner-rank" style={{ color: suit.color }}>
                        {rank}
                    </span>
                    <span className="community-cards__corner-suit" style={{ color: suit.color }}>
                        {suit.symbol}
                    </span>
                </div>

                {/* Center Suit */}
                <div className="community-cards__center-suit" style={{ color: suit.color }}>
                    {suit.symbol}
                </div>

                {/* Bottom Right Corner (Inverted) */}
                <div className="community-cards__corner community-cards__corner--bottom">
                    <span className="community-cards__corner-rank" style={{ color: suit.color }}>
                        {rank}
                    </span>
                    <span className="community-cards__corner-suit" style={{ color: suit.color }}>
                        {suit.symbol}
                    </span>
                </div>
            </div>

            {/* Highlight Glow */}
            {isHighlighted && <div className="community-cards__highlight-glow" />}
        </div>
    );
}

interface PlaceholderCardProps {
    index: number;
}

function PlaceholderCard({ index }: PlaceholderCardProps) {
    return (
        <div
            className="community-cards__placeholder"
            style={{ animationDelay: `${index * 100}ms` }}
        >
            <div className="community-cards__placeholder-pattern">
                <span>♠</span>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function CommunityCards({
    cards,
    stage,
    highlightedIndices = [],
    isDealing = false,
}: CommunityCardsProps) {
    const visibleCount = useMemo(() => getVisibleCardCount(stage), [stage]);

    // Create array of 5 slots
    const slots = useMemo(() => {
        return Array.from({ length: 5 }).map((_, i) => {
            if (i < visibleCount && cards[i]) {
                return {
                    type: 'card' as const,
                    card: cards[i],
                    isHighlighted: highlightedIndices.includes(i),
                };
            }
            return { type: 'placeholder' as const };
        });
    }, [cards, visibleCount, highlightedIndices]);

    return (
        <div className="community-cards">
            {/* Stage Label */}
            <div className="community-cards__stage-label">
                {stage.toUpperCase()}
            </div>

            {/* Card Container */}
            <div className="community-cards__container">
                {slots.map((slot, i) => (
                    slot.type === 'card' ? (
                        <CardFace
                            key={`card-${i}`}
                            card={slot.card}
                            index={i}
                            isHighlighted={slot.isHighlighted}
                            isDealing={isDealing && i === visibleCount - 1}
                        />
                    ) : (
                        <PlaceholderCard key={`placeholder-${i}`} index={i} />
                    )
                ))}
            </div>

            {/* Separator Lines */}
            {visibleCount >= 3 && (
                <>
                    <div className="community-cards__separator community-cards__separator--flop" />
                    {visibleCount >= 4 && (
                        <div className="community-cards__separator community-cards__separator--turn" />
                    )}
                </>
            )}
        </div>
    );
}

export default CommunityCards;
