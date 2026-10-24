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
    // Every player here has been the big blind before: this file is about
    // group sizes, not the first-entry rule (a never-BB slot is a newcomer,
    // held until it is a big blind; ANewPlayersFirstLightningHandIsTheBigBlind).
    lastBbAtMs: 0,
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

describe('Lightning deals six immediately or five after three seconds from the fifth arrival', () => {
  it.each([0, 1, 2, 3, 4])('never forms a %i-player hand, regardless of queue age', (n) => {
    expect(plan(players(n), 1_000_000, 6).groups).toHaveLength(0);
  });
  it('holds five until the exact deadline, then forms five', () => {
    expect(plan(players(5), 12_999, 6).groups).toHaveLength(0);
    expect(plan(players(5), 13_000, 6).groups.map((g) => g.players.length)).toEqual([5]);
  });
  it('deals six immediately and leaves a fresh five waiting', () => {
    expect(plan(players(6), 10_000, 6).groups.map((g) => g.players.length)).toEqual([6]);
    expect(plan(players(11), 10_000, 6).groups.map((g) => g.players.length)).toEqual([6]);
    expect(plan(players(11), 13_000, 6).groups.map((g) => g.players.length)).toEqual([6, 5]);
  });
  it('starts the wait at the fifth ready player, never at the oldest arrival', () => {
    const p = players(5);
    p[0].idleSinceMs = 0;
    p[4].idleSinceMs = 20_000;
    const before = structuredClone(p);
    expect(plan(p, 22_999, 6).groups).toHaveLength(0);
    expect(plan(p, 23_000, 6).groups.map((g) => g.players.length)).toEqual([5]);
    expect(p).toEqual(before);
  });
  it.each(['m1', 'm1-port', 'm2'])(
    'keeps every matcher version within five or six, independently of legacy size configuration: %s',
    (version) => {
      for (let n = 0; n <= 35; n++) {
        const p = players(n);
        const before = structuredClone(p);
        const model = lightningMatcherModel(version)!;
        const snapshot = { nowMs: 13_000, players: p, recentHands: [] };
        const result = model.plan(snapshot, {
          ...LIGHTNING_MATCHER_PARAM_DEFAULTS,
          instanceMin: 2,
          instanceTarget: 9,
          instanceMax: 9,
        });
        const sizes = result.groups.map((g) => g.players.length);
        expect(sizes).toEqual([...Array(Math.floor(n / 6)).fill(6), ...(n % 6 === 5 ? [5] : [])]);
        const seated = result.groups.flatMap((g) => g.players);
        expect(new Set(seated).size).toBe(seated.length);
        expect(p).toEqual(before);
      }
    }
  );
  it('holds a replacement fifth player for their own three-second wait', () => {
    const p = players(5, 0);
    expect(plan(p, 10_000, 6).groups).toHaveLength(1);
    p[4] = { ...p[4], playerId: 'replacement', idleSinceMs: 10_000 };
    expect(plan(p, 12_999, 6).groups).toHaveLength(0);
    expect(plan(p, 13_000, 6).groups.map((g) => g.players.length)).toEqual([5]);
  });
  it('does not reset an aged five-player group for a fresh player assigned to the full six', () => {
    const p = players(11, 0);
    p[0].idleSinceMs = 10_000;
    const groups = plan(p, 10_000, 6).groups;
    expect(groups.map((g) => g.players.length)).toEqual([6, 5]);
    expect(groups[0].players).toContain(p[0].playerId);
    expect(groups[1].players).not.toContain(p[0].playerId);
  });
  it('counts only legal players toward the minimum and the wait', () => {
    const p = players(6);
    p[0].legal = false;
    p[0].idleSinceMs = 100_000;
    expect(plan(p, 13_000, 6).groups.map((g) => g.players.length)).toEqual([5]);
    p[1].legal = false;
    expect(plan(p, 1_000_000, 6).groups).toHaveLength(0);
  });
});
