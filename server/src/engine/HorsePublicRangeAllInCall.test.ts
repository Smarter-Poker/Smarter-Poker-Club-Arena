import { beforeEach, describe, expect, it } from 'vitest';
import { HandController } from './HandController.js';
import { HorseMind } from './HorseMind.js';
import { omahaAggressorTier, type OppPostflopRead } from './HorseEval.js';
import type { ActionRecord, HandConfig, SeatPlayer } from '../types.js';

const variants = ['nlh', 'plo4', 'plo5', 'plo6', 'plo8'] as const;

function read(history: ActionRecord[], userId: string): OppPostflopRead {
  const out: OppPostflopRead = { aggrW: 0, checked: 0 };
  expect(HorseMind.bandFor(userId, history, 2, true, null, out)).not.toBeNull();
  return out;
}

function controllerAllIn(variant: (typeof variants)[number], stack: number) {
  const config: HandConfig = {
    tableId: `public-range-all-in-${variant}`,
    handNumber: 1,
    gameVariant: variant,
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
  };
  const players = [1, 2, 3].map((seat) => ({
    seat,
    user_id: `u${seat}`,
    username: `Seat ${seat}`,
    stack: seat === 1 ? stack : 500,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  })) as SeatPlayer[];
  const controller = new HandController(config, players, 1);
  controller.start();
  expect(controller.performAction(1, 'raise', 6)).toBe(true);
  for (const seat of [2, 3]) expect(controller.performAction(seat, 'call')).toBe(true);
  expect(controller.performAction(2, 'check')).toBe(true);
  expect(controller.performAction(3, 'bet', 10)).toBe(true);
  expect(controller.performAction(1, 'call')).toBe(true);
  expect(controller.performAction(2, 'raise', 40)).toBe(true);
  expect(controller.performAction(3, 'call')).toBe(true);
  expect(controller.performAction(1, 'all_in')).toBe(true);
  return controller.getState().actionHistory;
}

beforeEach(() => HorseMind.reset());

describe.each(variants)('%s public all-in range semantics', (variant) => {
  it.each([45, 46])('does not call a capped all-in from stack %s a big bet', (stack) => {
    const history = controllerAllIn(variant, stack);
    const last = history.at(-1)!;
    expect(last).toMatchObject({ action: 'all_in', amount: stack - 6 });
    expect(last.publicNode).toMatchObject({ status: 'captured', currentBet: 40 });
    // Controller-bound and historical replay paths must agree.
    for (const records of [history, history.map(({ publicNode: _node, ...entry }) => entry)]) {
      const out = read(records, 'u1');
      expect(out.streets).toBe(0);
      expect(out.bigBet).not.toBe(true);
    }
  });

  it.each([51, 76])('retains an actual all-in raise from stack %s', (stack) => {
    const history = controllerAllIn(variant, stack);
    expect(history.at(-1)!.isFullRaise).toBe(stack === 76);
    const out = read(history, 'u1');
    expect(out.streets).toBe(1);
    expect(out.raised).toBe(true);
    expect(out.bigBet).toBe(true);
  });
});

const action = (
  userId: string,
  kind: ActionRecord['action'],
  amount: number,
  stage: ActionRecord['stage']
): ActionRecord => ({
  seat: userId === 'a' ? 1 : 2,
  userId,
  action: kind,
  amount,
  stage,
  timestamp: 0,
});
const pre = [action('a', 'raise', 50, 'preflop'), action('b', 'call', 50, 'preflop')];

it('does not strengthen an earlier ordinary aggressor when its newest action is an all-in call', () => {
  const history = [
    ...pre,
    action('a', 'bet', 10, 'flop'),
    action('b', 'call', 10, 'flop'),
    action('b', 'bet', 60, 'turn'),
    action('a', 'all_in', 40, 'turn'),
  ];
  const out = read(history, 'a');
  expect(out.streets).toBe(1);
  expect(out.lastFrac).toBeLessThan(0.7);
  expect(out.bigBet).not.toBe(true);
  expect(omahaAggressorTier(out)).toBe(1);
});

it('keeps a real opening all-in bet even without a full-raise flag', () => {
  const out = read([...pre, action('a', 'all_in', 40, 'flop')], 'a');
  expect(out.bigBet).toBe(true);
  expect(out.raised).toBe(false);
});

it('keeps the existing 20bb threshold and newest-street boundary', () => {
  expect(read([...pre, action('a', 'bet', 39.99, 'flop')], 'a').bigBet).not.toBe(true);
  expect(read([...pre, action('a', 'bet', 40, 'flop')], 'a').bigBet).toBe(true);
  expect(
    read(
      [
        ...pre,
        action('a', 'bet', 40, 'flop'),
        action('b', 'call', 40, 'flop'),
        action('a', 'check', 0, 'turn'),
      ],
      'a'
    ).bigBet
  ).not.toBe(true);
});
