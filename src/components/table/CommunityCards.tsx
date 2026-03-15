/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  COMMUNITY CARDS — Flop/Turn/River Display (PNG Custom Deck)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Displays the community cards on the poker table using the custom PNG deck:
 * - Animated card deal effects
 * - Stage-based progressive reveal
 * - Card highlighting for winning hands
 * - Uses CardImage component for custom deck rendering
 */

import React, { useMemo, useEffect, useRef, useState, memo } from 'react';
import { CardImage, CardBack, type Card } from './CardImage';
import { haptic } from '../../services/SoundService';
import { ParticleSystem } from './ParticleSystem';
import { triggerScreenShake } from '../../utils/ScreenShake';
import './CommunityCards.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type { Card };

export type BoardStage = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

export interface CommunityCardsProps {
  cards: Card[];
  stage: BoardStage;
  highlightedIndices?: number[];
  isDealing?: boolean;
  winningHandName?: string; // e.g. "Straight" — shown as overlay at showdown
  deckStyle?: '4color' | '2color';
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function getVisibleCardCount(stage: BoardStage): number {
  switch (stage) {
    case 'preflop':
      return 0;
    case 'flop':
      return 3;
    case 'turn':
      return 4;
    case 'river':
    case 'showdown':
      return 5;
    default:
      return 0;
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
  stage: BoardStage;
  deckStyle?: '4color' | '2color';
}

function CardFace({
  card,
  index,
  isHighlighted,
  isDealing,
  stage,
  deckStyle = '4color',
}: CardFaceProps) {
  // Apply turn/river emphasis animations to the newly dealt card
  const isTurnCard = stage === 'turn' && index === 3;
  const isRiverCard = (stage === 'river' || stage === 'showdown') && index === 4;

  return (
    <div
      className={[
        'community-cards__card',
        isHighlighted ? 'community-cards__card--highlighted' : '',
        isDealing ? 'community-cards__card--dealing' : '',
        isTurnCard ? 'community-cards__card--turn' : '',
        isRiverCard ? 'community-cards__card--river' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ animationDelay: `${index * 100}ms`, '--card-index': index } as React.CSSProperties}
    >
      <CardImage card={card} deckStyle={deckStyle} size="lg" isHighlighted={isHighlighted} />
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
    <div className="community-cards__placeholder" style={{ animationDelay: `${index * 100}ms` }}>
      <CardBack size="lg" style="classic" />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

function CommunityCardsComponent({
  cards,
  stage,
  highlightedIndices = [],
  isDealing = false,
  winningHandName,
  deckStyle = '4color',
}: CommunityCardsProps) {
  const visibleCount = useMemo(() => getVisibleCardCount(stage), [stage]);
  const prevStageRef = useRef(stage);
  const prevCardCountRef = useRef(cards.length);
  const [showdownMode, setShowdownMode] = useState(false);
  const [highlightPop, setHighlightPop] = useState(false);
  const [showParticles, setShowParticles] = useState(false);
  const [particleOrigin, setParticleOrigin] = useState<{ x: number; y: number } | undefined>();
  const prevHighlightRef = useRef<number[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  // Haptic feedback when new community cards are dealt (triggered when cards array length increases)
  useEffect(() => {
    if (cards.length > prevCardCountRef.current) {
      haptic.medium();
      prevCardCountRef.current = cards.length;
    }
  }, [cards.length]);

  // Haptic feedback on stage transitions
  useEffect(() => {
    if (stage !== prevStageRef.current) {
      if (stage === 'flop') {
        haptic.medium();
      } else if (stage === 'turn') {
        haptic.light();
      } else if (stage === 'river') {
        haptic.medium();
      } else if (stage === 'showdown') {
        haptic.strong();
        setShowdownMode(true);

        // Screen shake on showdown
        triggerScreenShake('medium', containerRef.current);

        // Gold spark burst from board center
        if (containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          setParticleOrigin({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          });
        }
        setShowParticles(true);
        setTimeout(() => setShowParticles(false), 2500);
      }
      prevStageRef.current = stage;
    }
  }, [stage]);

  // Highlight pop animation — when highlightedIndices changes
  useEffect(() => {
    const highlightStr = JSON.stringify(highlightedIndices);
    const prevStr = JSON.stringify(prevHighlightRef.current);
    if (highlightStr !== prevStr && highlightedIndices.length > 0) {
      setHighlightPop(true);
      const timer = setTimeout(() => setHighlightPop(false), 400);
      prevHighlightRef.current = highlightedIndices;
      return () => clearTimeout(timer);
    }
    prevHighlightRef.current = highlightedIndices;
  }, [highlightedIndices]);

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
    <div
      ref={containerRef}
      className={`community-cards ${showdownMode ? 'community-cards--showdown' : ''}`}
    >
      {/* Card Container — no stage label clutter */}
      <div
        className={`community-cards__container ${highlightPop ? 'community-cards__container--highlight-pop' : ''}`}
      >
        {slots.map((slot, i) =>
          slot.type === 'card' ? (
            <CardFace
              key={`card-${i}`}
              card={slot.card}
              index={i}
              isHighlighted={slot.isHighlighted}
              isDealing={isDealing && i === visibleCount - 1}
              stage={stage}
              deckStyle={deckStyle}
            />
          ) : (
            <PlaceholderCard key={`placeholder-${i}`} index={i} />
          )
        )}
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

      {/* Winning Hand Name — PokerBros-style "Straight" label below community cards */}
      {winningHandName && <div className="community-cards__hand-name">{winningHandName}</div>}

      {/* Gold Spark Burst on Showdown */}
      <ParticleSystem
        active={showParticles}
        mode="sparks"
        origin={particleOrigin}
        count={50}
        intensity={1.5}
        duration={2500}
        onComplete={() => setShowParticles(false)}
      />
    </div>
  );
}

export const CommunityCards = memo(CommunityCardsComponent, (prev, next) => {
  // Return true if props are equal (skip re-render)
  if (prev.stage !== next.stage) return false;
  if (prev.isDealing !== next.isDealing) return false;
  if (prev.winningHandName !== next.winningHandName) return false;
  if (prev.deckStyle !== next.deckStyle) return false;
  if (JSON.stringify(prev.cards) !== JSON.stringify(next.cards)) return false;
  if (JSON.stringify(prev.highlightedIndices) !== JSON.stringify(next.highlightedIndices))
    return false;
  return true;
});

export default CommunityCards;
