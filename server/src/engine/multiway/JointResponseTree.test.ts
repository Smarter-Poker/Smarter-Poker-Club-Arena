import { describe, expect, it } from 'vitest';
import type { ActionType, GameVariant, SeatPlayer } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import { saveFastRandom, seedFastRandom } from '../HorseEval.js';
import { bettingStructureFor } from '../BettingStructure.js';
import { sampleJointRanges, type JointRangeSamples } from './JointRangeSampler.js';
import { jointFixture, jointPolicyFixture } from './JointRangeFixture.test-support.js';
import {
  evaluateJointActions,
  jointCallProbability,
  jointRaiseShare,
  jointResponseDraw,
  JOINT_ACTION_PACK,
  JOINT_ACTION_PACK_ROUND1,
  type JointActionRow,
} from './JointActionModel.js';
import type { JointResponseCount } from './JointResponseTree.js';

interface SeatSpec {
  stack: number;
  invested?: number;
  bet?: number;
  folded?: boolean;
  allIn?: boolean;
}
interface SpotSpec {
  dealer: number;
  currentBet?: number;
  lastRaise?: number;
  history?: [seat: number, action: ActionType, amount: number, full?: boolean][];
  legal: ActionType[];
  minTo?: number | null;
  maxTo?: number | null;
  boards?: number;
  samples?: number;
  stage?: 'turn' | 'river';
  rake?: number;
  extra?: Partial<HorseGameStateV2>;
}

/** A hand-specified post-flop spot: exact stacks, contributions, line and menu. */
function spot(variant: GameVariant, seats: SeatSpec[], s: SpotSpec) {
  const fixture = jointFixture(variant, s.stage ?? 'river', s.boards ?? 1, seats.length);
  const players: SeatPlayer[] = seats.map((spec, i) => ({
    ...fixture.state.players[i],
    stack: spec.stack,
    bet: spec.bet ?? 0,
    totalInvested: spec.invested ?? 5,
    is_folded: spec.folded === true,
    is_sitting_out: false,
    is_all_in: spec.allIn === true,
    cards: [],
  }));
  const hero = { ...fixture.hero, ...players[0], cards: fixture.hero.cards };
  const state: HorseGameStateV2 = Object.assign(fixture.state, {
    players,
    dealtSeatIds: players.map((p) => p.seat),
    dealerSeat: s.dealer,
    stateSchemaVersion: 1 as const,
    currentBet: s.currentBet ?? 0,
    toCall: Math.max(0, (s.currentBet ?? 0) - hero.bet),
    pot: players.reduce((a, p) => a + p.totalInvested, 0),
    lastRaise: s.lastRaise ?? 0,
    legalActions: s.legal,
    minRaiseTo: s.minTo ?? null,
    maxRaiseTo: s.maxTo ?? null,
    bettingStructure: bettingStructureFor(variant),
    fixedLimitSmallBet: 2,
    chipUnit: 0.01 as const,
    asset: 'chips' as const,
    gameMode: 'cash' as const,
    rakeConfig: { percent: s.rake ?? 0, cap: s.rake ? 3 : 0, noFlopNoDrop: true },
    bbjConfig: null,
    actionHistory: (s.history ?? []).map(([seat, action, amount, full], i) => ({
      seat,
      userId: 'p' + (seat - 1),
      action,
      amount,
      timestamp: i,
      stage: s.stage ?? 'river',
      ...(full === undefined ? {} : { isFullRaise: full }),
    })),
    ...s.extra,
  });
  const evidence = sampleJointRanges(hero, state, {
    seed: 13101006,
    samples: s.samples ?? 8,
    withinBudget: () => true,
  })!;
  return { hero, state, evidence };
}

/** Overwrite each joint sample's scores. Strength is the present-board read. */
function score(
  evidence: JointRangeSamples,
  fn: (index: number, board: number) => { hero: number; opponents: number[]; strength: number[] }
) {
  evidence.samples.forEach((sample, index) =>
    sample.boards.forEach((b, board) => {
      const v = fn(index, board);
      b.heroHigh = v.hero;
      b.heroLow = null;
      b.opponentHigh = v.opponents;
      b.opponentLow = v.opponents.map(() => null);
      b.opponentDecisionStrength = v.strength;
    })
  );
}

const STRAIGHT = 5 * 0x100000,
  PAIR = 2 * 0x100000,
  TRIPS = 4 * 0x100000;
