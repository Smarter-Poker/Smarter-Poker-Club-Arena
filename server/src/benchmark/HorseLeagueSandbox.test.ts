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
import { seedFastRandom, fastRandom } from '../engine/HorseEval.js';
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

describe('HorseMind V12.2 - sandbox isolation', () => {
  it('runInSandbox reads and writes only the sandbox state', async () => {
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

  it('restores live state even when the callback throws', async () => {
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

  it('refuses nesting rather than mixing two sandboxes', async () => {
    const sb = HorseMind.createSandbox();
    expect(() =>
      HorseMind.runInSandbox(sb, () => HorseMind.runInSandbox(HorseMind.createSandbox(), () => 0))
    ).toThrow(/already inside/);
  });
});

describe('HorseLeague V12.2 - sandbox-mode simulator integrity', () => {
  it('a sandboxed matchup leaves live HorseMind completely untouched', async () => {
    HorseMind.observe(liveHand(500), []);
    const liveDirty = HorseMind.dirtyCount();
    const liveDirtyPairs = HorseMind.dirtyPairsCount();

    const r = await runMatchup({ name: 't', a: {}, b: { v12: false }, mind: 'sandbox' }, 40, 42);
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

  it('conserves chips with the mind on (side pots included)', async () => {
    const sb = HorseMind.createSandbox();
    for (let h = 0; h < 120; h++) {
      const net = playHand(2000 + h * 7919, (h % 6) + 1, () => ({}), undefined, sb);
      const sum = net.reduce((a, b) => a + b, 0);
      expect(Math.abs(sum), `hand ${h} leaked ${sum} chips`).toBeLessThan(1e-6);
    }
  });

  it('produces zero illegal actions across a sandboxed matchup', async () => {
    const r = await runMatchup({ name: 't', a: {}, b: { mind: false }, mind: 'sandbox' }, 60, 7);
    expect(r.illegalActions).toBe(0);
    expect(Number.isFinite(r.bb100)).toBe(true);
  });

  it('is deterministic for a given seed (fresh sandboxes per run)', async () => {
    const r1 = await runMatchup({ name: 't', a: {}, b: { v12: false }, mind: 'sandbox' }, 30, 777);
    const r2 = await runMatchup({ name: 't', a: {}, b: { v12: false }, mind: 'sandbox' }, 30, 777);
    expect(r1.bb100).toBe(r2.bb100);
    expect(r1.stderr).toBe(r2.stderr);
  });

  it('self-play (identical configs) measures near zero with the mind on', async () => {
    // Each pass keeps its own sandbox, so identical configs evolve identical
    // memories and the duplicate seat swap kills any systematic edge.
    const r = await runMatchup({ name: 'mirror', a: {}, b: {}, mind: 'sandbox' }, 150, 1234);
    expect(Math.abs(r.bb100)).toBeLessThan(Math.max(30, 4 * r.stderr));
  });

  it('EVERY standing matchup is sandboxed, and the legacy ablation is complete', () => {
    // V12.3: sandboxing is no longer opt-in — running a league hand against
    // live HorseMind state was never safe (barrel plans are mind state and
    // ignore mind:false), so runMatchup always sandboxes. This test pins the
    // stronger property: the card cannot regrow an unsandboxed matchup,
    // because there is no such thing any more.
    const byName = new Map(LEAGUE_MATCHUPS.map((m) => [m.name, m]));
    expect(byName.get('v12_ranges_river')?.b).toEqual({ v12: false });
    expect(byName.get('mind_layer')?.b).toEqual({ mind: false });

    // The "vs v2 legacy" arm must disable EVERY strategy layer. It silently
    // kept v12 (and the mind) for a day, measuring the wrong thing under a
    // name that claimed otherwise. Any future layer that is not switched off
    // here fails this assertion instead of quietly drifting out.
    const legacy = byName.get('full_vs_v2_legacy')!.b as Record<string, unknown>;
    for (const flag of ['v7', 'v8', 'v9', 'v10', 'v11', 'v12', 'mind', 'streetIQ', 'handReading']) {
      expect(legacy[flag], `full_vs_v2_legacy must disable ${flag}`).toBe(false);
    }
  });

  it('a matchup leaves the shared strategy RNG exactly where it found it', async () => {
    // rngState in HorseEval is a module global shared with every live
    // decision, and playHand reseeds it once per synthetic hand. Without the
    // save/restore bracket, live horses draw from a stream fully determined
    // by the run date after every league run.
    seedFastRandom(0xfeed1234);
    const before = fastRandom();
    seedFastRandom(0xfeed1234);
    await runMatchup({ name: 't', a: {}, b: { v12: false } }, 12, 99);
    expect(fastRandom()).toBe(before);
  });

  it('never truncates a street, and never lets an unpaid bet reach showdown', async () => {
    const r = await runMatchup({ name: 't', a: {}, b: { v11: false } }, 80, 31);
    expect(r.truncatedStreets).toBe(0);
    expect(r.illegalActions).toBe(0);
  });

  it('validates sizings even when the caller passes no counters', () => {
    // Validation used to be gated on `counters` being present, so the
    // conservation tests ran a different code path from production. If the
    // gate ever comes back, a negative-increment raise would create chips and
    // this conservation check over the unmetered path would catch it.
    for (let h = 0; h < 60; h++) {
      const net = playHand(9000 + h * 104729, (h % 6) + 1, () => ({}));
      expect(Math.abs(net.reduce((a, b) => a + b, 0))).toBeLessThan(1e-6);
      for (const v of net) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('the two passes of a duplicate pair cannot share HorseMind keys', () => {
    // Both passes of a duplicate pair replay the SAME deal seed. The synthetic
    // action timestamp used to be derived from that seed, so both passes
    // produced identical hand keys AND identical action keys: pass 2's actions
    // were deduped away as "already seen", and config B read config A's barrel
    // plan — destroying the independence the duplicate design exists to give.
    // seenActions is the sharpest probe: it dedupes on timestamp+user+action,
    // so it only grows on the second pass if the timestamps really differ.
    const sb = HorseMind.createSandbox();
    playHand(555, 1, () => ({}), undefined, sb);
    const afterFirst = sb.seenActions.size;
    expect(afterFirst).toBeGreaterThan(0);
    playHand(555, 1, () => ({}), undefined, sb);
    expect(sb.seenActions.size).toBeGreaterThan(afterFirst);
  });
});
