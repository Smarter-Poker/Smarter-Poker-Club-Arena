/**
 * P13-B: the round 2 response branches against the actual controller.
 *
 * Each case is one rigged real hand. The joint action model runs on the
 * decision state the controller itself reached, with every joint sample
 * carrying the hand's true showdown (so samples differ only in the declared
 * response draws). Every terminal branch the model settles is captured from
 * the shared pot and deduction owners, replayed on a fresh controller with
 * the same deck, and settled by the controller. Three settlements must agree
 * for every branch: the model's terminal, the controller's payout, rake and
 * BBJ drop, and the joint terminal owner run on the controller's own final
 * state. The independent benchmark reference supplies gross awards, and each
 * case pins its economically distinct lines by hand.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { SeatPlayer } from '../../types.js';
import { sampleJointRanges } from './JointRangeSampler.js';
import { evaluateJointActions, type JointActionRow } from './JointActionModel.js';
import { evaluateJointLivePolicy } from './JointLivePolicy.js';
import { HandController } from '../HandController.js';
import { RANKS } from '../PokerEngine.js';
import { controllerSpotRandom } from '../remainingVariants/RemainingVariantControllerSpots.test-support.js';
import {
  cards,
  decisionSpot,
  holesOf,
  modelSettle,
  play,
  playBranch,
  referenceSettle,
  settle,
  trueSample,
  type Rig,
  type Settled,
  type Step,
} from './JointEconomicsHarness.test-support.js';

interface Captured {
  seats: SeatPlayer[];
  prepared: SeatPlayer[];
  net: Record<string, number>;
  rake: number;
  bbj: number;
  sawFlop: boolean;
}
const capture = vi.hoisted(() => ({
  on: false,
  seats: null as SeatPlayer[] | null,
  prepared: null as SeatPlayer[] | null,
  terminals: [] as Captured[],
}));
vi.mock('./JointPotDistribution.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./JointPotDistribution.js')>();
  return {
    ...actual,
    prepareJointPots: (...args: Parameters<typeof actual.prepareJointPots>) => {
      const prepared = actual.prepareJointPots(...args);
      if (capture.on) {
        capture.seats = args[0].map((p) => ({ ...p }));
        capture.prepared = prepared.seats.map((p) => ({ ...p }));
      }
      return prepared;
    },
  };
});
vi.mock('./JointDeductions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./JointDeductions.js')>();
  return {
    ...actual,
    applyJointDeductions: (input: Parameters<typeof actual.applyJointDeductions>[0]) => {
      const fees = actual.applyJointDeductions(input);
      if (capture.on)
        capture.terminals.push({
          seats: capture.seats!,
          prepared: capture.prepared!,
          net: fees.netTotals,
          rake: fees.rake,
          bbj: fees.bbjFee,
          sawFlop: input.sawFlop,
        });
      return fees;
    },
  };
});

const cents = (n: number) => Math.round(n * 100);

/** Runs the joint action model on the controller's own decision with every
 * joint sample carrying the true showdown, and returns each candidate with
 * the terminal settlements it made, in evaluation order. */
function runModel(rig: Rig, pre: Step[], strength: Record<string, number>) {
  const played = play(rig, pre);
  const decision = decisionSpot(played, rig);
  const evidence = sampleJointRanges(decision.hero, decision.state, {
    seed: 1310061,
    samples: 8,
    withinBudget: () => true,
  })!;
  const truth = trueSample(
    rig.variant,
    rig.boards.map(cards),
    holesOf(rig),
    decision.hero.user_id,
    evidence.opponentIds,
    strength
  );
  evidence.samples.forEach((s) => (s.boards = structuredClone(truth.boards)));
  capture.terminals = [];
  capture.on = true;
  let result;
  try {
    result = evaluateJointActions(
      decision.hero,
      decision.state,
      decision.baseline,
      evidence,
      () => true
    )!;
  } finally {
    capture.on = false;
  }
  let offset = 0;
  const rows = result.candidates.map((row) => {
    const count = row.responseTree?.terminalBranches ?? row.samples;
    const terminals = capture.terminals.slice(offset, offset + count);
    offset += count;
    return { row, terminals };
  });
  expect(offset).toBe(capture.terminals.length);
  return { decision, rows, result };
}

type Branch = Settled & {
  heroNet: number;
  model: ReturnType<typeof modelSettle>;
  reference: ReturnType<typeof referenceSettle>;
};
const lineKey = (row: JointActionRow, seats: SeatPlayer[]) =>
  row.id +
  '|' +
  seats.map((p) => `${p.user_id}:${cents(p.totalInvested)}:${+p.is_folded}`).join(',');

/** Every terminal branch of every candidate, replayed and settled by the
 * controller, must equal the joint model's own terminal settlement. */
