/**
 * V51 THE COMMITMENT CAP (2026-09-21, daily audit 2026-09-20 P2.2).
 *
 * The measurement and the thresholds are in HorseCommitCap.ts. These
 * scenarios pin four things:
 *   - with v51CommitCap on, the targeted spots change (one pair no better
 *     than top pair weak kicker, and trips with a weak kicker, in a 20bb+
 *     pot stop raising and jamming, and one pair folds to a raise or a shove
 *     it is not priced into), and each change carries a telemetry receipt;
 *   - with it off (the default) nothing changes;
 *   - with it on, every unrelated spot plays exactly as before, seed for
 *     seed: the nuts, the hand's own two pair, sets, top-kicker trips, trips
 *     with a ten-or-better kicker, overpairs, top pair with a ten kicker,
 *     draws, pots under 20bb, Omaha, and decisions that are not facing a bet;
 *   - the audit's question about the V15 dominated-hand floor: it does not
 *     reach sub-top-kicker trips in hold'em at all, and nothing else on the
 *     path reads a trips hand's kicker.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HorseLogic, type HorseDecideOpts } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import { HorseMind } from './HorseMind.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import {
  COMMIT_CAP_EQUITY_ONE_PAIR,
  COMMIT_CAP_EQUITY_TRIPS,
  COMMIT_CAP_POT_BB,
  COMMIT_CAP_WEAK_KICKER,
  commitCapClass,
  commitCapEquity,
  facesRaiseOrAllIn,
} from './HorseCommitCap.js';
import { LEAGUE_MATCHUPS } from '../benchmark/HorseLeague.js';
import type { Card, SeatPlayer, ActionRecord, HandStage } from '../types.js';

type GS = Parameters<(typeof HorseLogic)['decide']>[1];

const BB = 2;
const SUIT: Record<string, Card['suit']> = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
const cc = (...specs: string[]): Card[] =>
  specs.map((s) => ({ rank: s[0] as Card['rank'], suit: SUIT[s[1]] }));

function mkPlayer(seat: number, over: Partial<SeatPlayer> = {}): SeatPlayer {
  return {
    seat,
    user_id: `horse-${seat}`,
    username: `Horse${seat}`,
    stack: 1000,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
    ...over,
  } as SeatPlayer;
}

function rec(
  seat: number,
  action: ActionRecord['action'],
  amount: number,
  stage: HandStage,
  extra: Partial<ActionRecord> = {}
): ActionRecord {
  return { seat, userId: `horse-${seat}`, action, amount, timestamp: 1, stage, ...extra };
}

interface Spot {
  hole: string[];
  board: string[];
  /** chips in the middle before this street's wagers */
  potBefore: number;
  /** this street's actions, in order (hero is seat 1, out of position) */
  actions: (stage: HandStage) => ActionRecord[];
  heroBet: number;
  villainBet: number;
  heroStack: number;
  villainStack?: number;
  variant?: string;
}

/** Heads-up: hero seat 1 out of position, the opponent on the button. */
function build(s: Spot): { hero: SeatPlayer; gs: GS } {
  const stage: HandStage = s.board.length === 3 ? 'flop' : s.board.length === 4 ? 'turn' : 'river';
  const villainStack = s.villainStack ?? 1000;
  const hero = mkPlayer(1, {
    cards: cc(...s.hole),
    stack: s.heroStack,
    bet: s.heroBet,
    totalInvested: s.potBefore / 2 + s.heroBet,
  });
  const villain = mkPlayer(2, {
    stack: villainStack,
    bet: s.villainBet,
    totalInvested: s.potBefore / 2 + s.villainBet,
    is_all_in: villainStack === 0,
  });
  const gs = {
    players: [hero, villain],
    communityCards: cc(...s.board),
    pot: s.potBefore + s.heroBet + s.villainBet,
    currentBet: Math.max(s.heroBet, s.villainBet),
    minRaise: BB,
    stage,
    gameVariant: s.variant ?? 'nlh',
    bigBlind: BB,
    dealerSeat: 2,
    gameMode: 'cash' as const,
    actionHistory: [
      rec(2, 'raise', 6, 'preflop', { isFullRaise: true }),
      rec(1, 'call', 4, 'preflop'),
      ...s.actions(stage),
    ],
  } as unknown as GS;
  return { hero, gs };
}

