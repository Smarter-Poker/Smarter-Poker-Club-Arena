/**
 * V12 HORSE MEMORY PERSISTENCE — unit coverage for the pure halves.
 * The DB round-trip itself is covered in production by the GREATEST-merge RPC
 * (migration 20260822210000); here we pin the engine-side contract:
 * dirty tracking, export/requeue semantics, and never-downgrade imports.
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
  ({ seat: 1, userId, action, amount, timestamp: ts, stage }) as unknown as ActionRecord;

describe('HorseMind V12 - persistence contract', () => {
  beforeEach(() => HorseMind.reset());

  it('marks observed players dirty and exportDirty drains the set', () => {
    HorseMind.observe([act('p1', 'raise', 6, 1), act('p2', 'call', 6, 2)], []);
    expect(HorseMind.dirtyCount()).toBe(2);
    const rows = HorseMind.exportDirty();
    expect(rows.map((r) => r.user_id).sort()).toEqual(['p1', 'p2']);
    expect(HorseMind.dirtyCount()).toBe(0);
    // exported rows carry the real counters
    const p1 = rows.find((r) => r.user_id === 'p1')!;
    expect(p1.hands).toBe(1);
    expect(p1.pfr).toBe(1);
  });

  it('re-observing the same history does not re-dirty (idempotent observe)', () => {
    const h = [act('p1', 'raise', 6, 1)];
    HorseMind.observe(h, []);
    HorseMind.exportDirty();
    HorseMind.observe(h, []); // exact same records — deduped by seenActions
    expect(HorseMind.dirtyCount()).toBe(0);
  });

  it('requeueDirty puts failed rows back for the next flush', () => {
    HorseMind.observe([act('p1', 'raise', 6, 1)], []);
    const rows = HorseMind.exportDirty();
    expect(HorseMind.dirtyCount()).toBe(0);
    HorseMind.requeueDirty(rows.map((r) => r.user_id));
    expect(HorseMind.dirtyCount()).toBe(1);
  });

  it('importStats applies rows and never downgrades richer live memory', () => {
    const applied = HorseMind.importStats([
      {
        user_id: 'vet',
        hands: 500,
        vpip: 140,
        pfr: 90,
        threeBet: 30,
        aggr: 400,
        passive: 300,
        folds: 250,
        facedAggr: 550,
        rHands: 10,
        rFolds: 4,
        rFacedAggr: 8,
        rAggr: 12,
        rPassive: 9,
      },
    ]);
    expect(applied).toBe(1);
    expect(HorseMind.getStats('vet')?.hands).toBe(500);
    expect(HorseMind.getStats('vet')?.threeBet).toBe(30);

    // A second import that knows LESS must be ignored...
    expect(HorseMind.importStats([{ user_id: 'vet', hands: 100, vpip: 5 }])).toBe(0);
    expect(HorseMind.getStats('vet')?.hands).toBe(500);
    // ...and one that knows more wins.
    expect(HorseMind.importStats([{ user_id: 'vet', hands: 600, vpip: 170 }])).toBe(1);
    expect(HorseMind.getStats('vet')?.hands).toBe(600);
  });

  it('imported stats immediately drive the exploit layer', () => {
    // A folder profile straight from the DB: folds 70% vs aggression.
    HorseMind.importStats([
      {
        user_id: 'foldy-db',
        hands: 60,
        vpip: 15,
        pfr: 6,
        threeBet: 1,
        aggr: 10,
        passive: 20,
        folds: 35,
        facedAggr: 50,
        rHands: 0,
        rFolds: 0,
        rFacedAggr: 0,
        rAggr: 0,
        rPassive: 0,
      },
    ]);
    expect(HorseMind.exploit('foldy-db').bluffMod).toBeGreaterThan(1.2);
  });

  it('rejects malformed rows without throwing', () => {
    expect(
      HorseMind.importStats([
        { user_id: '' } as never,
        null as never,
        { user_id: 'ok', hands: Number.NaN, vpip: -5 },
      ])
    ).toBe(1);
    expect(HorseMind.getStats('ok')?.hands).toBe(0);
    expect(HorseMind.getStats('ok')?.vpip).toBe(0);
  });
});
