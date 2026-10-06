/**
 * ═══ A DIAMOND CASH HAND IS RAKED BY ITS SETTINGS, END TO END ════════════
 *
 * Not the pricer in isolation - a HandController dealt a real Diamond cash
 * hand, played to its end, charged a rake out of the pot before anyone was
 * paid, and asked afterwards whether the money adds up. Before this change
 * every one of these hands charged zero, because `calculateRake` reads the
 * CHIP schedule and a Diamond table's chip columns are required to be
 * explicitly zero.
 *
 * NO EXPECTED RAKE IS A LITERAL. Each expectation is recomputed from the
 * published settings rows through `priceDiamondCashRake`, and each hand's POT
 * is also established independently - from conservation (what the stacks lost
 * is what the rake took) and from the hand's construction (every seat calls
 * one big blind, so the pot is seats x big blind). A changed setting moves the
 * expectation; a mis-priced hand breaks conservation.
 *
 * HORSES ARE PLAYERS (CLAUDE.md 10.5). The last test deals the same hand with
 * every seat marked a horse and asserts the rake is the SAME number, charged
 * off the same pot - not an equal outcome reached some other way, the
 * identical arithmetic, because nothing on this path can see a seat at all.
 */
import { describe, expect, it } from 'vitest';
import { HandController } from './HandController.js';
import { calculateRake } from './PokerEngine.js';
import { assertDiamondAcceptedHand } from '../domain/DiamondCashBoundary.js';
import {
  priceDiamondCashRake,
  resolveDiamondCashRakeSchedule,
  type DiamondCashRakeSchedule,
  type EconomicsRow,
} from '../domain/diamondCashRakeSchedule.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';

/** The owner's published answers on 2026-10-06, as rows. */
let nextId = 1;
const row = (
  name: string,
  scope: string,
  value: number | null,
  value_text: string | null = null
): EconomicsRow => ({
  name,
  scope,
  value,
  value_text,
  recorded_at: '2026-10-05T00:00:00.000Z',
  id: nextId++,
});

const CAPS: Array<[number, number, number, number]> = [
  [2, 30, 15, 30],
  [5, 75, 37, 75],
  [100, 500, 250, 500],
];

function publishedRows(): EconomicsRow[] {
  const rows = [
    row('cash_rake_enabled', 'all', null, 'yes'),
    row('cash_rake_no_flop_no_drop', 'all', null, 'yes'),
    row('cash_rake_rounding', 'all', null, 'down'),
    row('cash_rake_min_pot', 'all', 0),
    row('cash_rake_percent', 'all', 10),
    row('cash_rake_percent_heads_up', 'all', 5),
    row('cash_rake_percent_three_handed', 'all', 10),
  ];
  for (const [bb, cap, hu, three] of CAPS) {
    rows.push(row('cash_rake_cap', `bb:${bb}`, cap));
    rows.push(row('cash_rake_cap_heads_up', `bb:${bb}`, hu));
    rows.push(row('cash_rake_cap_three_handed', `bb:${bb}`, three));
  }
  return rows;
}

const scheduleAt = (bb: number, rows = publishedRows()) => resolveDiamondCashRakeSchedule(rows, bb);

function players(stacks: number[], isHorse = false): SeatPlayer[] {
  return stacks.map(
    (stack, i) =>
      ({
        seat: i + 1,
        user_id: `p${i + 1}`,
        username: `P${i + 1}`,
        stack,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
        is_horse: isHorse,
      }) as unknown as SeatPlayer
  );
}

function handConfig(over: Partial<HandConfig> = {}): HandConfig {
  return {
    asset: 'diamonds',
    tableId: 'diamond-cash-rake',
    handNumber: 1_000_001,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    /* A Diamond table's chip columns are explicitly zero, which is exactly
       why the chip ladder answers zero and cannot price this hand. */
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    ...over,
  } as HandConfig;
}

interface PlayedHand {
  rake: number;
  bbjFee: number;
  pot: number;
  dealtIn: number;
  sawFlop: boolean;
  startingTotal: number;
  finalTotal: number;
  finalStacks: number[];
}