function controllerAgrees(rig: Rig, pre: Step[], run: ReturnType<typeof runModel>) {
  const { decision } = run;
  const heroId = decision.hero.user_id;
  const branches = new Map<string, Branch>();
  const perRow = new Map<string, Branch[]>();
  for (const { row, terminals } of run.rows) {
    const list: Branch[] = [];
    for (const t of terminals) {
      const key = lineKey(row, t.seats);
      if (!branches.has(key)) {
        const played = playBranch(
          rig,
          pre,
          decision,
          { action: row.action, amount: row.amount },
          t.seats
        );
        const settled = settle(played);
        branches.set(key, {
          ...settled,
          heroNet: settled.stacks[heroId] - decision.hero.stack,
          model: modelSettle(settled, decision.state, rig, heroId, t.sawFlop),
          reference: referenceSettle(settled, rig),
        });
      }
      const b = branches.get(key)!;
      // The controller dealt the rig's boards.
      if (b.boards[0]?.length === 5)
        expect(b.boards.map((x) => x.map((c) => c.rank + c.suit[0]).join(' '))).toEqual(rig.boards);
      // The controller reached the branch's own final state.
      for (const p of t.seats) {
        const s = b.snapshot.find((x) => x.user_id === p.user_id)!;
        // The tree's street replica accumulates binary floats; the controller
        // snaps to cents. Settlement reads both in whole units.
        expect([cents(s.totalInvested), s.is_folded], key).toEqual([
          cents(p.totalInvested),
          p.is_folded,
        ]);
      }
      // Model terminal = controller payout, rake and BBJ drop, for every seat.
      for (const p of t.prepared)
        expect(b.stacks[p.user_id], `${key} ${p.user_id}`).toBeCloseTo(
          p.stack + t.net[p.user_id],
          9
        );
      expect(b.rake, `${key} rake`).toBeCloseTo(t.rake, 9);
      expect(b.bbjFee, `${key} bbj`).toBeCloseTo(t.bbj, 9);
      // The terminal owner run on the controller's own final state agrees too.
      for (const [id, stack] of Object.entries(b.stacks))
        expect(b.model.stacks[id], `${key} model ${id}`).toBeCloseTo(stack, 9);
      // Independent gross: every payout is at most its gross entitlement and
      // the fees are the whole difference.
      const paid = Object.fromEntries(
        b.snapshot.map((p) => [p.user_id, b.stacks[p.user_id] - p.stack])
      );
      const paidTotal = Object.values(paid).reduce((a, v) => a + v, 0);
      if (b.reference) {
        const grossTotal = Object.values(b.reference.gross).reduce((a, v) => a + v, 0);
        expect(cents(grossTotal), key).toBe(cents(paidTotal + b.rake + b.bbjFee));
        for (const [id, gross] of Object.entries(b.reference.gross)) {
          if (b.rake + b.bbjFee === 0) expect(cents(paid[id]), `${key} ${id}`).toBe(cents(gross));
          else expect(cents(paid[id]), `${key} ${id}`).toBeLessThanOrEqual(cents(gross));
        }
      }
      // Every chip paid in is paid out, as fees or to a seat.
      const paidIn = b.snapshot.reduce((a, p) => a + p.totalInvested, 0);
      expect(cents(paidTotal + b.rake + b.bbjFee), key).toBe(cents(paidIn));
      list.push(b);
    }
    perRow.set(row.id, list);
    // The row's reachable extremes are the controller's.
    expect(row.minimumNetChips, row.id).toBeCloseTo(Math.min(...list.map((b) => b.heroNet)), 9);
    expect(row.maximumNetChips, row.id).toBeCloseTo(Math.max(...list.map((b) => b.heroNet)), 9);
  }
  return { branches, perRow };
}

/** With identical showdowns in every sample and the one raise slot held by
 * the first responder, each sample's raise weight is that responder's raise
 * probability, so the row's expectation is the controller's settlement of
 * each sample's no-raise line and raise line, weighted. */
function controllerExpectation(row: JointActionRow, list: Branch[], raiser: string) {
  const n = row.samples;
  expect(row.responseTree!.raiseBranches).toBe(n);
  const r = (row.responseCounts[raiser] as { raiseProbability: number }).raiseProbability;
  expect(r).toBeGreaterThan(0);
  let net = 0,
    rake = 0,
    bbj = 0;
  for (let i = 0; i < n; i++) {
    const a = list[i],
      b = list[n + i];
    net += (1 - r) * a.heroNet + r * b.heroNet;
    rake += (1 - r) * a.rake + r * b.rake;
    bbj += (1 - r) * a.bbjFee + r * b.bbjFee;
  }
  expect(row.expectedNetChips, row.id).toBeCloseTo(net / n, 9);
  expect(row.expectedRake, row.id).toBeCloseTo(rake / n, 9);
  expect(row.expectedBbj, row.id).toBeCloseTo(bbj / n, 9);
}

/** The distinct settled lines of one candidate, keyed by final investments. */
const lines = (list: Branch[]) =>
  Object.fromEntries(
    list.map((b) => [
      b.snapshot.map((p) => `${cents(p.totalInvested) / 100}${p.is_folded ? 'f' : ''}`).join(' '),
      { net: Math.round(b.heroNet * 100) / 100, rake: b.rake, bbj: b.bbjFee, refunds: b.refunds },
    ])
  );

const checkdown = (seats: number[]): Step[] => seats.map((s) => [s, 'check']);