const baseline = { action: 'check' as const, thinkTime: 0 };
const run = (x: ReturnType<typeof spot>, budget: () => boolean = () => true) =>
  evaluateJointActions(x.hero, x.state, baseline, x.evidence, budget)!;
const row = (result: ReturnType<typeof run>, id: string) => {
  const found = result.candidates.find((c) => c.id === id);
  if (!found) throw new Error('missing ' + id + ' in ' + result.candidates.map((c) => c.id));
  return found;
};
const counts = (r: JointActionRow, id: string) => r.responseCounts[id] as JointResponseCount;

/** Independent showdown reference: contribution layers, folded money stays,
 * an unmatched top contribution is returned, higher score wins, ties split. */
function referenceAward(
  contributions: Record<string, number>,
  folded: Set<string>,
  scores: Record<string, number>
): Record<string, number> {
  const ids = Object.keys(contributions);
  const award: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  const c = { ...contributions };
  const sorted = ids.slice().sort((a, b) => c[b] - c[a]);
  if (!folded.has(sorted[0]) && c[sorted[0]] > c[sorted[1]]) {
    award[sorted[0]] += c[sorted[0]] - c[sorted[1]];
    c[sorted[0]] = c[sorted[1]];
  }
  const levels = [...new Set(ids.filter((id) => !folded.has(id)).map((id) => c[id]))].sort(
    (a, b) => a - b
  );
  let prior = 0;
  for (const [layer, level] of levels.entries()) {
    const top = layer === levels.length - 1 ? Infinity : level;
    const amount = ids.reduce((a, id) => a + Math.max(0, Math.min(c[id], top) - prior), 0);
    const eligible = ids.filter((id) => !folded.has(id) && c[id] >= level);
    const best = Math.max(...eligible.map((id) => scores[id]));
    const winners = eligible.filter((id) => scores[id] === best);
    for (const id of winners) award[id] += amount / winners.length;
    prior = level;
  }
  return award;
}