const OFF: HorseDecideOpts = { mind: false, decisionTimeMs: 1_789_000_000_000 };
const ON: HorseDecideOpts = { ...OFF, v51CommitCap: true };

function decideAt(spot: Spot, opts: HorseDecideOpts, seed: number) {
  seedFastRandom(seed);
  const { hero, gs } = build(spot);
  const d = HorseLogic.decide(hero, gs, 'balanced', {}, opts);
  // the brain's safety net answers check/fold on a throw; a scenario that
  // passes by crashing proves nothing
  expect(d.policyFallback).toBeUndefined();
  return d;
}

const SEEDS = Array.from({ length: 24 }, (_, i) => 0x51c0 + i * 7919);

function actionsOver(spot: Spot, opts: HorseDecideOpts): string[] {
  return SEEDS.map((seed) => decideAt(spot, opts, seed).action);
}

/** Receipts fired over SEEDS, by feature. */
function fired(spot: Spot, opts: HorseDecideOpts): Record<string, number> {
  enableBrainTelemetry();
  drainFires();
  for (const seed of SEEDS) decideAt(spot, { ...opts, telemetry: true }, seed);
  return Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
}

/** The audit's -496bb hand: K4 on K-J-3-J-8, top pair with a four kicker. */
const K4 = { hole: ['Kh', '4c'], board: ['Kd', 'Js', '3h', 'Jc', '8s'] };
/** Trip kings with a four kicker, and the same board for the other trips. */
const TRIPS_BOARD = ['Kd', 'Kh', '3c', '2s', 'Jh'];

/** Hero bet 20bb into 40bb on the river and was raised to 100bb. */
function riverRaised(hand: { hole: string[]; board: string[] }, heroStack: number): Spot {
  return {
    ...hand,
    potBefore: 80,
    heroBet: 40,
    villainBet: 200,
    heroStack,
    actions: (st) => [rec(1, 'bet', 40, st), rec(2, 'raise', 200, st, { isFullRaise: true })],
  };
}

/** Hero checked and faces a plain bet of half the pot (pot 45bb as it decides). */
function facingBet(hand: { hole: string[]; board: string[] }, heroStack = 1000): Spot {
  return {
    ...hand,
    potBefore: 60,
    heroBet: 0,
    villainBet: 30,
    heroStack,
    actions: (st) => [rec(1, 'check', 0, st), rec(2, 'bet', 30, st)],
  };
}

beforeEach(() => {
  HorseMind.reset();
  drainFires();
});

