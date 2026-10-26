/**
 * V58 PLO6 RIVER NUT DISCIPLINE (2026-10-25). Dan: "YOU HAVE TO INSURE THAT
 * HORSES ARE NOT CALLING OFF THERE STACKS ON PAIRED BOARDS IN PLO6" and "IN
 * PLO6 IF ITS NOT THE NUTS, ITS PROBABLY NOT GOOD".
 *
 * The spot Dan watched (hand 48033406, 2026-10-25 21:32 UTC): board
 * 9d 4c 9c Ad 9h, a horse called a 113 river bet into ~150 and lost to kings
 * full. Production (3 hours, 324 paired-board PLO6 river decisions facing a
 * bet): calls with a hand 7-40 holdings beat lost 3,410 bb over 138 spots.
 */
import { describe, expect, it } from 'vitest';
import { horseDecisionReceiptIsValid } from './horseDecision/responseValidation.js';
import {
  HorseLogic,
  PLO6_RIVER_FOLD_BEAT_PROB,
  PLO6_RIVER_RAISE_BEAT_PROB,
  PLO6_RIVER_UNPAIRED_FOLD_BEAT_PROB,
  PLO6_RIVER_UNPAIRED_RAISE_BEAT_PROB,
  type HorseGameStateV2,
} from './HorseLogic.js';
import {
  omahaRiverBeatingCombos,
  omahaRiverBeatProbability,
  fastRandom,
  seedFastRandom,
} from './HorseEval.js';
import { evaluateOmahaHand, compareHands, RANKS, SUITS } from './PokerEngine.js';
import type { ActionRecord, Card, SeatPlayer } from '../types.js';

const c = (rank: string, suit: string): Card => ({ rank, suit }) as Card;
const H = 'hearts';
const D = 'diamonds';
const S = 'spades';
const C = 'clubs';
const parse = (s: string): Card[] => {
  const suit: Record<string, string> = { h: H, d: D, s: S, c: C };
  const out: Card[] = [];
  for (let i = 0; i < s.length; i += 2) out.push(c(s[i], suit[s[i + 1]]));
  return out;
};

/** Reference count with the engine's own showdown evaluator. */
function referenceBeaters(hole: Card[], board: Card[]): number {
  const mine = evaluateOmahaHand(hole, board);
  const seen = new Set([...hole, ...board].map((x) => x.rank + x.suit));
  const unseen: Card[] = [];
  for (const r of RANKS) for (const s of SUITS) if (!seen.has(r + s)) unseen.push(c(r, s));
  let n = 0;
  for (let i = 0; i < unseen.length; i++)
    for (let j = i + 1; j < unseen.length; j++)
      if (compareHands(evaluateOmahaHand([unseen[i], unseen[j]], board), mine) > 0) n++;
  return n;
}

// Production river spots (board | PLO6 hole cards), 2026-10-25.
const PRODUCTION = [
  ['9d4c9cAd9h', 'Ks5s5cQh2cKh'], // the kings full that won hand 48033406
  ['Kh7hKd9hKs', 'Td5d9c9s8s6h'],
  ['4c2cAsAdQh', '5s4hKsQs6d4d'],
  ['7d5d9d7c9h', 'JcKsQdQh2h3d'],
  ['ThTcTs5c4h', '9sJdAc7sQcJc'],
  ['2c4dTc4c4h', '3dJdTs5h8hTd'],
  ['AhKsJsAs4h', '3h4sQs2dAd2c'],
  ['6s6d6c8d8h', '4d2sQd8s4h3h'],
];

describe('omahaRiverBeatingCombos', () => {
  it('agrees with the showdown evaluator on production river spots', () => {
    for (const [b, h] of PRODUCTION) {
      const board = parse(b);
      const hole = parse(h);
      expect(omahaRiverBeatingCombos(hole, board, 10_000), `${b} ${h}`).toBe(
        referenceBeaters(hole, board)
      );
    }
  });
  it('counts no further than its cap, and refuses an incomplete or overlapping deal', () => {
    const board = parse('9d4c9cAd9h');
    const weak = parse('2s3s5h6h7s8d');
    expect(omahaRiverBeatingCombos(weak, board, 7)).toBe(7);
    expect(omahaRiverBeatingCombos(weak, board.slice(0, 4))).toBeNull();
    expect(omahaRiverBeatingCombos(parse('9d3s5h6h7s8d'), board)).toBeNull();
  });
  it('quads with the top kicker on a trips board is the nuts', () => {
    expect(omahaRiverBeatingCombos(parse('9sAhKc2d3h4s'), parse('9d4c9cAd9h'))).toBe(0);
  });
});

