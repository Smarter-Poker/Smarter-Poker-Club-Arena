/**
 * Poker Hand Odds Calculator
 * Calculates approximate hand equity based on board texture and hand ranges
 */

export interface HandOdds {
  equity: number; // 0-100 percentage
  outs: number;
  potOdds: number;
  isDrawing: boolean;
  drawType?: 'flush-draw' | 'straight-draw' | 'combo-draw' | 'gutshot' | 'overcards';
}

export interface PositionInfo {
  name: string;
  displayName: string;
  advice: string;
  tier: 'utg' | 'mid' | 'late' | 'blind';
}

// Card rank/suit types
type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
type Suit = 'h' | 'd' | 'c' | 's';

/**
 * Count potential outs (winning cards) based on hole cards and board
 */
export function countOuts(holeCards: string[], board: string[]): number {
  if (holeCards.length < 2 || board.length < 3) return 0;

  const allCards = [...holeCards, ...board];
  const suits = allCards.map((c) => c[1]);
  const ranks = allCards.map((c) => c[0]);

  let outs = 0;
  const rankValues: Record<string, number> = {
    '2': 2,
    '3': 3,
    '4': 4,
    '5': 5,
    '6': 6,
    '7': 7,
    '8': 8,
    '9': 9,
    T: 10,
    J: 11,
    Q: 12,
    K: 13,
    A: 14,
  };

  // Check for flush draw (4 to a suit)
  const suitCounts: Record<string, number> = {};
  suits.forEach((s) => {
    suitCounts[s] = (suitCounts[s] || 0) + 1;
  });
  const maxSuitCount = Math.max(...Object.values(suitCounts));
  if (maxSuitCount === 4 && board.length < 5) outs += 9;

  // Check for straight draw (simplified)
  const uniqueRanks = [...new Set(ranks.map((r) => rankValues[r] || 0))]
    .sort((a, b) => a - b)
    .filter((r) => r > 0);

  // Open-ended straight draw
  if (board.length >= 3) {
    for (let i = 0; i < uniqueRanks.length - 2; i++) {
      if (uniqueRanks[i + 2] - uniqueRanks[i] === 2) {
        outs += 8;
        break;
      }
    }
  }

  // Overcards (simplified - cards higher than board)
  if (board.length > 0) {
    const boardRanks = board.map((c) => rankValues[c[0]] || 0).filter((r) => r > 0);
    const maxBoardRank = Math.max(...boardRanks);
    const overcardsCount = holeCards.filter((c) => (rankValues[c[0]] || 0) > maxBoardRank).length;
    if (overcardsCount > 0) outs += overcardsCount * 3; // Approximate: 3 outs per overcard
  }

  return Math.min(Math.max(outs, 0), 20); // Cap at reasonable range
}

/**
 * Calculate equity percentage based on outs and cards to come
 */
export function calculateEquity(outs: number, cardsTocome: number): number {
  if (cardsTocome === 2) {
    // Rule of 4 for turn + river
    return Math.min(outs * 4, 100);
  }
  // Rule of 2 for single card
  return Math.min(outs * 2, 100);
}

/**
 * Get position name based on seat index at the table
 */
export function getPositionName(seatIndex: number, totalSeats: number, dealerSeat: number): string {
  const positions: Record<number, string[]> = {
    2: ['SB', 'BB'],
    6: ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'],
    9: ['UTG', 'UTG+1', 'UTG+2', 'MP', 'MP+1', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  };

  const positionNames = positions[totalSeats] || positions[6];
  const relativePosition = (seatIndex - dealerSeat - 1 + totalSeats) % totalSeats;
  return positionNames[relativePosition % positionNames.length] || `Seat ${seatIndex + 1}`;
}

/**
 * Get position-specific strategy advice
 */
export function getPositionInfo(position: string): PositionInfo {
  const adviceMap: Record<string, PositionInfo> = {
    UTG: {
      name: 'UTG',
      displayName: 'Under The Gun',
      advice: 'Tightest position - play premium hands only',
      tier: 'utg',
    },
    'UTG+1': {
      name: 'UTG+1',
      displayName: 'Under The Gun + 1',
      advice: 'Early position - stick to strong holdings',
      tier: 'utg',
    },
    'UTG+2': {
      name: 'UTG+2',
      displayName: 'Under The Gun + 2',
      advice: 'Early position - slightly wider than UTG',
      tier: 'utg',
    },
    MP: {
      name: 'MP',
      displayName: 'Middle Position',
      advice: 'Middle position - can widen range slightly',
      tier: 'mid',
    },
    'MP+1': {
      name: 'MP+1',
      displayName: 'Middle Position + 1',
      advice: 'Middle position - moderate range',
      tier: 'mid',
    },
    HJ: {
      name: 'HJ',
      displayName: 'Hijack',
      advice: 'Hijack - start opening wider ranges',
      tier: 'late',
    },
    CO: {
      name: 'CO',
      displayName: 'Cutoff',
      advice: 'Cutoff - strong stealing position, wider range',
      tier: 'late',
    },
    BTN: {
      name: 'BTN',
      displayName: 'Button',
      advice: 'Button - widest opening range, maximum positional advantage',
      tier: 'late',
    },
    SB: {
      name: 'SB',
      displayName: 'Small Blind',
      advice: 'Small blind - defend or 3-bet, worst postflop position',
      tier: 'blind',
    },
    BB: {
      name: 'BB',
      displayName: 'Big Blind',
      advice: 'Big blind - defend wide vs steals, position advantage preflop only',
      tier: 'blind',
    },
  };

  return (
    adviceMap[position] || {
      name: position,
      displayName: position,
      advice: 'Play tight and position-aware',
      tier: 'mid',
    }
  );
}

/**
 * Get color tier for position visualization
 */
export function getPositionColor(tier: string): string {
  switch (tier) {
    case 'utg':
      return '#ef4444'; // red
    case 'mid':
      return '#f59e0b'; // amber
    case 'late':
      return '#10b981'; // green
    case 'blind':
      return '#8b5cf6'; // purple
    default:
      return '#6b7280'; // gray
  }
}

/**
 * Classify draw type based on outs analysis
 */
export function classifyDrawType(holeCards: string[], board: string[]): string | undefined {
  if (holeCards.length < 2 || board.length < 3) return undefined;

  const allCards = [...holeCards, ...board];
  const suits = allCards.map((c) => c[1]);
  const ranks = allCards.map((c) => c[0]);

  // Check for flush draw
  const suitCounts: Record<string, number> = {};
  suits.forEach((s) => {
    suitCounts[s] = (suitCounts[s] || 0) + 1;
  });
  const hasFlushDraw = Math.max(...Object.values(suitCounts)) === 4;

  // Check for straight draw
  const rankValues: Record<string, number> = {
    '2': 2,
    '3': 3,
    '4': 4,
    '5': 5,
    '6': 6,
    '7': 7,
    '8': 8,
    '9': 9,
    T: 10,
    J: 11,
    Q: 12,
    K: 13,
    A: 14,
  };
  const uniqueRanks = [...new Set(ranks.map((r) => rankValues[r] || 0))]
    .sort((a, b) => a - b)
    .filter((r) => r > 0);
  let hasStraightDraw = false;

  for (let i = 0; i < uniqueRanks.length - 2; i++) {
    if (uniqueRanks[i + 2] - uniqueRanks[i] === 2) {
      hasStraightDraw = true;
      break;
    }
  }

  if (hasFlushDraw && hasStraightDraw) return 'combo-draw';
  if (hasFlushDraw) return 'flush-draw';
  if (hasStraightDraw) return 'straight-draw';
  return undefined;
}