describe('V51 the hand class', () => {
  const cls = (hole: string[], board: string[], shortDeck = false) =>
    commitCapClass(cc(...hole), cc(...board), shortDeck);

  it('reads the audit hands the way the V24 detectors do', () => {
    // the board's own pair belongs to everybody: K4 on K-J-3-J-8 is top pair, four kicker
    expect(cls(K4.hole, K4.board)).toBe('top_pair_weak_kicker');
    expect(cls(['As', '9c'], ['7h', '7c', 'Ah', 'Kh', '4c'])).toBe('top_pair_weak_kicker');
    expect(cls(['Ah', '6c'], ['As', 'Kd', '8h', '2c'])).toBe('top_pair_weak_kicker');
    // the audit's A4o for trip aces with a four kicker
    expect(cls(['Ad', '4c'], ['As', 'Ah', 'Td', '7s', '2c'])).toBe('weak_kicker_trips');
  });

  it('covers top pair weak kicker OR WORSE: a lower pair and an underpair', () => {
    expect(cls(['Kh', '7c'], ['As', '7d', '2h'])).toBe('lower_pair');
    expect(cls(['Kh', 'Qc'], ['As', 'Kd', '2h'])).toBe('lower_pair'); // second pair, any kicker
    expect(cls(['5h', '5c'], ['9s', '7d', '2h'])).toBe('underpair');
    expect(cls(['5h', '5c'], ['7s', '7d', '2h'])).toBe('underpair');
  });

  it('covers trips with a kicker of nine or worse, and no better kicker', () => {
    expect(cls(['Ks', '4c'], TRIPS_BOARD)).toBe('weak_kicker_trips');
    expect(cls(['Ks', '9c'], TRIPS_BOARD)).toBe('weak_kicker_trips');
    expect(cls(['Ks', 'Tc'], TRIPS_BOARD)).toBeNull(); // ten kicker is the line
    expect(cls(['Ks', 'Qc'], TRIPS_BOARD)).toBeNull();
    expect(cls(['Ks', 'Ac'], TRIPS_BOARD)).toBeNull(); // top-kicker trips
    expect(cls(['As', 'Kc'], ['Ad', 'Ah', '3c'])).toBeNull(); // top kicker to trip aces
  });

  it('never covers a better hand or a hand with no pair of its own', () => {
    expect(cls(['As', 'Tc'], ['Ad', '8h', '3c'])).toBeNull(); // ten kicker is the line
    expect(cls(['As', 'Kc'], ['Ad', '8h', '3c'])).toBeNull();
    expect(cls(['Qs', 'Qc'], ['Jd', '8h', '3c'])).toBeNull(); // overpair
    expect(cls(['8s', '8c'], ['Kd', '8h', '3c'])).toBeNull(); // set
    expect(cls(['Ks', '8c'], ['Kd', '8h', '3c'])).toBeNull(); // its own two pair
    expect(cls(['Ks', '3c'], ['Kd', 'Kh', '3h'])).toBeNull(); // a full house
    expect(cls(['Ks', '4c'], ['Kd', 'Kh', 'Kc'])).toBeNull(); // quads
    expect(cls(['As', 'Kc'], ['7d', '7h', '3c'])).toBeNull(); // no pair of its own
    expect(cls(['7h', 'Kc'], ['3d', '4h', '5c', '6s', 'Kh'])).toBeNull(); // a straight
    expect(cls(['Kh', '4h'], ['Ks', '8h', '2h', '9h'])).toBeNull(); // a flush
    expect(cls(['Kh', '4h', '9c'], ['Ks', '8d', '2c'])).toBeNull(); // pineapple before the discard
  });

  it('short deck reads the same ladder', () => {
    expect(cls(['Kh', '9c'], ['Ks', 'Td', '6c'], true)).toBe('top_pair_weak_kicker');
    expect(cls(['Kh', 'Tc'], ['Ks', '9d', '6c'], true)).toBeNull();
  });

  it('pins the thresholds the design names, and which ceiling each class uses', () => {
    expect(COMMIT_CAP_POT_BB).toBe(20);
    expect(COMMIT_CAP_WEAK_KICKER).toBe(9);
    expect(COMMIT_CAP_EQUITY_ONE_PAIR).toBe(0.2);
    expect(COMMIT_CAP_EQUITY_TRIPS).toBe(0.55);
    expect(commitCapEquity('top_pair_weak_kicker')).toBe(0.2);
    expect(commitCapEquity('lower_pair')).toBe(0.2);
    expect(commitCapEquity('underpair')).toBe(0.2);
    expect(commitCapEquity('weak_kicker_trips')).toBe(0.55);
  });
});

describe('V51 facing a raise or an all-in', () => {
  const h = (...a: ActionRecord[]) => a;
  it('a first bet is neither; a raise, a re-raise and a shove are', () => {
    expect(facesRaiseOrAllIn(h(rec(2, 'bet', 30, 'turn')), 'turn', 'horse-1')).toBe(false);
    expect(
      facesRaiseOrAllIn(
        h(rec(1, 'bet', 40, 'river'), rec(2, 'raise', 200, 'river')),
        'river',
        'horse-1'
      )
    ).toBe(true);
    expect(
      facesRaiseOrAllIn(
        h(rec(3, 'bet', 20, 'flop'), rec(2, 'raise', 60, 'flop'), rec(3, 'call', 40, 'flop')),
        'flop',
        'horse-1'
      )
    ).toBe(true);
    expect(facesRaiseOrAllIn(h(rec(2, 'all_in', 120, 'river')), 'river', 'horse-1')).toBe(true);
  });

  it('an all-in that only calls is not a wager, and another street does not count', () => {
    expect(
      facesRaiseOrAllIn(
        h(rec(2, 'bet', 30, 'turn'), rec(3, 'all_in', 18, 'turn')),
        'turn',
        'horse-1'
      )
    ).toBe(false);
    expect(
      facesRaiseOrAllIn(
        h(rec(1, 'bet', 10, 'flop'), rec(2, 'raise', 30, 'flop'), rec(2, 'bet', 30, 'turn')),
        'turn',
        'horse-1'
      )
    ).toBe(false);
  });
});

