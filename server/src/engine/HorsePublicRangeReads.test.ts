import { describe, it, expect } from 'vitest';
import { HandController } from './HandController.js';
import { HorseMind } from './HorseMind.js';
import f from './fixtures/horse-plo5-small-flush-45855223.json';
import type { ActionRecord, SeatPlayer, HandConfig } from '../types.js';
import type { OppPostflopRead } from './HorseEval.js';
function read(hist: unknown[], userId: string) {
  HorseMind.reset();
  const out: OppPostflopRead = { aggrW: 0, checked: 0 };
  const band = HorseMind.bandFor(userId, hist as ActionRecord[], 2, true, null, out);
  return { band, ...out };
}
const act = (userId: string, action: string, amount: number, stage = 'flop', extra = {}) => ({
  seat: userId === 'a' ? 1 : 2,
  userId,
  action,
  amount,
  stage,
  timestamp: 0,
  ...extra,
});
const pre = [act('a', 'raise', 6, 'preflop'), act('b', 'call', 6, 'preflop')];
describe('public mixed-amount controller range reads', () => {
  it('recognizes actual Woo short raise without full-reopening flag', () => {
    const uid = f.actions[20].userId;
    expect(read(f.actions.slice(0, 20), uid).streets).toBe(0);
    const out = read(f.actions.slice(0, 21), uid);
    expect(out.streets).toBe(1);
    expect(out.raised).toBe(true);
    expect(out.lastFrac).toBeCloseTo(181.75 / 428);
  });
  it('does not cap actual Cole prior check-call streets', () => {
    expect(read(f.actions.slice(0, 21), f.actions[21].userId).checked).toBe(1);
  });
  it.each([37, 32])('replays a real call then all-in street target from a %s stack', (stack) => {
    const config: HandConfig = {
      tableId: 'mixed-abi',
      handNumber: 1,
      gameVariant: 'nlh',
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
    for (const seat of [1, 2]) expect(controller.performAction(seat, 'call')).toBe(true);
    expect(controller.performAction(3, 'check')).toBe(true);
    expect(controller.performAction(2, 'check')).toBe(true);
    expect(controller.performAction(3, 'bet', 10)).toBe(true);
    expect(controller.performAction(1, 'call')).toBe(true);
    expect(controller.performAction(2, 'raise', 30)).toBe(true);
    expect(controller.performAction(3, 'call')).toBe(true);
    expect(controller.performAction(1, 'all_in')).toBe(true);
    const state = controller.getState(),
      last = state.actionHistory.at(-1)!;
    expect(last).toMatchObject({ action: 'all_in', amount: stack - 2 });
    expect(last.isFullRaise).toBe(stack === 37 ? false : undefined);
    expect(last.publicNode).toMatchObject({ status: 'captured', pot: 76, currentBet: 30 });
    const out = read(state.actionHistory, 'u1');
    if (stack === 37) {
      expect(out.raised).toBe(true);
      expect(out.streets).toBe(1);
      expect(out.lastFrac).toBeCloseTo(25 / 76);
    } else expect(out.streets).toBe(0);
    expect(out.checked).toBe(0);
    const money = HorseMind.initialPublicMoney(state.players, state.actionHistory, state.pot)!;
    expect(money.pot).toBe(3);
  });
  it('counts explicit dead ante in pot but not live price and counts blinds once', () => {
    const h = [
      act('a', 'sb', 1, 'preflop', { dead: false }),
      act('b', 'bb', 2, 'preflop', { dead: false }),
      act('b', 'ante', 2, 'preflop', { dead: true }),
      act('a', 'raise', 5, 'preflop'),
      act('b', 'call', 3, 'preflop'),
      act('a', 'bet', 12),
    ];
    expect(read(h, 'a').lastFrac).toBeCloseTo(1); // initial5 + raise-to5 adds4 + call3 =12
  });
  it('keeps true checked-through streets and resets price on a new street', () => {
    const h = [
      ...pre,
      act('a', 'check', 0),
      act('b', 'check', 0),
      act('a', 'all_in', 20, 'turn', { isFullRaise: false }),
    ];
    const out = read(h, 'a');
    expect(out.streets).toBe(1);
    expect(out.raised).toBe(false);
    expect(out.checked).toBe(1);
  });
});
it('accepts the exact live forced-money snapshot when controller history omits posting events', () => {
  HorseMind.reset();
  const out: OppPostflopRead = { aggrW: 0, checked: 0 };
  const h = [act('a', 'raise', 5, 'preflop'), act('b', 'call', 3, 'preflop'), act('a', 'bet', 12)];
  HorseMind.bandFor('a', h as ActionRecord[], 2, true, null, out, {
    pot: 5,
    streetBets: [
      ['a', 1],
      ['b', 2],
    ],
  });
  expect(out.lastFrac).toBeCloseTo(1);
});
