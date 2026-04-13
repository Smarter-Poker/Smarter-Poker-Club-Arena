/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HORSE AI — Server-Side Horse Decision Engine
 * ═══════════════════════════════════════════════════════════════════════════════
 * ALL horses are fundamentally WINNING poker players.
 * They have DIFFERENT STYLES, but they all play sound, +EV poker.
 * NEVER refer to them as "bots" — they are HORSES only.
 *
 * ZERO browser dependencies. Runs on Node.js.
 */

import type { Card, ActionType, SeatPlayer, HandStage, HorseStyle, HorseDecision, HorseGameState } from '../types.js';
import { evaluateHand, evaluateOmahaHand, RANK_VALUES } from './PokerEngine.js';

// ═══════════════════════════════════════════════════════════════════════════════
// STYLE PARAMETERS — All styles are winning; they differ in HOW they win
// ═══════════════════════════════════════════════════════════════════════════════

interface StyleParams {
    vpipThreshold: number;
    pfrThreshold: number;
    threeBetThreshold: number;
    cbetFreq: number;
    bluffFreq: number;
    slowplayFreq: number;
    checkRaiseFreq: number;
    sizingMultiplier: number;
    thinkRange: [number, number];
}

const STYLE_PARAMS: Record<HorseStyle, StyleParams> = {
    tag: {
        vpipThreshold: 0.20, pfrThreshold: 0.35, threeBetThreshold: 0.75,
        cbetFreq: 0.70, bluffFreq: 0.12, slowplayFreq: 0.10, checkRaiseFreq: 0.08,
        sizingMultiplier: 1.0, thinkRange: [600, 2500],
    },
    lag: {
        vpipThreshold: 0.15, pfrThreshold: 0.28, threeBetThreshold: 0.60,
        cbetFreq: 0.75, bluffFreq: 0.22, slowplayFreq: 0.15, checkRaiseFreq: 0.12,
        sizingMultiplier: 1.15, thinkRange: [400, 2000],
    },
    balanced: {
        vpipThreshold: 0.18, pfrThreshold: 0.32, threeBetThreshold: 0.70,
        cbetFreq: 0.65, bluffFreq: 0.18, slowplayFreq: 0.20, checkRaiseFreq: 0.15,
        sizingMultiplier: 1.0, thinkRange: [700, 2800],
    },
    tricky: {
        vpipThreshold: 0.18, pfrThreshold: 0.34, threeBetThreshold: 0.65,
        cbetFreq: 0.55, bluffFreq: 0.20, slowplayFreq: 0.35, checkRaiseFreq: 0.25,
        sizingMultiplier: 0.9, thinkRange: [800, 3000],
    },
    grinder: {
        vpipThreshold: 0.22, pfrThreshold: 0.36, threeBetThreshold: 0.72,
        cbetFreq: 0.60, bluffFreq: 0.10, slowplayFreq: 0.12, checkRaiseFreq: 0.10,
        sizingMultiplier: 0.85, thinkRange: [500, 2200],
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DECISION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

export class HorseLogic {

    static decide(player: SeatPlayer, gameState: HorseGameState, style: HorseStyle = 'balanced'): HorseDecision {
        const params = STYLE_PARAMS[style] || STYLE_PARAMS.balanced;
        const { currentBet, pot, communityCards, stage, bigBlind } = gameState;
        const toCall = Math.max(0, currentBet - player.bet);

        const handStrength = this.calculateHandStrength(player.cards, communityCards, stage, gameState.gameVariant);
        const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
        const variance = (Math.random() * 0.10) - 0.05;
        const effectiveStrength = Math.max(0, Math.min(1, handStrength + variance));

        let decision: HorseDecision;
        if (stage === 'preflop') {
            decision = this.decidePreflop(player, gameState, effectiveStrength, params);
        } else {
            decision = this.decidePostflop(player, gameState, effectiveStrength, potOdds, params);
        }

        // Server-side: MUCH faster think times (50-300ms) for millisecond-level performance
        const [minThink, maxThink] = params.thinkRange;
        let thinkTime = minThink + Math.random() * (maxThink - minThink);
        if (gameState.players.filter(p => !p.is_folded).length === 2) thinkTime *= 0.7;
        if (stage === 'river' && toCall > pot * 0.5) thinkTime *= 1.3;
        decision.thinkTime = Math.round(Math.min(thinkTime, 3000));

        return decision;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PREFLOP DECISIONS
    // ─────────────────────────────────────────────────────────────────────────

    private static decidePreflop(player: SeatPlayer, gs: HorseGameState, strength: number, params: StyleParams): HorseDecision {
        const { currentBet, bigBlind } = gs;
        const toCall = Math.max(0, currentBet - player.bet);
        const stack = player.stack;
        const facingRaise = currentBet > bigBlind;
        const facingThreeBet = currentBet > bigBlind * 4;

        if (strength > 0.85) {
            if (facingThreeBet) {
                if (strength > 0.93 || Math.random() < 0.5) {
                    return { action: 'raise', amount: Math.min(stack, currentBet * 2.5), thinkTime: 0 };
                }
                return { action: 'call', amount: toCall, thinkTime: 0 };
            }
            if (facingRaise) {
                return { action: 'raise', amount: Math.min(stack, currentBet * 3), thinkTime: 0 };
            }
            const openSize = bigBlind * (2.5 + Math.random() * 0.5);
            return { action: 'raise', amount: Math.min(stack, openSize), thinkTime: 0 };
        }

        if (strength > params.pfrThreshold) {
            if (facingThreeBet) {
                if (strength > params.threeBetThreshold) return { action: 'call', amount: toCall, thinkTime: 0 };
                return { action: 'fold', thinkTime: 0 };
            }
            if (facingRaise) {
                if (strength > params.threeBetThreshold) {
                    return { action: 'raise', amount: Math.min(stack, currentBet * 3), thinkTime: 0 };
                }
                if (toCall <= bigBlind * 8) return { action: 'call', amount: toCall, thinkTime: 0 };
                return { action: 'fold', thinkTime: 0 };
            }
            const openSize = bigBlind * (2.5 + Math.random() * 0.5);
            return { action: 'raise', amount: Math.min(stack, openSize), thinkTime: 0 };
        }

        if (strength > params.vpipThreshold) {
            if (facingThreeBet) return { action: 'fold', thinkTime: 0 };
            if (facingRaise) {
                if (toCall <= bigBlind * 4 && stack > toCall * 10) return { action: 'call', amount: toCall, thinkTime: 0 };
                return { action: 'fold', thinkTime: 0 };
            }
            if (Math.random() < 0.6) {
                const openSize = bigBlind * (2.2 + Math.random() * 0.3);
                return { action: 'raise', amount: Math.min(stack, openSize), thinkTime: 0 };
            }
            if (toCall === 0) return { action: 'check', thinkTime: 0 };
            if (toCall <= bigBlind) return { action: 'call', amount: toCall, thinkTime: 0 };
            return { action: 'fold', thinkTime: 0 };
        }

        if (toCall === 0) return { action: 'check', thinkTime: 0 };
        // Always call if it costs just the big blind (never fold to a limp)
        if (toCall <= bigBlind * 1.5) return { action: 'call', amount: toCall, thinkTime: 0 };
        return { action: 'fold', thinkTime: 0 };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // POSTFLOP DECISIONS
    // ─────────────────────────────────────────────────────────────────────────

    private static decidePostflop(player: SeatPlayer, gs: HorseGameState, strength: number, potOdds: number, params: StyleParams): HorseDecision {
        const { currentBet, pot } = gs;
        const toCall = Math.max(0, currentBet - player.bet);
        const stack = player.stack;
        const facingBet = toCall > 0;
        const sizeMult = params.sizingMultiplier;

        // Nutted hands (> 0.80)
        if (strength > 0.80) {
            if (!facingBet) {
                if (Math.random() < params.slowplayFreq) return { action: 'check', thinkTime: 0 };
                const betSize = Math.trunc(pot * (0.60 + Math.random() * 0.20) * sizeMult);
                return { action: 'bet', amount: Math.min(stack, Math.max(betSize, gs.minRaise)), thinkTime: 0 };
            }
            if (Math.random() < params.checkRaiseFreq * 1.5) {
                const raiseSize = Math.trunc(Math.min(stack, toCall + (pot + toCall) * (0.8 + Math.random() * 0.4) * sizeMult) * 100) / 100;
                return { action: 'raise', amount: raiseSize, thinkTime: 0 };
            }
            if (strength > 0.90) {
                const raiseSize = Math.trunc(Math.min(stack, currentBet * (2.5 + Math.random() * 0.5)) * 100) / 100;
                return { action: 'raise', amount: raiseSize, thinkTime: 0 };
            }
            return { action: 'call', amount: toCall, thinkTime: 0 };
        }

        // Strong hands (0.55-0.80)
        if (strength > 0.55) {
            if (!facingBet) {
                const betSize = Math.trunc(pot * (0.45 + Math.random() * 0.20) * sizeMult);
                return { action: 'bet', amount: Math.min(stack, Math.max(betSize, gs.minRaise)), thinkTime: 0 };
            }
            const betToCallRatio = toCall / pot;
            if (strength > 0.70 && Math.random() < 0.35) {
                return { action: 'raise', amount: Math.trunc(Math.min(stack, currentBet * (2.2 + Math.random() * 0.6)) * 100) / 100, thinkTime: 0 };
            }
            if (betToCallRatio < 0.8) return { action: 'call', amount: toCall, thinkTime: 0 };
            if (strength > 0.65) return { action: 'call', amount: toCall, thinkTime: 0 };
            return { action: 'fold', thinkTime: 0 };
        }

        // Marginal hands (0.30-0.55)
        if (strength > 0.30) {
            if (!facingBet) {
                if (strength > 0.45 && Math.random() < params.cbetFreq * 0.6) {
                    const betSize = Math.trunc(pot * (0.30 + Math.random() * 0.15) * sizeMult);
                    return { action: 'bet', amount: Math.min(stack, Math.max(betSize, gs.minRaise)), thinkTime: 0 };
                }
                return { action: 'check', thinkTime: 0 };
            }
            const betToCallRatio = toCall / (pot + toCall);
            if (strength > betToCallRatio + 0.05) return { action: 'call', amount: toCall, thinkTime: 0 };
            if (strength > 0.45 && Math.random() < params.bluffFreq * 0.5) {
                return { action: 'raise', amount: Math.trunc(Math.min(stack, currentBet * 2.5 * sizeMult) * 100) / 100, thinkTime: 0 };
            }
            return { action: 'fold', thinkTime: 0 };
        }

        // Weak hands (< 0.30)
        if (!facingBet) {
            if (Math.random() < params.bluffFreq) {
                const betSize = Math.trunc(pot * (0.50 + Math.random() * 0.25) * params.sizingMultiplier);
                return { action: 'bet', amount: Math.min(stack, Math.max(betSize, gs.minRaise)), thinkTime: 0 };
            }
            return { action: 'check', thinkTime: 0 };
        }
        if (strength > 0.20 && toCall < pot * 0.3 && Math.random() < 0.08) {
            return { action: 'call', amount: toCall, thinkTime: 0 };
        }
        return { action: 'fold', thinkTime: 0 };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // HAND STRENGTH EVALUATION
    // ═══════════════════════════════════════════════════════════════════════════

    static calculateHandStrength(holeCards: Card[], communityCards: Card[], stage: HandStage, gameVariant: string = 'nlh'): number {
        if (!holeCards || holeCards.length === 0) return 0;

        if (stage === 'preflop') {
            if (gameVariant.startsWith('plo') && holeCards.length >= 4) {
                return this.evaluateOmahaHoleCards(holeCards);
            }
            if (holeCards.length !== 2) return 0.3;
            return this.evaluateHoleCards(holeCards);
        }

        let myHand;
        try {
            const evaluator = gameVariant.startsWith('plo') ? evaluateOmahaHand : evaluateHand;
            myHand = evaluator(holeCards, communityCards);
        } catch {
            return 0.3;
        }

        const rankingScores: Record<number, [number, number]> = {
            1: [0.05, 0.20], 2: [0.20, 0.45], 3: [0.50, 0.65], 4: [0.65, 0.75],
            5: [0.78, 0.85], 6: [0.82, 0.88], 7: [0.88, 0.93], 8: [0.93, 0.97],
            9: [0.97, 0.99], 10: [0.99, 1.00],
        };

        const [low, high] = rankingScores[myHand.ranking] || [0, 0.1];
        const kicker = myHand.kickers?.length ? myHand.kickers[0] / 14 : 0.5;
        return low + (high - low) * Math.min(kicker, 1);
    }

    private static evaluateHoleCards(cards: Card[]): number {
        const [c1, c2] = cards;
        const r1 = this.rankValue(c1.rank);
        const r2 = this.rankValue(c2.rank);
        const high = Math.max(r1, r2);
        const low = Math.min(r1, r2);
        const isPair = r1 === r2;
        const isSuited = c1.suit === c2.suit;
        const gap = high - low;

        let score = 0;
        if (high === 14) score = 10;
        else if (high === 13) score = 8;
        else if (high === 12) score = 7;
        else if (high === 11) score = 6;
        else score = high / 2;

        if (isPair) { score *= 2; if (score < 5) score = 5; }
        if (isSuited) score += 2;
        if (gap === 1) score += 1;
        else if (gap === 2) score -= 1;
        else if (gap === 3) score -= 2;
        else if (gap === 4) score -= 4;
        else if (gap >= 5) score -= 5;
        if (gap <= 2 && high <= 12 && !isPair) score += 1;

        return Math.max(0, Math.min(1, (score + 2) / 22));
    }

    private static evaluateOmahaHoleCards(cards: Card[]): number {
        let score = 0;
        const ranks = cards.map(c => this.rankValue(c.rank));
        const suits = cards.map(c => c.suit);

        for (const r of ranks) {
            if (r === 14) score += 4;
            else if (r >= 12) score += 2;
            else if (r >= 10) score += 1;
        }

        const rankCounts = new Map<number, number>();
        for (const r of ranks) rankCounts.set(r, (rankCounts.get(r) || 0) + 1);
        for (const [r, count] of rankCounts) {
            if (count === 2 && r >= 10) score += 3;
            else if (count === 2) score += 1;
        }

        const suitCounts = new Map<string, number>();
        for (const s of suits) suitCounts.set(s, (suitCounts.get(s) || 0) + 1);
        for (const count of suitCounts.values()) {
            if (count === 2) score += 3;
            if (count === 3) score += 1;
        }

        const sorted = [...ranks].sort((a, b) => a - b);
        for (let i = 1; i < sorted.length; i++) {
            const gap = sorted[i] - sorted[i - 1];
            if (gap === 1) score += 2;
            else if (gap === 2) score += 1;
        }

        return Math.max(0, Math.min(1, score / 30));
    }

    private static rankValue(rank: string): number {
        const map: Record<string, number> = {
            '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
            'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14
        };
        return map[rank] || 0;
    }
}