describe('P13-A river response tree: hand-built settlements', () => {
  it('NLH single contested pot: one pot-sized opponent raise and hero answer', () => {
    const wins = [1, 0, 1, 1, 0, 0, 1, 0];
    const x = spot(
      'nlh',
      [{ stack: 100 }, { stack: 100 }, { stack: 100, folded: true }, { stack: 100, folded: true }],
      { dealer: 4, legal: ['check', 'bet', 'all_in'], minTo: 2, maxTo: 100 }
    );
    score(x.evidence, (i) => ({
      hero: wins[i] ? STRAIGHT : PAIR,
      opponents: [wins[i] ? PAIR : STRAIGHT],
      strength: [0.9],
    }));
    const bet = row(run(x), 'bet:20');
    // p1 faces 20 into 40 it can win; nobody else is live; it covers hero.
    const range = x.evidence.ranges.find((r) => r.userId === 'p1')!;
    const c = jointCallProbability({
      strengths: [0.9],
      range,
      price: 20,
      pot: 40,
      activeOpponents: 1,
      coversHero: true,
    });
    const r = c * jointRaiseShare({ strengths: [0.9], range, price: 20, pot: 40 });
    expect(r).toBeGreaterThan(0);
    // Pot-sized raise: 20 + (40 in the middle + 20 to call) = 80. Hero owes
    // 60 to win 120 and has 4 wins in 8 equally weighted raise branches.
    const heroCalls = 4 / 8 >= 60 / 180;
    let expected = 0;
    for (let i = 0; i < 8; i++) {
      const call = jointResponseDraw(i, 'p1') < (c - r) / (1 - r);
      const noRaise = call ? (wins[i] ? 40 : -20) : 20;
      const raised = heroCalls ? (wins[i] ? 100 : -80) : -20;
      expected += (1 - r) * noRaise + r * raised;
    }
    expect(bet.expectedNetChips).toBeCloseTo(expected / 8, 9);
    expect(bet.responseTree!.raiseTo).toEqual({ p1: [80] });
    expect(bet.responseTree!.raiseIsFull).toEqual({ p1: true });
    expect(bet.responseTree!.raiseBranches).toBe(8);
    expect(bet.responseTree!.terminalBranches).toBe(16);
    expect(bet.responseTree!.heroCallsRaiseProbability).toBeCloseTo(r, 12);
    expect(bet.minimumNetChips).toBe(-80);
    expect(counts(bet, 'p1').raiseProbability).toBeCloseTo(r, 12);
    // The comparison identity has no raise branch and cannot lose 80.
    const old = evaluateJointActions(x.hero, x.state, baseline, x.evidence, () => true, {
      responseModel: 'round1',
    })!;
    expect(old.version).toBe(JOINT_ACTION_PACK_ROUND1.version);
    expect(row(old, 'bet:20').minimumNetChips).toBe(-20);
    expect(row(old, 'bet:20').responseTree).toBeNull();
  });

  it('PLO4 single contested pot: the pot-limit raise is a full all-in for less than pot', () => {
    const wins = [0, 1, 1, 0, 1, 0, 0, 1];
    const x = spot(
      'plo4',
      [{ stack: 100 }, { stack: 50 }, { stack: 100, folded: true }, { stack: 100, folded: true }],
      { dealer: 4, legal: ['check', 'bet'], minTo: 2, maxTo: 20 }
    );
    score(x.evidence, (i) => ({
      hero: wins[i] ? STRAIGHT : PAIR,
      opponents: [wins[i] ? PAIR : STRAIGHT],
      strength: [0.92],
    }));
    const bet = row(run(x), 'bet:20');
    const range = x.evidence.ranges.find((r) => r.userId === 'p1')!;
    const input = { strengths: [0.92], range, price: 20, pot: 40 };
    const c = jointCallProbability({ ...input, activeOpponents: 1, coversHero: false });
    const r = c * jointRaiseShare(input);
    // Pot limit would allow 80; the 50 stack moves all in (a full raise of 30).
    // Hero owes 30 to win 90: 30/120 against 4 of 8 equally weighted wins.
    const heroCalls = 4 / 8 >= 30 / 120;
    let expected = 0;
    for (let i = 0; i < 8; i++) {
      const call = jointResponseDraw(i, 'p1') < (c - r) / (1 - r);
      expected +=
        (1 - r) * (call ? (wins[i] ? 40 : -20) : 20) + r * (heroCalls ? (wins[i] ? 70 : -50) : -20);
    }
    expect(bet.expectedNetChips).toBeCloseTo(expected / 8, 9);
    expect(bet.responseTree!.raiseTo).toEqual({ p1: [50] });
    expect(bet.responseTree!.raiseIsFull).toEqual({ p1: true });
    expect(bet.maxConservationError).toBeLessThan(1e-6);
  });

  it('NLH unequal side-pot access: a short caller, a deep raiser and hero answer', () => {
    // Hero beats p2 everywhere; p1 (all in for 10 more) beats hero in half.
    const p1Wins = [1, 0, 0, 1, 1, 0, 1, 0];
    const x = spot(
      'nlh',
      [{ stack: 100 }, { stack: 10 }, { stack: 100 }, { stack: 100, folded: true }],
      { dealer: 4, legal: ['check', 'bet', 'all_in'], minTo: 2, maxTo: 100 }
    );
    score(x.evidence, (i) => ({
      hero: TRIPS,
      opponents: [p1Wins[i] ? STRAIGHT : PAIR, PAIR - 1],
      strength: [0.8, 0.95],
    }));
    const bet = row(run(x), 'bet:20');
    const ranges = Object.fromEntries(x.evidence.ranges.map((r) => [r.userId, r]));
    const c1 = jointCallProbability({
      strengths: [0.8],
      range: ranges.p1,
      price: 10,
      // Each live seat can put 15 in p1's pot: hero 15, p1 5 (+10 call),
      // p2 5 and the dead 5. Excluding p1's own call: 30.
      pot: 30,
      activeOpponents: 2,
      coversHero: false,
    });
    let expected = 0;
    const scores = (i: number) => ({ p0: 4, p1: p1Wins[i] ? 5 : 2, p2: 1, p3: 0 });
    for (let i = 0; i < 8; i++) {
      const p1Called = jointResponseDraw(i, 'p1') < c1;
      const middle = 40 + (p1Called ? 10 : 0);
      const p2 = {
        strengths: [0.95],
        range: ranges.p2,
        price: 20,
        pot: middle,
      };
      const c2 = jointCallProbability({
        ...p2,
        activeOpponents: p1Called ? 2 : 1,
        coversHero: true,
      });
      const r2 = c2 * jointRaiseShare(p2);
      const raiseTo = 20 + middle + 20;
      const folded = new Set(['p3', ...(p1Called ? [] : ['p1'])]);
      const base = { p0: 25, p1: p1Called ? 15 : 5, p3: 5 };
      const net = (p2Total: number, p2Folded: boolean) => {
        const f = new Set(folded);
        if (p2Folded) f.add('p2');
        const heroTotal = Math.max(base.p0, p2Folded ? 25 : p2Total);
        const award = referenceAward({ ...base, p0: heroTotal, p2: p2Total }, f, scores(i));
        return award.p0 - (heroTotal - 5);
      };
      const p2Calls = jointResponseDraw(i, 'p2') < (c2 - r2) / (1 - r2);
      // Hero's raise-weighted heads-up equity against p2 is 1: hero calls.
      expected +=
        (1 - r2) * (p2Calls ? net(25, false) : net(5, true)) + r2 * net(raiseTo + 5, false);
    }
    expect(bet.expectedNetChips).toBeCloseTo(expected / 8, 9);
    expect(bet.responseTree!.heroRaiseEquity).toEqual({ p2: 1 });
    expect(bet.responseTree!.raiseTo.p2.length).toBeGreaterThanOrEqual(1);
    expect(bet.sidePotCount).toBe(2);
    expect(counts(bet, 'p1').raiseProbability).toBe(0);
    // p1 is all in after calling: it never faces the raise.
    expect(counts(bet, 'p1').facedRaise).toBe(0);
  });
});

