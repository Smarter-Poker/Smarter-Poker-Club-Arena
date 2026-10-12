/**
 * THE MATCHER SIMULATOR, SMOKE (Lightning Phase 11). CI runs only this small
 * run (2,000 hands); the 10k / 100k tables in the changelog come from the
 * CLI (src/scripts/lightningMatcherSim.ts), never from CI.
 */
import { describe, expect, it } from 'vitest';
import {
  formatLightningSimTable,
  runLightningMatcherSim,
  seededRandom,
} from './LightningMatcherSim.js';
import { parseSimArgs } from '../scripts/lightningMatcherSim.js';

describe('the Lightning matcher simulator', () => {
  it('drives both matcher versions over 2,000 hands and reports every measure', () => {
    for (const version of ['m1', 'm2']) {
      const r = runLightningMatcherSim({ players: 25, hands: 2_000, seed: 7, version });
      expect(r.version).toBe(version);
      expect(r.hands).toBe(2_000);
      expect(r.hands_per_hour).toBeGreaterThan(0);
      expect(r.wait_ms.p50).not.toBeNull();
      expect(r.wait_ms.p99!).toBeGreaterThanOrEqual(r.wait_ms.p95!);
      expect(r.wait_ms.p95!).toBeGreaterThanOrEqual(r.wait_ms.p50!);
      expect(r.max_bb_gap).not.toBeNull();
      expect(r.bb_gap_std_dev).not.toBeNull();
      const shares = Object.values(r.position_distribution).reduce((s, x) => s + x, 0);
      expect(shares).toBeCloseTo(1, 2);
      expect(r.instance_utilization!).toBeGreaterThan(0);
      expect(r.instance_utilization!).toBeLessThanOrEqual(1);
      expect(r.repeat_opponent_rate!).toBeGreaterThanOrEqual(0);
      expect(r.repeat_group_rate!).toBeGreaterThanOrEqual(0);
      // Every hand has exactly one big blind.
      expect(r.position_distribution.bb * r.avg_instance_size! * r.hands).toBeCloseTo(r.hands, -1);
    }
  });

  it('is deterministic per seed, and a different seed differs', () => {
    const a = runLightningMatcherSim({ players: 10, hands: 500, seed: 3 });
    const b = runLightningMatcherSim({ players: 10, hands: 500, seed: 3 });
    const c = runLightningMatcherSim({ players: 10, hands: 500, seed: 4 });
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
    expect(seededRandom(1)()).toBe(seededRandom(1)());
  });

  it('refuses a version it does not model, and prints a table', () => {
    expect(() => runLightningMatcherSim({ version: 'm9', hands: 10 })).toThrow(/unknown matcher/);
    const table = formatLightningSimTable([runLightningMatcherSim({ players: 10, hands: 100 })]);
    expect(table.split('\n')[0]).toMatch(/Hands\/Hour/);
    expect(table.split('\n')).toHaveLength(3);
  });

  it('parses the command line', () => {
    const a = parseSimArgs([
      '--players',
      '10,25',
      '--hands',
      '500',
      '--versions',
      'm1',
      '--fold-rate',
      '0.5',
      '--first-entry-rule',
      'big_blind',
    ]);
    expect(a.players).toEqual([10, 25]);
    expect(a.versions).toEqual(['m1']);
    expect(a.options).toEqual({ hands: 500, foldRate: 0.5, firstEntryRule: 'big_blind' });
    expect(() => parseSimArgs(['--nonsense', '1'])).toThrow(/unknown flag/);
  });
});
