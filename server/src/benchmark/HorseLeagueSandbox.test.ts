/**
 * V12.2 SANDBOXED MIND — the league can finally measure the mind layer.
 * Pins the properties that make sandbox-mode numbers trustworthy AND safe:
 * total isolation from live HorseMind state (in both directions, even on a
 * throw), unchanged simulator integrity (chip conservation, zero illegal
 * actions, determinism, mirror symmetry) with the mind switched on, and the
 * standing matchup card actually carrying the sandbox matchups.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { playHand, runMatchup, LEAGUE_MATCHUPS } from './HorseLeague.js';
import { HorseMind } from '../engine/HorseMind.js';
import type { ActionRecord } from '../types.js';

beforeEach(() => HorseMind.reset());

const liveHand = (ts: number): ActionRecord[] =>
  [
    { seat: 2, userId: 'real-player', action: 'raise', amount: 6, timestamp: ts, stage: 'preflop' },
    {
      seat: 5,
      userId: 'real-victim',
      action: 'fold',
      amount: 0,
      timestamp: ts + 1,
      stage: 'preflop',
    },
  ] as never;

describe('HorseMind V12.2 — sandbox isolation', () => {
  it('runInSandbox reads and writes only the sandbox state', () => {
    HorseMind.observe(liveHand(100), []);
    expect(HorseMind.getStats('real-player')?.hands).toBe(1);
    const liveDirty = HorseMind.dirtyCount();

    const sb = HorseMind.createSandbox();
    HorseMind.runInSandbox(sb, () => {
      // The sandbox cannot see live memory...
      expect(HorseMind.getStats('real-player')).toBeUndefined();
      // ...and what it observes stays inside.
      HorseMind.observe(liveHand(200), []);
      expect(HorseMind.getStats('real-player')?.hands).toBe(1);
    });

    // Live state is byte-for-byte what it was: same stats, same dirty set.
    expect(HorseMind.getStats('real-player')?.hands).toBe(1);
    expect(HorseMind.dirtyCount()).toBe(liveDirty);
    // The sandbox kept its own copy.
    expect(sb.stats.get('real-player')?.hands).toBe(1);
  });

  it('restores live state even when the callback throws', () => {
    HorseMind.observe(liveHand(300), []);
    const sb = HorseMind.createSandbox();
    expect(() =>
      HorseMind.runInSandbox(sb, () => {
        HorseMind.observe(liveHand(400), []);
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(HorseMind.getStats('real-player')?.hands).toBe(1);
    // A second sandbox run works — the depth guard was reset.
    expect(HorseMind.runInSandbox(HorseMind.createSandbox(), () => 7)).toBe(7);
  });

  it('refuses nesting rather than mixing two sandboxes', () => {
    const sb = HorseMind.createSandbox();
    expect(() =>
      HorseMind.runInSandbox(sb, () => HorseMind.runInSandbox(HorseMind.createSandbox(), () => 0))
    ).toThrow(/already inside/);
  });
});

describe('HorseLeague V12.2 — sandbox-mode simulator integrity', () => {
  it('a sandboxed matchup leaves live HorseMind completely untouched', () => {
    HorseMind.observe(liveHand(500), []);
    const liveDirty = HorseMind.dirtyCount();
    const liveDirtyPairs = HorseMind.dirtyPairsCount();

    const r = runMatchup({ name: 't', a: {}, b: { v12: false }, mind: 'sandbox' }, 40, 42);
    expect(r.hands).toBe(80);

    // No synthetic league id ever reached live memory, in stats or pairs...
    for (let s = 1; s <= 6; s++) {
      expect(HorseMind.getStats(`league-${s}`)).toBeUndefined();
      for (let v = 1; v <= 6; v++) {
        if (v !== s) expect(HorseMind.getPair(`league-${s}`, `league-${v}`)).toBeUndefined();
      }
    }
    // ...and nothing was queued for the DB flush beyond what was already there.
    expect(HorseMind.dirtyCount()).toBe(liveDirty);
    expect(HorseMind.dirtyPairsCount()).toBe(liveDirtyPairs);
    expect(HorseMind.getStats('real-player')?.hands).toBe(1);
  });

  it('conserves chips with the mind on (side pots included)', () => {
    const sb = HorseMind.createSandbox();
    for (let h = 0; h < 120; h++) {
      const net = playHand(2000 + h * 7919, (h % 6) + 1, () => ({}), undefined, sb);
      const sum = net.reduce((a, b) => a + b, 0);
      expect(Math.abs(sum), `hand ${h} leaked ${sum} chips`).toBeLessThan(1e-6);
    }
  });

  it('produces zero illegal actions across a sandboxed matchup', () => {
    const r = runMatchup({ name: 't', a: {}, b: { mind: false }, mind: 'sandbox' }, 60, 7);
    expect(r.illegalActions).toBe(0);
    expect(Number.isFinite(r.bb100)).toBe(true);
  });

  it('is deterministic for a given seed (fresh sandboxes per run)', () => {
    const r1 = runMatchup({ name: 't', a: {}, b: { v12: false }, mind: 'sandbox' }, 30, 777);
    const r2 = runMatchup({ name: 't', a: {}, b: { v12: false }, mind: 'sandbox' }, 30, 777);
    expect(r1.bb100).toBe(r2.bb100);
    expect(r1.stderr).toBe(r2.stderr);
  });

  it('self-play (identical configs) measures near zero with the mind on', () => {
    // Each pass keeps its own sandbox, so identical configs evolve identical
    // memories and the duplicate seat swap kills any systematic edge.
    const r = runMatchup({ name: 'mirror', a: {}, b: {}, mind: 'sandbox' }, 150, 1234);
    expect(Math.abs(r.bb100)).toBeLessThan(Math.max(30, 4 * r.stderr));
  });

  it('the standing card carries both sandbox matchups', () => {
    const byName = new Map(LEAGUE_MATCHUPS.map((m) => [m.name, m]));
    expect(byName.get('v12_ranges_river')?.mind).toBe('sandbox');
    expect(byName.get('v12_ranges_river')?.b).toEqual({ v12: false });
    expect(byName.get('mind_layer')?.mind).toBe('sandbox');
    expect(byName.get('mind_layer')?.b).toEqual({ mind: false });
  });
});