describe('V51 with the flag on, the targeted spots change', () => {
  it('K4 facing a river raise it is not priced into folds instead of calling (deep)', () => {
    const spot = riverRaised(K4, 1000);
    expect(actionsOver(spot, OFF).filter((a) => a !== 'fold').length).toBeGreaterThan(0);
    expect(new Set(actionsOver(spot, ON))).toEqual(new Set(['fold']));
  });

  it('K4 committed and facing a river raise folds instead of jamming (the -496bb shape)', () => {
    const spot = riverRaised(K4, 260);
    expect(actionsOver(spot, OFF)).toContain('all_in');
    expect(new Set(actionsOver(spot, ON))).toEqual(new Set(['fold']));
  });

  it("an opponent's all-in bet the hand is not priced into is folded", () => {
    const spot: Spot = {
      hole: ['Ah', '6c'],
      board: ['As', 'Kd', '8h', '2c', 'Td'],
      potBefore: 80,
      heroBet: 0,
      villainBet: 120,
      villainStack: 0,
      heroStack: 400,
      actions: (st) => [rec(1, 'check', 0, st), rec(2, 'all_in', 120, st, { isFullRaise: true })],
    };
    expect(actionsOver(spot, OFF).filter((a) => a !== 'fold').length).toBeGreaterThan(0);
    expect(new Set(actionsOver(spot, ON))).toEqual(new Set(['fold']));
  });

  it('the call-down is bounded, not closed: a raise priced under the ceiling is still called', () => {
    const spot: Spot = {
      ...K4,
      potBefore: 200,
      heroBet: 20,
      villainBet: 40,
      heroStack: 1000,
      actions: (st) => [rec(1, 'bet', 20, st), rec(2, 'raise', 40, st, { isFullRaise: true })],
    };
    // 20 to call into 260: 7.1% pot odds, under the 0.20 ceiling
    expect(new Set(actionsOver(spot, ON))).toEqual(new Set(['call']));
  });

  it('top pair weak kicker never raises a bet in a 20bb+ pot: every raise becomes a call', () => {
    const spot = facingBet({ hole: ['Ah', '6c'], board: ['As', 'Kd', '8h', '2c'] });
    const off = actionsOver(spot, OFF);
    const on = actionsOver(spot, ON);
    expect(off).toContain('raise');
    expect(on).not.toContain('raise');
    expect(on).not.toContain('all_in');
    // seed for seed, every raise became a call and nothing else moved
    off.forEach((a, i) => expect(on[i]).toBe(a === 'raise' ? 'call' : a));
  });

  it('weak-kicker trips never raise a bet in a 20bb+ pot: every raise becomes a call', () => {
    const spot = facingBet({ hole: ['Ks', '4c'], board: TRIPS_BOARD.slice(0, 4) });
    const off = actionsOver(spot, OFF);
    const on = actionsOver(spot, ON);
    expect(off).toContain('raise');
    expect(on).not.toContain('raise');
    expect(on).not.toContain('all_in');
    off.forEach((a, i) => expect(on[i]).toBe(a === 'raise' || a === 'all_in' ? 'call' : a));
  });

  it('weak-kicker trips committed and facing a river raise call where they used to jam', () => {
    const spot = riverRaised({ hole: ['Ks', '4c'], board: TRIPS_BOARD }, 260);
    expect(actionsOver(spot, OFF)).toContain('all_in');
    expect(new Set(actionsOver(spot, ON))).toEqual(new Set(['call']));
  });

  it('one pair committed and facing a plain bet calls where it used to jam', () => {
    const spot: Spot = {
      hole: ['Ah', '6c'],
      board: ['As', 'Kd', '8h', '2c', 'Td'],
      potBefore: 120,
      heroBet: 0,
      villainBet: 40,
      heroStack: 80,
      actions: (st) => [rec(1, 'check', 0, st), rec(2, 'bet', 40, st)],
    };
    expect(actionsOver(spot, OFF)).toContain('all_in');
    expect(new Set(actionsOver(spot, ON))).toEqual(new Set(['call']));
  });

  it('every change carries its receipt, and the flag off fires none', () => {
    const raised = riverRaised(K4, 1000);
    expect(fired(raised, ON).v51_commit_cap_fold ?? 0).toBeGreaterThan(0);
    expect(fired(raised, OFF).v51_commit_cap_fold ?? 0).toBe(0);
    const bet = facingBet({ hole: ['Ah', '6c'], board: ['As', 'Kd', '8h', '2c'] });
    expect(fired(bet, ON).v51_commit_cap_no_raise ?? 0).toBeGreaterThan(0);
    expect(fired(bet, OFF).v51_commit_cap_no_raise ?? 0).toBe(0);
    const trips = riverRaised({ hole: ['Ks', '4c'], board: TRIPS_BOARD }, 260);
    expect(fired(trips, ON).v51_commit_cap_no_jam ?? 0).toBeGreaterThan(0);
    expect(fired(trips, OFF).v51_commit_cap_no_jam ?? 0).toBe(0);
  });

  it('a receipt counts a decision the cap changed, never one it left alone', () => {
    // the bounded call-down above calls with the flag on and off: no fold receipt
    const cheap: Spot = {
      ...K4,
      potBefore: 200,
      heroBet: 20,
      villainBet: 40,
      heroStack: 1000,
      actions: (st) => [rec(1, 'bet', 20, st), rec(2, 'raise', 40, st, { isFullRaise: true })],
    };
    expect(fired(cheap, ON).v51_commit_cap_fold ?? 0).toBe(0);
    // one receipt per changed decision, not one per gate it passed through
    const bet = facingBet({ hole: ['Ah', '6c'], board: ['As', 'Kd', '8h', '2c'] });
    const raises = actionsOver(bet, OFF).filter((a) => a === 'raise').length;
    expect(fired(bet, ON).v51_commit_cap_no_raise).toBe(raises);
  });
});

