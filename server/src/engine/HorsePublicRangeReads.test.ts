import { describe, it, expect } from 'vitest';
import { HorseMind } from './HorseMind.js';
import f from './fixtures/horse-plo5-small-flush-45855223.json';
import type { ActionRecord } from '../types.js';
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
describe('public paid-delta range reads', () => {
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
  it('uses paid call plus shortjam and rejects pure allincall', () => {
    const h = [
      ...pre,
      act('a', 'bet', 160),
      act('b', 'call', 160),
      act('a', 'raise', 20),
      act('b', 'all_in', 21.75, 'flop', { isFullRaise: false }),
    ];
    expect(read(h, 'b').raised).toBe(true);
    expect(read(h, 'b').streets).toBe(1);
    expect(
      read(
        [...pre, act('a', 'bet', 160), act('b', 'all_in', 160, 'flop', { isFullRaise: false })],
        'b'
      ).streets
    ).toBe(0);
  });
  it('counts explicit dead ante in pot but not live price and counts blinds once', () => {
    const h = [
      act('a', 'sb', 1, 'preflop', { dead: false }),
      act('b', 'bb', 2, 'preflop', { dead: false }),
      act('b', 'ante', 2, 'preflop', { dead: true }),
      act('a', 'raise', 5, 'preflop'),
      act('b', 'call', 4, 'preflop'),
      act('a', 'bet', 14),
    ];
    expect(read(h, 'a').lastFrac).toBeCloseTo(1); // preflop pot14, paid flopbet14
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
  const h = [act('a', 'raise', 5, 'preflop'), act('b', 'call', 4, 'preflop'), act('a', 'bet', 14)];
  HorseMind.bandFor('a', h as ActionRecord[], 2, true, null, out, {
    pot: 5,
    streetBets: [
      ['a', 1],
      ['b', 2],
    ],
  });
  expect(out.lastFrac).toBeCloseTo(1);
});
