/**
 * A FINISH THAT DEADLOCKS IS RETRIED, AND A MANAGER THAT NEVER CAME BACK DOES
 * NOT HIDE THE ROW (2026-09-06).
 *
 * 15:01, 15:06, 15:07 UTC: three events paid their winners, settled rake, and
 * deadlocked on COMPLETING -> COMPLETED. finishTournament logged "left for
 * recoverStuckCompletingTournaments" and never returned; the manager stayed
 * registered; the watchdog skipped the row every pass because a manager
 * existed. Fifty minutes, two pager alerts on rows that were paid, one
 * operator with psql.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  COMPLETED_FLIP_ATTEMPTS,
  COMPLETED_FLIP_BACKOFF_MS,
  isTransientFlipError,
} from './completedFlip.js';
import {
  COMPLETING_DWELL_MS,
  COMPLETING_MANAGED_GRACE_MS,
  managerHasOverstayed,
} from './completingDwell.js';

const here = dirname(fileURLToPath(import.meta.url));
const ELIM = readFileSync(join(here, 'TournamentManagerEliminations.ts'), 'utf8');
const SERVER = readFileSync(join(here, '..', 'GameServer.ts'), 'utf8');

describe('the flip is retried on a deadlock and nothing else', () => {
  it('three attempts, a quarter second apart, growing', () => {
    expect(COMPLETED_FLIP_ATTEMPTS).toBe(3);
    expect(COMPLETED_FLIP_BACKOFF_MS).toBe(250);
  });

  it('a deadlock, a lock timeout and a serialization failure are transient', () => {
    expect(isTransientFlipError({ code: '40P01', message: 'deadlock detected' })).toBe(true);
    expect(
      isTransientFlipError({ code: '55P03', message: 'canceling statement due to lock timeout' })
    ).toBe(true);
    expect(isTransientFlipError({ code: '40001' })).toBe(true);
    expect(isTransientFlipError({ message: 'deadlock detected' })).toBe(true);
  });

  it('a refusal is not retried - a trigger that says no means no', () => {
    expect(isTransientFlipError({ code: '23514', message: 'a spin cannot complete unpaid' })).toBe(
      false
    );
    expect(isTransientFlipError({ code: 'PGRST301', message: 'JWT expired' })).toBe(false);
    expect(isTransientFlipError(null)).toBe(false);
  });

  it('finishTournament loops the update and keeps the COMPLETING guard on every attempt', () => {
    const i = ELIM.indexOf('for (let attempt = 1; attempt <= COMPLETED_FLIP_ATTEMPTS; attempt++)');
    expect(i).toBeGreaterThan(0);
    const body = ELIM.slice(i, ELIM.indexOf('if (completedErr) {', i));
    expect(body).toContain(".eq('status', 'COMPLETING')");
    expect(body).toContain("status: 'COMPLETED'");
    expect(body).toContain('if (!error || !isTransientFlipError(error)) break;');
    expect(body).toContain('COMPLETED_FLIP_BACKOFF_MS * attempt');
  });
});

describe('a manager past the grace is the thing that is stuck', () => {
  it('the grace is two dwells - ten minutes', () => {
    expect(COMPLETING_MANAGED_GRACE_MS).toBe(2 * COMPLETING_DWELL_MS);
    expect(COMPLETING_MANAGED_GRACE_MS).toBe(10 * 60 * 1000);
  });

  it("a row first seen under ten minutes ago is still the manager's", () => {
    const now = 1_000_000_000;
    expect(managerHasOverstayed(now - COMPLETING_MANAGED_GRACE_MS + 1, now)).toBe(false);
    expect(managerHasOverstayed(now, now)).toBe(false);
    expect(managerHasOverstayed(undefined, now)).toBe(false);
  });

  it('at ten minutes it is not', () => {
    const now = 1_000_000_000;
    expect(managerHasOverstayed(now - COMPLETING_MANAGED_GRACE_MS, now)).toBe(true);
    expect(managerHasOverstayed(now - 50 * 60_000, now)).toBe(true);
  });

  it('the watchdog stops and drops the overstayed manager, then recovers through the same door', () => {
    /* The window is the loop body the guard lives in, not a byte count:
       tests/helpers/sourceWindow, and the publish outage its header records. */
    const loop = sliceEnclosingBlock(
      SERVER,
      'managerHasOverstayed(dwell.seenAt.get(String(stuck.id)), Date.now())'
    );
    expect(loop).toContain('lingering.stop();');
    expect(loop).toContain('this.tournamentEngines.delete(String(stuck.id));');
    expect(loop).toContain(
      "await recoverStuckCompletingTournaments('discovery-watchdog', stuck.id);"
    );
    // The drop happens BEFORE the has() test that gates recovery, so the
    // recovery that follows is the ordinary one.
    expect(loop.indexOf('this.tournamentEngines.delete(String(stuck.id));')).toBeLessThan(
      loop.indexOf('if (!this.tournamentEngines.has(stuck.id))')
    );
  });
});
