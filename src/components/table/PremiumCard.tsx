/**
 * 🃏 PREMIUM CARD COMPONENT
 * High-end video game style playing card with 3D effects and animations
 */

import { useState, useEffect } from 'react';
import './PremiumCard.css';

// Local type definitions (compatible with club-engine Card type)
export interface PremiumCardType {
    rank: string;
    suit: 'h' | 'd' | 'c' | 's' | 'hearts' | 'diamonds' | 'clubs' | 'spades';
}

// Deck theme definitions with custom card back images
export type DeckTheme = 'classic' | 'burgundy' | 'navy' | 'gold';

export const DECK_THEMES: Record<DeckTheme, { name: string; image: string }> = {
    classic: { name: 'Classic', image: '/cards/backs/classic.jpg' },
    burgundy: { name: 'Burgundy', image: '/cards/backs/burgundy.jpg' },
    navy: { name: 'Navy', image: '/cards/backs/navy.jpg' },
    gold: { name: 'Premium Gold', image: '/cards/backs/gold.jpg' },
};

interface PremiumCardProps {
    card?: PremiumCardType;
    isHidden?: boolean;
    isDealing?: boolean;
    dealDelay?: number;
    size?: 'sm' | 'md' | 'lg';
    isHighlighted?: boolean;
    deckTheme?: DeckTheme;
    onClick?: () => void;
}

// Suit symbol and color mapping (handles both short and long suit names)
function getSuitInfo(suit: string): { symbol: string; color: string } {
    const suitMap: Record<string, { symbol: string; color: string }> = {
        h: { symbol: '♥', color: '#ff3b5c' },
        hearts: { symbol: '♥', color: '#ff3b5c' },
        d: { symbol: '♦', color: '#ff6b35' },
        diamonds: { symbol: '♦', color: '#ff6b35' },
        c: { symbol: '♣', color: '#1a1a2e' },
        clubs: { symbol: '♣', color: '#1a1a2e' },
        s: { symbol: '♠', color: '#1a1a2e' },
        spades: { symbol: '♠', color: '#1a1a2e' },
    };
    return suitMap[suit] || { symbol: '?', color: '#333' };
}

// Card sizes
const SIZES = {
    sm: { width: 44, height: 62 },
    md: { width: 56, height: 78 },
    lg: { width: 72, height: 100 },
};

export default function PremiumCard({
    card,
    isHidden = false,
    isDealing = false,
    dealDelay = 0,
    size = 'md',
    isHighlighted = false,
    deckTheme = 'gold',
    onClick,
}: PremiumCardProps) {
    const [isFlipped, setIsFlipped] = useState(isHidden);
    const [isDealt, setIsDealt] = useState(!isDealing);

    // Handle deal animation
    useEffect(() => {
        if (isDealing) {
            const timer = setTimeout(() => {
                setIsDealt(true);
            }, dealDelay);
            return () => clearTimeout(timer);
        }
    }, [isDealing, dealDelay]);

    // Handle flip animation
    useEffect(() => {
        if (!isHidden && isFlipped && isDealt) {
            const timer = setTimeout(() => {
                setIsFlipped(false);
            }, 150);
            return () => clearTimeout(timer);
        }
    }, [isHidden, isFlipped, isDealt]);

    const dimensions = SIZES[size];
    const suit = card ? getSuitInfo(card.suit) : null;
    const theme = DECK_THEMES[deckTheme];

    return (
        <div
            className={`premium-card-wrapper ${isDealt ? 'dealt' : 'dealing'} ${isHighlighted ? 'highlighted' : ''}`}
            style={{
                width: dimensions.width,
                height: dimensions.height,
                transitionDelay: `${dealDelay}ms`,
            }}
            onClick={onClick}
        >
            <div className={`premium-card ${isFlipped || isHidden ? 'flipped' : ''}`}>
                {/* Card Front */}
                <div className="card-front">
                    {card && suit && (
                        <>
                            {/* Top Left Corner */}
                            <div className="card-corner top-left">
                                <span className="card-rank" style={{ color: suit.color }}>
                                    {card.rank}
                                </span>
                                <span className="card-suit-mini" style={{ color: suit.color }}>
                                    {suit.symbol}
                                </span>
                            </div>

                            {/* Center Suit */}
                            <div className="card-center">
                                <span
                                    className="card-suit-main"
                                    style={{ color: suit.color }}
                                >
                                    {suit.symbol}
                                </span>
                            </div>

                            {/* Bottom Right Corner (inverted) */}
                            <div className="card-corner bottom-right">
                                <span className="card-rank" style={{ color: suit.color }}>
                                    {card.rank}
                                </span>
                                <span className="card-suit-mini" style={{ color: suit.color }}>
                                    {suit.symbol}
                                </span>
                            </div>

                            {/* Shine Effect */}
                            <div className="card-shine" />
                        </>
                    )}
                </div>

                {/* Card Back - Using custom image */}
                <div className="card-back">
                    <img
                        src={theme.image}
                        alt="Card Back"
                        className="card-back-image"
                    />
                </div>
            </div>
        </div>
    );
}

// Card placeholder for empty slots
export function CardPlaceholder({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
    const dimensions = SIZES[size];
    return (
        <div
            className="card-placeholder"
            style={{ width: dimensions.width, height: dimensions.height }}
        >
            <div className="placeholder-inner" />
        </div>
    );
}

export { PremiumCard };