describe('P13-B round 2 raise branches settle exactly as the controller settles them', () => {
  it('NLH: a raise creates a side pot with different pot winners; the rake cap binds only on raised lines', () => {
    // Short (set of nines) beats hero (kings) beats deep (queen high).
    const rig: Rig = {
      variant: 'nlh',
      mode: 'cash',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 5, cap: 3, noFlopNoDrop: true },
      dealer: 4,
      seats: [
        { id: 'hero', stack: 110, hole: 'Ah Kd' },
        { id: 'deep', stack: 310, hole: 'Qc Jc' },
        { id: 'short', stack: 40, hole: '9s 9h' },
        { id: 'gone', stack: 110, hole: '3c 2d' },
      ],
      boards: ['9d 7c 4h Kc 2s'],
    };
    const pre: Step[] = [
      [3, 'raise', 10],
      [4, 'fold'],
      [1, 'call'],
      [2, 'call'],
      ...checkdown([1, 2, 3, 1, 2, 3]),
    ];
    const run = runModel(rig, pre, { deep: 0.95, short: 0.5 });
    const { perRow } = controllerAgrees(rig, pre, run);
    const bet = run.rows.find((r) => r.row.id === 'bet:15')!.row;
    controllerExpectation(bet, perRow.get('bet:15')!, 'deep');
    // Pot-sized raise: 15 + (30 + 15 + 15) = 75. Hero beats deep, so its
    // raise-weighted heads-up equity is 1 and it calls.
    expect(bet.responseTree!.raiseTo).toEqual({ deep: [75] });
    expect(bet.responseTree!.heroRaiseEquity).toEqual({ deep: 1 });
    expect(bet.sidePotCount).toBe(2);
    // By hand (contributions in seat order hero, deep, short, gone):
    expect(lines(perRow.get('bet:15')!)).toEqual({
      // Deep and short call 15: short takes 75 less the 3.00 cap.
      '25 25 25 0f': { net: -15, rake: 3, bbj: 0, refunds: {} },
      // Short folds: hero takes 60; 5% is exactly the 3.00 cap.
      '25 25 10f 0f': { net: 42, rake: 3, bbj: 0, refunds: {} },
      // Both fold: hero's 15 comes back before the fee; 5% of 30 is 1.50.
      '25 10f 10f 0f': { net: 28.5, rake: 1.5, bbj: 0, refunds: { hero: 15 } },
      // Raise to 75, short calls all in for 30: main 120 to short, side 90 to
      // hero; the 3.00 cap is shared 207/210: hero 88.71, short 118.29.
      '85 85 40 0f': { net: 13.71, rake: 3, bbj: 0, refunds: {} },
      // Raise, short folds: hero takes 180 less 3.00.
      '85 85 10f 0f': { net: 102, rake: 3, bbj: 0, refunds: {} },
    });
    // Hero all in: deep's raise above it is a pot hero can never win and,
    // with nobody left to call it, it comes straight back to deep.
    expect(perRow.get('jam')!.some((b) => b.refunds.deep === 200)).toBe(true);
  });

  it('NLH: a hero-ineligible side pot between two deep players, a tied main pot and an odd cent', () => {
    // Hero and p3 hold the same ace-king; p2's queens lose. Hero is short.
    const rig: Rig = {
      variant: 'nlh',
      mode: 'cash',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 5, cap: 3, noFlopNoDrop: true },
      dealer: 4,
      seats: [
        { id: 'hero', stack: 37.01, hole: 'Ah Kd' },
        { id: 'p2', stack: 300, hole: 'Qh Qd' },
        { id: 'p3', stack: 300, hole: 'As Kc' },
        { id: 'p4', stack: 50, hole: '7c 6c' },
      ],
      boards: ['Kh 8c 5d 3s 2h'],
    };
    const pre: Step[] = [
      [3, 'raise', 7],
      [4, 'fold'],
      [1, 'call'],
      [2, 'call'],
      ...checkdown([1, 2, 3, 1, 2, 3]),
    ];
    const run = runModel(rig, pre, { p2: 0.95, p3: 0.5 });
    const { perRow } = controllerAgrees(rig, pre, run);
    const jam = run.rows.find((r) => r.row.id === 'jam')!;
    controllerExpectation(jam.row, perRow.get('jam')!, 'p2');
    const raised = perRow.get('jam')!.filter((b) => b.snapshot[1].totalInvested > 37.01);
    expect(raised.length).toBeGreaterThan(0);
    for (const b of raised) {
      expect(b.model.pots[0].eligiblePlayers).toContain('hero');
      for (const side of b.model.pots.slice(1)) expect(side.eligiblePlayers).not.toContain('hero');
    }
    // p2 raises, p3 calls: the tied 111.03 main pot splits 55.52 (hero is the
    // first seat left of the button) and 55.51; the side pot is p3's alone.
    const both = raised.find((b) => !b.snapshot[2].is_folded)!;
    expect(both).toBeDefined();
    expect(both.model.pots[0].amount).toBeCloseTo(111.03, 9);
    expect(both.reference!.gross.hero).toBe(55.52);
    expect(both.rake).toBe(3);
  });

  it('PLO8 two-board bomb: a raise with a quartered low on board 1 and a tied high, no low, on board 2', () => {
    // Board 1: hero's kings take the high; hero and the raiser tie the A-4 low.
    // Board 2 has no low; the raiser's and p3's queen-high straights tie.
    const rig: Rig = {
      variant: 'plo8',
      mode: 'cash',
      smallBlind: 0.1,
      bigBlind: 0.25,
      rakeConfig: { percent: 5, cap: 3, noFlopNoDrop: true },
      bombPot: { boardCount: 2, anteMultiplier: 2 },
      dealer: 3,
      seats: [
        { id: 'hero', stack: 20, hole: 'Kc Kd Ah 4s' },
        { id: 'raiser', stack: 20, hole: 'As 4c Qh Jd' },
        { id: 'p3', stack: 20, hole: 'Qd Jh 6s 6d' },
      ],
      boards: ['2h 3d 7c Kh Qs', 'Jc Ts 9d 8h 5c'],
    };
    const pre: Step[] = checkdown([1, 2, 3, 1, 2, 3]);
    const run = runModel(rig, pre, { raiser: 0.95, p3: 0.5 });
    expect(run.decision.state.boardCount).toBe(2);
    const { perRow } = controllerAgrees(rig, pre, run);
    const raisedRows = run.rows.filter((r) => r.row.responseTree!.raiseBranches > 0);
    expect(raisedRows.length).toBeGreaterThan(0);
    for (const { row } of raisedRows) controllerExpectation(row, perRow.get(row.id)!, 'raiser');
    // Hero checks behind the 1.50 of antes: 0.75 a board. Board 1: high 0.38
    // to hero, the 0.37 low quartered 0.19 hero (first left of the button)
    // and 0.18 raiser. Board 2, no low: the tied high splits 0.38 raiser and
    // 0.37 p3. Rake 5% of 1.50 is 0.08 (7.5 rounds up); the 1.42 left is
    // shared by largest remainder, the odd cent to hero's larger remainder.
    const check = perRow.get('check')!;
    expect(check[0].reference!.gross).toEqual({ hero: 0.57, raiser: 0.56, p3: 0.37 });
    expect(check[0].rake).toBe(0.08);
    expect(check[0].stacks).toEqual({ hero: 20.04, raiser: 20.03, p3: 19.85 });
  });

  it('NLH tournament two-board bomb: whole chips, an odd chip across boards and a tie, with a raise', () => {
    const rig: Rig = {
      variant: 'nlh',
      mode: 'tournament',
      smallBlind: 10,
      bigBlind: 25,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      bombPot: { boardCount: 2, anteMultiplier: 1.5 },
      dealer: 3,
      seats: [
        { id: 'hero', stack: 1000, hole: 'Kh 2d' },
        { id: 'raiser', stack: 1000, hole: 'Ah 5h' },
        { id: 'short', stack: 115, hole: 'Kd 2c' },
      ],
      boards: ['Ks Qd 8s 7c 6s', 'Jh Th 9c 3h 3d'],
    };
    const pre: Step[] = checkdown([1, 2, 3, 1, 2, 3]);
    const run = runModel(rig, pre, { raiser: 0.95, short: 0.5 });
    // The 1.5 x 25 ante is whole: 38 each.
    expect(run.decision.state.pot).toBe(114);
    const { perRow } = controllerAgrees(rig, pre, run);
    for (const { row } of run.rows) {
      expect(row.expectedRake + row.expectedBbj).toBe(0);
      for (const to of Object.values(row.responseTree!.raiseTo).flat())
        expect(Number.isInteger(to)).toBe(true);
      if (row.responseTree!.raiseBranches)
        controllerExpectation(row, perRow.get(row.id)!, 'raiser');
    }
    const all = [...perRow.values()].flat();
    for (const b of all)
      for (const s of Object.values(b.stacks)) expect(Number.isInteger(s)).toBe(true);
    // Hero bets 25, the raiser raises to 189, short calls all in for 77 more
    // and hero calls. Main pot 3 x 115 = 345 is odd: board 1 takes 173 and
    // splits hero 87 / short 86 (hero is first left of the button), board 2's
    // 172 goes to the raiser's flush. Side pot 2 x 112 = 224: board 1 to
    // hero's kings, board 2 to the flush, 112 each.
    const line = perRow
      .get('bet:25')!
      .find((b) => b.snapshot.map((p) => p.totalInvested).join() === '227,227,115')!;
    expect(line.model.pots).toEqual([
      { amount: 345, eligiblePlayers: ['hero', 'raiser', 'short'] },
      { amount: 224, eligiblePlayers: ['hero', 'raiser'] },
    ]);
    expect(line.stacks).toEqual({ hero: 972, raiser: 1057, short: 86 });
  });

  it('Diamond NLH three-board bomb: whole Diamonds, zero deductions, odd units over three boards', () => {
    const rig: Rig = {
      variant: 'nlh',
      mode: 'cash',
      asset: 'diamonds',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      bombPot: { boardCount: 3, anteMultiplier: 2 },
      dealer: 3,
      seats: [
        { id: 'hero', stack: 200, hole: 'Kh 2d' },
        { id: 'raiser', stack: 200, hole: 'Ah 5h' },
        { id: 'short', stack: 21, hole: 'Kd 2c' },
      ],
      boards: ['Ks Qd 8s 7c 6s', 'Jh Th 9c 3h 3d', '4c 4d 9s Jd Ac'],
    };
    const pre: Step[] = checkdown([1, 2, 3, 1, 2, 3]);
    const run = runModel(rig, pre, { raiser: 0.95, short: 0.5 });
    expect(run.decision.state.boardCount).toBe(3);
    const { perRow } = controllerAgrees(rig, pre, run);
    for (const { row } of run.rows) {
      expect([row.expectedRake, row.expectedBbj]).toEqual([0, 0]);
      if (row.responseTree!.raiseBranches)
        controllerExpectation(row, perRow.get(row.id)!, 'raiser');
    }
    const all = [...perRow.values()].flat();
    for (const b of all) {
      expect([b.rake, b.bbjFee]).toEqual([0, 0]);
      for (const s of Object.values(b.stacks)) expect(Number.isInteger(s)).toBe(true);
    }
    // Hero bets 2 (ante 4 each), the raiser raises to 18, short calls all in
    // for 17 more, hero calls. Main pot 63 is 21 a board: board 1 ties hero
    // and short, 11 to hero (first left of the button) and 10; boards 2 and
    // 3 to the raiser. The side pot 2 units over three boards is 1, 1, 0:
    // board 1's to hero, board 2's to the raiser.
    const line = perRow
      .get('bet:2')!
      .find((b) => b.snapshot.map((p) => p.totalInvested).join() === '22,22,21')!;
    expect(line.reference!.gross).toEqual({ hero: 12, raiser: 43, short: 10 });
    expect(line.stacks).toEqual({ hero: 190, raiser: 221, short: 10 });
  });

  it('PLO6 tournament: a three-board request downgraded to two boards by a seven-seat deal, with a raise', () => {
    // 7 x 6 hole cards + 2 x 5 board cards = 52: the whole deck, so the
    // controller deals two of the three requested boards.
    const random = controllerSpotRandom(1306020);
    const deck = RANKS.flatMap((r) => ['s', 'h', 'd', 'c'].map((suit) => r + suit));
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    const rig: Rig = {
      variant: 'plo6',
      mode: 'tournament',
      smallBlind: 10,
      bigBlind: 20,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      bombPot: { boardCount: 3, anteMultiplier: 1.5 },
      dealer: 7,
      seats: Array.from({ length: 7 }, (_, i) => ({
        id: 'p' + (i + 1),
        stack: [900, 900, 75, 900, 61, 900, 900][i],
        hole: deck.slice(i * 6, i * 6 + 6).join(' '),
      })),
      boards: [deck.slice(42, 47).join(' '), deck.slice(47, 52).join(' ')],
    };
    const pre: Step[] = checkdown([1, 2, 3, 4, 5, 6, 7, 1, 2, 3, 4, 5, 6, 7]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const run = runModel(rig, pre, {
      p2: 0.95,
      p3: 0.5,
      p4: 0.4,
      p5: 0.5,
      p6: 0.3,
      p7: 0.3,
    });
    expect(run.decision.state.boardCount).toBe(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain('3-board bomb pot downgraded to 2 board(s)');
    const { perRow } = controllerAgrees(rig, pre, run);
    const raised = run.rows.filter((r) => r.row.responseTree!.raiseBranches > 0);
    expect(raised.length).toBeGreaterThan(0);
    for (const { row } of raised) {
      expect(row.covariance).toHaveLength(2);
      controllerExpectation(row, perRow.get(row.id)!, 'p2');
    }
    // Two short stacks all in at different levels: three pot layers occur.
    expect(Math.max(...run.rows.map((r) => r.row.sidePotCount))).toBeGreaterThanOrEqual(3);
    for (const b of [...perRow.values()].flat())
      for (const v of Object.values(b.stacks)) expect(Number.isInteger(v)).toBe(true);
  });

  it('NLH: refund before fee on an uncalled raise, with the BBJ drop and a dealt-count rake tier', () => {
    // Short (all in preflop) beats raiser beats hero. Four dealt, so the
    // three-player tier cap (2.00) applies although only two can bet.
    const rig: Rig = {
      variant: 'nlh',
      mode: 'cash',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: {
        percent: 10,
        cap: 5,
        noFlopNoDrop: true,
        playerCountCaps: [
          { players: 2, cap: 0.5 },
          { players: 3, cap: 2 },
        ],
      },
      bbjConfig: { enabled: true, feeBB: 0.5, minPotBB: 10, minPlayersDealt: 3 },
      dealer: 4,
      seats: [
        { id: 'hero', stack: 100, hole: '7d 6d' },
        { id: 'raiser', stack: 100, hole: 'Ac Qh' },
        { id: 'short', stack: 4, hole: 'Kh Ks' },
        { id: 'gone', stack: 100, hole: '3c 2d' },
      ],
      boards: ['Qs 9c 4d Jh 2s'],
    };
    const pre: Step[] = [
      [3, 'all_in'],
      [4, 'fold'],
      [1, 'call'],
      [2, 'call'],
      ...checkdown([1, 2, 1, 2]),
    ];
    const run = runModel(rig, pre, { raiser: 0.95 });
    const { perRow } = controllerAgrees(rig, pre, run);
    const bet = run.rows.find((r) => r.row.id === 'bet:6')!.row;
    controllerExpectation(bet, perRow.get('bet:6')!, 'raiser');
    // Hero cannot beat the raiser: it folds the pot-sized raise to 30.
    expect(bet.responseTree!.raiseTo).toEqual({ raiser: [30] });
    expect(bet.responseTree!.heroRaiseEquity).toEqual({ raiser: 0 });
    expect(bet.responseTree!.heroFoldsToRaiseProbability).toBeGreaterThan(0);
    expect(lines(perRow.get('bet:6')!)).toEqual({
      // Raiser calls: main 12 to short, side 12 to the raiser; 10% is 2.40,
      // capped at 2.00 by the three-player tier; BBJ 1.00.
      '10 10 4 0f': { net: -6, rake: 2, bbj: 1, refunds: {} },
      // Raiser folds: hero's 6 returns first; 12 to short less 1.20 and 1.00.
      '10 4f 4 0f': { net: 0, rake: 1.2, bbj: 1, refunds: { hero: 6 } },
      // Raise to 30, hero folds: 24 returns to the raiser BEFORE the fee;
      // only the contested 24 (12 + 6 + 6) is raked, 2.00, and BBJ 1.00.
      '10f 34 4 0f': { net: -6, rake: 2, bbj: 1, refunds: { raiser: 24 } },
    });
    // Below the cap the refund sets the rake: raise to 23.88 over 3.96,
    // 19.92 returned, 10% of the contested 19.92 is 1.99.
    expect(lines(perRow.get('bet:3.96')!)['7.96f 27.88 4 0f']).toEqual({
      net: -3.96,
      rake: 1.99,
      bbj: 1,
      refunds: { raiser: 19.92 },
    });
  });

  it('NLH: a one big blind ante, a straddle and an ante-only all in under a raise branch', () => {
    // Seat 4 is all in for its ante alone and holds the best hand.
    const rig: Rig = {
      variant: 'nlh',
      mode: 'cash',
      smallBlind: 1,
      bigBlind: 2,
      ante: 2,
      straddles: [{ seat: 3, amount: 4 }],
      rakeConfig: { percent: 5, cap: 3, noFlopNoDrop: true },
      dealer: 5,
      seats: [
        { id: 'hero', stack: 100, hole: 'Ah Kd' },
        { id: 'raiser', stack: 300, hole: 'Qc Jc' },
        { id: 'straddle', stack: 100, hole: '8h 8d' },
        { id: 'ante', stack: 2, hole: '9s 9h' },
        { id: 'button', stack: 100, hole: '3c 2d' },
      ],
      boards: ['9d 7c 4h Kc 2s'],
    };
    const pre: Step[] = [
      [5, 'call'],
      [1, 'call'],
      [2, 'call'],
      [3, 'check'],
      ...checkdown([1, 2, 3, 5, 1, 2, 3, 5]),
    ];
    const run = runModel(rig, pre, { raiser: 0.95, straddle: 0.3, button: 0.3 });
    const { perRow } = controllerAgrees(rig, pre, run);
    const all = [...perRow.values()].flat();
    // The ante pot (2 x 5 = 10) is the only pot the ante-only all in can win,
    // and it wins it on every line; the straddle is ordinary live money.
    for (const b of all) {
      expect(b.model.pots[0].amount).toBe(10);
      expect(b.model.pots[0].eligiblePlayers).toContain('ante');
      for (const side of b.model.pots.slice(1)) expect(side.eligiblePlayers).not.toContain('ante');
      expect(b.reference!.gross.ante).toBe(10);
      expect(b.stacks.ante).toBeLessThanOrEqual(10);
    }
    expect(run.rows.some((r) => r.row.responseTree!.raiseBranches > 0)).toBe(true);
  });

  it('FLO8: a fixed-limit raise with a three-way tied low (sixths) and a high half', () => {
    const rig: Rig = {
      variant: 'flo8',
      mode: 'cash',
      smallBlind: 0.05,
      bigBlind: 0.1,
      rakeConfig: { percent: 5, cap: 1, noFlopNoDrop: true },
      dealer: 3,
      seats: [
        { id: 'hero', stack: 10, hole: 'Ah 4h Kd Jc' },
        { id: 'raiser', stack: 10, hole: 'As 4s Qh Td' },
        { id: 'p3', stack: 10, hole: 'Ad 4c 9s 9h' },
      ],
      boards: ['2c 3d 7h Ks Qd'],
    };
    const pre: Step[] = [[3, 'call'], [1, 'call'], [2, 'check'], ...checkdown([1, 2, 3, 1, 2, 3])];
    const run = runModel(rig, pre, { raiser: 0.95, p3: 0.5 });
    const { perRow } = controllerAgrees(rig, pre, run);
    const bet = run.rows.find((r) => r.row.id === 'bet:0.2')!.row;
    // The fixed big bet and its one fixed raise.
    expect(bet.responseTree!.raiseTo).toEqual({ raiser: [0.4] });
    controllerExpectation(bet, perRow.get('bet:0.2')!, 'raiser');
    // The fixed-limit all in is the same capped wager as the bet.
    expect(lines(perRow.get('jam')!)).toEqual(lines(perRow.get('bet:0.2')!));
    // Everyone in for 0.50: high 0.75 to hero, low 0.75 in sixths, 0.25 each.
    // Rake 5% of 1.50 is 0.08. On one board the controller rounds each
    // share (0.95, 0.24, 0.24) and takes the overshoot cent from the first
    // winner: hero is paid 0.94, a net 0.54 after its 0.40.
    const full = perRow
      .get('bet:0.2')!
      .find((b) => b.snapshot.every((p) => cents(p.totalInvested) === 50))!;
    expect(full.reference!.gross).toEqual({ hero: 1, raiser: 0.25, p3: 0.25 });
    expect(lines([full])).toEqual({
      '0.5 0.5 0.5': { net: 0.54, rake: 0.08, bbj: 0, refunds: {} },
    });
  });
});