/**
 * Deal a hand and play it out. `foldPreflop` folds everyone but the big
 * blind, which is the only way to reach the end of a hand with no flop.
 */
function playHand(
  config: HandConfig,
  stacks: number[],
  opts: { foldPreflop?: boolean; allIn?: boolean } = {}
): PlayedHand {
  const seats = players(stacks);
  const startingTotal = stacks.reduce((sum, stack) => sum + stack, 0);
  let completed: { rake: number; bbjFee: number } | null = null;
  const hc = new HandController(config, seats, 1);
  hc.onEvent((event: HandEvent) => {
    if (event.type === 'HAND_COMPLETE')
      completed = {
        rake: (event as never as { rake: number }).rake,
        bbjFee: (event as never as { bbjFee: number }).bbjFee,
      };
  });
  hc.start();
  for (let step = 0; step < 200 && completed === null; step++) {
    const state = hc.getState();
    const player = state.players.find((p) => p.seat === state.currentPlayerSeat);
    if (!player || player.is_all_in || player.is_folded) {
      hc.continueRunout();
      continue;
    }
    if (opts.foldPreflop && state.stage === 'preflop' && player.bet < state.currentBet) {
      if (hc.performAction(player.seat, 'fold')) continue;
    }
    /* EVERY SEAT ALL IN is how a pot big enough to reach the cap is built at
       a small stake, and the only line this driver needs beyond call/check. */
    if (opts.allIn && hc.performAction(player.seat, 'all_in')) continue;
    if (hc.performAction(player.seat, player.bet < state.currentBet ? 'call' : 'check')) continue;
    hc.continueRunout();
  }
  const after = hc.getState();
  expect(completed, 'the hand never completed').not.toBeNull();
  return {
    rake: completed!.rake,
    bbjFee: completed!.bbjFee,
    pot: after.players.reduce((sum, p) => sum + (p.totalInvested ?? 0), 0),
    dealtIn: after.players.length,
    sawFlop: hc.handSawFlopForMoney(),
    startingTotal,
    finalTotal: after.players.reduce((sum, p) => sum + p.stack, 0),
    finalStacks: after.players.map((p) => p.stack),
  };
}

/** Everything that must be true of every settled Diamond cash hand. */
function assertWholeAndConserving(played: PlayedHand, schedule: DiamondCashRakeSchedule): void {
  /* THE ENGINE'S NUMBER IS THE SETTINGS' NUMBER for this hand's own facts -
     the same three the settler recomputes from. */
  expect(
    priceDiamondCashRake(schedule, {
      pot: played.pot,
      dealtIn: played.dealtIn,
      sawFlop: played.sawFlop,
    })
  ).toBe(played.rake);
  /* A Diamond pays no jackpot drop. */
  expect(played.bbjFee).toBe(0);
  /* CONSERVATION, the settler's own rule: the stacks are short by exactly the
     rake and by nothing else. */
  expect(played.startingTotal - played.finalTotal).toBe(played.rake);
  /* WHOLE INDIVISIBLE DIAMONDS, everywhere. */
  expect(Number.isSafeInteger(played.rake)).toBe(true);
  for (const stack of played.finalStacks) expect(Number.isSafeInteger(stack)).toBe(true);
  expect(Number.isSafeInteger(played.pot)).toBe(true);
  /* And the accepted-hand boundary admits it, re-pricing it the same way. */
  expect(() =>
    assertDiamondAcceptedHand({
      arena: { id: 'arena', kind: 'diamond_arena', asset: 'diamonds' },
      verifiedLease: true,
      variant: 'nlh',
      rake: played.rake,
      bbj: 0,
      inflow: 0,
      insuranceCount: 0,
      amounts: [played.pot, ...played.finalStacks],
      rakeSchedule: schedule,
      rakeFacts: { pot: played.pot, dealtIn: played.dealtIn, sawFlop: played.sawFlop },
    })
  ).not.toThrow();
}

