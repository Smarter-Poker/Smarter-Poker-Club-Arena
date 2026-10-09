/**
 * LAW: A CASH TABLE HELD BY A RETAINED-HAND REFUSAL GETS NO HORSES (2026-10-09).
 *
 * Three Diamond cash tables held since 2026-10-07 kept receiving horses: 17 of
 * them, with 21,745 Diamonds of buy-ins parked at tables that could not deal.
 * GameServer's hold now marks the table in retainedHandHolds, its release
 * clears it, and the fleet withholds a marked table before it seats anyone.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  markRetainedHandHold,
  clearRetainedHandHold,
  tableHeldByRetainedHand,
  __resetRetainedHandHolds,
} from './retainedHandHolds.js';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const gameServer = read('../GameServer.ts');
const fleet = read('../services/HorseFleetManager.ts');
const between = (src: string, a: string, b: string) => {
  const i = src.indexOf(a);
  return src.slice(i, src.indexOf(b, i + a.length));
};

beforeEach(() => __resetRetainedHandHolds());

describe('a held table gets no horses', () => {
  it('a hold is marked and its release clears it', () => {
    expect(tableHeldByRetainedHand('t1')).toBe(false);
    markRetainedHandHold('t1');
    expect(tableHeldByRetainedHand('t1')).toBe(true);
    expect(tableHeldByRetainedHand('t2')).toBe(false);
    clearRetainedHandHold('t1');
    expect(tableHeldByRetainedHand('t1')).toBe(false);
  });

  it('GameServer marks on every hold, before the repeat-report early return', () => {
    const hold = between(
      gameServer,
      'private holdRetainedHandRefusal(',
      'private releaseRetainedHandHold('
    );
    const mark = hold.indexOf('markRetainedHandHold(tableId);');
    const early = hold.indexOf('if (previous?.code === code) return;');
    expect(mark).toBeGreaterThan(-1);
    expect(early).toBeGreaterThan(mark);
  });

  it('GameServer clears on every release, before the no-hold early return', () => {
    const release = between(
      gameServer,
      'private releaseRetainedHandHold(',
      'private retainedHandHeld('
    );
    const clear = release.indexOf('clearRetainedHandHold(tableId);');
    const early = release.indexOf('if (!previous) return;');
    expect(clear).toBeGreaterThan(-1);
    expect(early).toBeGreaterThan(clear);
  });

  it('the fleet withholds a held table before it reads the seating policy', () => {
    const check = fleet.indexOf('if (tableHeldByRetainedHand(table.id)) {');
    const policy = fleet.indexOf('const policy = policyFor(table.club_id);');
    expect(check).toBeGreaterThan(-1);
    expect(policy).toBeGreaterThan(check);
    expect(fleet.slice(check, policy)).toContain("'retained_hand_held'");
    expect(fleet.slice(check, policy)).toContain('continue;');
  });
});
