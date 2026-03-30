/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🐴 HORSE LOGIC — Upgraded Horse Brain (Anti Gravity Agents v2)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ALL horses are fundamentally WINNING poker players.
 * They have DIFFERENT STYLES, but they all play sound, +EV poker.
 * Losses come from VARIANCE, not from bad play or mistakes.
 *
 * HORSE STYLES (all winning):
 * - TAG:      Tight-Aggressive — classic solid ABC poker, selective + aggressive
 * - LAG:      Loose-Aggressive — wider ranges, more aggression, creative lines
 * - BALANCED: GTO-oriented — mixed strategies, hard to exploit
 * - TRICKY:   Deceptive — slowplays, check-raises, trap plays
 * - GRINDER:  Disciplined — small ball, pot control, value extraction
 */

import type { Card, ActionType, SeatPlayer, HandStage } from '../types/database.types';
import { evaluateHand, evaluateOmahaHand } from './PokerEngine';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type HorseStyle = 'tag' | 'lag' | 'balanced' | 'tricky' | 'grinder';

export interface HorseDecision {
  action: ActionType;
  amount?: number;
  thinkTime: number;
}

export interface GameState {
  players: SeatPlayer[];
  communityCards: Card[];
  pot: number;
  currentBet: number;
  minRaise: number;
  stage: HandStage;
  gameVariant: 'nlh' | 'plo4' | 'plo5' | 'plo6';
  bigBlind: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STYLE PARAMETERS — All styles are winning; they differ in HOW they win
// ═══════════════════════════════════════════════════════════════════════════════

interface StyleParams {
  /** VPIP threshold — minimum hand strength to voluntarily enter pot preflop */
  vpipThreshold: number;
  /** PFR threshold — minimum strength to open-raise preflop */
  pfrThreshold: number;
  /** 3-bet threshold — minimum strength to re-raise preflop */
  threeBetThreshold: number;
  /** Continuation bet frequency (0-1) */
  cbetFreq: number;
  /** Bluff frequency on later streets (0-1) */
  bluffFreq: number;
  /** Slowplay frequency with nutted hands (0-1) */
  slowplayFreq: number;
  /** Check-raise frequency with strong hands (0-1) */
  checkRaiseFreq: number;
  /** Bet sizing multiplier (1.0 = standard) */
  sizingMultiplier: number;
  /** Base think time range [min, max] ms */
  thinkRange: [number, number];
}

const STYLE_PARAMS: Record<HorseStyle, StyleParams> = {
  tag: {
    vpipThreshold: 0.35, // ~22% VPIP — tight
    pfrThreshold: 0.45, // Strong raises
    threeBetThreshold: 0.75, // Premium 3-bets
    cbetFreq: 0.7, // High cbet
    bluffFreq: 0.12, // Selective bluffs
    slowplayFreq: 0.1, // Rarely slowplays
    checkRaiseFreq: 0.08, // Occasional c/r
    sizingMultiplier: 1.0, // Standard sizing
    thinkRange: [400, 900],
  },
  lag: {
    vpipThreshold: 0.25, // ~30% VPIP — wider
    pfrThreshold: 0.35, // Opens wider
    threeBetThreshold: 0.6, // Wider 3-bets
    cbetFreq: 0.75, // Very high cbet
    bluffFreq: 0.22, // Frequent bluffs
    slowplayFreq: 0.15, // Some slowplays
    checkRaiseFreq: 0.12, // Active c/r
    sizingMultiplier: 1.15, // Slightly bigger sizing
    thinkRange: [250, 700],
  },
  balanced: {
    vpipThreshold: 0.3, // ~25% VPIP
    pfrThreshold: 0.4, // Standard opens
    threeBetThreshold: 0.7, // Solid 3-bets
    cbetFreq: 0.65, // Mixed cbet
    bluffFreq: 0.18, // Balanced bluffs
    slowplayFreq: 0.2, // Mixed slowplays
    checkRaiseFreq: 0.15, // Mixed c/r
    sizingMultiplier: 1.0, // Standard
    thinkRange: [350, 850],
  },
  tricky: {
    vpipThreshold: 0.28, // ~27% VPIP
    pfrThreshold: 0.42, // Standard-ish
    threeBetThreshold: 0.65, // Wider 3-bets (deceptive)
    cbetFreq: 0.55, // Lower cbet (traps more)
    bluffFreq: 0.2, // Good bluff frequency
    slowplayFreq: 0.35, // Lots of slowplays
    checkRaiseFreq: 0.25, // Frequent c/r
    sizingMultiplier: 0.9, // Slightly smaller (induce)
    thinkRange: [500, 1000],
  },
  grinder: {
    vpipThreshold: 0.32, // ~24% VPIP
    pfrThreshold: 0.43, // Tight opens
    threeBetThreshold: 0.72, // Selective 3-bets
    cbetFreq: 0.6, // Moderate cbet
    bluffFreq: 0.1, // Low bluffs (value-heavy)
    slowplayFreq: 0.12, // Rarely slowplays
    checkRaiseFreq: 0.1, // Selective c/r
    sizingMultiplier: 0.85, // Small ball sizing
    thinkRange: [300, 800],
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DECISION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

export type TablePosition = 'early' | 'middle' | 'late' | 'blinds';

export class HorseLogic {
  /**
   * Calculate position category based on seat relative to dealer.
   */
  static getPosition(seat: number, dealerSeat: number, totalPlayers: number): TablePosition {
    // Calculate seats after dealer
    const seatsFromDealer = (seat - dealerSeat + totalPlayers) % totalPlayers;

    // Blinds are seats 1 and 2 after dealer
    if (seatsFromDealer <= 2) return 'blinds';

    const playableSeats = totalPlayers - 2; // Exclude blinds
    const relativePos = seatsFromDealer - 2; // 1-indexed from UTG
    const third = playableSeats / 3;

    if (relativePos <= third) return 'early';
    if (relativePos <= third * 2) return 'middle';
    return 'late';
  }

  static decide(
    player: SeatPlayer,
    gameState: GameState,
    style: HorseStyle = 'balanced',
    position?: TablePosition
  ): HorseDecision {
    const params = STYLE_PARAMS[style] || STYLE_PARAMS.balanced;
    const { currentBet, pot, communityCards, stage, bigBlind, minRaise } = gameState;
    const toCall = Math.max(0, currentBet - player.bet);
    const stack = player.stack;

    // 1. Evaluate hand strength (0-1 scale)
    const handStrength = this.calculateHandStrength(
      player.cards,
      communityCards,
      stage,
      gameState.gameVariant
    );

    // 2. Calculate pot odds
    const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;

    // 3. Add small random variance (±5%) — variance creates different outcomes, not mistakes
    const variance = Math.random() * 0.1 - 0.05;
    let effectiveStrength = Math.max(0, Math.min(1, handStrength + variance));

    // 3b. Position adjustment — tighten in early, loosen in late
    if (position && stage === 'preflop') {
      switch (position) {
        case 'early':
          // Tighten range by ~10% (play fewer hands from early position)
          effectiveStrength -= 0.05;
          break;
        case 'middle':
          // Slight tightening
          effectiveStrength -= 0.02;
          break;
        case 'late':
          // Loosen range by ~8% (play more hands from button/cutoff)
          effectiveStrength += 0.04;
          break;
        case 'blinds':
          // Blinds play tighter facing raises, wider to complete
          if (toCall > bigBlind) {
            effectiveStrength -= 0.03;
          } else {
            effectiveStrength += 0.03;
          }
          break;
      }
      effectiveStrength = Math.max(0, Math.min(1, effectiveStrength));
    }

    // 4. Make stage-specific decision
    let decision: HorseDecision;
    if (stage === 'preflop') {
      decision = this.decidePreflop(player, gameState, effectiveStrength, params);
    } else {
      decision = this.decidePostflop(player, gameState, effectiveStrength, potOdds, params);
    }

    // 5. Apply think time with style variance
    const [minThink, maxThink] = params.thinkRange;
    let thinkTime = minThink + Math.random() * (maxThink - minThink);
    // Faster heads-up, slower on big decisions
    if (gameState.players.filter((p) => !p.is_folded).length === 2) thinkTime *= 0.7;
    if (stage === 'river' && toCall > pot * 0.5) thinkTime *= 1.3;
    // Ensure decision delay is enforced (min 250ms, max 1000ms)
    decision.thinkTime = Math.round(Math.max(250, Math.min(thinkTime, 1000)));

    return decision;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PREFLOP DECISIONS — All styles play solid preflop, vary in range width
  // ─────────────────────────────────────────────────────────────────────────

  private static decidePreflop(
    player: SeatPlayer,
    gs: GameState,
    strength: number,
    params: StyleParams
  ): HorseDecision {
    const { currentBet, pot, bigBlind } = gs;
    const toCall = Math.max(0, currentBet - player.bet);
    const stack = player.stack;
    const facingRaise = currentBet > bigBlind;
    const facingThreeBet = currentBet > bigBlind * 4;

    // Premium hands (AA, KK, AKs, QQ) — always raise/re-raise
    if (strength > 0.85) {
      if (facingThreeBet) {
        // 4-bet or call with traps
        if (strength > 0.93 || Math.random() < 0.5) {
          const fourBetSize = Math.min(stack, currentBet * 2.5);
          return { action: 'raise', amount: fourBetSize, thinkTime: 0 };
        }
        return { action: 'call', amount: toCall, thinkTime: 0 };
      }
      if (facingRaise) {
        // 3-bet
        const threeBetSize = Math.min(stack, currentBet * 3);
        return { action: 'raise', amount: threeBetSize, thinkTime: 0 };
      }
      // Open raise — vary between 2.5x and 3x
      const openSize = bigBlind * (2.5 + Math.random() * 0.5);
      return { action: 'raise', amount: Math.min(stack, openSize), thinkTime: 0 };
    }

    // Strong hands — above PFR threshold
    if (strength > params.pfrThreshold) {
      if (facingThreeBet) {
        // Strong but not premium — mostly call, sometimes fold
        if (strength > params.threeBetThreshold) {
          return { action: 'call', amount: toCall, thinkTime: 0 };
        }
        // Fold to 3-bets with medium strength
        return { action: 'fold', thinkTime: 0 };
      }
      if (facingRaise) {
        // 3-bet with top of range
        if (strength > params.threeBetThreshold) {
          const threeBetSize = Math.min(stack, currentBet * 3);
          return { action: 'raise', amount: threeBetSize, thinkTime: 0 };
        }
        // Call with playable hands
        if (toCall <= bigBlind * 8) {
          return { action: 'call', amount: toCall, thinkTime: 0 };
        }
        return { action: 'fold', thinkTime: 0 };
      }
      // Open raise
      const openSize = bigBlind * (2.5 + Math.random() * 0.5);
      return { action: 'raise', amount: Math.min(stack, openSize), thinkTime: 0 };
    }

    // Playable hands — above VPIP threshold
    if (strength > params.vpipThreshold) {
      if (facingThreeBet) return { action: 'fold', thinkTime: 0 };
      if (facingRaise) {
        // Call reasonable raises with speculative hands
        if (toCall <= bigBlind * 4 && stack > toCall * 10) {
          return { action: 'call', amount: toCall, thinkTime: 0 };
        }
        return { action: 'fold', thinkTime: 0 };
      }
      // Limp or raise depending on style
      if (Math.random() < 0.6) {
        // Open raise (no limping for winning players)
        const openSize = bigBlind * (2.2 + Math.random() * 0.3);
        return { action: 'raise', amount: Math.min(stack, openSize), thinkTime: 0 };
      }
      // Occasional limp from SB/BB or late position
      if (toCall === 0) return { action: 'check', thinkTime: 0 };
      if (toCall <= bigBlind) return { action: 'call', amount: toCall, thinkTime: 0 };
      return { action: 'fold', thinkTime: 0 };
    }

    // Below threshold — fold (but check if free)
    if (toCall === 0) return { action: 'check', thinkTime: 0 };
    return { action: 'fold', thinkTime: 0 };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POSTFLOP DECISIONS — Sound play with style-specific tendencies
  // ─────────────────────────────────────────────────────────────────────────

  private static decidePostflop(
    player: SeatPlayer,
    gs: GameState,
    strength: number,
    potOdds: number,
    params: StyleParams
  ): HorseDecision {
    const { currentBet, pot, bigBlind, minRaise, stage, gameVariant, communityCards } = gs;
    const toCall = Math.max(0, currentBet - player.bet);
    const stack = player.stack;
    const facingBet = toCall > 0;
    const sizeMult = params.sizingMultiplier;

    // Recalculate hand strength for this street based on current community cards
    const currentStrength = this.calculateHandStrength(
      player.cards,
      communityCards,
      stage,
      gameVariant
    );

    // ── NUTTED HANDS (strength > 0.80) — Sets, straights, flushes+
    if (currentStrength > 0.8) {
      return this.playNuttedHand(player, gs, currentStrength, params);
    }

    // ── STRONG HANDS (0.55-0.80) — Top pair good kicker, overpairs, two pair
    if (currentStrength > 0.55) {
      return this.playStrongHand(player, gs, currentStrength, potOdds, params);
    }

    // ── MARGINAL HANDS (0.30-0.55) — Middle pair, weak top pair, draws
    if (currentStrength > 0.3) {
      return this.playMarginalHand(player, gs, currentStrength, potOdds, params);
    }

    // ── WEAK HANDS (< 0.30) — Missed draws, low pair, nothing
    return this.playWeakHand(player, gs, currentStrength, potOdds, params);
  }

  // ── Nutted hand play ──
  private static playNuttedHand(
    player: SeatPlayer,
    gs: GameState,
    strength: number,
    params: StyleParams
  ): HorseDecision {
    const { currentBet, pot } = gs;
    const toCall = Math.max(0, currentBet - player.bet);
    const stack = player.stack;
    const facingBet = toCall > 0;
    const sizeMult = params.sizingMultiplier;

    if (!facingBet) {
      // Slowplay trap (style-dependent frequency)
      if (Math.random() < params.slowplayFreq) {
        return { action: 'check', thinkTime: 0 };
      }
      // Value bet — 60-80% pot with variance
      const baseBetSize = pot * (0.6 + Math.random() * 0.2) * sizeMult;
      // Add ±10% variance to bet sizing for naturalness
      const variance = (Math.random() - 0.5) * 0.2; // ±10%
      const betSize = Math.trunc(baseBetSize * (1 + variance));
      // Check if we should go all-in instead of a capped bet
      if (betSize >= stack * 0.95) {
        return { action: 'all_in', thinkTime: 0 };
      }
      return {
        action: 'bet',
        amount: Math.min(stack, Math.max(betSize, gs.minRaise)),
        thinkTime: 0,
      };
    }

    // Facing bet with nuts
    // Check-raise (style-dependent)
    if (Math.random() < params.checkRaiseFreq * 1.5) {
      const raiseSize =
        Math.trunc(
          Math.min(stack, toCall + (pot + toCall) * (0.8 + Math.random() * 0.4) * sizeMult) * 100
        ) / 100;
      return { action: 'raise', amount: raiseSize, thinkTime: 0 };
    }
    // Raise for value
    if (strength > 0.9) {
      const raiseSize =
        Math.trunc(Math.min(stack, currentBet * (2.5 + Math.random() * 0.5)) * 100) / 100;
      return { action: 'raise', amount: raiseSize, thinkTime: 0 };
    }
    // Call to keep opponent in
    return { action: 'call', amount: toCall, thinkTime: 0 };
  }

  // ── Strong hand play ──
  private static playStrongHand(
    player: SeatPlayer,
    gs: GameState,
    strength: number,
    potOdds: number,
    params: StyleParams
  ): HorseDecision {
    const { currentBet, pot } = gs;
    const toCall = Math.max(0, currentBet - player.bet);
    const stack = player.stack;
    const facingBet = toCall > 0;
    const sizeMult = params.sizingMultiplier;

    if (!facingBet) {
      // Bet for value — 45-65% pot
      const betSize = Math.trunc(pot * (0.45 + Math.random() * 0.2) * sizeMult);
      return {
        action: 'bet',
        amount: Math.min(stack, Math.max(betSize, gs.minRaise)),
        thinkTime: 0,
      };
    }

    // Facing a bet
    const betToCallRatio = toCall / pot;

    // Raise top of strong range
    if (strength > 0.7 && Math.random() < 0.35) {
      const raiseSize =
        Math.trunc(Math.min(stack, currentBet * (2.2 + Math.random() * 0.6)) * 100) / 100;
      return { action: 'raise', amount: raiseSize, thinkTime: 0 };
    }

    // Call if getting decent price
    if (betToCallRatio < 0.8) {
      return { action: 'call', amount: toCall, thinkTime: 0 };
    }

    // Big bet facing strong hand — call with top, fold with bottom
    if (strength > 0.65) return { action: 'call', amount: toCall, thinkTime: 0 };
    return { action: 'fold', thinkTime: 0 };
  }

  // ── Marginal hand play ──
  private static playMarginalHand(
    player: SeatPlayer,
    gs: GameState,
    strength: number,
    potOdds: number,
    params: StyleParams
  ): HorseDecision {
    const { currentBet, pot } = gs;
    const toCall = Math.max(0, currentBet - player.bet);
    const stack = player.stack;
    const facingBet = toCall > 0;
    const sizeMult = params.sizingMultiplier;

    if (!facingBet) {
      // Check-raise bluff occasionally
      if (Math.random() < params.checkRaiseFreq) {
        // Will check, hoping to c/r (simplified: just check)
        return { action: 'check', thinkTime: 0 };
      }
      // Thin value bet / blocking bet
      if (strength > 0.45 && Math.random() < params.cbetFreq * 0.6) {
        const betSize = Math.trunc(pot * (0.3 + Math.random() * 0.15) * sizeMult);
        return {
          action: 'bet',
          amount: Math.min(stack, Math.max(betSize, gs.minRaise)),
          thinkTime: 0,
        };
      }
      return { action: 'check', thinkTime: 0 };
    }

    // Facing bet with marginal hand — pot odds decision
    const betToCallRatio = toCall / (pot + toCall);

    // Call if we're getting the right price
    if (strength > betToCallRatio + 0.05) {
      return { action: 'call', amount: toCall, thinkTime: 0 };
    }

    // Semi-bluff raise with draws (top of marginal range)
    if (strength > 0.45 && Math.random() < params.bluffFreq * 0.5) {
      const raiseSize = Math.trunc(Math.min(stack, currentBet * 2.5 * sizeMult) * 100) / 100;
      return { action: 'raise', amount: raiseSize, thinkTime: 0 };
    }

    return { action: 'fold', thinkTime: 0 };
  }

  // ── Weak hand play ──
  private static playWeakHand(
    player: SeatPlayer,
    gs: GameState,
    strength: number,
    potOdds: number,
    params: StyleParams
  ): HorseDecision {
    const { currentBet, pot } = gs;
    const toCall = Math.max(0, currentBet - player.bet);
    const stack = player.stack;
    const facingBet = toCall > 0;

    if (!facingBet) {
      // Bluff with air at style-specific frequency
      if (Math.random() < params.bluffFreq) {
        const betSize = Math.trunc(pot * (0.5 + Math.random() * 0.25) * params.sizingMultiplier);
        return {
          action: 'bet',
          amount: Math.min(stack, Math.max(betSize, gs.minRaise)),
          thinkTime: 0,
        };
      }
      return { action: 'check', thinkTime: 0 };
    }

    // Facing bet with nothing — hero call bluff catch at tiny frequency
    if (strength > 0.2 && toCall < pot * 0.3 && Math.random() < 0.08) {
      return { action: 'call', amount: toCall, thinkTime: 0 };
    }

    return { action: 'fold', thinkTime: 0 };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HAND STRENGTH EVALUATION
  // ═══════════════════════════════════════════════════════════════════════════

  static calculateHandStrength(
    holeCards: Card[],
    communityCards: Card[],
    stage: HandStage,
    gameVariant: string = 'nlh'
  ): number {
    if (!holeCards || holeCards.length === 0) return 0;

    if (stage === 'preflop') {
      if (gameVariant.startsWith('plo') && holeCards.length >= 4) {
        return this.evaluateOmahaHoleCards(holeCards);
      }
      if (holeCards.length !== 2) return 0.3;
      return this.evaluateHoleCards(holeCards);
    }

    // Postflop — use hand evaluator (with defensive try/catch)
    let myHand;
    try {
      const evaluator = gameVariant.startsWith('plo') ? evaluateOmahaHand : evaluateHand;
      myHand = evaluator(holeCards, communityCards);
    } catch (e) {
      reportError(e, 'HorseLogic');
      // Graceful fallback if hand evaluation fails (e.g., card count mismatch)
      return 0.3;
    }

    // Map hand ranking (1=High Card → 10=Royal Flush) to 0-1 score
    // ranking 1 (High Card): 0.05-0.20
    // ranking 2 (Pair):       0.20-0.45
    // ranking 3 (Two Pair):   0.50-0.65
    // ranking 4 (Trips):      0.65-0.75
    // ranking 5 (Straight):   0.78-0.85
    // ranking 6 (Flush):      0.82-0.88
    // ranking 7 (Full House): 0.88-0.93
    // ranking 8+ (Quads+):    0.93-1.00
    const rankingScores: Record<number, [number, number]> = {
      1: [0.05, 0.2], // High Card
      2: [0.2, 0.45], // One Pair
      3: [0.5, 0.65], // Two Pair
      4: [0.65, 0.75], // Three of a Kind
      5: [0.78, 0.85], // Straight
      6: [0.82, 0.88], // Flush
      7: [0.88, 0.93], // Full House
      8: [0.93, 0.97], // Four of a Kind
      9: [0.97, 0.99], // Straight Flush
      10: [0.99, 1.0], // Royal Flush
    };

    const [low, high] = rankingScores[myHand.ranking] || [0, 0.1];
    // Use kickers to interpolate within the range
    const kicker = myHand.kickers?.length ? myHand.kickers[0] / 14 : 0.5;
    return low + (high - low) * Math.min(kicker, 1);
  }

  private static evaluateHoleCards(cards: Card[]): number {
    // Chen Formula — assigns a starting hand score
    const [c1, c2] = cards;
    const r1 = this.rankValue(c1.rank);
    const r2 = this.rankValue(c2.rank);

    const high = Math.max(r1, r2);
    const low = Math.min(r1, r2);

    const isPair = r1 === r2;
    const isSuited = c1.suit === c2.suit;
    const gap = high - low;

    // Chen-style scoring
    let score = 0;

    // Highest card score
    if (high === 14)
      score = 10; // Ace
    else if (high === 13)
      score = 8; // King
    else if (high === 12)
      score = 7; // Queen
    else if (high === 11)
      score = 6; // Jack
    else score = high / 2; // Others: half face value

    // Pair bonus
    if (isPair) {
      score *= 2;
      if (score < 5) score = 5; // min pair score
    }

    // Suited bonus
    if (isSuited) score += 2;

    // Gap penalty
    if (gap === 1)
      score += 1; // Connectors
    else if (gap === 2)
      score -= 1; // One-gapper
    else if (gap === 3) score -= 2;
    else if (gap === 4) score -= 4;
    else if (gap >= 5) score -= 5;

    // Straight potential bonus for both cards <= Q and gap <= 2
    if (gap <= 2 && high <= 12 && !isPair) score += 1;

    // Normalize: max ~20 (AA), min ~-2 (72o) → remap to 0-1
    // AA = 20, KK = 16, AKs = 13, 72o ≈ -1
    return Math.max(0, Math.min(1, (score + 2) / 22));
  }

  private static evaluateOmahaHoleCards(cards: Card[]): number {
    let score = 0;
    const ranks = cards.map((c) => this.rankValue(c.rank));
    const suits = cards.map((c) => c.suit);
    const highCard = Math.max(...ranks);

    // High cards bonus
    for (const r of ranks) {
      if (r === 14) score += 4;
      else if (r >= 12) score += 2;
      else if (r >= 10) score += 1;
    }

    // Pairs (set potential)
    const rankCounts = new Map<number, number>();
    for (const r of ranks) rankCounts.set(r, (rankCounts.get(r) || 0) + 1);
    for (const [r, count] of rankCounts) {
      if (count === 2 && r >= 10)
        score += 3; // High pair
      else if (count === 2) score += 1;
    }

    // Suited cards (flush potential)
    const suitCounts = new Map<string, number>();
    for (const s of suits) suitCounts.set(s, (suitCounts.get(s) || 0) + 1);
    for (const count of suitCounts.values()) {
      if (count === 2) score += 3; // Double suited potential
      if (count === 3) score += 1; // Counterfeited suited — less value
    }

    // Connectedness (straight potential)
    const sorted = [...ranks].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1];
      if (gap === 1) score += 2;
      else if (gap === 2) score += 1;
    }

    // Normalize to 0-1 (max ~30)
    return Math.max(0, Math.min(1, score / 30));
  }

  private static rankValue(rank: string): number {
    const map: Record<string, number> = {
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
    return map[rank] || 0;
  }
}