describe('P13-A split games, side pots and every variant', () => {
  it('PLO8 hi-lo: hero holds high, the raiser holds low, every branch splits', () => {
    const x = spot(
      'plo8',
      [{ stack: 100 }, { stack: 100 }, { stack: 100, folded: true }, { stack: 100, folded: true }],
      { dealer: 4, legal: ['check', 'bet'], minTo: 2, maxTo: 20 }
    );
    score(x.evidence, () => ({ hero: STRAIGHT, opponents: [PAIR], strength: [0.93] }));
    x.evidence.samples.forEach((sample) =>
      sample.boards.forEach((b) => {
        b.opponentLow = [0x54321];
      })
    );
    const bet = row(run(x), 'bet:20');
    const range = x.evidence.ranges.find((r) => r.userId === 'p1')!;
    const input = { strengths: [0.93], range, price: 20, pot: 40 };
    const c = jointCallProbability({ ...input, activeOpponents: 1, coversHero: true });
    const r = c * jointRaiseShare(input);
    // Heads-up share 0.5 covers the 60/180 price: hero calls the raise to 80.
    // A called pot of 60 or 180 returns its high half (30 or 90) to hero.
    let expected = 0;
    for (let i = 0; i < 8; i++) {
      const call = jointResponseDraw(i, 'p1') < (c - r) / (1 - r);
      expected += (1 - r) * (call ? 30 - 20 : 20) + r * (90 - 80);
    }
    expect(bet.responseTree!.heroRaiseEquity).toEqual({ p1: 0.5 });
    expect(bet.responseTree!.raiseTo).toEqual({ p1: [80] });
    expect(bet.expectedNetChips).toBeCloseTo(expected / 8, 9);
  });

  it.each([
    'nlh',
    'plo4',
    'plo5',
    'plo6',
    'plo8',
    'flo8',
    'flh',
    'pineapple',
    'short_deck',
  ] as GameVariant[])(
    '%s strong responders conserve every raise and continuation branch on every board and unit',
    (variant) => {
      let raised = 0;
      for (const street of ['turn', 'river'] as const)
        for (const boards of [1, 2, 3])
          for (const mode of ['cash', 'tournament'] as const) {
            const { hero, state } = jointPolicyFixture(variant, boards, mode, street);
            const evidence = sampleJointRanges(hero, state, {
              seed: 13101006,
              samples: 8,
              withinBudget: () => true,
            })!;
            evidence.samples.forEach((sample) =>
              sample.boards.forEach((b) => {
                b.opponentDecisionStrength = b.opponentDecisionStrength.map(() => 0.96);
              })
            );
            const result = evaluateJointActions(hero, state, baseline, evidence, () => true)!;
            expect(result.responseModel).toBe('bounded_raise_tree');
            for (const c of result.candidates) {
              expect(c.maxConservationError).toBeLessThan(1e-6);
              expect(c.covariance).toHaveLength(boards);
              expect(c.responseTree!.terminalBranches).toBe(8 + c.responseTree!.raiseBranches);
              if (mode === 'tournament') expect(c.expectedRake).toBe(0);
              for (const to of Object.values(c.responseTree!.raiseTo).flat()) {
                if (state.bettingStructure === 'fixed_limit') expect(to % 4).toBe(0);
                if (mode === 'tournament') expect(Number.isInteger(to)).toBe(true);
              }
              raised += c.responseTree!.raiseBranches;
            }
          }
      expect(raised).toBeGreaterThan(0);
    }
  );
});

