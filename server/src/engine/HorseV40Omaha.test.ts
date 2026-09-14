/**
 * V40 (Dan 2026-09-04): "HORSES ARE PLAYING PLO4, PLO5, PLO6 AND PLO8 LIKE
 * IT'S HOLDEM. This horse check-called a pot sized bet on the flop, turn and
 * river with naked aces."
 *
 * Hand #6046101, PLO6 1/2, Shark Club: RiverMonk (BB) 7s 2s Ah 4h Ad Qs,
 * board 4s 5c 7d 5d Jc. KingFish potted flop (7 into 13), turn (27 into
 * 27) and river (81 into 81); RiverMonk check-called all three with
 * aces-up. The Monte Carlo priced that river at 41% against a range that
 * "connects" - which in six-card Omaha is every hand - so a pot bet
 * (33% to call) was always a call.
 *
 * These tests pin the three structural corrections and the diagnostic boundary:
 *   1. the sampler tiers an aggressor's hand by his LINE (omahaQuickCategory
 *      + omahaTierRequirement), so the river reads single digits;
 *   2. pair / two pair / trips get a pressure cap keyed on WHICH two pair
 *      on WHAT board (omahaMadeClass) and on the barrel count;
 *   3. a weak-class made hand plays small ball and fires no third barrel;
 *   4. the horse's review tags remain diagnostic and cannot alter its decision.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  HorseLogic,
  resolveHorseStyle,
  ploStackoffLoad,
  type HorseGameStateV2,
} from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import {
  seedFastRandom,
  fastRandom,
  simulateEquity,
  variantInfo,
  scoreOmahaHiPartial,
  omahaQuickCategory,
  omahaMadeClass,
  omahaAggressorTier,
  omahaTierRequirement,
} from './HorseEval.js';
import { SUITS, RANKS } from './PokerEngine.js';
import { LEAGUE_MATCHUPS } from '../benchmark/HorseLeague.js';
import type { Card, SeatPlayer, ActionRecord, HandStage } from '../types.js';

beforeEach(() => {
  seedFastRandom(0x40a0);
  HorseMind.reset();
});

function c(spec: string): Card {
  const suitMap: Record<string, Card['suit']> = {
    h: 'hearts',
    d: 'diamonds',
    c: 'clubs',
    s: 'spades',
  };
  return { rank: spec[0] as Card['rank'], suit: suitMap[spec[1]] };
}
const cc = (...specs: string[]): Card[] => specs.map(c);

function mkPlayer(seat: number, overrides: Partial<SeatPlayer> = {}): SeatPlayer {
  return {
    seat,
    user_id: `horse-${seat}`,
    username: `Horse${seat}`,
    stack: 240,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
    ...overrides,
  } as SeatPlayer;
}

function rec(
  seat: number,
  action: ActionRecord['action'],
  amount: number,
  stage: HandStage,
  extra: Partial<ActionRecord> = {}
): ActionRecord {
  return { seat, userId: `horse-${seat}`, action, amount, timestamp: 0, stage, ...extra };
}

/** Hand #6046101 as the engine recorded it, up to (not including) hero's
 *  decision on `street`. Hero is seat 2 (BB), KingFish seat 3. */
function hand6046101(street: 'flop' | 'turn' | 'river'): ActionRecord[] {
  const h: ActionRecord[] = [
    rec(1, 'sb' as ActionRecord['action'], 1, 'preflop'),
    rec(2, 'bb' as ActionRecord['action'], 2, 'preflop'),
    rec(3, 'call', 2, 'preflop'),
    rec(4, 'fold', 0, 'preflop'),
    rec(5, 'fold', 0, 'preflop'),
    rec(1, 'fold', 0, 'preflop'),
    rec(2, 'raise', 6, 'preflop', { isFullRaise: true }),
    rec(3, 'call', 4, 'preflop'),
    rec(2, 'check', 0, 'flop'),
    rec(3, 'bet', 7, 'flop', { isFullRaise: true }),
  ];
  if (street === 'flop') return h;
  h.push(
    rec(2, 'call', 7, 'flop'),
    rec(2, 'check', 0, 'turn'),
    rec(3, 'bet', 27, 'turn', { isFullRaise: true })
  );
  if (street === 'turn') return h;
  h.push(
    rec(2, 'call', 27, 'turn'),
    rec(2, 'check', 0, 'river'),
    rec(3, 'bet', 81, 'river', { isFullRaise: true })
  );
  return h;
}