describe('P13-B scoops and shared dead money under a raise branch', () => {
  it('FLO8: hero scoops high and low on every raised and unraised line', () => {
    // Hero holds trip kings and the A-4 low; the raiser's A-5 and p3's 8-6
    // lows qualify and lose.
    const rig: Rig = {
      variant: 'flo8',
      mode: 'cash',
      smallBlind: 0.05,
      bigBlind: 0.1,
      rakeConfig: { percent: 5, cap: 1, noFlopNoDrop: true },
      dealer: 3,
      seats: [
        { id: 'hero', stack: 10, hole: 'Ah 4h Kd Kc' },
        { id: 'raiser', stack: 10, hole: 'As 5s Qh Td' },
        { id: 'p3', stack: 10, hole: '9s 9h 8d 6c' },
      ],
      boards: ['2c 3d 7h Ks Qd'],
    };
    const pre: Step[] = [[3, 'call'], [1, 'call'], [2, 'check'], ...checkdown([1, 2, 3, 1, 2, 3])];
    const run = runModel(rig, pre, { raiser: 0.95, p3: 0.5 });
    const { perRow } = controllerAgrees(rig, pre, run);
    const bet = run.rows.find((r) => r.row.id === 'bet:0.2')!.row;
    controllerExpectation(bet, perRow.get('bet:0.2')!, 'raiser');
    for (const b of perRow.get('bet:0.2')!) {
      // A scoop: hero's gross is the whole pot, and only the drop is missing.
      const pot = b.snapshot.reduce((a, p) => a + p.totalInvested, 0);
      expect(b.reference!.gross.hero).toBeCloseTo(pot, 9);
      expect(b.stacks.hero - b.snapshot[0].stack).toBeCloseTo(pot - b.rake, 9);
    }
    // The raised and called line: 1.50, rake 0.08 (7.5 rounds up), hero +1.02.
    expect(
      lines(perRow.get('bet:0.2')!.filter((b) => b.snapshot.every((p) => p.totalInvested === 0.5)))
    ).toEqual({ '0.5 0.5 0.5': { net: 1.02, rake: 0.08, bbj: 0, refunds: {} } });
  });

  it('NLH tournament big blind ante at the one big blind boundary: an all-in BB fronts shared dead money', () => {
    // ante == BB in a BB-ante structure is the table total (25), not per seat.
    // The BB (40) posts 25 live and only 15 of the ante: all in, 15 dead.
    const rig: Rig = {
      variant: 'nlh',
      mode: 'tournament',
      smallBlind: 10,
      bigBlind: 25,
      ante: 25,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      dealer: 4,
      seats: [
        { id: 'hero', stack: 1000, hole: 'Kh Kd' },
        { id: 'bb', stack: 40, hole: 'As Ad' },
        { id: 'raiser', stack: 1500, hole: 'Qc Jc' },
        { id: 'p4', stack: 800, hole: '7s 6s' },
      ],
      bigBlindAnte: true,
      boards: ['9d 8c 4h 2c 3s'],
    };
    const pre: Step[] = [
      [3, 'raise', 60],
      [4, 'call'],
      [1, 'call'],
      ...checkdown([1, 3, 4, 1, 3, 4]),
    ];
    const run = runModel(rig, pre, { raiser: 0.95, p4: 0.4 });
    const bb = run.decision.state.players.find((p) => p.user_id === 'bb')!;
    expect([bb.totalInvested, bb.deadInvested, bb.is_all_in]).toEqual([40, 15, true]);
    const { perRow } = controllerAgrees(rig, pre, run);
    expect(run.rows.some((r) => r.row.responseTree!.raiseBranches > 0)).toBe(true);
    for (const b of [...perRow.values()].flat()) {
      // The BB's matched 25 builds the main pot with every live 25 and the
      // shared dead 15: 25 x 4 + 15 = 115, all to the aces.
      expect(b.model.pots[0]).toEqual({
        amount: 115,
        eligiblePlayers: b.snapshot.filter((p) => !p.is_folded).map((p) => p.user_id),
      });
      expect(b.stacks.bb).toBe(115);
      for (const v of Object.values(b.stacks)) expect(Number.isInteger(v)).toBe(true);
    }
    // Hero checks it down: the 105 side pot (35 x 3) is the kings'.
    expect(perRow.get('check')![0].stacks).toEqual({ hero: 1045, bb: 115, raiser: 1440, p4: 740 });
  });
});