describe('P13-A authoritative raise rights inside the tree', () => {
  const shortOrFull = (full: boolean) => {
    // Identical table chips. Short: p1 bets 10, p2 moves in to 18 (an 8
    // increment, below the 10 full raise). Full: p1 bets 6, p2 moves in to 18.
    const bet = full ? 6 : 10;
    const x = spot(
      'nlh',
      [
        { stack: 100 },
        { stack: 100 - bet, bet, invested: 5 + bet },
        { stack: 0, bet: 18, invested: 23, allIn: true },
        { stack: 100, folded: true },
      ],
      {
        dealer: 1,
        currentBet: 18,
        lastRaise: full ? 12 : 10,
        history: [
          [2, 'bet', bet, true],
          [3, 'all_in', 18, full],
        ],
        legal: ['fold', 'call', 'raise', 'all_in'],
        minTo: 18 + (full ? 12 : 10),
        maxTo: 100,
      }
    );
    score(x.evidence, (i) => ({
      hero: i % 2 ? STRAIGHT : PAIR,
      opponents: [PAIR + 1, TRIPS],
      strength: [0.95, 0.9],
    }));
    return x;
  };
  it('a short all-in does not reopen a player who already acted; a full raise does', () => {
    const short = shortOrFull(false),
      full = shortOrFull(true);
    const total = (x: ReturnType<typeof spot>) =>
      x.state.players.reduce((a, p) => a + p.stack + p.totalInvested, 0);
    expect(total(short)).toBe(total(full));
    const a = row(run(short), 'call'),
      b = row(run(full), 'call');
    expect(counts(a, 'p1').responded).toBe(8);
    expect(counts(a, 'p1').raiseProbability).toBe(0);
    expect(a.responseTree!.raiseBranches).toBe(0);
    expect(counts(b, 'p1').responded).toBe(8);
    expect(counts(b, 'p1').raiseProbability).toBeGreaterThan(0);
    expect(b.responseTree!.raiseBranches).toBe(8);
    // Hero's own full raise reopens p1 in both lines.
    const raise = row(run(short), 'raise:28');
    expect(counts(raise, 'p1').raiseProbability).toBeGreaterThan(0);
    // p2 is all in: it never responds, raises or faces the raise.
    for (const r of [a, b, raise]) {
      expect(counts(r, 'p2')).toMatchObject({ responded: 0, allIn: 8, facedRaise: 0 });
      expect(r.maxConservationError).toBeLessThan(1e-6);
    }
  });

  it('fixed limit raises by the fixed increment and honours the four-wager cap', () => {
    // p1 bets 4, p2 raises 8, p3 raises 12: hero's raise to 16 caps the river.
    const x = spot(
      'flh',
      [
        { stack: 100 },
        { stack: 96, bet: 4, invested: 9 },
        { stack: 92, bet: 8, invested: 13 },
        { stack: 88, bet: 12, invested: 17 },
        { stack: 100, folded: true },
      ],
      {
        dealer: 1,
        currentBet: 12,
        lastRaise: 4,
        history: [
          [2, 'bet', 4, true],
          [3, 'raise', 8, true],
          [4, 'raise', 12, true],
        ],
        legal: ['fold', 'call', 'raise'],
        minTo: 16,
        maxTo: 16,
        extra: { fixedBetSize: 4 },
      }
    );
    score(x.evidence, (i) => ({
      hero: i % 3 ? STRAIGHT : PAIR,
      opponents: [TRIPS, TRIPS, PAIR],
      strength: [0.95, 0.95, 0.95],
    }));
    const result = run(x);
    const capped = row(result, 'raise:16');
    expect(capped.responseTree!.raiseBranches, JSON.stringify(capped.responseTree)).toBe(0);
    for (const id of ['p1', 'p2', 'p3']) expect(counts(capped, id).raiseProbability).toBe(0);
    const call = row(result, 'call');
    // After hero calls, p1 and p2 (reopened, owing 8 and 4) may make the
    // fourth and final wager: exactly the fixed 4 increment, to 16.
    expect(call.responseTree!.raiseBranches).toBeGreaterThan(0);
    expect(Object.values(call.responseTree!.raiseTo).flat()).toEqual(
      Object.values(call.responseTree!.raiseTo)
        .flat()
        .map(() => 16)
    );
    expect(counts(call, 'p3').raiseProbability).toBe(0);
    for (const r of result.candidates) expect(r.maxConservationError).toBeLessThan(1e-6);
  });

  it('players owing a response before and after hero answer the one raise in ring order', () => {
    // River order: p3 (checked), hero, p1, p2. p2 moved all in on an earlier
    // street. After hero bets, p1, p2 and p3 owe in clockwise order from hero.
    const x = spot(
      'nlh',
      [
        { stack: 100 },
        { stack: 100 },
        { stack: 0, invested: 30, allIn: true },
        { stack: 100 },
        { stack: 100, folded: true },
      ],
      {
        dealer: 3,
        history: [[4, 'check', 0]],
        legal: ['check', 'bet', 'all_in'],
        minTo: 2,
        maxTo: 100,
      }
    );
    score(x.evidence, (i) => ({
      hero: i % 2 ? STRAIGHT : TRIPS,
      opponents: [TRIPS + 3, PAIR, PAIR],
      strength: [0.97, 0.5, 0.6],
    }));
    const bet = row(run(x), 'bet:50');
    expect(counts(bet, 'p3').responded).toBe(8);
    expect(counts(bet, 'p2')).toMatchObject({ responded: 0, allIn: 8, facedRaise: 0 });
    expect(counts(bet, 'p1').raiseProbability).toBeGreaterThan(0);
    // p3 answers p1's raise when it did not fold to hero first.
    expect(counts(bet, 'p3').facedRaise).toBeGreaterThan(0);
    expect(
      bet.responseTree!.heroCallsRaiseProbability + bet.responseTree!.heroFoldsToRaiseProbability
    ).toBeCloseTo(bet.responseTree!.raiseProbability, 12);
    expect(bet.sidePotCount).toBeGreaterThan(1);
  });
});

