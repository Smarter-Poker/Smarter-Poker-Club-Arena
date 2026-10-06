import { describe, expect, it } from 'vitest';
import { HandController } from './HandController.js';
import { calculatePots } from './PokerEngine.js';
import { KNOWN_VARIANTS } from './VariantRules.js';
import type { Card, HandConfig, HandEvent, SeatPlayer } from '../types.js';
const suits = { h: 'hearts', d: 'diamonds', c: 'clubs', s: 'spades' };
const cards = (list: string[]): Card[] =>
  list.map((c) => ({ rank: c[0], suit: suits[c[1] as keyof typeof suits] }) as Card);

describe('partial individual ante contribution caps through a complete hand', () => {
  it.each(
    [
      [3, 100, 100, 7],
      [100, 3, 100, 7],
      [100, 100, 3, 7],
    ].flatMap((stacks) =>
      [1, 0.01].map((scale) => ({ stacks: stacks.map((n) => n * scale), scale }))
    )
  )('complete hand $stacks at unit $scale', ({ stacks, scale }) => {
    const events: HandEvent[] = [];
    const h = new HandController(
      {
        tableId: 'partial-ante',
        handNumber: 1,
        gameVariant: 'nlh',
        smallBlind: scale,
        bigBlind: 2 * scale,
        ante: 10 * scale,
        bigBlindAnte: false,
        isTournament: scale === 1,
        rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      } as HandConfig,
      stacks.map((stack, i) => ({
        seat: i + 1,
        user_id: `u${i + 1}`,
        username: `P${i + 1}`,
        stack,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      })) as SeatPlayer[],
      1
    );
    h.onEvent((e) => events.push(e));
    h.start();
    let s = h.getState();
    for (let i = 0; i < stacks.length; i++) {
      expect(s.players[i].deadInvested).toBe(Math.min(10 * scale, stacks[i]));
      expect(s.players[i].stack).toBeGreaterThanOrEqual(0);
    }
    expect(s.currentBet).toBe(2 * scale);
    const forced = events.find((e) => e.type === 'FORCED_BETS_POSTED') as any;
    expect(forced.postings.filter((p: any) => p.kind === 'ante').map((p: any) => p.amount)).toEqual(
      stacks.map((n) => Math.min(10 * scale, n))
    );
    let actions = 0;
    while (h.getState().stage !== 'river' && actions++ < 20) {
      s = h.getState();
      const p = s.players.find((p) => p.seat === s.currentPlayerSeat)!;
      expect(p).toBeDefined();
      expect(h.performAction(p.seat, s.currentBet > p.bet ? 'call' : 'check')).toBe(true);
    }
    expect(h.getState().stage).toBe('river');
    const internal = (h as any).state;
    internal.communityCards = cards(['Ah', 'Ad', '7c', '2d', '3s']);
    let longIndex = 0;
    for (let i = 0; i < stacks.length; i++)
      internal.players[i].cards = cards(
        stacks[i] === 3 * scale
          ? ['As', 'Ac']
          : stacks[i] === 7 * scale
            ? ['Kh', 'Kd']
            : longIndex++ === 0
              ? ['Qh', 'Qd']
              : ['Jh', 'Jd']
      );
    while (h.getState().stage === 'river' && actions++ < 24) {
      s = h.getState();
      expect(h.performAction(s.currentPlayerSeat, 'check')).toBe(true);
    }
    const finished = events.filter((e) => e.type === 'HAND_COMPLETE') as any[];
    expect(finished).toHaveLength(1);
    const result = h.getState();
    const winnerEvent = events.find((e) => e.type === 'WINNERS') as any;
    const awards = (uid: string) =>
      winnerEvent.winners
        .filter((w: any) => w.userId === uid)
        .reduce((n: number, w: any) => n + w.amount, 0);
    expect(awards(`u${stacks.indexOf(3 * scale) + 1}`)).toBe(12 * scale);
    expect(awards(`u${stacks.indexOf(7 * scale) + 1}`)).toBe(12 * scale);
    expect(awards(`u${stacks.indexOf(100 * scale) + 1}`)).toBe(10 * scale);
    expect(Math.round(result.players.reduce((n, p) => n + p.stack, 0) * 100)).toBe(
      Math.round(210 * scale * 100)
    );
    expect(events.filter((e) => e.type === 'UNCALLED_BET_RETURNED')).toHaveLength(0);
  });
});

