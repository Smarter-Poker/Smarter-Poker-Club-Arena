import { describe, expect, it } from 'vitest';
import {
  LIGHTNING_MATCHER_PARAM_DEFAULTS,
  lightningMatcherModel,
  type LightningPoolPlayer,
} from './LightningMatcherModel.js';

const players = (n: number, idle = 10_000): LightningPoolPlayer[] =>
  Array.from({ length: n }, (_, i) => ({
    playerId: `player-${String(i).padStart(2, '0')}`,
    legal: true,
    reasonCode: null,
    idleSinceMs: idle,
    enteredAtMs: 0,
    lastBbAtMs: null,
    bbUnresolved: false,
    debtSinceMs: 0,
    handsSinceBb: null,
    newcomer: false,
    positions: { btn: 0, co: 0, hj: 0, utg: 0 },
  }));
const plan = (population: LightningPoolPlayer[], now: number, size: number) =>
  lightningMatcherModel('m1')!.plan(
    { nowMs: now, players: population, recentHands: [] },
    { ...LIGHTNING_MATCHER_PARAM_DEFAULTS, instanceTarget: size, instanceMax: size }
  );

describe('Lightning waits at most three seconds for full rings', () => {
  it.each([6, 9])(
    'holds two freshly idle players in a %i-max pool until the exact deadline',
    (size) => {
      expect(plan(players(2), 12_999, size).groups).toHaveLength(0);
      expect(plan(players(2), 13_000, size).groups.map((g) => g.players.length)).toEqual([2]);
    }
  );
  it.each([6, 9])('deals a full %i-max ring immediately and holds the fresh remainder', (size) => {
    expect(plan(players(size + 2), 10_000, size).groups.map((g) => g.players.length)).toEqual([
      size,
    ]);
  });
  it('uses only legal players to decide whether the aging deadline has elapsed', () => {
    const p = players(3);
    p[0].legal = false;
    p[0].idleSinceMs = 0;
    expect(plan(p, 10_001, 6).groups).toHaveLength(0);
  });
  it('lets one aged legal player release a thin pool without resetting their queue age', () => {
    const p = players(4);
    p[0].idleSinceMs = 7_000;
    const before = structuredClone(p);
    expect(plan(p, 10_000, 6).groups.map((g) => g.players.length)).toEqual([4]);
    expect(p).toEqual(before);
  });
  it('does not form a one-player hand even after the deadline', () => {
    expect(plan(players(1), 30_000, 6).groups).toHaveLength(0);
  });
});