describe('P13-B no flop no drop and the one-response model against the controller', () => {
  it('NLH preflop: folded-out raises pay no drop, called lines pay rake, every refund first', () => {
    const rig: Rig = {
      variant: 'nlh',
      mode: 'cash',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 10, cap: 3, noFlopNoDrop: true },
      bbjConfig: { enabled: true, feeBB: 0.5, minPotBB: 10, minPlayersDealt: 3 },
      dealer: 4,
      seats: [
        { id: 'sb', stack: 100, hole: 'Qc Jc' },
        { id: 'bb', stack: 100, hole: '9s 9h' },
        { id: 'hero', stack: 100, hole: 'Ah Kd' },
        { id: 'btn', stack: 100, hole: '3c 2d' },
      ],
      boards: ['9d 7c 4h Kc 2s'],
    };
    const run = runModel(rig, [], { sb: 0.2, bb: 0.2, btn: 0.2 });
    expect(run.result.responseModel).toBe('one_response_then_showdown');
    const { perRow } = controllerAgrees(rig, [], run);
    let foldOuts = 0;
    for (const [id, list] of perRow)
      for (const b of list) {
        if (b.snapshot.filter((p) => !p.is_folded).length === 1) {
          // A walk or a fold-out deals no board: no rake and no BBJ drop.
          foldOuts++;
          expect([b.rake, b.bbjFee], id).toEqual([0, 0]);
        } else {
          // A called preflop line is dealt to showdown: four dealt, BBJ 1.00.
          expect(b.rake, id).toBeGreaterThan(0);
          expect(b.bbjFee, id).toBe(1);
        }
      }
    expect(foldOuts).toBeGreaterThan(0);
    expect(lines(perRow.get('raise:4')!)).toEqual({
      // Everybody folds: hero's 2 above the big blind returns, no drop.
      '1f 2f 4 0f': { net: 3, rake: 0, bbj: 0, refunds: { hero: 2 } },
      // The big blind calls: 9 with the small blind's dead 1, raked 0.90.
      '1f 4 4 0f': { net: -4, rake: 0.9, bbj: 1, refunds: {} },
      // The small blind calls: 10, raked 1.00; hero's kings win 8.00.
      '4 2f 4 0f': { net: 4, rake: 1, bbj: 1, refunds: {} },
    });
  });
});