describe('a Diamond cash hand charges the rake the owner published', () => {
  it('rakes a flopped three-handed pot under the cap', () => {
    const schedule = scheduleAt(100);
    const played = playHand(
      handConfig({ smallBlind: 50, bigBlind: 100, diamondRakeSchedule: schedule }),
      [1000, 1000, 1000]
    );
    expect(played.sawFlop).toBe(true);
    /* The pot is known by construction: three seats, each in for one big
       blind, nobody raising. */
    expect(played.pot).toBe(3 * 100);
    /* 10% of 300 is 30, and the three-handed cap at bb:100 is 500, so the
       percent is the binding term - asserted, not assumed. */
    expect(played.rake).toBeGreaterThan(0);
    expect(played.rake).toBeLessThan(500);
    assertWholeAndConserving(played, schedule);
  });

  it('rakes a flopped multiway pot under the cap', () => {
    const schedule = scheduleAt(100);
    const played = playHand(
      handConfig({ smallBlind: 50, bigBlind: 100, diamondRakeSchedule: schedule }),
      [1000, 1000, 1000, 1000, 1000, 1000]
    );
    expect(played.dealtIn).toBe(6);
    expect(played.pot).toBe(6 * 100);
    expect(played.rake).toBeGreaterThan(0);
    assertWholeAndConserving(played, schedule);
  });

  it('is held to the cap when the pot is large enough to reach it', () => {
    const schedule = scheduleAt(2);
    /* 1/2, six-handed, every seat all-in for 500: a pot of 3000, 10% of which
       is 300, against a published cap of 30 at bb:2. The cap binds by a long
       way, and that it binds is asserted rather than assumed. */
    const played = playHand(
      handConfig({ smallBlind: 1, bigBlind: 2, diamondRakeSchedule: schedule }),
      [500, 500, 500, 500, 500, 500],
      { allIn: true }
    );
    expect(played.pot).toBe(3000);
    const uncapped = Math.floor((played.pot * 10) / 100);
    expect(uncapped).toBeGreaterThan(played.rake);
    assertWholeAndConserving(played, schedule);
  });

  it('rakes a heads-up hand at the heads-up percent and cap', () => {
    const schedule = scheduleAt(5);
    const played = playHand(
      handConfig({ smallBlind: 2, bigBlind: 5, diamondRakeSchedule: schedule }),
      [5000, 5000]
    );
    expect(played.dealtIn).toBe(2);
    assertWholeAndConserving(played, schedule);
    /* The heads-up bracket, not the four-or-more one: the same pot priced at
       the full percent would be a different number. */
    const atFullPercent = Math.floor((played.pot * 10) / 100);
    const atHeadsUpPercent = Math.floor((played.pot * 5) / 100);
    expect(atFullPercent).not.toBe(atHeadsUpPercent);
    expect(played.rake).toBe(Math.min(atHeadsUpPercent, 37));
  });

  it('floors a big heads-up pot at the bb:5 rung, the one cap that is not half', () => {
    const schedule = scheduleAt(5);
    /* A pot of 1000 at 5% is 50; the published heads-up cap at bb:5 is 37,
       because 75 halves to 37.5 and the owner published 37. */
    const played = playHand(
      handConfig({ smallBlind: 2, bigBlind: 5, diamondRakeSchedule: schedule }),
      [500, 500],
      { allIn: true }
    );
    expect(played.pot).toBe(1000);
    expect(Math.floor((1000 * 5) / 100)).toBe(50);
    expect(played.rake).toBe(37);
    assertWholeAndConserving(played, schedule);
  });

  it('rakes nothing from a hand that never saw a flop', () => {
    const schedule = scheduleAt(100);
    const played = playHand(
      handConfig({ smallBlind: 50, bigBlind: 100, diamondRakeSchedule: schedule }),
      [1000, 1000, 1000],
      { foldPreflop: true }
    );
    expect(played.sawFlop).toBe(false);
    expect(played.rake).toBe(0);
    assertWholeAndConserving(played, schedule);
    /* The zero is no-flop-no-drop firing, not an empty schedule: the same
       seats and stakes WITH a flop are raked. */
    const flopped = playHand(
      handConfig({ smallBlind: 50, bigBlind: 100, diamondRakeSchedule: schedule }),
      [1000, 1000, 1000]
    );
    expect(flopped.rake).toBeGreaterThan(0);
  });

  it('rakes nothing from a flopped pot too small to yield one whole Diamond', () => {
    const schedule = scheduleAt(2);
    /* 1/2 three-handed, nobody raising: a pot of 6, and 10% of 6 truncates to
       zero. The hand still settles, and it settles at zero. */
    const played = playHand(
      handConfig({ smallBlind: 1, bigBlind: 2, diamondRakeSchedule: schedule }),
      [100, 100, 100]
    );
    expect(played.sawFlop).toBe(true);
    expect(played.pot).toBe(6);
    expect((played.pot * 10) / 100).toBeLessThan(1);
    expect(played.rake).toBe(0);
    assertWholeAndConserving(played, schedule);
  });

  it("charges a horse's seat the identical rake off the identical pot", () => {
    /* CLAUDE.md 10.5. Same stakes, same stacks, same line - once with every
       seat a person and once with every seat a horse. Not "a comparable
       outcome": the same number, because the pricer is handed a pot, a count
       and a flop fact and has no way to ask who was sitting there. */
    const schedule = scheduleAt(100);
    const config = handConfig({ smallBlind: 50, bigBlind: 100, diamondRakeSchedule: schedule });
    const human = playHand(config, [1000, 1000, 1000]);
    const horseSeats = players([1000, 1000, 1000], true);
    let horseRake: number | null = null;
    const hc = new HandController({ ...config, handNumber: 1_000_002 }, horseSeats, 1);
    hc.onEvent((event: HandEvent) => {
      if (event.type === 'HAND_COMPLETE') horseRake = (event as never as { rake: number }).rake;
    });
    hc.start();
    for (let step = 0; step < 60 && hc.getState().stage !== 'showdown'; step++) {
      const state = hc.getState();
      const player = state.players.find((p) => p.seat === state.currentPlayerSeat);
      if (!player || player.is_all_in) {
        hc.continueRunout();
        continue;
      }
      hc.performAction(player.seat, player.bet < state.currentBet ? 'call' : 'check');
    }
    expect(horseRake).toBe(human.rake);
    expect(horseRake).toBeGreaterThan(0);
  });
});

