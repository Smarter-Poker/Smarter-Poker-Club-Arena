/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🐰 RABBIT HUNT — See What Cards Would Have Come
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Post-hand feature showing undealt cards:
 * - Reveal remaining board cards
 * - Animation for drama
 * - Diamond cost indicator
 */

import React, { useState, useCallback } from 'react';
import './RabbitHunt.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Card {
    rank: string;
    suit: 'h' | 'd' | 'c' | 's';
}

export interface RabbitHuntProps {
    isAvailable: boolean;
    onReveal: () => Promise<Card[]>;
    cost?: number; // Diamond cost
    currentBoard: Card[];
    maxCards?: number; // How many cards to reveal (5 - currentBoard.length)
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

const SUIT_SYMBOLS: Record<string, string> = {
    h: '♥',
    d: '♦',
    c: '♣',
    s: '♠',
};

const SUIT_COLORS: Record<string, string> = {
    h: '#F85149',
    d: '#1877F2',
    c: '#3FB950',
    s: '#E4E6EB',
};

function formatCard(card: Card): string {
    return `${card.rank}${SUIT_SYMBOLS[card.suit]}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function RabbitHunt({
    isAvailable,
    onReveal,
    cost = 5,
    currentBoard,
    maxCards = 5,
}: RabbitHuntProps) {
    const [isRevealing, setIsRevealing] = useState(false);
    const [revealedCards, setRevealedCards] = useState<Card[]>([]);
    const [hasRevealed, setHasRevealed] = useState(false);

    // Cards remaining to reveal
    const cardsToReveal = maxCards - currentBoard.length;

    // Handle reveal click
    const handleReveal = useCallback(async () => {
        if (isRevealing || hasRevealed || !isAvailable) return;

        setIsRevealing(true);
        try {
            const cards = await onReveal();
            // Reveal cards one by one with delay
            for (let i = 0; i < cards.length; i++) {
                await new Promise((resolve) => setTimeout(resolve, 500));
                setRevealedCards((prev) => [...prev, cards[i]]);
            }
            setHasRevealed(true);
        } catch (error) {
            console.error('Rabbit hunt failed:', error);
        } finally {
            setIsRevealing(false);
        }
    }, [isRevealing, hasRevealed, isAvailable, onReveal]);

    if (!isAvailable && !hasRevealed) {
        return null;
    }

    return (
        <div className="rabbit-hunt">
            {/* Button */}
            {!hasRevealed && (
                <button
                    className={`rabbit-hunt__button ${isRevealing ? 'rabbit-hunt__button--loading' : ''}`}
                    onClick={handleReveal}
                    disabled={isRevealing}
                >
                    <span className="rabbit-hunt__icon">🐰</span>
                    <span className="rabbit-hunt__label">
                        {isRevealing ? 'Revealing...' : 'Rabbit Hunt'}
                    </span>
                    {cost > 0 && !isRevealing && (
                        <span className="rabbit-hunt__cost">
                            {cost} 💎
                        </span>
                    )}
                </button>
            )}

            {/* Revealed Cards */}
            {revealedCards.length > 0 && (
                <div className="rabbit-hunt__reveal">
                    <span className="rabbit-hunt__reveal-label">
                        🐰 Rabbit shows:
                    </span>
                    <div className="rabbit-hunt__cards">
                        {revealedCards.map((card, idx) => (
                            <div
                                key={idx}
                                className="rabbit-hunt__card"
                                style={{
                                    color: SUIT_COLORS[card.suit],
                                    animationDelay: `${idx * 0.1}s`,
                                }}
                            >
                                <span className="rabbit-hunt__rank">{card.rank}</span>
                                <span className="rabbit-hunt__suit">{SUIT_SYMBOLS[card.suit]}</span>
                            </div>
                        ))}
                        {/* Placeholder for unrevealed */}
                        {Array(cardsToReveal - revealedCards.length)
                            .fill(null)
                            .map((_, idx) => (
                                <div key={`pending-${idx}`} className="rabbit-hunt__card rabbit-hunt__card--pending">
                                    <span className="rabbit-hunt__pending-icon">?</span>
                                </div>
                            ))}
                    </div>
                </div>
            )}
        </div>
    );
}

export default RabbitHunt;