describe('V51 with the flag off (the default), nothing changes', () => {
  it('omitting the flag and passing false are the same brain, and neither is the cap', () => {
    const spot = riverRaised(K4, 260);
    const omitted = SEEDS.map((s) => decideAt(spot, OFF, s));
    const explicit = SEEDS.map((s) => decideAt(spot, { ...OFF, v51CommitCap: false }, s));
    expect(explicit.map((d) => [d.action, d.amount])).toEqual(
      omitted.map((d) => [d.action, d.amount])
    );
    expect(omitted.map((d) => d.action)).not.toEqual(actionsOver(spot, ON));
  });
});

describe('V51 with the flag on, unrelated spots play exactly as before', () => {
  const same = (spot: Spot): void => {
    for (const seed of SEEDS) {
      const off = decideAt(spot, OFF, seed);
      const on = decideAt(spot, ON, seed);
      expect([on.action, on.amount]).toEqual([off.action, off.amount]);
    }
  };
  const raisedOn = (hole: string[], board: string[]) => riverRaised({ hole, board }, 1000);

  it('the nut flush facing the raise', () =>
    same(raisedOn(['Ah', 'Qh'], ['Kh', '7h', '2h', 'Js', '3c'])));
  it('its own two pair facing the raise', () =>
    same(raisedOn(['Ks', '8c'], ['Kd', '8h', '3c', '2s', 'Jh'])));
  it('a set facing the raise', () => same(raisedOn(['8s', '8c'], ['Kd', '8h', '3c', '2s', 'Jh'])));
  it('top-kicker trips facing the raise', () => same(raisedOn(['Ks', 'Ac'], TRIPS_BOARD)));
  it('top-kicker trips committed facing the raise', () =>
    same(riverRaised({ hole: ['Ks', 'Ac'], board: TRIPS_BOARD }, 260)));
  it('trips with a queen kicker committed facing the raise', () =>
    same(riverRaised({ hole: ['Ks', 'Qc'], board: TRIPS_BOARD }, 260)));
  it('top-kicker trips facing a plain bet', () =>
    same(facingBet({ hole: ['Ks', 'Ac'], board: TRIPS_BOARD.slice(0, 4) })));
  it('an overpair facing the raise', () =>
    same(raisedOn(['Qs', 'Qc'], ['Jd', '8h', '3c', '2s', '7h'])));
  it('top pair with a ten kicker facing the raise', () =>
    same(raisedOn(['As', 'Tc'], ['Ad', '8h', '3c', '2s', 'Jh'])));
  it('a hand with no pair of its own (a draw) facing a flop raise', () =>
    same({
      hole: ['Qh', 'Th'],
      board: ['9h', '8h', '2c'],
      potBefore: 60,
      heroBet: 20,
      villainBet: 70,
      heroStack: 1000,
      actions: (st) => [rec(1, 'bet', 20, st), rec(2, 'raise', 70, st, { isFullRaise: true })],
    }));

  it('top pair weak kicker in a pot under 20bb, even facing a raise', () => {
    const spot: Spot = {
      ...K4,
      potBefore: 16,
      heroBet: 4,
      villainBet: 12,
      heroStack: 1000,
      actions: (st) => [rec(1, 'bet', 4, st), rec(2, 'raise', 12, st, { isFullRaise: true })],
    };
    expect((spot.potBefore + spot.heroBet + spot.villainBet) / BB).toBeLessThan(COMMIT_CAP_POT_BB);
    same(spot);
  });

  it('weak-kicker trips in a pot under 20bb, facing a bet', () => {
    const spot: Spot = {
      hole: ['Ks', '4c'],
      board: TRIPS_BOARD.slice(0, 4),
      potBefore: 20,
      heroBet: 0,
      villainBet: 10,
      heroStack: 1000,
      actions: (st) => [rec(1, 'check', 0, st), rec(2, 'bet', 10, st)],
    };
    expect((spot.potBefore + spot.villainBet) / BB).toBeLessThan(COMMIT_CAP_POT_BB);
    same(spot);
  });

  it('top pair weak kicker when it is not facing a bet', () =>
    same({
      ...K4,
      potBefore: 80,
      heroBet: 0,
      villainBet: 0,
      heroStack: 1000,
      actions: () => [],
    }));

  it('Omaha is not hold em: a PLO4 one-pair hand facing the raise', () =>
    same({
      ...riverRaised({ hole: ['Kh', '4c', '9d', '2s'], board: K4.board }, 1000),
      variant: 'plo4',
    }));
});