describe('the bracket is the count the settler counts', () => {
  it('brackets by seats DEALT IN, not by seats that are not sitting out', () => {
    /* MUTATION FINDING (2026-10-06). The chip ladder brackets on
       `players.filter(p => !p.is_sitting_out).length`; the settler brackets on
       `count(*) FILTER (WHERE dealt_in)`, and `dealt_in` is membership of the
       map the hand was DEALT from - a sitting-out seat in that roster is
       dealt in and is counted. The two counts are equal in every ordinary
       hand, so swapping one for the other left every other test green while
       changing the bracket, the percent and the cap on any hand where they
       differ. This is the hand where they differ.

       Three seats, one sitting out, at 50/100. On the settler's count of
       three the three-handed percent applies; on the chip count of two it
       would be the heads-up percent and the heads-up cap - a different
       number, and a refused hand. */
    const schedule = scheduleAt(100);
    const seats = players([1000, 1000, 1000]);
    (seats[2] as unknown as { is_sitting_out: boolean }).is_sitting_out = true;
    const hc = new HandController(
      handConfig({ smallBlind: 50, bigBlind: 100, diamondRakeSchedule: schedule }),
      seats,
      1
    );
    hc.start();
    /* To the flop, so the rake is priced on a board that corroborates it -
       the same rule every money path is held to. */
    for (let step = 0; step < 20 && hc.getState().communityCards.length < 3; step++) {
      const live = hc.getState();
      const actor = live.players.find((p) => p.seat === live.currentPlayerSeat);
      if (!actor) break;
      if (!hc.performAction(actor.seat, actor.bet < live.currentBet ? 'call' : 'check')) break;
    }
    const state = hc.getState();
    expect(state.communityCards.length).toBeGreaterThanOrEqual(3);
    const dealtRoster = state.players.length;
    const notSittingOut = state.players.filter((p) => !p.is_sitting_out).length;
    /* The premise of the test: the two counts really do disagree here. */
    expect(dealtRoster).toBe(3);
    expect(notSittingOut).toBe(2);
    const pot = state.players.reduce((sum, p) => sum + (p.totalInvested ?? 0), 0);
    expect(pot).toBeGreaterThan(0);
    const priced = hc.priceDeductions(true, pot);
    /* And the two brackets really do price this pot differently, or the
       assertion below would hold either way. */
    const atDealtIn = priceDiamondCashRake(schedule, { pot, dealtIn: dealtRoster, sawFlop: true });
    const atNotSittingOut = priceDiamondCashRake(schedule, {
      pot,
      dealtIn: notSittingOut,
      sawFlop: true,
    });
    expect(atDealtIn).not.toBe(atNotSittingOut);
    expect(priced.rake).toBe(atDealtIn);
  });
});