describe('P13-A joint downside, laws and limits', () => {
  it('shows the same displayed mean with a different joint downside', () => {
    // Two bomb boards. A: hero splits the boards in every sample. B: hero
    // scoops or is scooped, balanced inside each fold/call draw class.
    const make = () =>
      spot(
        'nlh',
        [
          { stack: 100 },
          { stack: 100 },
          { stack: 100, folded: true },
          { stack: 100, folded: true },
        ],
        { dealer: 4, legal: ['check', 'bet', 'all_in'], minTo: 2, maxTo: 100, boards: 2 }
      );
    const a = make(),
      b = make();
    const range = a.evidence.ranges[0];
    const c = jointCallProbability({
      strengths: [0.9, 0.9],
      range,
      price: 20,
      pot: 40,
      activeOpponents: 1,
      coversHero: true,
    });
    const r = c * jointRaiseShare({ strengths: [0.9, 0.9], range, price: 20, pot: 40 });
    const classes = [0, 1].map((k) =>
      [...Array(8).keys()].filter(
        (i) => Number(jointResponseDraw(i, 'p1') < (c - r) / (1 - r)) === k
      )
    );
    const scoop = new Map<number, number>();
    for (const group of classes)
      group.forEach((i, j) =>
        scoop.set(i, j === group.length - 1 && group.length % 2 ? -1 : j % 2)
      );
    score(a.evidence, (_, board) => ({
      hero: board ? STRAIGHT : PAIR,
      opponents: [board ? PAIR : STRAIGHT],
      strength: [0.9],
    }));
    score(b.evidence, (i, board) => {
      const s = scoop.get(i)!;
      const heroWins = s === -1 ? board === 1 : s === 1;
      return {
        hero: heroWins ? STRAIGHT : PAIR,
        opponents: [heroWins ? PAIR : STRAIGHT],
        strength: [0.9],
      };
    });
    const x = row(run(a), 'bet:20'),
      y = row(run(b), 'bet:20');
    expect(y.expectedNetChips).toBeCloseTo(x.expectedNetChips, 9);
    expect(y.boardMeans[0] + y.boardMeans[1]).toBeCloseTo(x.boardMeans[0] + x.boardMeans[1], 9);
    expect(y.minimumNetChips).toBeLessThan(x.minimumNetChips);
    expect(y.variance).toBeGreaterThan(x.variance);
    expect(y.covariance[0][1]).toBeGreaterThan(x.covariance[0][1]);
  });

  it('returns no partial ranking when the deadline falls between response branches', () => {
    const x = spot(
      'nlh',
      [{ stack: 100 }, { stack: 100 }, { stack: 100 }, { stack: 100, folded: true }],
      { dealer: 4, legal: ['check', 'bet', 'all_in'], minTo: 2, maxTo: 100 }
    );
    score(x.evidence, () => ({
      hero: STRAIGHT,
      opponents: [TRIPS, TRIPS],
      strength: [0.95, 0.95],
    }));
    const complete = run(x);
    const branches = complete.candidates.reduce((a, c) => a + c.responseTree!.terminalBranches, 0);
    expect(complete.candidates.some((c) => c.responseTree!.raiseBranches > 0)).toBe(true);
    // Every possible interruption point, including inside raise branches.
    let calls = 0;
    evaluateJointActions(x.hero, x.state, baseline, x.evidence, () => (calls++, true));
    expect(calls).toBeGreaterThan(branches);
    for (let stop = 1; stop < calls; stop += 3) {
      let k = 0;
      expect(
        evaluateJointActions(x.hero, x.state, baseline, x.evidence, () => ++k < stop)
      ).toBeNull();
    }
  });

  it('keeps opponents away from showdown ranks and leaves the baseline RNG untouched', () => {
    for (const stage of ['river', 'turn'] as const) {
      const x = spot(
        'plo4',
        [{ stack: 100 }, { stack: 100 }, { stack: 60 }, { stack: 100, folded: true }],
        { dealer: 4, legal: ['check', 'bet'], minTo: 2, maxTo: 20, stage, boards: 2 }
      );
      score(x.evidence, (i, b) => ({
        hero: (i + b) % 2 ? STRAIGHT : PAIR,
        opponents: [TRIPS, PAIR],
        strength: [0.9, 0.85],
      }));
      const changed = structuredClone(x.evidence);
      changed.samples.forEach((s) =>
        s.boards.forEach((b) => {
          b.heroHigh += 3 * 0x100000;
          b.opponentHigh = b.opponentHigh.map(() => 0);
        })
      );
      seedFastRandom(1310061);
      const before = saveFastRandom();
      const a = run(x);
      const b = evaluateJointActions(x.hero, x.state, baseline, changed, () => true)!;
      expect(saveFastRandom()).toBe(before);
      const opponentReads = (r: typeof a) =>
        r.candidates.map((c) =>
          Object.fromEntries(
            Object.entries(c.responseCounts).map(([id, v]) => {
              const k = v as JointResponseCount;
              // Initial responses and raise probabilities read present boards only.
              return [
                id,
                [k.responded, k.called, k.folded, k.meanCallProbability, k.raiseProbability],
              ];
            })
          )
        );
      expect(opponentReads(a)).toEqual(opponentReads(b));
      expect(a.candidates.map((c) => c.expectedNetChips)).not.toEqual(
        b.candidates.map((c) => c.expectedNetChips)
      );
    }
  });

  it('rejects an outcome pool from an earlier river state', () => {
    const x = spot(
      'nlh',
      [{ stack: 100 }, { stack: 100 }, { stack: 100, folded: true }, { stack: 100, folded: true }],
      { dealer: 4, legal: ['check', 'bet', 'all_in'], minTo: 2, maxTo: 100 }
    );
    x.state.players[1].stack--;
    expect(() => run(x)).toThrow('stale_evidence');
  });

  it('caps raise branches at the declared opponent limit and refuses work over the branch limit', () => {
    const seats: SeatSpec[] = Array.from({ length: 9 }, () => ({ stack: 100 }));
    const x = spot('nlh', seats, {
      dealer: 9,
      legal: ['check', 'bet', 'all_in'],
      minTo: 2,
      maxTo: 100,
    });
    score(x.evidence, () => ({
      hero: STRAIGHT,
      opponents: Array(8).fill(TRIPS),
      strength: Array(8).fill(0.97),
    }));
    const bet = row(run(x), 'bet:45');
    expect(bet.responseTree!.raiseBranches).toBeLessThanOrEqual(
      8 * JOINT_ACTION_PACK.limits.maxRaiseBranchOpponents
    );
    expect(bet.responseTree!.raiseLimitedResponders).toBeGreaterThan(0);
    expect(bet.responseTree!.terminalBranches).toBeLessThanOrEqual(
      JOINT_ACTION_PACK.limits.maxTerminalBranchesPerCandidate
    );
    const big = spot('nlh', seats, {
      dealer: 9,
      legal: ['check', 'bet', 'all_in'],
      minTo: 2,
      maxTo: 100,
      samples: 32,
    });
    score(big.evidence, () => ({
      hero: STRAIGHT,
      opponents: Array(8).fill(TRIPS),
      strength: Array(8).fill(0.97),
    }));
    expect(() => run(big)).toThrow('joint_response_branch_unavailable');
  });
});