describe('P13-B explicit fee schedules the joint owner does not price', () => {
  const river = () => {
    const rig: Rig = {
      variant: 'nlh',
      mode: 'cash',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 5, cap: 3, noFlopNoDrop: true },
      dealer: 4,
      seats: [
        { id: 'hero', stack: 110, hole: 'Ah Kd' },
        { id: 'deep', stack: 310, hole: 'Qc Jc' },
        { id: 'short', stack: 40, hole: '9s 9h' },
        { id: 'gone', stack: 110, hole: '3c 2d' },
      ],
      boards: ['9d 7c 4h Kc 2s'],
    };
    const played = play(rig, [
      [3, 'raise', 10],
      [4, 'fold'],
      [1, 'call'],
      [2, 'call'],
      ...checkdown([1, 2, 3, 1, 2, 3]),
    ]);
    return decisionSpot(played, rig);
  };
  it.each([
    ['timed rake', 'joint_deductions_invalid_config'],
    ['player-count cap for one player', 'joint_deductions_invalid_config'],
    ['tournament rake', 'joint_deductions_nonzero_whole_unit_fees'],
    ['Diamond BBJ', 'joint_deductions_nonzero_whole_unit_fees'],
  ])('refuses %s by name before any ranking', (fault, reason) => {
    const { hero, state, baseline } = river();
    if (fault === 'timed rake') state.rakeConfig!.timedRake = { amountPerMinute: 1 };
    if (fault === 'player-count cap for one player')
      state.rakeConfig!.playerCountCaps = [{ players: 1, cap: 1 }];
    if (fault === 'tournament rake') Object.assign(state, { gameMode: 'tournament', chipUnit: 1 });
    if (fault === 'Diamond BBJ') {
      Object.assign(state, { asset: 'diamonds', chipUnit: 1 });
      state.rakeConfig = { percent: 0, cap: 0, noFlopNoDrop: true };
      state.bbjConfig = { enabled: true, feeBB: 0.5, minPotBB: 10, minPlayersDealt: 3 };
    }
    const result = evaluateJointLivePolicy(hero, state, baseline, 'candidate', () => 0);
    expect(result.receipt.reason).toBe(reason);
    expect(result.receipt.fired).toBe(false);
    expect(result.decision).toBe(baseline);
  });
  it('the controller itself refuses a Diamond hand with a BBJ drop at admission', () => {
    expect(
      () =>
        new HandController(
          {
            tableId: 'p13-b-diamond-bbj',
            handNumber: 1,
            gameVariant: 'nlh',
            smallBlind: 1,
            bigBlind: 2,
            asset: 'diamonds',
            rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
            bbjConfig: { enabled: true, feeBB: 0.5, minPotBB: 10, minPlayersDealt: 3 },
          },
          [],
          1
        )
    ).toThrow('Diamond Certification Requires A Supported Game With No Deductions');
  });
});
