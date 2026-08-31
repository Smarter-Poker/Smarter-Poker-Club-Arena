/**
 * V12.1 ANTI-EXPLOIT PAIR PERSISTENCE — unit coverage for the pure halves.
 * The DB round-trip itself is covered in production by the GREATEST-merge RPC
 * (migration 20260822235000); here we pin the engine-side contract:
 * pair dirty tracking, export/requeue semantics, never-downgrade imports, and
 * that a hydrated hunter profile immediately drives targetingOf().
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HorseMind } from '../engine/HorseMind.js';
import type { ActionRecord } from '../types.js';

const act = (
  userId: string,
  action: string,
  amount: number,
  ts: number,
  stage = 'preflop'
): ActionRecord =>
  ({ seat: userId === 'hero' ? 2 : 5, userId, action, amount, timestamp: ts, stage }) as never;

/** One hand where hero opens and the hunter 3-bets (hero folds). */
const huntedHand = (ts: number): ActionRecord[] => [
  act('hero', 'raise', 6, ts),
  act('hunter', 'raise', 20, ts + 1),
  act('hero', 'fold', 0, ts + 2),
];

describe('HorseMind V12.1 - pair persistence contract', () => {
  beforeEach(() => HorseMind.reset());

  it('marks mutated pairs dirty and exportDirtyPairs drains the set', () => {
    HorseMind.observe(huntedHand(1000), []);
    expect(HorseMind.dirtyPairsCount()).toBe(1);
    const rows = HorseMind.exportDirtyPairs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      attacker_id: 'hunter',
      victim_id: 'hero',
      n3: 1,
      opp3: 1,
      nR: 0,
      oppR: 0,
    });
    expect(HorseMind.dirtyPairsCount()).toBe(0);
  });

  it('re-observing the same history does not re-dirty (idempotent observe)', () => {
    const h = huntedHand(2000);
    HorseMind.observe(h, []);
    HorseMind.exportDirtyPairs();
    HorseMind.observe(h, []); // exact same records — deduped by seenActions
    expect(HorseMind.dirtyPairsCount()).toBe(0);
  });

  it('requeueDirtyPairs puts failed rows back for the next flush', () => {
    HorseMind.observe(huntedHand(3000), []);
    const rows = HorseMind.exportDirtyPairs();
    expect(HorseMind.dirtyPairsCount()).toBe(0);
    HorseMind.requeueDirtyPairs(rows);
    expect(HorseMind.dirtyPairsCount()).toBe(1);
  });

  it('importPairs applies rows and never downgrades richer live memory', () => {
    const applied = HorseMind.importPairs([
      { attacker_id: 'hunter', victim_id: 'hero', n3: 9, opp3: 12, nR: 4, oppR: 8 },
    ]);
    expect(applied).toBe(1);
    expect(HorseMind.getPair('hunter', 'hero')).toEqual({ n3: 9, opp3: 12, nR: 4, oppR: 8 });

    // A second import that has seen LESS must be ignored...
    expect(
      HorseMind.importPairs([
        { attacker_id: 'hunter', victim_id: 'hero', n3: 1, opp3: 2, nR: 0, oppR: 1 },
      ])
    ).toBe(0);
    expect(HorseMind.getPair('hunter', 'hero')?.n3).toBe(9);
    // ...and one that has seen more wins.
    expect(
      HorseMind.importPairs([
        { attacker_id: 'hunter', victim_id: 'hero', n3: 11, opp3: 15, nR: 5, oppR: 9 },
      ])
    ).toBe(1);
    expect(HorseMind.getPair('hunter', 'hero')?.opp3).toBe(15);
  });

  it('a hydrated hunter profile immediately drives targetingOf', () => {
    // Straight from the DB: 8-for-8 3-betting this horse's opens. No live
    // observation has happened this process — the memory must still bite.
    HorseMind.importPairs([
      { attacker_id: 'hunter', victim_id: 'hero', n3: 8, opp3: 8, nR: 0, oppR: 0 },
    ]);
    expect(HorseMind.targetingOf('hero', 'hunter')).toBeGreaterThan(0.3);
  });

  it('live observation on top of a hydrated pair keeps counting', () => {
    HorseMind.importPairs([
      { attacker_id: 'hunter', victim_id: 'hero', n3: 5, opp3: 6, nR: 0, oppR: 0 },
    ]);
    HorseMind.observe(huntedHand(4000), []);
    expect(HorseMind.getPair('hunter', 'hero')).toEqual({ n3: 6, opp3: 7, nR: 0, oppR: 0 });
    // the live mutation re-dirtied the pair for the next flush
    expect(HorseMind.dirtyPairsCount()).toBe(1);
  });

  it('rejects malformed rows without throwing', () => {
    expect(
      HorseMind.importPairs([
        { attacker_id: '', victim_id: 'x' } as never,
        null as never,
        { attacker_id: 'a', victim_id: 'b', n3: Number.NaN, opp3: -5, nR: 2.7, oppR: 3 },
      ])
    ).toBe(1);
    expect(HorseMind.getPair('a', 'b')).toEqual({ n3: 0, opp3: 0, nR: 2, oppR: 3 });
  });

  it('reset clears the pair dirty set', () => {
    HorseMind.observe(huntedHand(5000), []);
    expect(HorseMind.dirtyPairsCount()).toBe(1);
    HorseMind.reset();
    expect(HorseMind.dirtyPairsCount()).toBe(0);
    expect(HorseMind.exportDirtyPairs()).toHaveLength(0);
  });
});
