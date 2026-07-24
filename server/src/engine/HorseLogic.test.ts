/**
 * HORSE AI V2 — Verification suite (2026-07-23 audit)
 *
 * Covers:
 *  1. LEGALITY FUZZ — thousands of randomized states across every variant,
 *     every street, every stack/pot shape. Every decision must pass the
 *     engine's own validateAction() rules. A horse must NEVER produce an
 *     illegal action, a NaN, a negative amount, or a sub-cent amount.
 *  2. POKER SANITY — premiums raise preflop, trash folds to big bets, free
 *     checks are never folded, draws call correct prices, monsters do not
 *     fold postflop.
 *  3. DISCARD INTELLIGENCE — pineapple discard keeps the best 2 cards.
 *  4. STYLE RESOLUTION — jsonb objects, strings, legacy names, and the {}
 *     production case all resolve to stable, diverse styles.
 *  5. PERFORMANCE — decisions stay inside the synchronous turn-handler budget.
 */

import { describe, it, expect } from 'vitest';
import { HorseLogic, resolveHorseStyle } from './HorseLogic.js';
import {
  validateAction,
  calculateBettingState,
  evaluateHand,
  evaluateOmahaHand,
  evaluateOmahaLowHand,
  compareHands,
  SUITS,
  RANKS,
} from './PokerEngine.js';
import type { Card, SeatPlayer, HorseStyle, HandStage } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeDeck(shortDeck = false): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      if (shortDeck && ['2', '3', '4', '5'].includes(rank)) continue;
      deck.push({ rank, suit });
    }
  }
  return deck;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function c(spec: string): Card {
  // 'Ah' -> {rank:'A', suit:'hearts'}
  const suitMap: Record<string, Card['suit']> = {
    h: 'hearts',
    d: 'diamonds',
    c: 'clubs',
    s: 'spades',
  };
  return { rank: spec[0] as Card['rank'], suit: suitMap[spec[1]] };
}

function mkPlayer(seat: number, overrides: Partial<SeatPlayer> = {}): SeatPlayer {
  return {
    seat,
    user_id: `horse-${seat}`,
    username: `Horse${seat}`,
    stack: 200,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
    ...overrides,
  };
}

const VARIANTS: { variant: string; hole: number; short: boolean }[] = [
  { variant: 'nlh', hole: 2, short: false },
  { variant: 'short_deck', hole: 2, short: true },
  { variant: 'pineapple', hole: 3, short: false },
  { variant: 'plo4', hole: 4, short: false },
  { variant: 'plo5', hole: 5, short: false },
  { variant: 'plo6', hole: 6, short: false },
  { variant: 'plo8', hole: 4, short: false },
];

const STYLES: HorseStyle[] = ['tag', 'lag', 'balanced', 'tricky', 'grinder'];

// ─────────────────────────────────────────────────────────────────────────────
// 1. LEGALITY FUZZ
// ─────────────────────────────────────────────────────────────────────────────

