/**
 * ♠ CLUB ARENA — Hand Strength Indicator
 * Visual display of hand strength during gameplay
 */

import React, { useMemo, useState, useEffect, useRef } from 'react';
import './HandStrengthIndicator.css';

interface HandStrengthIndicatorProps {
  cards: string[]; // e.g., ['Ah', 'Kh']
  communityCards?: string[];
  showPercent?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

type HandRank =
  | 'high_card'
  | 'pair'
  | 'two_pair'
  | 'three_kind'
  | 'straight'
  | 'flush'
  | 'full_house'
  | 'four_kind'
  | 'straight_flush'
  | 'royal_flush';

interface HandEvaluation {
  rank: HandRank;
  name: string;
  strength: number; // 0-100
  color: string;
}

export const HandStrengthIndicator: React.FC<HandStrengthIndicatorProps> = ({
  cards,
  communityCards = [],
  showPercent = true,
  size = 'md',
}) => {
  const evaluation = useMemo(() => {
    return evaluateHand(cards, communityCards);
  }, [cards, communityCards]);

  const [fillWidth, setFillWidth] = useState(0);
  const [glowPulse, setGlowPulse] = useState(false);
  const prevEvaluationRef = useRef(evaluation);

  const getStrengthLabel = (strength: number): string => {
    if (strength >= 90) return 'Monster';
    if (strength >= 75) return 'Strong';
    if (strength >= 50) return 'Medium';
    if (strength >= 25) return 'Marginal';
    return 'Weak';
  };

  // Animate bar fill on mount and change
  useEffect(() => {
    const timer = setTimeout(() => setFillWidth(evaluation.strength), 50);
    return () => clearTimeout(timer);
  }, [evaluation.strength]);

  // Glow pulse when strength changes significantly
  useEffect(() => {
    const prevStrength = prevEvaluationRef.current.strength;
    if (Math.abs(evaluation.strength - prevStrength) >= 10) {
      setGlowPulse(true);
      const timer = setTimeout(() => setGlowPulse(false), 600);
      prevEvaluationRef.current = evaluation;
      return () => clearTimeout(timer);
    }
    prevEvaluationRef.current = evaluation;
  }, [evaluation.strength]);

  return (
    <div
      className={`hand-strength-indicator size-${size} ${glowPulse ? 'hand-strength-indicator--glow-pulse' : ''}`}
    >
      <div className="strength-bar-container">
        <div
          className="strength-bar-fill"
          style={{
            width: `${fillWidth}%`,
            background: evaluation.color,
          }}
        />
        <div className="strength-markers">
          {[25, 50, 75].map((mark) => (
            <div key={mark} className="marker" style={{ left: `${mark}%` }} />
          ))}
        </div>
      </div>
      <div className="strength-info">
        <span className="hand-name" style={{ color: evaluation.color }}>
          {evaluation.name}
        </span>
        {showPercent && (
          <span className="strength-percent">{getStrengthLabel(evaluation.strength)}</span>
        )}
      </div>
    </div>
  );
};

// FIX 193: Full hand evaluation with flush and straight detection
// (previous version was missing flush + straight — §1.10 Visual Truth Law violation)
const RANK_ORDER = '23456789TJQKA';

function getRankValue(rank: string): number {
  const idx = RANK_ORDER.indexOf(rank);
  return idx >= 0 ? idx : -1;
}

function evaluateHand(holeCards: string[], communityCards: string[]): HandEvaluation {
  const allCards = [...holeCards, ...communityCards];

  // Preflop strength based on hole cards
  if (communityCards.length === 0) {
    const ranks = holeCards.map((c) => c[0]);
    const suited = holeCards.length === 2 && holeCards[0][1] === holeCards[1][1];

    // Premium pairs
    if (ranks[0] === ranks[1] && ['A', 'K', 'Q', 'J'].includes(ranks[0])) {
      return { rank: 'pair', name: 'Premium Pair', strength: 90, color: '#27ae60' };
    }
    // Medium pairs
    if (ranks[0] === ranks[1]) {
      return { rank: 'pair', name: 'Pocket Pair', strength: 65, color: '#f39c12' };
    }
    // AK suited/offsuit
    if (ranks.includes('A') && ranks.includes('K')) {
      return {
        rank: 'high_card',
        name: suited ? 'AKs' : 'AKo',
        strength: suited ? 78 : 70,
        color: '#27ae60',
      };
    }
    // Suited Broadway
    if (suited && ranks.every((r) => ['A', 'K', 'Q', 'J', 'T'].includes(r))) {
      return { rank: 'high_card', name: 'Suited Broadway', strength: 60, color: '#f39c12' };
    }
    // Suited connectors
    if (suited) {
      return { rank: 'high_card', name: 'Suited', strength: 45, color: '#95a5a6' };
    }
    // Default
    return { rank: 'high_card', name: 'High Card', strength: 30, color: '#e74c3c' };
  }

  // ── Post-flop evaluation with flush + straight detection ──

  // Rank counts for pair/trips/quads
  const rankCounts: Record<string, number> = {};
  allCards.forEach((c) => {
    const r = c[0];
    rankCounts[r] = (rankCounts[r] || 0) + 1;
  });
  const counts = Object.values(rankCounts).sort((a, b) => b - a);

  // Flush detection: 5+ cards of same suit
  const suitCounts: Record<string, number> = {};
  allCards.forEach((c) => {
    const s = c[c.length - 1]; // last char is suit
    suitCounts[s] = (suitCounts[s] || 0) + 1;
  });
  const hasFlush = Object.values(suitCounts).some((count) => count >= 5);

  // Straight detection: 5 consecutive rank values
  const uniqueRanks = [...new Set(allCards.map((c) => getRankValue(c[0])))].filter(
    (v) => v >= 0
  );
  uniqueRanks.sort((a, b) => a - b);
  // Ace can also be low (value 12 plays as -1 for A-2-3-4-5)
  if (uniqueRanks.includes(12)) uniqueRanks.unshift(-1);

  let hasStraight = false;
  for (let i = 0; i <= uniqueRanks.length - 5; i++) {
    if (uniqueRanks[i + 4] - uniqueRanks[i] === 4) {
      // Verify all 5 values are consecutive (no gaps)
      let consecutive = true;
      for (let j = 1; j < 5; j++) {
        if (uniqueRanks[i + j] - uniqueRanks[i + j - 1] !== 1) {
          consecutive = false;
          break;
        }
      }
      if (consecutive) {
        hasStraight = true;
        break;
      }
    }
  }

  // Check for straight flush (both straight + flush in same suit)
  let hasStraightFlush = false;
  if (hasFlush && hasStraight) {
    // Check if the flush suit cards form a straight
    const flushSuit = Object.entries(suitCounts).find(([, count]) => count >= 5)?.[0];
    if (flushSuit) {
      const flushRanks = [
        ...new Set(
          allCards.filter((c) => c[c.length - 1] === flushSuit).map((c) => getRankValue(c[0]))
        ),
      ]
        .filter((v) => v >= 0)
        .sort((a, b) => a - b);
      if (flushRanks.includes(12)) flushRanks.unshift(-1);
      for (let i = 0; i <= flushRanks.length - 5; i++) {
        let consecutive = true;
        for (let j = 1; j < 5; j++) {
          if (flushRanks[i + j] - flushRanks[i + j - 1] !== 1) {
            consecutive = false;
            break;
          }
        }
        if (consecutive) {
          hasStraightFlush = true;
          // Check for royal flush (T-J-Q-K-A of same suit)
          if (flushRanks[i + 4] === 12 && flushRanks[i] === 8) {
            return {
              rank: 'royal_flush',
              name: 'Royal Flush',
              strength: 100,
              color: '#9b59b6',
            };
          }
          break;
        }
      }
    }
  }

  // Return best hand (ordered by strength)
  if (hasStraightFlush) {
    return { rank: 'straight_flush', name: 'Straight Flush', strength: 99, color: '#9b59b6' };
  }
  if (counts[0] >= 4) {
    return { rank: 'four_kind', name: 'Four of a Kind', strength: 98, color: '#9b59b6' };
  }
  if (counts[0] === 3 && counts[1] >= 2) {
    return { rank: 'full_house', name: 'Full House', strength: 95, color: '#9b59b6' };
  }
  if (hasFlush) {
    return { rank: 'flush', name: 'Flush', strength: 85, color: '#27ae60' };
  }
  if (hasStraight) {
    return { rank: 'straight', name: 'Straight', strength: 80, color: '#27ae60' };
  }
  if (counts[0] === 3) {
    return { rank: 'three_kind', name: 'Three of a Kind', strength: 75, color: '#27ae60' };
  }
  if (counts[0] === 2 && counts[1] === 2) {
    return { rank: 'two_pair', name: 'Two Pair', strength: 60, color: '#f39c12' };
  }
  if (counts[0] === 2) {
    return { rank: 'pair', name: 'One Pair', strength: 40, color: '#95a5a6' };
  }

  return { rank: 'high_card', name: 'High Card', strength: 20, color: '#e74c3c' };
}

export default HandStrengthIndicator;