describe('ante caps across contribution levels', () => {
  it.each([
    [1, 3, 5, 10, 20],
    [3, 7, 10, 100],
    [10, 10, 10, 10],
    [2, 4, 8, 16],
    [1, 1, 1, 1],
  ])('caps every player at the sum of matched contributions: %j', (...amounts: number[]) => {
    const players = amounts.map((amount, i) => ({
      seat: i + 1,
      user_id: `u${i + 1}`,
      username: `P${i + 1}`,
      stack: 0,
      bet: Math.max(0, amount - 10),
      totalInvested: amount,
      deadInvested: Math.min(10, amount),
      individualAnteInvested: Math.min(10, amount),
      cards: [],
      is_folded: false,
      is_all_in: true,
      is_sitting_out: false,
    })) as SeatPlayer[];
    const pots = calculatePots(players);
    expect(pots.reduce((n, p) => n + p.amount, 0)).toBe(amounts.reduce((a, b) => a + b, 0));
    for (let i = 0; i < amounts.length; i++) {
      const maximum = amounts.reduce(
        (n, contribution) => n + Math.min(contribution, amounts[i]),
        0
      );
      expect(
        pots
          .filter((p) => p.eligiblePlayers.includes(`u${i + 1}`))
          .reduce((n, p) => n + p.amount, 0)
      ).toBe(maximum);
    }
  });
  it.each(KNOWN_VARIANTS)('pays individual ante before short blinds in %s', (gameVariant) => {
    const h = new HandController(
      {
        tableId: 'ante-variant',
        handNumber: 1,
        gameVariant,
        smallBlind: 1,
        bigBlind: 2,
        ante: 10,
        bigBlindAnte: false,
        rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      } as HandConfig,
      [100, 3, 7, 100].map((stack, i) => ({
        seat: i + 1,
        user_id: `u${i + 1}`,
        username: `P${i + 1}`,
        stack,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      })) as SeatPlayer[],
      1
    );
    h.start();
    const s = h.getState();
    expect(s.players.map((p) => p.individualAnteInvested)).toEqual([10, 3, 7, 10]);
    expect(s.players[1].bet).toBe(0);
    expect(s.players[2].bet).toBe(0);
    expect(s.currentBet).toBe(2);
    expect(s.players.every((p) => p.stack >= 0)).toBe(true);
    const { deck, ...serialized } = s;
    const restored = JSON.parse(JSON.stringify(serialized));
    expect(calculatePots(restored.players)).toEqual(calculatePots(s.players));
  });
});

it('heads-up skips a sitting-out old button before posting or announcing blinds', () => {
  const players = [
    { seat: 1, stack: 2.02 },
    { seat: 4, stack: 0.98 },
    { seat: 7, stack: 2.32 },
  ].map((p) => ({
    ...p,
    user_id: `u${p.seat}`,
    username: `P${p.seat}`,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: p.seat === 7,
  })) as SeatPlayer[];
  const h = new HandController(
    {
      tableId: 'ante-inactive-button',
      handNumber: 1,
      gameVariant: 'pineapple',
      smallBlind: 0.5,
      bigBlind: 1,
      ante: 0.2,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    } as HandConfig,
    players,
    7
  );
  let announced = 0;
  h.onEvent((e) => {
    if (e.type === 'HAND_START') announced = h.getState().dealerSeat;
  });
  h.start();
  const s = h.getState();
  const away = s.players.find((p) => p.seat === 7)!;
  expect(away.totalInvested).toBe(0);
  expect(away.stack).toBe(2.32);
  expect(away.cards).toHaveLength(0);
  expect(s.dealerSeat).toBe(1);
  expect(announced).toBe(1);
  expect(s.players.find((p) => p.seat === 1)!.bet).toBe(0.5);
  expect(s.players.find((p) => p.seat === 4)!.bet).toBe(0.78);
});