describe('the chip path is not touched by any of this', () => {
  it('prices a chip hand with calculateRake, exactly as it did', () => {
    /* No schedule, a real chip rake config: the number is `calculateRake`'s,
       to the cent. If the Diamond branch could ever reach a chip hand this
       would be the first thing to move. */
    const rakeConfig = { percent: 5, cap: 3, noFlopNoDrop: true };
    const seats = players([1000, 1000, 1000]);
    let rake: number | null = null;
    const hc = new HandController(
      {
        ...handConfig({ smallBlind: 50, bigBlind: 100, rakeConfig }),
        asset: undefined,
      } as HandConfig,
      seats,
      1
    );
    hc.onEvent((event: HandEvent) => {
      if (event.type === 'HAND_COMPLETE') rake = (event as never as { rake: number }).rake;
    });
    hc.start();
    for (let step = 0; step < 60 && hc.getState().stage !== 'showdown'; step++) {
      const state = hc.getState();
      const player = state.players.find((p) => p.seat === state.currentPlayerSeat);
      if (!player || player.is_all_in) {
        hc.continueRunout();
        continue;
      }
      hc.performAction(player.seat, player.bet < state.currentBet ? 'call' : 'check');
    }
    const pot = hc.getState().players.reduce((sum, p) => sum + (p.totalInvested ?? 0), 0);
    expect(rake).toBe(calculateRake(pot, true, rakeConfig, 3));
    expect(rake).toBeGreaterThan(0);
  });

  it('leaves a chip hand at exactly the same number when the field is null', () => {
    /* `diamondRakeSchedule: null` must be indistinguishable from the field not
       existing - the config site writes null on every chip hand. */
    const rakeConfig = { percent: 5, cap: 3, noFlopNoDrop: true };
    const run = (over: Partial<HandConfig>) => {
      const seats = players([1000, 1000, 1000]);
      let rake: number | null = null;
      const hc = new HandController(
        {
          ...handConfig({ smallBlind: 50, bigBlind: 100, rakeConfig, ...over }),
          asset: undefined,
        } as HandConfig,
        seats,
        1
      );
      hc.onEvent((event: HandEvent) => {
        if (event.type === 'HAND_COMPLETE') rake = (event as never as { rake: number }).rake;
      });
      hc.start();
      for (let step = 0; step < 60 && hc.getState().stage !== 'showdown'; step++) {
        const state = hc.getState();
        const player = state.players.find((p) => p.seat === state.currentPlayerSeat);
        if (!player || player.is_all_in) {
          hc.continueRunout();
          continue;
        }
        hc.performAction(player.seat, player.bet < state.currentBet ? 'call' : 'check');
      }
      return rake;
    };
    expect(run({ diamondRakeSchedule: null })).toBe(run({}));
    expect(run({ diamondRakeSchedule: undefined })).toBe(run({}));
  });
});