function riverMonkSpot(
  street: 'flop' | 'turn' | 'river',
  heroCards: Card[] = cc('7s', '2s', 'Ah', '4h', 'Ad', 'Qs')
): { hero: SeatPlayer; gs: HorseGameStateV2 } {
  const board =
    street === 'flop'
      ? cc('4s', '5c', '7d')
      : street === 'turn'
        ? cc('4s', '5c', '7d', '5d')
        : cc('4s', '5c', '7d', '5d', 'Jc');
  const bet = street === 'flop' ? 7 : street === 'turn' ? 27 : 81;
  const potBefore = street === 'flop' ? 13 : street === 'turn' ? 27 : 81;
  const invested = street === 'flop' ? 6 : street === 'turn' ? 13 : 40;
  const hero = mkPlayer(2, { cards: heroCards, stack: 250 - invested, totalInvested: invested });
  const gs = {
    players: [
      mkPlayer(1, { is_folded: true }),
      hero,
      mkPlayer(3, { bet, stack: 300 }),
      mkPlayer(4, { is_folded: true }),
      mkPlayer(5, { is_folded: true }),
    ],
    communityCards: board,
    pot: potBefore + bet,
    currentBet: bet,
    minRaise: bet,
    stage: street as HandStage,
    gameVariant: 'plo6',
    bigBlind: 2,
    dealerSeat: 5,
    gameMode: 'cash' as const,
    format: 'cash',
    actionHistory: hand6046101(street),
  } as unknown as HorseGameStateV2;
  return { hero, gs };
}

