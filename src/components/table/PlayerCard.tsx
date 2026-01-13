/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🃏 PLAYER CARD — Hole Card Display with Animations
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Premium hole card component featuring:
 * - Card deal animations
 * - Flip reveal for showdown
 * - Peek animation for hero
 * - Winner highlight effects
 */

import React, { useState, useEffect, useMemo } from 'react';
import './PlayerCard.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Card {
    rank: '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
    suit: 'h' | 'd' | 'c' | 's';
}

export interface PlayerCardProps {
    card?: Card;
    index: number; // 0 or 1 for positioning
    isVisible: boolean;
    isHero?: boolean;
    isWinner?: boolean;
    isDealing?: boolean;
    isFlipping?: boolean;
    size?: 'small' | 'medium' | 'large' | 'hero';
    dealDelay?: number; // ms delay before deal animation
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
    '2': '2', '3': '3', '4': '4', '5': '5', '6': '6',
    '7': '7', '8': '8', '9': '9', 'T': '10',
    'J': 'J', 'Q': 'Q', 'K': 'K', 'A': 'A',
};

const SIZE_CONFIG = {
    small: { width: 32, height: 44, fontSize: 10 },
    medium: { width: 44, height: 62, fontSize: 12 },
    large: { width: 56, height: 78, fontSize: 14 },
    hero: { width: 72, height: 100, fontSize: 18 },
};

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function PlayerCard({
    card,
    index,
    isVisible,
    isHero = false,
    isWinner = false,
    isDealing = false,
    isFlipping = false,
    size = 'medium',
    dealDelay = 0,
}: PlayerCardProps) {
    const [hasDealt, setHasDealt] = useState(!isDealing);
    const [isFlipped, setIsFlipped] = useState(isVisible);

    // Handle deal animation
    useEffect(() => {
        if (isDealing && !hasDealt) {
            const timer = setTimeout(() => {
                setHasDealt(true);
            }, dealDelay + 200);
            return () => clearTimeout(timer);
        }
    }, [isDealing, dealDelay, hasDealt]);

    // Handle flip animation
    useEffect(() => {
        if (isFlipping && !isFlipped) {
            const timer = setTimeout(() => {
                setIsFlipped(true);
            }, 150);
            return () => clearTimeout(timer);
        }
        if (isVisible && !isFlipping) {
            setIsFlipped(true);
        }
    }, [isFlipping, isVisible, isFlipped]);

    // Get size config
    const sizeConfig = SIZE_CONFIG[size];

    // Card rotation for natural look
    const rotation = index === 0 ? -8 : 8;
    const offsetX = index === 0 ? -6 : 6;

    // Build class names
    const classNames = useMemo(() => {
        const classes = ['player-card'];
        if (isHero) classes.push('player-card--hero');
        if (isWinner) classes.push('player-card--winner');
        if (isDealing && !hasDealt) classes.push('player-card--dealing');
        if (hasDealt && isDealing) classes.push('player-card--dealt');
        if (isFlipping) classes.push('player-card--flipping');
        if (isFlipped && isVisible) classes.push('player-card--face-up');
        classes.push(`player-card--${size}`);
        return classes.join(' ');
    }, [isHero, isWinner, isDealing, hasDealt, isFlipping, isFlipped, isVisible, size]);

    // Get suit config if card is provided
    const suit = card ? SUIT_CONFIG[card.suit] : null;
    const rank = card ? RANK_DISPLAY[card.rank] : null;

    return (
        <div
            className={classNames}
            style={{
                width: sizeConfig.width,
                height: sizeConfig.height,
                transform: `translateX(${offsetX}px) rotate(${rotation}deg)`,
                animationDelay: `${dealDelay}ms`,
                zIndex: index === 0 ? 1 : 2,
            }}
        >
            <div className="player-card__inner">
                {/* Card Back */}
                <div className="player-card__back">
                    <div className="player-card__back-pattern">
                        <span className="player-card__back-symbol">♠</span>
                        <div className="player-card__back-border" />
                    </div>
                </div>

                {/* Card Face */}
                <div
                    className="player-card__face"
                    style={{
                        '--card-color': suit?.color || '#000',
                        fontSize: sizeConfig.fontSize,
                    } as React.CSSProperties}
                >
                    {card && (
                        <>
                            {/* Top Left Corner */}
                            <div className="player-card__corner player-card__corner--top">
                                <span className="player-card__rank" style={{ color: suit?.color }}>
                                    {rank}
                                </span>
                                <span className="player-card__suit" style={{ color: suit?.color }}>
                                    {suit?.symbol}
                                </span>
                            </div>

                            {/* Center Suit */}
                            <div className="player-card__center" style={{ color: suit?.color }}>
                                {suit?.symbol}
                            </div>

                            {/* Bottom Right Corner (Inverted) */}
                            <div className="player-card__corner player-card__corner--bottom">
                                <span className="player-card__rank" style={{ color: suit?.color }}>
                                    {rank}
                                </span>
                                <span className="player-card__suit" style={{ color: suit?.color }}>
                                    {suit?.symbol}
                                </span>
                            </div>
                        </>
                    )}
                </div>
            </div>

            {/* Winner Glow Effect */}
            {isWinner && <div className="player-card__winner-glow" />}

            {/* Hero Peek Animation */}
            {isHero && !isFlipped && (
                <div className="player-card__peek-indicator">
                    <span>PEEK</span>
                </div>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// HOLE CARDS CONTAINER
// ═══════════════════════════════════════════════════════════════════════════════

export interface HoleCardsProps {
    cards: Card[];
    isVisible: boolean;
    isHero?: boolean;
    isWinner?: boolean;
    isDealing?: boolean;
    size?: 'small' | 'medium' | 'large' | 'hero';
}

export function HoleCards({
    cards,
    isVisible,
    isHero = false,
    isWinner = false,
    isDealing = false,
    size = 'medium',
}: HoleCardsProps) {
    return (
        <div className={`hole-cards hole-cards--${size} ${isHero ? 'hole-cards--hero' : ''}`}>
            {cards.slice(0, 2).map((card, index) => (
                <PlayerCard
                    key={index}
                    card={card}
                    index={index}
                    isVisible={isVisible}
                    isHero={isHero}
                    isWinner={isWinner}
                    isDealing={isDealing}
                    size={size}
                    dealDelay={index * 150}
                />
            ))}

            {/* PLO Additional Cards (3-4) */}
            {cards.length > 2 && (
                <div className="hole-cards__extra">
                    {cards.slice(2, 4).map((card, index) => (
                        <PlayerCard
                            key={index + 2}
                            card={card}
                            index={index}
                            isVisible={isVisible}
                            isHero={isHero}
                            isWinner={isWinner}
                            isDealing={isDealing}
                            size={size === 'hero' ? 'large' : size}
                            dealDelay={(index + 2) * 150}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

export default PlayerCard;