const SEEDS = Array.from({ length: 60 }, (_, i) => (i + 1) * 7919);
// Hand 45872846's board, and the horse's six cards around each made hand.
const DEUCES = parse('Ts2h2d3d2s');
const JACKS_FULL = parse('JsAsThJh5c6c'); // under-full: AA, KK, QQ, TT and quads beat it
const TENS_FULL = parse('TcAsThJh5c6c'); // the top boat: only the last deuce beats it
const QUADS = parse('2cAsThJh5c6c'); // the nuts
// Dan's hand 48033406 board.
const NINES = parse('9d4c9cAd9h');
const FOURS_FULL = parse('4h4s7c8d2hJs');

describe('omahaRiverBeatProbability', () => {
  it('reads a single-card threat as the chance of holding that card, not 40 holdings', () => {
    expect(omahaRiverBeatingCombos(TENS_FULL, DEUCES, 10_000)).toBe(40);
    const p = omahaRiverBeatProbability(TENS_FULL, DEUCES, 6)!;
    // A six-card hand from 41 unseen cards holds the last deuce 6/41 of the time.
    expect(p).toBeGreaterThan(6 / 41 - 0.01);
    expect(p).toBeLessThan(6 / 41 + 0.01);
  });
  it('orders the incident holdings and answers the same every time', () => {
    const jacks = omahaRiverBeatProbability(JACKS_FULL, DEUCES, 6)!;
    const tens = omahaRiverBeatProbability(TENS_FULL, DEUCES, 6)!;
    expect(omahaRiverBeatProbability(QUADS, DEUCES, 6)).toBe(0);
    expect(jacks).toBeGreaterThan(PLO6_RIVER_FOLD_BEAT_PROB);
    expect(tens).toBeGreaterThanOrEqual(PLO6_RIVER_RAISE_BEAT_PROB);
    expect(tens).toBeLessThan(PLO6_RIVER_FOLD_BEAT_PROB);
    expect(omahaRiverBeatProbability(JACKS_FULL, DEUCES, 6)).toBe(jacks);
  });
  it('never touches the shared horse random stream', () => {
    seedFastRandom(42);
    const untouched = fastRandom();
    seedFastRandom(42);
    omahaRiverBeatProbability(JACKS_FULL, DEUCES, 6);
    expect(fastRandom()).toBe(untouched);
  });
});

function seat(n: number, cards: Card[], over: Partial<SeatPlayer> = {}): SeatPlayer {
  return {
    seat: n,
    user_id: n === 1 ? 'hero' : `opp${n}`,
    username: n === 1 ? 'hero' : `opp${n}`,
    stack: 800,
    bet: 0,
    totalInvested: 0,
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
    cards,
    ...over,
  } as SeatPlayer;
}

/** River, hero checked, opp3 bets `bet` into `pot`. */
function facingRiverBet(
  hole: Card[],
  board: Card[],
  variant: string,
  seed: number,
  opts: Record<string, unknown> = {},
  bet = 113,
  pot = 150
) {
  seedFastRandom(seed);
  const history = [
    { seat: 1, userId: 'hero', action: 'check', amount: 0, timestamp: 1, stage: 'river' },
    { seat: 3, userId: 'opp3', action: 'bet', amount: bet, timestamp: 2, stage: 'river' },
  ] as ActionRecord[];
  const hero = seat(1, hole, { stack: 400 });
  const gs = {
    players: [hero, seat(3, [], { bet, stack: 500 })],
    communityCards: board,
    pot: pot + bet,
    currentBet: bet,
    minRaise: bet,
    lastRaise: bet,
    stage: 'river',
    gameVariant: variant,
    bigBlind: 2,
    dealerSeat: 3,
    actionHistory: history,
    gameMode: 'cash',
    format: 'cash',
  } as HorseGameStateV2;
  return HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false, ...opts });
}