function foldRate(
  make: () => { hero: SeatPlayer; gs: HorseGameStateV2 },
  opts: Record<string, unknown>,
  trials = 60,
  mods: Record<string, unknown> = {}
): number {
  let folds = 0;
  for (let t = 1; t <= trials; t++) {
    seedFastRandom(t * 7919 + 3);
    HorseMind.reset();
    const { hero, gs } = make();
    const d = HorseLogic.decide(hero, gs, 'balanced', mods, opts);
    if (d.action === 'fold') folds++;
  }
  return folds / trials;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The structural category the sampler uses agrees with the scorer
// ─────────────────────────────────────────────────────────────────────────────
describe('V40 omahaQuickCategory', () => {
  it('matches scoreOmahaHiPartial on random 4/5/6-card deals (straight flushes read as flush)', () => {
    seedFastRandom(11);
    const deck: Card[] = [];
    for (const suit of SUITS) for (const rank of RANKS) deck.push({ rank, suit });
    let mismatch = 0;
    for (let n = 0; n < 6000; n++) {
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(fastRandom() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      const hc = 4 + (n % 3);
      const bl = 3 + (n % 3);
      const hole = deck.slice(0, hc);
      const board = deck.slice(hc, hc + bl);
      const q = omahaQuickCategory(hole, board);
      const real = Math.floor(scoreOmahaHiPartial(hole, board) / 0x100000);
      if (q !== real && !(real >= 9 && q >= 5)) mismatch++;
    }
    expect(mismatch).toBe(0);
  });

  it('knows the Omaha two-card rule: a pocket pair cannot also play a board hit', () => {
    // QQ + 3 on 3 6 J: QQ plays (pair) or Q3 plays (pair of 3s) - never two pair.
    expect(omahaQuickCategory(cc('Qc', '3d', 'Qs', 'Td'), cc('3h', '6h', 'Js'))).toBe(2);
    // K + JJ on K 9 3 K: KJ plays trips, JJ plays two pair - never a boat.
    expect(omahaQuickCategory(cc('Js', '7h', 'Jh', 'Kc'), cc('Kd', '9s', '3h', 'Ks'))).toBe(4);
    // 4 + x on J 9 J 4: two pair (the 4 pairs once); J + 4 is the boat.
    expect(omahaQuickCategory(cc('7d', '5s', '4d', '2c'), cc('Jh', '9d', 'Jc', '4c'))).toBe(3);
    expect(omahaQuickCategory(cc('7d', '5s', '4d', 'Jd'), cc('Jh', '9d', 'Jc', '4c'))).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The made-hand class: which two pair, on what board
// ─────────────────────────────────────────────────────────────────────────────
describe('V40 omahaMadeClass', () => {
  const heroAA = cc('7s', '2s', 'Ah', '4h', 'Ad', 'Qs');
  it('aces-up on the paired 4-5-7-5-J board is a weak two pair', () => {
    const m = omahaMadeClass(heroAA, cc('4s', '5c', '7d', '5d', 'Jc'));
    expect(m.category).toBe(3);
    expect(m.weak).toBe(true);
    expect(m.boardPaired).toBe(true);
  });
  it('bottom two on the 4-5-7 flop is low2p and weak', () => {
    const m = omahaMadeClass(heroAA, cc('4s', '5c', '7d'));
    expect(m.cls).toBe('low2p');
    expect(m.weak).toBe(true);
  });
  it('top set on a dry rainbow board is NOT weak; on a three-flush board it is', () => {
    const set = cc('Kh', 'Kd', '7c', '2s');
    expect(omahaMadeClass(set, cc('Ks', '8d', '3c'))).toMatchObject({ cls: 'set', weak: false });
    expect(omahaMadeClass(set, cc('Ks', '8s', '3s'))).toMatchObject({ cls: 'set', weak: true });
  });
  it('top two on a brick is not weak; top two on a paired board is', () => {
    const t2 = cc('Kh', '8d', '7c', '2s');
    expect(omahaMadeClass(t2, cc('Ks', '8c', '3d'))).toMatchObject({ cls: 'top2p', weak: false });
    expect(omahaMadeClass(t2, cc('Ks', '8c', '3d', '3h'))).toMatchObject({
      cls: 'top2p',
      weak: true,
    });
  });
  it('trips via the board pair are weaktrips; a boat is strong', () => {
    expect(omahaMadeClass(cc('5h', '9d', 'Tc', '2s'), cc('4s', '5c', '7d', '5d'))).toMatchObject({
      cls: 'weaktrips',
      weak: true,
    });
    expect(omahaMadeClass(cc('5h', '7h', 'Tc', '2s'), cc('4s', '5c', '7d', '5d'))).toMatchObject({
      cls: 'strong',
      weak: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The tiered sampler: a pot-pot-pot line is priced as the hands that bet it
// ─────────────────────────────────────────────────────────────────────────────
describe('V40 tiered aggressor sampling', () => {
  it('tiers climb with barrels, size and raises', () => {
    expect(omahaAggressorTier({ aggrW: 0.07, checked: 0, streets: 1, lastFrac: 0.4 })).toBe(1);
    expect(omahaAggressorTier({ aggrW: 0.07, checked: 0, streets: 1, lastFrac: 1 })).toBe(2);
    expect(omahaAggressorTier({ aggrW: 0.14, checked: 0, streets: 2, lastFrac: 0.5 })).toBe(2);
    expect(omahaAggressorTier({ aggrW: 0.21, checked: 0, streets: 3, lastFrac: 1 })).toBe(3);
    expect(
      omahaAggressorTier({ aggrW: 0.07, checked: 0, streets: 1, lastFrac: 0.5, raised: true })
    ).toBe(2);
    expect(omahaAggressorTier({ aggrW: 0, checked: 2 })).toBe(0);
  });
  it('a triple barrel on a paired river demands trips or better', () => {
    const shape = { paired: true, straightPossible: true, flushPossible: false };
    expect(omahaTierRequirement(3, 5, shape).minCat).toBe(4);
    expect(omahaTierRequirement(3, 5, { ...shape, paired: false }).minCat).toBe(5);
    expect(omahaTierRequirement(1, 5, shape).minCat).toBe(2);
  });
  it('aces-up on 4-5-7-5-J reads single digits against a pot-pot-pot bettor (was 41%)', () => {
    const vi = variantInfo('plo6');
    const hero = cc('7s', '2s', 'Ah', '4h', 'Ad', 'Qs');
    const board = cc('4s', '5c', '7d', '5d', 'Jc');
    seedFastRandom(7);
    const legacy = simulateEquity(hero, board, 1, vi, 1500, [[0.3, 1]], false, undefined, [
      { aggrW: 0.21, checked: 0, bigBet: true },
    ]);
    seedFastRandom(7);
    const v40 = simulateEquity(hero, board, 1, vi, 1500, [[0.3, 1]], false, undefined, [
      { aggrW: 0.21, checked: 0, bigBet: true, streets: 3, lastFrac: 1, raised: false },
    ]);
    expect(legacy).toBeGreaterThan(0.33); // the old read: "a pot bet is a call"
    expect(v40).toBeLessThan(0.2);
  });
  it('the tiered redraw stays inside the per-decision budget', () => {
    const vi = variantInfo('plo6');
    const hero = cc('7s', '2s', 'Ah', '4h', 'Ad', 'Qs');
    const board = cc('4s', '5c', '7d', '5d', 'Jc');
    const reads = [
      { aggrW: 0.21, checked: 0, bigBet: true, streets: 3, lastFrac: 1 },
      null,
      null,
      null,
    ];
    const bands: Array<[number, number] | null> = [
      [0.3, 1],
      [0.3, 1],
      [0.3, 1],
      [0.3, 1],
    ];
    simulateEquity(hero, board, 4, vi, vi.iterations, bands, true, undefined, reads); // warm
    const t0 = performance.now();
    for (let i = 0; i < 10; i++)
      simulateEquity(hero, board, 4, vi, vi.iterations, bands, true, undefined, reads);
    const perDecision = (performance.now() - t0) / 10;
    expect(perDecision).toBeLessThan(60);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The decision: hand #6046101 replayed
// ─────────────────────────────────────────────────────────────────────────────
describe('V40 hand #6046101 - aces-up vs pot, pot, pot', () => {
  it('folds the river pot bet with aces-up (with V40 off it called)', () => {
    const on = foldRate(() => riverMonkSpot('river'), {});
    const off = foldRate(() => riverMonkSpot('river'), { v40Omaha: false });
    expect(on).toBeGreaterThanOrEqual(0.85);
    expect(off).toBeLessThan(0.5);
  });
  it('folds the turn pot bet (second barrel, board paired) most of the time', () => {
    const on = foldRate(() => riverMonkSpot('turn'), {});
    expect(on).toBeGreaterThanOrEqual(0.7);
  });
  it('the flop bet (half pot, first barrel) is still mostly a call', () => {
    const on = foldRate(() => riverMonkSpot('flop'), {});
    expect(on).toBeLessThan(0.5);
  });
  it('a full house on the same river never folds', () => {
    const r = foldRate(() => riverMonkSpot('river', cc('5h', '7h', 'Tc', '2s', 'Kd', '9c')), {});
    expect(r).toBe(0);
  });
  it('the nut straight on an unpaired river still calls the third barrel', () => {
    const make = () => {
      const { hero, gs } = riverMonkSpot('river', cc('6h', '8h', 'Tc', '2s', 'Kd', '9c'));
      gs.communityCards = cc('4s', '5c', '7d', 'Qd', 'Jc');
      return { hero, gs };
    };
    expect(foldRate(make, {})).toBeLessThan(0.15);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The betting side: KingFish's third barrel with bottom two on a paired board
// ─────────────────────────────────────────────────────────────────────────────
describe('V40 small ball - no third barrel with a weak-class made hand', () => {
  function kingFishRiver(): { hero: SeatPlayer; gs: HorseGameStateV2 } {
    const hero = mkPlayer(3, {
      cards: cc('9s', 'Tc', '4c', '7c', 'Qh', '3h'),
      stack: 260,
      totalInvested: 40,
    });
    const gs = {
      players: [mkPlayer(1, { is_folded: true }), mkPlayer(2, { stack: 210 }), hero],
      communityCards: cc('4s', '5c', '7d', '5d', 'Jc'),
      pot: 81,
      currentBet: 0,
      minRaise: 2,
      stage: 'river' as HandStage,
      gameVariant: 'plo6',
      bigBlind: 2,
      dealerSeat: 5,
      gameMode: 'cash' as const,
      format: 'cash',
      actionHistory: [
        ...hand6046101('river').filter((a) => !(a.stage === 'river')),
        rec(2, 'call', 27, 'turn'),
        rec(2, 'check', 0, 'river'),
      ],
    } as unknown as HorseGameStateV2;
    // drop the duplicated turn call the filter kept
    gs.actionHistory = gs.actionHistory!.filter(
      (a, i, arr) =>
        !(
          a.stage === 'turn' &&
          a.action === 'call' &&
          arr.findIndex((b) => b.stage === 'turn' && b.action === 'call') !== i
        )
    );
    return { hero, gs };
  }
  function betRate(opts: Record<string, unknown>, trials = 60): { bets: number; potBets: number } {
    let bets = 0;
    let potBets = 0;
    for (let t = 1; t <= trials; t++) {
      seedFastRandom(t * 104729 + 1);
      HorseMind.reset();
      const { hero, gs } = kingFishRiver();
      const d = HorseLogic.decide(hero, gs, 'lag', {}, opts);
      if (d.action === 'bet' || d.action === 'raise' || d.action === 'all_in') {
        bets++;
        if ((d.amount ?? 0) >= 0.9 * 81) potBets++;
      }
    }
    return { bets: bets / trials, potBets: potBets / trials };
  }
  it('checks back the river with 7-4 two pair after two called barrels; never pots it', () => {
    const on = betRate({});
    expect(on.potBets).toBe(0);
    expect(on.bets).toBeLessThan(0.35);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The tag loop: the horse's own review verdicts reach the decision
// ─────────────────────────────────────────────────────────────────────────────
describe('V40 historical leak profile - diagnostic only', () => {
  it('resolveHorseStyle carries the leak counts and denominator', () => {
    const { mods } = resolveHorseStyle(
      {
        style: 'tag',
        tightness: 1.05,
        leaks: { plo_naked_trips_stackoff: 9, coldcall_stackoff: 4, junk: 'x', neg: -3 },
        leaksHands: 100,
      },
      'h1'
    );
    expect(mods.leaks).toEqual({ plo_naked_trips_stackoff: 9, coldcall_stackoff: 4 });
    expect(mods.leaksHands).toBe(100);
    expect(ploStackoffLoad(mods)).toBeCloseTo(0.13, 5);
  });
  it('no profile, or too small a sample, reads as no load', () => {
    expect(ploStackoffLoad(undefined)).toBe(0);
    expect(ploStackoffLoad({ leaks: { coldcall_stackoff: 5 }, leaksHands: 10 })).toBe(0);
  });
  it('historical review tags leave the marginal turn fold frequency unchanged', () => {
    // A softer spot than the paired turn: top two with a live straight on an
    // unpaired turn, facing a pot-sized second barrel.
    const make = () => {
      const { hero, gs } = riverMonkSpot('turn', cc('7s', '2s', 'Ah', '9h', 'Td', 'Qs'));
      gs.communityCards = cc('4s', 'Tc', '7d', '2d');
      return { hero, gs };
    };
    const clean = foldRate(make, {}, 80);
    const tagged = foldRate(make, {}, 80, {
      leaks: { plo_naked_trips_stackoff: 8, coldcall_stackoff: 6, dominated_straight_stackoff: 4 },
      leaksHands: 120,
    });
    expect(tagged).toBe(clean);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. The league can measure it, and the legacy card switches it off
// ─────────────────────────────────────────────────────────────────────────────
describe('V40 league wiring', () => {
  it('has plo6 and plo4 ablation matchups and is off in full_vs_v2_legacy', () => {
    const names = LEAGUE_MATCHUPS.map((m) => m.name);
    expect(names).toContain('plo6_v40_omaha');
    expect(names).toContain('plo4_v40_omaha');
    const legacy = LEAGUE_MATCHUPS.find((m) => m.name === 'full_vs_v2_legacy')!.b as Record<
      string,
      unknown
    >;
    expect(legacy.v40Omaha).toBe(false);
  });
});
