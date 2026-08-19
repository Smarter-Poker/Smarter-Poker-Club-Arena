/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CARD REVEAL — Animated Hole Card Reveal (Custom PNG Deck)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Uses the custom PNG deck for card faces and custom card back images.
 * Features a 3D flip animation via CSS rotateY + backface-visibility.
 */

import React from 'react';
import { CardImage, CardBack, type Card } from './CardImage';
import './CardReveal.css';

interface CardRevealProps {
  cards: string[];
  isRevealed: boolean;
  isWinner?: boolean;
  handName?: string;
}

/**
 * Parse a string card format ("Ah", "Ts", "2d") into our Card type.
 * Handles both single-char ranks (2-9, T, J, Q, K, A) and "10" format.
 */
function parseCard(cardStr: string): Card {
  const suit = cardStr.slice(-1) as Card['suit'];
  let rank = cardStr.slice(0, -1);
  // Normalize "10" to "T"
  if (rank === '10') rank = 'T';
  return { rank: rank as Card['rank'], suit };
}

export function CardReveal({ cards, isRevealed, isWinner, handName }: CardRevealProps) {
  return (
    <div className={`card-reveal ${isRevealed ? 'revealed' : ''} ${isWinner ? 'winner' : ''}`}>
      <div className="cards">
        {cards.map((cardStr, idx) => {
          const card = parseCard(cardStr);
          return (
            <div
              key={idx}
              className={`card ${isRevealed ? 'flipped' : ''}`}
              style={{ animationDelay: `${idx * 0.1}s` }}
            >
              <div className="card-inner">
                <div className="card-back">
                  <CardBack style="classic_red" size="md" />
                </div>
                <div className="card-front">
                  <CardImage card={card} size="md" isHighlighted={isWinner} />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {handName && isRevealed && <div className="hand-name">{handName}</div>}
    </div>
  );
}

export default CardReveal;