describe('V58 PLO6 paired-board river nut discipline', () => {
  it('folds an under-full to a real river bet', () => {
    for (const seed of SEEDS)
      expect(facingRiverBet(JACKS_FULL, DEUCES, 'plo6', seed).action).toBe('fold');
    expect(omahaRiverBeatProbability(FOURS_FULL, NINES, 6)!).toBeGreaterThan(
      PLO6_RIVER_FOLD_BEAT_PROB
    );
    for (const seed of SEEDS.slice(0, 20))
      expect(facingRiverBet(FOURS_FULL, NINES, 'plo6', seed).action).toBe('fold');
  });

  it('the top boat calls but never raises', () => {
    for (const seed of SEEDS)
      expect(['call', 'all_in']).toContain(facingRiverBet(TENS_FULL, DEUCES, 'plo6', seed).action);
  });

  it('leaves the nuts free to raise', () => {
    const actions = new Set(SEEDS.map((s) => facingRiverBet(QUADS, DEUCES, 'plo6', s).action));
    expect(actions.has('fold')).toBe(false);
    expect([...actions].some((a) => a === 'raise' || a === 'all_in')).toBe(true);
  });

  it('keeps a cheap call: a tiny bet is priced, not folded into', () => {
    for (const seed of SEEDS.slice(0, 10))
      expect(['call', 'fold']).toContain(
        facingRiverBet(JACKS_FULL, DEUCES, 'plo6', seed, {}, 2, 400).action
      );
  });

  it("is PLO6 only and switchable: other games and the ablation keep today's brain", () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const off = facingRiverBet(JACKS_FULL, DEUCES, 'plo6', seed, { v58Plo6RiverNuts: false });
      const offAgain = facingRiverBet(JACKS_FULL, DEUCES, 'plo6', seed, {
        v58Plo6RiverNuts: false,
      });
      expect(off.action).toBe(offAgain.action);
      const plo5Hole = JACKS_FULL.slice(0, 5);
      const on5 = facingRiverBet(plo5Hole, DEUCES, 'plo5', seed);
      const off5 = facingRiverBet(plo5Hole, DEUCES, 'plo5', seed, { v58Plo6RiverNuts: false });
      expect(on5.action).toBe(off5.action);
    }
  });

  it('an unpaired board is left to V59', () => {
    const board = parse('Kd9c4h2sJd');
    const hole = parse('KhJc7c8d3h5s');
    for (const seed of SEEDS.slice(0, 20)) {
      const on = facingRiverBet(hole, board, 'plo6', seed, { v59Plo6RiverUnpaired: false });
      const off = facingRiverBet(hole, board, 'plo6', seed, {
        v58Plo6RiverNuts: false,
        v59Plo6RiverUnpaired: false,
      });
      expect(on.action).toBe(off.action);
    }
  });

  it('the policy graph binds the disciplined action', () => {
    const d = facingRiverBet(JACKS_FULL, DEUCES, 'plo6', SEEDS[0]);
    expect(d.action).toBe('fold');
    if (d.policyGraph) expect(d.policyGraph.finalAction.action).toBe(d.action);
  });
});

// V59: the board has no pair, so straights and flushes are the nut hands.
const KING_HIGH = parse('Kd9c4h2sJd');
const TOP_TWO = parse('KhJc7c8d3h5s'); // beaten by sets and the Q-T straight, ~38%
const TOP_SET = parse('KhKc7c8d2hJs'); // beaten only by the straight, ~21%
const NUT_STRAIGHT = parse('QhTc7c8d3h5s'); // the nuts
const HEARTS = parse('Kh9h4h2sJd');
const LOW_FLUSH = parse('6h5h7c8d3c5s'); // a six-high flush, ~33%
const QUEEN_FLUSH = parse('QhTh7c8d3c5s'); // second-nut flush, ~10%
const NUT_FLUSH = parse('AhQhTc8d3c5s');