describe('HorseLogic V2 — legality fuzz (all variants, all streets)', () => {
  it('never produces an illegal action across randomized states', () => {
    let checked = 0;
    for (const { variant, hole, short } of VARIANTS) {
      const isPotLimit = variant.startsWith('plo');
      for (let trial = 0; trial < 250; trial++) {
        const deck = shuffle(makeDeck(short));
        const boardCount = [0, 3, 4, 5][trial % 4];
        const stage: HandStage =
          boardCount === 0
            ? 'preflop'
            : boardCount === 3
              ? 'flop'
              : boardCount === 4
                ? 'turn'
                : 'river';

        const bigBlind = [0.02, 2, 5, 100][trial % 4];
        const heroStack = bigBlind * (2 + Math.random() * 250);
        // Engine invariant: player.bet <= currentBet always; currentBet==0 -> bet==0
        const currentBet =
          Math.random() < 0.35 ? 0 : Math.random() * Math.min(heroStack * 1.5, bigBlind * 40);
        const heroBet = currentBet > 0 && Math.random() < 0.4 ? Math.random() * currentBet : 0;
        const pot = Math.max(bigBlind * 1.5, currentBet * 2 * Math.random() + bigBlind * 3);
        const lastRaise = Math.max(bigBlind, currentBet * 0.4);

        const numPlayers = 2 + (trial % 5);
        const players: SeatPlayer[] = [];
        let cardIdx = 0;
        for (let s = 1; s <= numPlayers; s++) {
          players.push(
            mkPlayer(s, {
              cards: deck.slice(cardIdx, (cardIdx += hole)),
              stack: s === 1 ? heroStack : bigBlind * (10 + Math.random() * 150),
              bet: s === 1 ? heroBet : 0,
              is_folded: s > 1 && Math.random() < 0.3 && numPlayers > 2,
            })
          );
        }
        const board = deck.slice(cardIdx, cardIdx + boardCount);
        const hero = players[0];

        const gs = {
          players,
          communityCards: board,
          pot,
          currentBet: currentBet > 0 ? Math.min(currentBet, heroBet + heroStack * 2) : 0,
          minRaise: lastRaise,
          stage,
          gameVariant: variant,
          bigBlind,
          dealerSeat: ((trial % numPlayers) + 1) as number,
        };

        const style = STYLES[trial % STYLES.length];
        const decision = HorseLogic.decide(hero, gs as any, style);

        // Amounts must be sane numbers
        if (decision.amount !== undefined) {
          expect(Number.isFinite(decision.amount)).toBe(true);
          expect(decision.amount).toBeGreaterThanOrEqual(0);
          // Whole cents only (Bible V8 §2.6)
          expect(Math.abs(decision.amount * 100 - Math.round(decision.amount * 100))).toBeLessThan(
            1e-6
          );
        }
        expect(decision.thinkTime).toBeGreaterThanOrEqual(0);
        expect(decision.thinkTime).toBeLessThanOrEqual(10000);

        // Validate against the engine's own rules
        const bettingState = calculateBettingState(
          gs.pot,
          gs.currentBet,
          hero.bet,
          bigBlind,
          lastRaise,
          isPotLimit
        );
        const check = validateAction(decision.action, decision.amount, hero.stack, bettingState);
        if (!check.valid) {
          throw new Error(
            `ILLEGAL ${variant}/${stage}: ${decision.action} ${decision.amount} — ${check.error} ` +
              `(toCall=${bettingState.toCall}, minRaise=${bettingState.minRaise}, ` +
              `maxRaise=${bettingState.maxRaise}, stack=${hero.stack}, bet=${hero.bet}, ` +
              `currentBet=${gs.currentBet}, pot=${gs.pot})`
          );
        }
        checked++;
      }
    }
    expect(checked).toBe(VARIANTS.length * 250);
  });

  it('survives corrupted inputs without throwing', () => {
    const hero = mkPlayer(1, { cards: [] });
    const gs: any = {
      players: [hero],
      communityCards: [],
      pot: NaN,
      currentBet: -5,
      minRaise: 0,
      stage: 'flop',
      gameVariant: 'unknown_variant',
      bigBlind: 0,
    };
    const d = HorseLogic.decide(hero, gs, 'balanced');
    expect(['check', 'fold', 'call', 'bet', 'all_in']).toContain(d.action);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. POKER SANITY
// ─────────────────────────────────────────────────────────────────────────────

function frequency(
  fn: () => { action: string },
  predicate: (a: string) => boolean,
  n = 60
): number {
  let hits = 0;
  for (let i = 0; i < n; i++) if (predicate(fn().action)) hits++;
  return hits / n;
}

describe('HorseLogic V2 — poker sanity', () => {
  const baseGs = (over: Record<string, unknown> = {}) => ({
    players: [mkPlayer(1), mkPlayer(2), mkPlayer(3), mkPlayer(4), mkPlayer(5), mkPlayer(6)],
    communityCards: [] as Card[],
    pot: 3,
    currentBet: 2,
    minRaise: 2,
    stage: 'preflop' as HandStage,
    gameVariant: 'nlh',
    bigBlind: 2,
    dealerSeat: 6,
    ...over,
  });

  it('opens AA aggressively from any position', () => {
    const freq = frequency(
      () => {
        const hero = mkPlayer(3, { cards: [c('Ah'), c('Ad')] });
        const gs = baseGs();
        gs.players[2] = hero;
        return HorseLogic.decide(hero, gs as any, 'tag');
      },
      (a) => a === 'raise' || a === 'bet' || a === 'all_in'
    );
    expect(freq).toBeGreaterThan(0.75); // small trap/limp mix is allowed
  });

  it('folds 72o to a large 3-bet', () => {
    const freq = frequency(
      () => {
        const hero = mkPlayer(4, { cards: [c('7h'), c('2c')], bet: 0 });
        const gs = baseGs({
          currentBet: 24,
          pot: 36,
          minRaise: 16,
          actionHistory: [
            { seat: 2, userId: 'a', action: 'raise', amount: 6, timestamp: 1, stage: 'preflop' },
            { seat: 3, userId: 'b', action: 'raise', amount: 24, timestamp: 2, stage: 'preflop' },
          ],
        });
        return HorseLogic.decide(hero, gs as any, 'lag');
      },
      (a) => a === 'fold'
    );
    expect(freq).toBeGreaterThan(0.95);
  });

  it('never folds when checking is free', () => {
    for (let i = 0; i < 200; i++) {
      const hero = mkPlayer(2, { cards: [c('7h'), c('2c')], bet: 0 });
      const gs = baseGs({
        currentBet: 0,
        pot: 6,
        stage: 'flop',
        communityCards: [c('Ah'), c('Kd'), c('Qs')],
      });
      const d = HorseLogic.decide(hero, gs as any, 'grinder');
      expect(d.action).not.toBe('fold');
    }
  });

  it('does not fold the nuts to a normal river bet', () => {
    const freq = frequency(
      () => {
        const hero = mkPlayer(2, { cards: [c('Ah'), c('Kh')], bet: 0, stack: 300 });
        const gs = baseGs({
          stage: 'river',
          communityCards: [c('Qh'), c('Jh'), c('Th'), c('2c'), c('7d')],
          currentBet: 20,
          pot: 60,
          minRaise: 20,
        });
        gs.players = [hero, mkPlayer(5)];
        return HorseLogic.decide(hero, gs as any, 'balanced');
      },
      (a) => a === 'raise' || a === 'call' || a === 'all_in'
    );
    expect(freq).toBe(1);
  });

  it('continues with a strong flush draw getting a good price (old engine folded here)', () => {
    const freq = frequency(
      () => {
        // Nut flush draw + overcard vs a half-pot bet, heads up
        const hero = mkPlayer(2, { cards: [c('Ah'), c('9h')], bet: 0, stack: 200 });
        const gs = baseGs({
          stage: 'flop',
          communityCards: [c('Kh'), c('7h'), c('2s')],
          currentBet: 5,
          pot: 15,
          minRaise: 5,
        });
        gs.players = [hero, mkPlayer(5)];
        return HorseLogic.decide(hero, gs as any, 'balanced');
      },
      (a) => a === 'call' || a === 'raise' || a === 'all_in'
    );
    expect(freq).toBeGreaterThan(0.85);
  });

  it('value-bets a set when checked to', () => {
    const freq = frequency(
      () => {
        const hero = mkPlayer(2, { cards: [c('8h'), c('8d')], bet: 0, stack: 200 });
        const gs = baseGs({
          stage: 'flop',
          communityCards: [c('8s'), c('Kd'), c('2c')],
          currentBet: 0,
          pot: 12,
        });
        gs.players = [hero, mkPlayer(5)];
        return HorseLogic.decide(hero, gs as any, 'tag');
      },
      (a) => a === 'bet' || a === 'all_in'
    );
    expect(freq).toBeGreaterThan(0.6); // slowplay mix allowed
  });

  it('respects pot-limit caps in PLO', () => {
    for (let i = 0; i < 150; i++) {
      const hero = mkPlayer(2, {
        cards: [c('Ah'), c('Ad'), c('Kh'), c('Kd')],
        bet: 0,
        stack: 500,
      });
      const gs = baseGs({
        gameVariant: 'plo4',
        currentBet: 10,
        pot: 25,
        minRaise: 8,
      });
      const d = HorseLogic.decide(hero, gs as any, 'lag');
      if (d.action === 'raise' && d.amount !== undefined) {
        const toCall = 10;
        const maxRaiseSize = gs.pot + toCall; // engine's pot-limit rule
        expect(d.amount - gs.currentBet).toBeLessThanOrEqual(maxRaiseSize + 0.01);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. DISCARD INTELLIGENCE (Crazy Pineapple)
// ─────────────────────────────────────────────────────────────────────────────

describe('HorseLogic V2 — pineapple discard', () => {
  it('keeps the flopped set, discards the offsuit rag', () => {
    // Hand: 8h 8d 3c on board 8s Kd 2h -> discard MUST be the 3c (index 2)
    const idx = HorseLogic.decideDiscard(
      [c('8h'), c('8d'), c('3c')],
      [c('8s'), c('Kd'), c('2h')],
      'pineapple'
    );
    expect(idx).toBe(2);
  });

  it('keeps the nut flush draw over a dry pair kicker', () => {
    // Ah 9h Kc on board Qh 7h 2s: keep Ah9h (nut flush draw) -> discard Kc (index 2)
    const idx = HorseLogic.decideDiscard(
      [c('Ah'), c('9h'), c('Kc')],
      [c('Qh'), c('7h'), c('2s')],
      'pineapple'
    );
    expect(idx).toBe(2);
  });

  it('returns a valid index even with no board', () => {
    const idx = HorseLogic.decideDiscard([c('Ah'), c('Kh'), c('2c')], [], 'pineapple');
    expect([0, 1, 2]).toContain(idx);
    expect(idx).toBe(2); // AKs is clearly the keep
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. STYLE RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveHorseStyle', () => {
  it('resolves plain strings and legacy names', () => {
    expect(resolveHorseStyle('tag', 'x').style).toBe('tag');
    expect(resolveHorseStyle('maniac', 'x').style).toBe('lag');
    expect(resolveHorseStyle('nit', 'x').style).toBe('grinder');
    expect(resolveHorseStyle('fish', 'x').style).toBe('balanced');
  });

  it('resolves jsonb object profiles with modifiers', () => {
    const r = resolveHorseStyle({ style: 'tricky', aggression: 1.2 }, 'x');
    expect(r.style).toBe('tricky');
    expect(r.mods.aggression).toBe(1.2);
  });

  it('is deterministic and diverse for the production {} case', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `horse-uuid-${i}-abcdef`);
    const styles = ids.map((id) => resolveHorseStyle({}, id).style);
    // Deterministic
    for (const id of ids.slice(0, 20)) {
      expect(resolveHorseStyle({}, id).style).toBe(resolveHorseStyle({}, id).style);
    }
    // Diverse: at least 3 distinct styles across 200 horses
    expect(new Set(styles).size).toBeGreaterThanOrEqual(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. FAST EVALUATOR CROSS-VALIDATION vs the authoritative PokerEngine
// ─────────────────────────────────────────────────────────────────────────────

describe('HorseLogic V2 — fast evaluator agrees with PokerEngine', () => {
  const { scoreHoldem, scoreOmahaHi, scoreOmahaLow } = (HorseLogic as any).__testables;
  const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);

  it('matches evaluateHand ordering (normal + short deck)', () => {
    for (const short of [false, true]) {
      for (let t = 0; t < 3000; t++) {
        const deck = shuffle(makeDeck(short));
        const board = deck.slice(0, 5);
        const a = deck.slice(5, 7);
        const b = deck.slice(7, 9);
        const fastCmp = sign(
          scoreHoldem(a.concat(board), 7, short) - scoreHoldem(b.concat(board), 7, short)
        );
        const truthCmp = sign(
          compareHands(evaluateHand(a, board, short), evaluateHand(b, board, short))
        );
        expect(fastCmp).toBe(truthCmp);
      }
    }
  });

  it('matches evaluateOmahaHand ordering for 4/5/6-card Omaha', () => {
    for (const hole of [4, 5, 6]) {
      for (let t = 0; t < 1000; t++) {
        const deck = shuffle(makeDeck(false));
        const board = deck.slice(0, 5);
        const a = deck.slice(5, 5 + hole);
        const b = deck.slice(5 + hole, 5 + hole * 2);
        const fastCmp = sign(scoreOmahaHi(a, board) - scoreOmahaHi(b, board));
        const truthCmp = sign(
          compareHands(evaluateOmahaHand(a, board), evaluateOmahaHand(b, board))
        );
        expect(fastCmp).toBe(truthCmp);
      }
    }
  });

  it('matches evaluateOmahaLowHand existence and ordering (plo8)', () => {
    for (let t = 0; t < 1500; t++) {
      const deck = shuffle(makeDeck(false));
      const board = deck.slice(0, 5);
      const a = deck.slice(5, 9);
      const b = deck.slice(9, 13);
      const fa = scoreOmahaLow(a, board);
      const fb = scoreOmahaLow(b, board);
      const ta = evaluateOmahaLowHand(a, board);
      const tb = evaluateOmahaLowHand(b, board);
      expect(fa === Infinity).toBe(ta === null);
      expect(fb === Infinity).toBe(tb === null);
      if (ta && tb) {
        let truthCmp = 0;
        for (let i = 0; i < 5; i++) {
          if (ta.kickers[i] !== tb.kickers[i]) {
            truthCmp = sign(ta.kickers[i] - tb.kickers[i]);
            break;
          }
        }
        expect(sign(fa - fb)).toBe(truthCmp);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. PERFORMANCE
// ─────────────────────────────────────────────────────────────────────────────

describe('HorseLogic V2 — performance budget', () => {
  it('averages well under the synchronous turn-handler budget', () => {
    const cases: Array<() => void> = [];
    for (const { variant, hole, short } of VARIANTS) {
      const deck = shuffle(makeDeck(short));
      const hero = mkPlayer(1, { cards: deck.slice(0, hole), stack: 400 });
      const villain = mkPlayer(2, { cards: deck.slice(hole, hole * 2) });
      const gs = {
        players: [hero, villain],
        communityCards: deck.slice(hole * 2, hole * 2 + 4), // turn decision (MC-heavy)
        pot: 40,
        currentBet: 12,
        minRaise: 8,
        stage: 'turn' as HandStage,
        gameVariant: variant,
        bigBlind: 2,
        dealerSeat: 2,
      };
      cases.push(() => void HorseLogic.decide(hero, gs as any, 'balanced'));
    }

    // Warm up JIT
    for (const fn of cases) fn();

    const N = 30;
    const start = performance.now();
    for (let i = 0; i < N; i++) for (const fn of cases) fn();
    const avgMs = (performance.now() - start) / (N * cases.length);

    // Budget: 25ms average per decision (includes plo6 worst case).
    expect(avgMs).toBeLessThan(25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. V3 — HORSE MIND: opponent intelligence (2026-07-23)
// ─────────────────────────────────────────────────────────────────────────────

import { HorseMind } from './HorseMind.js';
import type { ActionRecord } from '../types.js';

describe('HorseMind V3 — opponent intelligence', () => {
  it('reads a 3-bettor into a tight band and a limper into a wide one', () => {
    const hist: ActionRecord[] = [
      { seat: 1, userId: 'op', action: 'raise', amount: 6, timestamp: 1, stage: 'preflop' },
      { seat: 2, userId: 'tb', action: 'raise', amount: 20, timestamp: 2, stage: 'preflop' },
      { seat: 3, userId: 'lp', action: 'call', amount: 20, timestamp: 3, stage: 'preflop' },
    ];
    const tb = HorseMind.bandFor('tb', hist, 2)!;
    const op = HorseMind.bandFor('op', hist, 2)!;
    expect(tb[0]).toBeGreaterThanOrEqual(0.55); // 3-bettor: strong range floor
    expect(op[0]).toBeGreaterThanOrEqual(0.3); // opener: medium floor
    expect(op[0]).toBeLessThan(tb[0]); // 3-bet range tighter than open range
  });

  it('range-conditioned equity shifts correctly (the core V3 claim)', () => {
    const qq = [c('Qh'), c('Qd')];
    const board = [c('9h'), c('7d'), c('2s')];
    let vsRandom = 0;
    let vsThreeBet = 0;
    for (let i = 0; i < 8; i++) {
      vsRandom += HorseLogic.estimateEquityVsBands(qq, board, [null], 'nlh', 1200);
      vsThreeBet += HorseLogic.estimateEquityVsBands(qq, board, [[0.62, 1]], 'nlh', 1200);
    }
    vsRandom /= 8;
    vsThreeBet /= 8;
    // An overpair is worth meaningfully LESS against a 3-bettor's range.
    expect(vsThreeBet).toBeLessThan(vsRandom - 0.03);
  });

  it('learns exploit profiles from the action stream', () => {
    HorseMind.reset();
    let ts = 100000;
    for (let hand = 0; hand < 30; hand++) {
      HorseMind.observe(
        [
          { seat: 1, userId: 'r', action: 'raise', amount: 6, timestamp: ts++, stage: 'preflop' },
          { seat: 2, userId: 'foldy', action: 'fold', amount: 0, timestamp: ts++, stage: 'preflop' },
          { seat: 3, userId: 'sticky', action: 'call', amount: 6, timestamp: ts++, stage: 'preflop' },
          { seat: 1, userId: 'r', action: 'bet', amount: 8, timestamp: ts++, stage: 'flop' },
          { seat: 3, userId: 'sticky', action: 'call', amount: 8, timestamp: ts++, stage: 'flop' },
        ],
        []
      );
      ts += 50;
    }
    expect(HorseMind.exploit('foldy').bluffMod).toBeGreaterThan(1.2); // bluff the folder
    expect(HorseMind.exploit('sticky').bluffMod).toBeLessThan(0.8); // stop bluffing the station
    expect(HorseMind.exploit('sticky').valueThinMod).toBeGreaterThan(1.1); // value bet them thinner
    HorseMind.reset();
  });

  it('scores board texture sanely', () => {
    expect(HorseMind.texture([c('Ah'), c('7d'), c('2s')]).wetness).toBeLessThan(0.2);
    const wet = HorseMind.texture([c('9h'), c('8h'), c('7h')]);
    expect(wet.wetness).toBeGreaterThan(0.6);
    expect(wet.monotone).toBe(true);
    expect(wet.straighty).toBe(true);
  });

  it('identifies nut blockers', () => {
    expect(HorseMind.hasBlocker([c('Ah'), c('2c')], [c('Kh'), c('9h'), c('2s')])).toBe(true);
    expect(HorseMind.hasBlocker([c('7c'), c('2c')], [c('Kh'), c('9h'), c('2s')])).toBe(false);
  });

  it('observation is idempotent (same history replayed does not double-count)', () => {
    HorseMind.reset();
    const hist: ActionRecord[] = [
      { seat: 1, userId: 'idem', action: 'raise', amount: 6, timestamp: 999999, stage: 'preflop' },
    ];
    HorseMind.observe(hist, []);
    HorseMind.observe(hist, []);
    HorseMind.observe(hist, []);
    const s = HorseMind.getStats('idem')!;
    expect(s.hands).toBe(1);
    expect(s.pfr).toBe(1);
    HorseMind.reset();
  });

  it('mind-enabled decisions stay legal and within budget with rich history', () => {
    const players = [
      mkPlayer(1, { cards: [c('Qh'), c('Qd')], stack: 400, bet: 6 }),
      mkPlayer(2),
      mkPlayer(3),
      mkPlayer(4),
    ];
    const hist: ActionRecord[] = [
      { seat: 2, userId: 'horse-2', action: 'raise', amount: 6, timestamp: 500000, stage: 'preflop' },
      { seat: 3, userId: 'horse-3', action: 'call', amount: 6, timestamp: 500001, stage: 'preflop' },
      { seat: 1, userId: 'horse-1', action: 'call', amount: 6, timestamp: 500002, stage: 'preflop' },
      { seat: 2, userId: 'horse-2', action: 'bet', amount: 15, timestamp: 500003, stage: 'flop' },
    ];
    const gs: any = {
      players,
      communityCards: [c('9h'), c('7d'), c('2s')],
      pot: 39,
      currentBet: 15,
      minRaise: 9,
      stage: 'flop',
      gameVariant: 'nlh',
      bigBlind: 2,
      dealerSeat: 4,
      actionHistory: hist,
      lastRaise: 9,
    };
    const start = performance.now();
    for (let i = 0; i < 20; i++) {
      const d = HorseLogic.decide(players[0], gs, 'balanced');
      const bs = calculateBettingState(gs.pot, gs.currentBet, players[0].bet, 2, 9, false);
      expect(validateAction(d.action, d.amount, players[0].stack, bs).valid).toBe(true);
    }
    const avg = (performance.now() - start) / 20;
    expect(avg).toBeLessThan(25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. V4 — STREET IQ: initiative, position, made class, scare cards (2026-07-23)
// ─────────────────────────────────────────────────────────────────────────────

describe('HorseLogic V4 — street IQ', () => {
  const { readInitiative, actsLastPostflop, madeCategory, scareShift, scoreOmahaHiPartial } = (
    HorseLogic as any
  ).__testables;

  it('reads initiative: preflop raiser owns the flop, check-raiser owns the turn', () => {
    const pfHist: ActionRecord[] = [
      { seat: 2, userId: 'pfr', action: 'raise', amount: 6, timestamp: 1, stage: 'preflop' },
      { seat: 3, userId: 'clr', action: 'call', amount: 6, timestamp: 2, stage: 'preflop' },
    ];
    expect(readInitiative(pfHist, 'pfr', 'flop')).toBe('hero');
    expect(readInitiative(pfHist, 'clr', 'flop')).toBe('opp');
    const xrHist: ActionRecord[] = [
      ...pfHist,
      { seat: 2, userId: 'pfr', action: 'bet', amount: 8, timestamp: 3, stage: 'flop' },
      { seat: 3, userId: 'clr', action: 'raise', amount: 24, timestamp: 4, stage: 'flop' },
      { seat: 2, userId: 'pfr', action: 'call', amount: 24, timestamp: 5, stage: 'flop' },
    ];
    expect(readInitiative(xrHist, 'clr', 'turn')).toBe('hero');
    expect(readInitiative(xrHist, 'pfr', 'turn')).toBe('opp');
    expect(readInitiative([], 'x', 'flop')).toBe('none');
  });

  it('knows who closes the action postflop', () => {
    const players = [mkPlayer(1), mkPlayer(3), mkPlayer(6)];
    // Dealer seat 6: order is 1, 3, then 6 — the button closes.
    expect(actsLastPostflop(6, 6, players)).toBe(true);
    expect(actsLastPostflop(1, 6, players)).toBe(false);
    expect(actsLastPostflop(3, 6, players)).toBe(false);
    // Dealer seat 3: order is 6, 1, then 3.
    expect(actsLastPostflop(3, 3, players)).toBe(true);
    expect(actsLastPostflop(6, 3, players)).toBe(false);
  });

  it('classifies the made hand right now, including partial-board Omaha', () => {
    const vi = { holeCount: 2, isOmaha: false, isHiLo: false, isShortDeck: false } as any;
    expect(madeCategory([c('8h'), c('8d')], [c('8s'), c('Kd'), c('2c')], vi)).toBe(4); // set
    expect(madeCategory([c('Ah'), c('Kh')], [c('Qh'), c('Jh'), c('Th')], vi)).toBe(10); // royal
    expect(madeCategory([c('7h'), c('2c')], [c('Ah'), c('Kd'), c('Qs')], vi)).toBe(1); // air
    const viO = { holeCount: 4, isOmaha: true, isHiLo: false, isShortDeck: false } as any;
    const oHole = [c('8h'), c('8d'), c('Ac'), c('Kc')];
    expect(madeCategory(oHole, [c('8s'), c('Kd'), c('2c')], viO)).toBe(4); // flopped set, 3-card board
    expect(scoreOmahaHiPartial(oHole, [c('8s'), c('Kd'), c('2c'), c('8c')]) >= 8 * 0x100000).toBe(
      true
    ); // quads on the 4-card board
  });

  it('detects fresh scare cards on turn and river', () => {
    const flushTurn = scareShift([c('9h'), c('7h'), c('2s'), c('Kh')]);
    expect(flushTurn.flush).toBe(true);
    const pairRiver = scareShift([c('9h'), c('7d'), c('2s'), c('Kc'), c('9c')]);
    expect(pairRiver.pair).toBe(true);
    expect(scareShift([c('9h'), c('7d'), c('2s')]).any).toBe(false); // flop = no shift
  });

  it('c-bets a dry flop as the aggressor far more than a caller in the same seat', () => {
    const mkGs = (heroId: string): any => ({
      players: [
        mkPlayer(2, { user_id: heroId, cards: [c('Ah'), c('5d')] }),
        mkPlayer(5, { user_id: 'villain' }),
      ],
      communityCards: [c('Kd'), c('7s'), c('2c')],
      pot: 13,
      currentBet: 0,
      minRaise: 2,
      stage: 'flop',
      gameVariant: 'nlh',
      bigBlind: 2,
      dealerSeat: 2,
      actionHistory: [
        { seat: 2, userId: 'raiser', action: 'raise', amount: 6, timestamp: 1, stage: 'preflop' },
        { seat: 5, userId: 'villain', action: 'call', amount: 6, timestamp: 2, stage: 'preflop' },
      ],
    });
    const n = 150;
    let pfrBets = 0;
    let callerBets = 0;
    for (let i = 0; i < n; i++) {
      const gsA = mkGs('raiser');
      if (['bet', 'raise', 'all_in'].includes(HorseLogic.decide(gsA.players[0], gsA, 'tag').action))
        pfrBets++;
      const gsB = mkGs('someone-else');
      if (['bet', 'raise', 'all_in'].includes(HorseLogic.decide(gsB.players[0], gsB, 'tag').action))
        callerBets++;
    }
    expect(pfrBets / n).toBeGreaterThan(callerBets / n + 0.2); // initiative gap is real
  });

  it('bets vulnerable made hands for protection instead of slowplaying', () => {
    // Top two pair on a wet two-tone connected flop, checked to hero.
    const freq = frequency(
      () => {
        const hero = mkPlayer(2, { cards: [c('Th'), c('9c')], stack: 200 });
        const gs: any = {
          players: [hero, mkPlayer(5)],
          communityCards: [c('Ts'), c('9s'), c('8d')],
          pot: 12,
          currentBet: 0,
          minRaise: 2,
          stage: 'flop',
          gameVariant: 'nlh',
          bigBlind: 2,
          dealerSeat: 2,
        };
        return HorseLogic.decide(hero, gs, 'tricky'); // trickiest style = most slowplay pressure
      },
      (a) => a === 'bet' || a === 'all_in',
      100
    );
    expect(freq).toBeGreaterThan(0.85);
  });

  it('respects a completed flush more when holding no blocker', () => {
    // Overpair faces a pot-sized bet the moment the third heart lands.
    const decideOn = (streetIQ: boolean) => {
      const hero = mkPlayer(2, { cards: [c('Kc'), c('Kd')], stack: 200, bet: 0 });
      const gs: any = {
        players: [hero, mkPlayer(5)],
        communityCards: [c('9h'), c('7h'), c('2s'), c('Qh')],
        pot: 40,
        currentBet: 40,
        minRaise: 20,
        stage: 'turn',
        gameVariant: 'nlh',
        bigBlind: 2,
        dealerSeat: 5,
        lastRaise: 20,
      };
      return HorseLogic.decide(hero, gs, 'balanced', {}, { streetIQ });
    };
    const n = 120;
    let foldsIQ = 0;
    let foldsBase = 0;
    for (let i = 0; i < n; i++) {
      if (decideOn(true).action === 'fold') foldsIQ++;
      if (decideOn(false).action === 'fold') foldsBase++;
    }
    expect(foldsIQ).toBeGreaterThanOrEqual(foldsBase); // scare respect never decreases discipline
  });

  it('street-IQ decisions stay legal across randomized states with histories', () => {
    for (let trial = 0; trial < 400; trial++) {
      const deck = shuffle(makeDeck(false));
      const boardCount = [3, 4, 5][trial % 3];
      const stage = boardCount === 3 ? 'flop' : boardCount === 4 ? 'turn' : 'river';
      const hero = mkPlayer(1, {
        cards: deck.slice(0, 2),
        stack: 50 + Math.random() * 300,
        bet: 0,
      });
      const villain = mkPlayer(2, { cards: deck.slice(2, 4) });
      const currentBet = Math.random() < 0.5 ? 0 : Math.random() * 40;
      const gs: any = {
        players: [hero, villain],
        communityCards: deck.slice(4, 4 + boardCount),
        pot: 10 + Math.random() * 80,
        currentBet,
        minRaise: 2,
        stage,
        gameVariant: 'nlh',
        bigBlind: 2,
        dealerSeat: (trial % 2) + 1,
        lastRaise: 2,
        actionHistory: [
          {
            seat: (trial % 2) + 1,
            userId: trial % 2 === 0 ? 'horse-1' : 'horse-2',
            action: 'raise',
            amount: 6,
            timestamp: 1000 + trial,
            stage: 'preflop',
          },
        ],
      };
      const d = HorseLogic.decide(hero, gs, STYLES[trial % STYLES.length]);
      const bs = calculateBettingState(gs.pot, gs.currentBet, hero.bet, 2, 2, false);
      const check = validateAction(d.action, d.amount, hero.stack, bs);
      if (!check.valid) {
        throw new Error(`V4 ILLEGAL ${stage}: ${d.action} ${d.amount} — ${check.error}`);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. V5 — DYNAMIC HAND READING: street narrowing, probes, river discipline
// ─────────────────────────────────────────────────────────────────────────────

describe('HorseMind V5 — dynamic hand reading', () => {
  it('narrows a barreller street by street', () => {
    const openOnly: ActionRecord[] = [
      { seat: 1, userId: 'v', action: 'raise', amount: 6, timestamp: 1, stage: 'preflop' },
      { seat: 2, userId: 'h', action: 'call', amount: 6, timestamp: 2, stage: 'preflop' },
    ];
    const barrel1: ActionRecord[] = [
      ...openOnly,
      { seat: 1, userId: 'v', action: 'bet', amount: 8, timestamp: 3, stage: 'flop' },
      { seat: 2, userId: 'h', action: 'call', amount: 8, timestamp: 4, stage: 'flop' },
    ];
    const barrel2: ActionRecord[] = [
      ...barrel1,
      { seat: 1, userId: 'v', action: 'bet', amount: 20, timestamp: 5, stage: 'turn' },
    ];
    const b0 = HorseMind.bandFor('v', openOnly, 2)!;
    const b1 = HorseMind.bandFor('v', barrel1, 2)!;
    const b2 = HorseMind.bandFor('v', barrel2, 2)!;
    expect(b1[0]).toBeGreaterThan(b0[0]); // one barrel tightens the floor
    expect(b2[0]).toBeGreaterThan(b1[0]); // two barrels tighten it further
    expect(b2[0]).toBeLessThanOrEqual(0.9); // but bluffs stay in the range
  });

  it('detects a street that checked through', () => {
    const checked: ActionRecord[] = [
      { seat: 1, userId: 'a', action: 'raise', amount: 6, timestamp: 1, stage: 'preflop' },
      { seat: 2, userId: 'b', action: 'call', amount: 6, timestamp: 2, stage: 'preflop' },
      { seat: 2, userId: 'b', action: 'check', amount: 0, timestamp: 3, stage: 'flop' },
      { seat: 1, userId: 'a', action: 'check', amount: 0, timestamp: 4, stage: 'flop' },
    ];
    expect(HorseMind.streetCheckedThrough(checked, 'flop')).toBe(true);
    const bet: ActionRecord[] = [
      ...checked.slice(0, 3),
      { seat: 1, userId: 'a', action: 'bet', amount: 8, timestamp: 4, stage: 'flop' },
    ];
    expect(HorseMind.streetCheckedThrough(bet, 'flop')).toBe(false);
    expect(HorseMind.streetCheckedThrough([], 'flop')).toBe(false);
  });

  it('probes the turn after a checked-through flop more than without the read', () => {
    const mkGs = (): any => ({
      players: [
        mkPlayer(2, { user_id: 'hero-probe', cards: [c('9c'), c('8c')] }),
        mkPlayer(5, { user_id: 'villain' }),
      ],
      communityCards: [c('Kd'), c('7s'), c('2c'), c('5h')],
      pot: 13,
      currentBet: 0,
      minRaise: 2,
      stage: 'turn',
      gameVariant: 'nlh',
      bigBlind: 2,
      dealerSeat: 2,
      actionHistory: [
        { seat: 5, userId: 'villain', action: 'raise', amount: 6, timestamp: 1, stage: 'preflop' },
        { seat: 2, userId: 'hero-probe', action: 'call', amount: 6, timestamp: 2, stage: 'preflop' },
        { seat: 5, userId: 'villain', action: 'check', amount: 0, timestamp: 3, stage: 'flop' },
        { seat: 2, userId: 'hero-probe', action: 'check', amount: 0, timestamp: 4, stage: 'flop' },
      ],
    });
    const n = 150;
    let withHR = 0;
    let withoutHR = 0;
    for (let i = 0; i < n; i++) {
      const a = mkGs();
      if (['bet', 'all_in'].includes(HorseLogic.decide(a.players[0], a, 'tag', {}, {}).action))
        withHR++;
      const b = mkGs();
      if (
        ['bet', 'all_in'].includes(
          HorseLogic.decide(b.players[0], b, 'tag', {}, { handReading: false }).action
        )
      )
        withoutHR++;
    }
    expect(withHR).toBeGreaterThan(withoutHR); // the capped-range probe exists
  });

  it('checks back medium hands on the river instead of thin bet-folding', () => {
    // Pick a hand whose measured river equity vs a random hand lands in the
    // THIN-VALUE band (0.52..0.62) — that is where V5 polarization applies.
    const board = [c('Ad'), c('Kc'), c('8s'), c('4h'), c('2c')];
    const candidates: Card[][] = [
      [c('Qs'), c('8h')], // third pair
      [c('9h'), c('9d')], // underpair
      [c('Th'), c('8d')], // third pair weak kicker
      [c('Qh'), c('4d')], // fourth pair
    ];
    let hole: Card[] | null = null;
    for (const cand of candidates) {
      const eq = HorseLogic.estimateEquity(cand, board, 1, 'nlh', 4000);
      if (eq >= 0.53 && eq <= 0.61) {
        hole = cand;
        break;
      }
    }
    expect(hole).not.toBe(null); // at least one medium hand must exist here
    const mkGs = (): any => ({
      players: [mkPlayer(2, { cards: hole! }), mkPlayer(5)],
      communityCards: board,
      pot: 30,
      currentBet: 0,
      minRaise: 2,
      stage: 'river',
      gameVariant: 'nlh',
      bigBlind: 2,
      dealerSeat: 2,
    });
    const n = 200;
    let betsHR = 0;
    let betsBase = 0;
    for (let i = 0; i < n; i++) {
      const a = mkGs();
      if (['bet', 'all_in'].includes(HorseLogic.decide(a.players[0], a, 'balanced').action))
        betsHR++;
      const b = mkGs();
      if (
        ['bet', 'all_in'].includes(
          HorseLogic.decide(b.players[0], b, 'balanced', {}, { handReading: false }).action
        )
      )
        betsBase++;
    }
    // V5 thin-bets the river at ~25% vs the base ~65% — demand a real gap.
    expect(betsHR).toBeLessThan(betsBase - 20);
  });

  it('hand-reading decisions stay legal across randomized multi-street histories', () => {
    for (let trial = 0; trial < 400; trial++) {
      const deck = shuffle(makeDeck(false));
      const boardCount = [4, 5][trial % 2];
      const stage = boardCount === 4 ? 'turn' : 'river';
      const hero = mkPlayer(1, { cards: deck.slice(0, 2), stack: 60 + Math.random() * 240 });
      const villain = mkPlayer(2, { cards: deck.slice(2, 4) });
      const currentBet = Math.random() < 0.5 ? 0 : Math.random() * 30;
      const hist: any[] = [
        { seat: 2, userId: 'horse-2', action: 'raise', amount: 6, timestamp: 9000 + trial * 10, stage: 'preflop' },
        { seat: 1, userId: 'horse-1', action: 'call', amount: 6, timestamp: 9001 + trial * 10, stage: 'preflop' },
      ];
      if (trial % 3 === 0) {
        hist.push({ seat: 2, userId: 'horse-2', action: 'bet', amount: 8, timestamp: 9002 + trial * 10, stage: 'flop' });
        hist.push({ seat: 1, userId: 'horse-1', action: 'call', amount: 8, timestamp: 9003 + trial * 10, stage: 'flop' });
      } else if (trial % 3 === 1) {
        hist.push({ seat: 2, userId: 'horse-2', action: 'check', amount: 0, timestamp: 9002 + trial * 10, stage: 'flop' });
        hist.push({ seat: 1, userId: 'horse-1', action: 'check', amount: 0, timestamp: 9003 + trial * 10, stage: 'flop' });
      }
      const gs: any = {
        players: [hero, villain],
        communityCards: deck.slice(4, 4 + boardCount),
        pot: 10 + Math.random() * 60,
        currentBet,
        minRaise: 2,
        stage,
        gameVariant: 'nlh',
        bigBlind: 2,
        dealerSeat: (trial % 2) + 1,
        lastRaise: 2,
        actionHistory: hist,
      };
      const d = HorseLogic.decide(hero, gs, STYLES[trial % STYLES.length]);
      const bs = calculateBettingState(gs.pot, gs.currentBet, hero.bet, 2, 2, false);
      const check = validateAction(d.action, d.amount, hero.stack, bs);
      if (!check.valid) {
        throw new Error(`V5 ILLEGAL ${stage}: ${d.action} ${d.amount} — ${check.error}`);
      }
    }
  });
});