it('does not collect a stale queued dead blind from a sitting-out seat', () => {
  const players = [1, 2, 3, 4].map((seat) => ({
    seat,
    user_id: `u${seat}`,
    username: `P${seat}`,
    stack: 100,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: seat === 4,
  })) as SeatPlayer[];
  const h = new HandController(
    {
      tableId: 'inactive-dead-blind',
      handNumber: 1,
      gameVariant: 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      ante: 1,
      deadBlinds: [{ seat: 4 }],
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    } as HandConfig,
    players,
    1
  );
  h.start();
  const away = h.getState().players.find((p) => p.seat === 4)!;
  expect(away.totalInvested).toBe(0);
  expect(away.stack).toBe(100);
  expect(away.cards).toHaveLength(0);
  expect(calculatePots(h.getState().players).every((p) => !p.eligiblePlayers.includes('u4'))).toBe(
    true
  );
});

it('ante-only all-ins exclude an undealt sitting-out seat from every pot', () => {
  const players = [1, 2, 3].map((seat) => ({
    seat,
    user_id: `u${seat}`,
    username: `P${seat}`,
    stack: seat === 3 ? 5 : 0.01,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: seat === 3,
  })) as SeatPlayer[];
  const h = new HandController(
    {
      tableId: 'ante-only-eligibility',
      handNumber: 1,
      gameVariant: 'plo8',
      smallBlind: 0.01,
      bigBlind: 0.02,
      ante: 0.01,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    } as HandConfig,
    players,
    1
  );
  h.start();
  expect(calculatePots(h.getState().players)).toEqual([
    { amount: 0.02, eligiblePlayers: ['u1', 'u2'] },
  ]);
});

/**
 * NATURAL-EVIDENCE F1 (2026-10-03): UNCALLED MONEY BEHIND AN ANTE-ONLY ALL-IN.
 *
 * Hand 0e68afa3 (natural-evidence hash bad804ab1731), PLO6 run three times,
 * heads-up, 2026-09-30: the BB posted 2.00 plus a 1.00 individual ante and the
 * button was all-in for a 0.70 ante. Production kept the BB's uncalled 2.30 as
 * a one-player pot and raked all 3.70 (0.19). Matched contribution is 3.00
 * against 0.70, so 2.30 was never called: it goes back to the BB before any
 * deduction, the only pot is 0.70 x 2 = 1.40, and heads-up rake is 5% of 1.40.
 * Every expected figure below is that arithmetic, not engine output.
 */