describe('V15 dominated-hand floor: does it cover sub-top-kicker trips? No.', () => {
  // The committed branch flats a hand the board dominates (preferFlat15) and
  // marks its folds dominated_commitment_floor. In hold'em both read
  // dominated21 (the V21 straight/flush/boat demotions, categories 5-7); the
  // V15 pieces (nuts15, nutClass15) are Omaha categories 5-6 only. A hold'em
  // trips hand is category 4, so none of it applies, and the two caps that do
  // meet it (V20's pressure cap, V21's raise-war gate) read the category, not
  // the kicker.
  it('the floor flats a board-dominated hand: sixes full under the jacks calls the raise', () => {
    const spot = riverRaised({ hole: ['6d', '5d'], board: ['Jd', '6h', 'Jc', '6c', 'Th'] }, 260);
    expect(new Set(actionsOver(spot, OFF))).toEqual(new Set(['call']));
  });

  it('the same committed raise with trip kings and a four kicker is jammed: the floor never sees it', () => {
    const spot = riverRaised({ hole: ['Ks', '4c'], board: TRIPS_BOARD }, 260);
    const acts = actionsOver(spot, OFF);
    expect(acts).toContain('all_in');
    expect(acts).not.toContain('call');
    for (const seed of SEEDS) {
      expect(decideAt(spot, OFF, seed).continuationGuard).toBeUndefined();
    }
  });

  it('nothing downstream reads the kicker: trip kings with a four and with an ace play the same', () => {
    const four = riverRaised({ hole: ['Ks', '4c'], board: TRIPS_BOARD }, 260);
    const ace = riverRaised({ hole: ['Ks', 'Ac'], board: TRIPS_BOARD }, 260);
    expect(actionsOver(four, OFF)).toEqual(actionsOver(ace, OFF));
  });

  it('with v51CommitCap on, the four kicker calls and the ace kicker still jams', () => {
    const four = riverRaised({ hole: ['Ks', '4c'], board: TRIPS_BOARD }, 260);
    const ace = riverRaised({ hole: ['Ks', 'Ac'], board: TRIPS_BOARD }, 260);
    expect(new Set(actionsOver(four, ON))).toEqual(new Set(['call']));
    expect(actionsOver(ace, ON)).toEqual(actionsOver(ace, OFF));
  });
});

describe('V51 league matchup', () => {
  it('is the last matchup on the card: a flag-on arm against the default, dealt on NLH', () => {
    const last = LEAGUE_MATCHUPS[LEAGUE_MATCHUPS.length - 1];
    expect(last.name).toBe('v51_commitment_cap');
    expect(last.pairs).toBe(6000);
    expect(last.a).toEqual({ v51CommitCap: true });
    expect(last.b).toEqual({});
    expect(last.variant ?? 'nlh').toBe('nlh');
    expect(LEAGUE_MATCHUPS.filter((m) => m.name === 'v51_commitment_cap')).toHaveLength(1);
  });
});