describe('V59 PLO6 unpaired-board river discipline', () => {
  it('reads the example hands where the thresholds put them', () => {
    const p = (h: Card[], b: Card[]) => omahaRiverBeatProbability(h, b, 6)!;
    expect(p(TOP_TWO, KING_HIGH)).toBeGreaterThanOrEqual(PLO6_RIVER_UNPAIRED_FOLD_BEAT_PROB);
    expect(p(TOP_SET, KING_HIGH)).toBeGreaterThanOrEqual(PLO6_RIVER_UNPAIRED_RAISE_BEAT_PROB);
    expect(p(TOP_SET, KING_HIGH)).toBeLessThan(PLO6_RIVER_UNPAIRED_FOLD_BEAT_PROB);
    expect(p(NUT_STRAIGHT, KING_HIGH)).toBe(0);
    expect(p(LOW_FLUSH, HEARTS)).toBeGreaterThanOrEqual(PLO6_RIVER_UNPAIRED_FOLD_BEAT_PROB);
    expect(p(QUEEN_FLUSH, HEARTS)).toBeLessThan(PLO6_RIVER_UNPAIRED_RAISE_BEAT_PROB);
    expect(p(NUT_FLUSH, HEARTS)).toBe(0);
  });

  it('folds top two pair and a low flush to a real river bet', () => {
    for (const seed of SEEDS) {
      expect(facingRiverBet(TOP_TWO, KING_HIGH, 'plo6', seed).action).toBe('fold');
      expect(facingRiverBet(LOW_FLUSH, HEARTS, 'plo6', seed).action).toBe('fold');
    }
  });

  it('top set may call but never raises; folding it is not this rule', () => {
    for (const seed of SEEDS) {
      const on = facingRiverBet(TOP_SET, KING_HIGH, 'plo6', seed);
      // All in for 400 against a 113 bet would be a raise.
      expect(['call', 'fold']).toContain(on.action);
      if (on.action === 'fold')
        expect(
          facingRiverBet(TOP_SET, KING_HIGH, 'plo6', seed, { v59Plo6RiverUnpaired: false }).action
        ).toBe('fold');
    }
  });

  it('a jack-high flush the brain raises becomes a call', () => {
    const jackFlush = parse('JhTh7c6d3c5s'); // beaten ~17%: higher flushes
    expect(omahaRiverBeatProbability(jackFlush, HEARTS, 6)!).toBeGreaterThanOrEqual(
      PLO6_RIVER_UNPAIRED_RAISE_BEAT_PROB
    );
    let raisedOff = 0;
    for (const seed of SEEDS) {
      const off = facingRiverBet(
        jackFlush,
        HEARTS,
        'plo6',
        seed,
        { v59Plo6RiverUnpaired: false },
        40
      );
      const on = facingRiverBet(jackFlush, HEARTS, 'plo6', seed, {}, 40);
      if (off.action === 'raise' || off.action === 'all_in') {
        raisedOff++;
        expect(on.action).toBe('call');
        expect(horseDecisionReceiptIsValid(on, 'plo6')).toBe(true);
      } else expect(on.action).toBe(off.action);
    }
    expect(raisedOff).toBeGreaterThan(0);
  });

  it('leaves the nut straight and the nut flush free to raise', () => {
    for (const [hole, board] of [
      [NUT_STRAIGHT, KING_HIGH],
      [NUT_FLUSH, HEARTS],
    ] as const) {
      const actions = new Set(SEEDS.map((s) => facingRiverBet(hole, board, 'plo6', s).action));
      expect(actions.has('fold')).toBe(false);
      expect([...actions].some((a) => a === 'raise' || a === 'all_in')).toBe(true);
    }
  });

  it('does not touch a hand stronger than its lines', () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const on = facingRiverBet(QUEEN_FLUSH, HEARTS, 'plo6', seed);
      const off = facingRiverBet(QUEEN_FLUSH, HEARTS, 'plo6', seed, {
        v59Plo6RiverUnpaired: false,
      });
      expect(on.action).toBe(off.action);
    }
  });

  it('keeps a cheap call and is switchable', () => {
    for (const seed of SEEDS.slice(0, 10)) {
      expect(['call', 'fold']).toContain(
        facingRiverBet(TOP_TWO, KING_HIGH, 'plo6', seed, {}, 2, 400).action
      );
      const off = facingRiverBet(TOP_TWO, KING_HIGH, 'plo6', seed, { v59Plo6RiverUnpaired: false });
      const offAgain = facingRiverBet(TOP_TWO, KING_HIGH, 'plo6', seed, {
        v59Plo6RiverUnpaired: false,
      });
      expect(off.action).toBe(offAgain.action);
    }
  });

  it('switching V59 off leaves paired boards to V58', () => {
    for (const seed of SEEDS.slice(0, 10))
      expect(
        facingRiverBet(JACKS_FULL, DEUCES, 'plo6', seed, { v59Plo6RiverUnpaired: false }).action
      ).toBe('fold');
  });

  it('the policy graph binds the disciplined action', () => {
    const d = facingRiverBet(TOP_TWO, KING_HIGH, 'plo6', SEEDS[0]);
    expect(d.action).toBe('fold');
    if (d.policyGraph) expect(d.policyGraph.finalAction.action).toBe(d.action);
  });
});
