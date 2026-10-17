/**
 * THE VPIP FLOOR CALL-DOWN (2026-10-17). See vpipFloorCallDown in HorseLogic:
 * widening alone left floor-50 sittings at ~38% VPIP and every one of them
 * evicted, because a horse under its floor still folded to small prices. A
 * horse below its target now calls a small price instead of folding, more
 * often the further under it is. Everything outside that one case is
 * returned untouched.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  VPIP_CALLDOWN_MAX_BB,
  VPIP_CALLDOWN_MAX_STACK_SHARE,
  vpipFloorCallDown,
  vpipTargetFor,
} from './HorseLogic.js';
import type { HorseDecision } from '../types.js';

const fold: HorseDecision = { action: 'fold', thinkTime: 0 };
const player = { bet: 0, stack: 8 };
const table = (over: Record<string, unknown> = {}) => ({
  stage: 'preflop',
  currentBet: 0.08,
  bigBlind: 0.04,
  vpipFloor: 50,
  ownVpip: { hands: 12, vpip: 40 },
  ...over,
});
const always = () => 0;
const never = () => 0.999999;

describe('vpipFloorCallDown', () => {
  it('a horse under its target calls a small price it was about to fold', () => {
    expect(vpipFloorCallDown(fold, player, table(), always)).toEqual({
      action: 'call',
      amount: 0.08,
      thinkTime: 0,
    });
  });

  it('calls only the price still owed, rounded to the cent', () => {
    const out = vpipFloorCallDown(
      fold,
      { bet: 0.04, stack: 8 },
      table({ currentBet: 0.12 }),
      always
    );
    expect(out).toMatchObject({ action: 'call', amount: 0.08 });
  });

  it('leaves the fold on a table with no floor, or with a floor it has already cleared', () => {
    expect(vpipFloorCallDown(fold, player, table({ vpipFloor: 0 }), always)).toBe(fold);
    expect(vpipFloorCallDown(fold, player, table({ vpipFloor: undefined }), always)).toBe(fold);
    const over = Math.ceil(100 * vpipTargetFor(50));
    expect(
      vpipFloorCallDown(fold, player, table({ ownVpip: { hands: 20, vpip: over } }), always)
    ).toBe(fold);
  });

  it('never pays an expensive price', () => {
    const bb = 0.04;
    const priceOver = (VPIP_CALLDOWN_MAX_BB + 1) * bb;
    expect(vpipFloorCallDown(fold, player, table({ currentBet: priceOver }), always)).toBe(fold);
    // And never a large share of a short stack.
    const short = { bet: 0, stack: 0.08 / VPIP_CALLDOWN_MAX_STACK_SHARE - 0.04 };
    expect(vpipFloorCallDown(fold, short, table(), always)).toBe(fold);
    // Or a price that is the whole stack (that is an all-in, not a call-down).
    expect(vpipFloorCallDown(fold, { bet: 0, stack: 0.08 }, table(), always)).toBe(fold);
  });

  it('touches only a preflop fold for a price', () => {
    const check: HorseDecision = { action: 'check', thinkTime: 0 };
    const raise: HorseDecision = { action: 'raise', amount: 0.2, thinkTime: 0 };
    expect(vpipFloorCallDown(check, player, table(), always)).toBe(check);
    expect(vpipFloorCallDown(raise, player, table(), always)).toBe(raise);
    expect(vpipFloorCallDown(fold, player, table({ currentBet: 0 }), always)).toBe(fold);
    expect(vpipFloorCallDown(fold, player, table({ stage: 'flop' }), always)).toBe(fold);
    expect(vpipFloorCallDown(fold, player, table({ allInOrFold: true }), always)).toBe(fold);
  });

  it('is a probability that grows with the gap, and is certain far under it', () => {
    // 40% against a target of ~70.6%: the gap is large, the call is certain.
    expect(vpipFloorCallDown(fold, player, table(), never).action).toBe('call');
    // Just under target: a coin most horses do not take.
    const near = Math.floor(100 * vpipTargetFor(50)) - 1;
    const nearTable = table({ ownVpip: { hands: 20, vpip: near } });
    expect(vpipFloorCallDown(fold, player, nearTable, never)).toBe(fold);
    expect(vpipFloorCallDown(fold, player, nearTable, always).action).toBe('call');
  });

  it('with no sample yet, a floored horse starts under target', () => {
    expect(
      vpipFloorCallDown(fold, player, table({ ownVpip: { hands: 0, vpip: null } }), never).action
    ).toBe('call');
    expect(vpipFloorCallDown(fold, player, table({ ownVpip: undefined }), never).action).toBe(
      'call'
    );
  });

  it('runs inside the reference node, so the policy graph sees it as the reference choice', () => {
    const src = readFileSync(resolve(__dirname, 'HorseLogic.ts'), 'utf8');
    const start = src.indexOf("graph.run('reference', null");
    const end = src.indexOf("graph.run('reference_legality'");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).toMatch(
      /decision = vpipFloorCallDown\(decision, player, gs, fastRandom\);/
    );
  });
});
