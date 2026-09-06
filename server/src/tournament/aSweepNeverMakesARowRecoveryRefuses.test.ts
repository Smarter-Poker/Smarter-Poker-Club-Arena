/**
 * A SWEEP NEVER MAKES A ROW THE RECOVERY WILL REFUSE (2026-09-06).
 *
 * The boot-time stale sweep flips any RUNNING tournament older than twelve
 * hours with no hand in the last hour to COMPLETING and hands it to
 * `recoverStuckCompletingTournaments`. That function asks `fieldIsStillLive`
 * and REFUSES a field with more players left than the structure pays - and
 * once it has refused, nothing can finish the event: the discovery loop
 * resumes RUNNING tournaments only, so a COMPLETING row is invisible to the
 * one path that could play it out.
 *
 * PLO4 Heads-Up 25 (3e281f5c) sat in exactly that state for three days with
 * two players holding chips, and was settled by hand (migration
 * 20260906153943). The sweep took a stalled game a manager could still adopt
 * and made it permanently stuck.
 *
 * The fix is to ask the same question, with the same guard, BEFORE the claim.
 * The decision is `fieldIsStillLive` (pure, tested in its own file); this
 * pins the wiring, because the sweep needs a live Supabase to run.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fieldIsStillLive } from './recoveryFieldGuard.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(join(here, '..', 'GameServer.ts'), 'utf8');

/** The sweep, from its own comment block to the claim it guards. */
const sweep = SERVER.slice(
  SERVER.indexOf('const twelveHoursAgo ='),
  SERVER.indexOf("await recoverStuckCompletingTournaments('startup-stale-12h-settle'")
);

describe('the sweep asks what the recovery will ask', () => {
  it('reads the live field and the paid places before it claims the row', () => {
    expect(sweep).toContain(
      'fieldIsStillLive({ livePlayers: liveCount, paidPlaces: sweepPayouts.length })'
    );
    expect(sweep).toContain('resolvePayoutStructure(');
    // Both counts come from the database, exactly, not from a page of rows.
    expect(sweep).toContain("{ count: 'exact', head: true }");
    expect(sweep).toContain(".eq('status', 'playing')");
  });

  it('the guard sits BEFORE the COMPLETING claim, not after it', () => {
    const guard = sweep.indexOf('fieldIsStillLive({');
    const claim = sweep.indexOf("update({ status: 'COMPLETING' })");
    expect(guard).toBeGreaterThan(0);
    expect(claim).toBeGreaterThan(0);
    expect(guard).toBeLessThan(claim);
  });

  it('a live field is LEFT RUNNING and reported, never flipped', () => {
    const branch = sweep.slice(
      sweep.indexOf('fieldIsStillLive({'),
      sweep.indexOf("update({ status: 'COMPLETING' })")
    );
    expect(branch).toContain('LEFT RUNNING');
    expect(branch).toContain("'GameServer.stale_sweep_left_live_field_running'");
    expect(branch).toMatch(/\n\s*continue;\n/);
    // Nothing in the refusing branch writes a status.
    expect(branch).not.toContain('update({ status:');
  });

  it('a count it could not read skips the row rather than guessing (10.86)', () => {
    expect(sweep).toContain("if (liveErr || fieldErr || typeof liveCount !== 'number')");
    const unreadable = sweep.slice(
      sweep.indexOf('if (liveErr || fieldErr'),
      sweep.indexOf('const sweepPayouts')
    );
    expect(unreadable).toContain('left RUNNING');
    expect(unreadable).toMatch(/\n\s*continue;\n/);
  });
});

describe('the guard the sweep now shares with the recovery', () => {
  it('refuses the shape that stuck 3e281f5c: two alive, one paid place', () => {
    expect(fieldIsStillLive({ livePlayers: 2, paidPlaces: 1 })).toBe(true);
  });

  it('allows a genuine finish: nobody left, or fewer left than places', () => {
    expect(fieldIsStillLive({ livePlayers: 0, paidPlaces: 1 })).toBe(false);
    expect(fieldIsStillLive({ livePlayers: 1, paidPlaces: 1 })).toBe(false);
    expect(fieldIsStillLive({ livePlayers: 3, paidPlaces: 9 })).toBe(false);
  });

  it('an unresolved structure is not swallowed by this guard', () => {
    expect(fieldIsStillLive({ livePlayers: 90, paidPlaces: 0 })).toBe(false);
  });
});