describe('P13-A turn to river continuation', () => {
  it('reads each river board as it then exists, from the same physical sample', () => {
    const make = () =>
      spot('nlh', [{ stack: 100 }, { stack: 100 }, { stack: 100 }, { stack: 100, folded: true }], {
        dealer: 4,
        legal: ['check', 'bet', 'all_in'],
        minTo: 2,
        maxTo: 100,
        stage: 'turn',
      });
    const weak = make(),
      strong = make();
    score(weak.evidence, () => ({
      hero: PAIR,
      opponents: [PAIR - 5, PAIR - 9],
      strength: [0.6, 0.55],
    }));
    score(strong.evidence, () => ({
      hero: 8 * 0x100000,
      opponents: [TRIPS, 7 * 0x100000],
      strength: [0.6, 0.55],
    }));
    const a = run(weak),
      b = run(strong);
    const check = (r: typeof a) => row(r, 'check');
    // Turn responses read the turn board only and are identical.
    expect(a.candidates.map((c) => c.responseCounts)).toEqual(
      b.candidates.map((c) => c.responseCounts)
    );
    // Nobody reaches the river bet threshold on weak river boards.
    expect(check(a).responseTree!.riverRoundProbability).toBe(1);
    expect(check(a).responseTree!.riverBetProbability).toBe(0);
    expect(check(b).responseTree!.riverBetProbability).toBe(1);
    for (const r of [...a.candidates, ...b.candidates]) {
      expect(r.maxConservationError).toBeLessThan(1e-6);
      expect(r.samples).toBe(8);
    }
    // A pair checks down: the check line wins exactly the 20 turn pot.
    expect(check(a).expectedNetChips).toBeCloseTo(20, 9);
    // Quads lead the river for the pot (20). p1's trips (0.425) call a
    // one-third price (threshold 0.3); p2's full house (0.74) calls a quarter.
    expect(check(b).expectedNetChips).toBeCloseTo(20 + 20 * 2, 9);
  });

  it('keeps preflop and flop on the one-response comparison model', () => {
    for (const stage of ['preflop', 'flop'] as const) {
      const { hero, state } = jointFixture('nlh', stage, 1, 4);
      Object.assign(state, {
        stateSchemaVersion: 1,
        legalActions: ['check', 'bet', 'all_in'],
        minRaiseTo: 2,
        maxRaiseTo: 100,
        bettingStructure: 'no_limit',
        chipUnit: 0.01,
        asset: 'chips',
        gameMode: 'cash',
        rakeConfig: { percent: 10, cap: 2, noFlopNoDrop: true },
        bbjConfig: null,
      });
      const evidence = sampleJointRanges(hero, state, {
        seed: 13100401,
        samples: 8,
        withinBudget: () => true,
      })!;
      const a = evaluateJointActions(hero, state, baseline, evidence, () => true)!;
      const b = evaluateJointActions(hero, state, baseline, evidence, () => true, {
        responseModel: 'round1',
      })!;
      expect(a.version).toBe(JOINT_ACTION_PACK.version);
      expect(b.version).toBe(JOINT_ACTION_PACK_ROUND1.version);
      expect(a.responseModel).toBe('one_response_then_showdown');
      expect(a.candidates).toEqual(b.candidates);
    }
  });
});