describe('uncalled money behind an ante-only all-in is returned before rake', () => {
  const rakeConfig = {
    percent: 10,
    cap: 5,
    noFlopNoDrop: true,
    playerCountCaps: [
      { players: 2, cap: 2.5 },
      { players: 3, cap: 5 },
      { players: 4, cap: 5 },
    ],
  };
  const seats = (stacks: Record<number, number>) =>
    Object.entries(stacks).map(([seat, stack]) => ({
      seat: Number(seat),
      user_id: `u${seat}`,
      username: `P${seat}`,
      stack,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    })) as SeatPlayer[];

  it('PLO6 heads-up, BB 2.00 + ante 1.00 against a 0.70 ante all-in, through the run-it settlement steps', () => {
    const events: HandEvent[] = [];
    const h = new HandController(
      {
        tableId: 'f1-uncalled-ante',
        handNumber: 1,
        gameVariant: 'plo6',
        smallBlind: 1,
        bigBlind: 2,
        ante: 1,
        bigBlindAnte: false,
        rakeConfig,
      } as HandConfig,
      seats({ 1: 100, 3: 0.7 }),
      3
    );
    h.onEvent((e) => events.push(e));
    h.start();
    const seat = (n: number) => h.getState().players.find((p) => p.seat === n)!;
    // The postings: 2.00 BB + 1.00 ante against a 0.70 ante all-in. Seat 1
    // already covers that all-in, so it is not asked to act (2026-10-06: this
    // used to pin a turn and a check here, with seat 1 showing 3.00 invested
    // until the check). The hand goes straight to the runout, the refund is
    // already made when start() returns, and the arithmetic below is
    // unchanged.
    expect(seat(3).totalInvested).toBe(0.7);
    expect(seat(3).is_all_in).toBe(true);
    expect(h.getState().currentPlayerSeat).toBe(-1);

    // 3.00 matched - 0.70 matched = 2.30, of which 2.00 is the live blind and
    // 0.30 the unmatched part of the BB's own ante.
    const refunds = events.filter(
      (e) => e.type === ('UNCALLED_BET_RETURNED' as never)
    ) as never as {
      seat: number;
      amount: number;
    }[];
    expect(refunds.map((r) => [r.seat, r.amount])).toEqual([[1, 2.3]]);
    expect(seat(1).stack).toBe(99.3);
    expect(seat(1).totalInvested).toBe(0.7);
    expect(seat(1).deadInvested).toBe(0.7);
    expect(seat(1).individualAnteInvested).toBe(0.7);
    expect(seat(1).returnedUncalled).toBe(2.3);
    expect(h.getState().pot).toBe(1.4);

    // ServerTableEngineRunout's own sequence for a run-it hand.
    h.markFlopSeen();
    expect(h.settleUncalledBet()).toBe(0);
    expect(h.computeLivePots()).toEqual([{ amount: 1.4, eligiblePlayers: ['u1', 'u3'] }]);
    expect(h.computeRakeAndBBJ()).toEqual({ rake: 0.07, bbjFee: 0 });
  });

  it('NLH heads-up single board: a full-ante all-in leaves the BB blind uncalled, never raked', () => {
    const events: HandEvent[] = [];
    const h = new HandController(
      {
        tableId: 'f1-uncalled-ante-single',
        handNumber: 1,
        gameVariant: 'nlh',
        smallBlind: 1,
        bigBlind: 2,
        ante: 1,
        bigBlindAnte: false,
        rakeConfig,
      } as HandConfig,
      seats({ 1: 100, 2: 1 }),
      2
    );
    h.onEvent((e) => events.push(e));
    h.start();
    expect(h.getState().players.find((p) => p.seat === 2)!.is_all_in).toBe(true);
    // Seat 1 covers the all-in ante and is not asked to act (2026-10-06).
    expect(events.some((e) => e.type === 'ALL_IN_RUNOUT')).toBe(true);
    const internal = (h as any).state;
    internal.players.find((p: SeatPlayer) => p.seat === 1).cards = cards(['7c', '2d']);
    internal.players.find((p: SeatPlayer) => p.seat === 2).cards = cards(['As', 'Ac']);
    // The runout's board, fixed so the winner is known. Dealing it is what
    // marks the flop seen, so the fixture marks it with the board.
    internal.communityCards = cards(['Kh', 'Qd', '9c', '5s', '3h']);
    internal.sawFlop = true;
    h.continueRunout();

    // Matched 3.00 v 1.00: 2.00 returned. Pot 1.00 x 2 = 2.00, 5% heads-up
    // rake = 0.10, the button's aces collect 1.90.
    const complete = events.find((e) => e.type === 'HAND_COMPLETE') as any;
    expect(complete.rake).toBe(0.1);
    expect(complete.bbjFee).toBe(0);
    const refunds = events.filter(
      (e) => e.type === ('UNCALLED_BET_RETURNED' as never)
    ) as never as {
      seat: number;
      amount: number;
    }[];
    expect(refunds.map((r) => [r.seat, r.amount])).toEqual([[1, 2]]);
    const winners = (events.find((e) => e.type === 'WINNERS') as any).winners;
    expect(winners.map((w: any) => [w.userId, w.amount])).toEqual([['u2', 1.9]]);
    const final = h.getState().players;
    expect(final.find((p) => p.seat === 1)!.stack).toBe(99);
    expect(final.find((p) => p.seat === 2)!.stack).toBe(1.9);
  });
});
