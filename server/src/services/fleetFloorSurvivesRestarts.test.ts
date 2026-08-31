/**
 * THE FLEET-FLOOR ALARM MUST SURVIVE A RESTART LOOP.
 *
 * The floor alarm is the detector of last resort: the deal-rate check cannot
 * conclude anything from an empty fleet, so "the fleet collapsed" is watched
 * separately and losing it is its own alarm.
 *
 * It could not fire on 2026-08-30, and the reason is worth keeping. The floor
 * is not judged during a five-minute startup grace — correct on its own terms,
 * because a cold start really does have no dealable tables for minutes and an
 * alarm that cries wolf during a slow boot gets ignored when it matters. But
 * the grace is measured from `startedAt`, THIS PROCESS's clock, and it resets
 * on every restart.
 *
 * Supabase went into RESIZING, the engine could not win its leadership claim,
 * and it restarted roughly every two minutes for over forty minutes. Every one
 * of those processes died well inside the grace, so `belowFloorChecks` was
 * never incremented once. The whole platform was dark, the alarm written for
 * exactly this was structurally unable to fire, and a person found it by
 * looking at a lobby.
 *
 * The fix keys the grace to something that outlives a restart: whether the
 * DATABASE has seen a hand from anywhere in that window.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { sliceBlockAfter, sliceMethod } from '../testHelpers/sourceWindow.js';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
/** Strip comments so a guard cannot pass on a mention in prose. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const SRC = code(read('src/services/DealRateVerifier.ts'));

/**
 * Bounded by the structure, never by a byte count. These pins used to read
 * `slice(at, at + 500)` and `slice(at, at + 700)`, which is the shape
 * tests/unit/noFixedSizeSourceWindows.test.ts refuses: the grace branch below
 * carries a five-line explanatory comment, so one more sentence in it pushes
 * `return;` out of a 500-byte window and fails a guard whose code never
 * changed. The silent direction is worse - a window can also drift off the end
 * of the thing it watches while staying green.
 */
const GRACE_BRANCH = () =>
  sliceBlockAfter(SRC, 'if (Date.now() - this.startedAt < STARTUP_GRACE_MS)');
const FLEET_DARK = () => sliceMethod(SRC, 'private async fleetDarkAcrossRestarts');

describe('the startup grace must justify itself against the database', () => {
  it('no longer returns blind just because the process is young', () => {
    // The bug in one line: `if (young) return;` with nothing else asked.
    const window = GRACE_BRANCH();
    expect(window).toMatch(/fleetDarkAcrossRestarts\(\)/);
  });

  it('only stands down when the fleet is NOT dark', () => {
    const window = GRACE_BRANCH();
    // Stand down on "not dark"; fall through to judge otherwise.
    expect(window).toMatch(/if \(!darkAcrossRestarts\)/);
    expect(window).toMatch(/return;/);
  });

  it('asks a question that outlives a restart, unfiltered by table', () => {
    const fn = FLEET_DARK();
    expect(fn).toMatch(/from\('hand_history'\)/);
    // Unfiltered BY DESIGN: a collapsed fleet has no table ids left to filter
    // by, which is the entire hole being closed.
    expect(fn).not.toMatch(/\.in\('table_id'/);
    expect(fn).toMatch(/STARTUP_GRACE_MS/);
  });

  it('treats a failed query as NOT dark — could-not-ask is never evidence', () => {
    // A flaky database must not manufacture a critical page.
    const fn = FLEET_DARK();
    expect(fn).toMatch(/if \(error\) return false;/);
    expect(fn).toMatch(/catch \{[\s\S]*?return false;/);
  });

  it('only calls the fleet dark when the count is exactly zero', () => {
    const fn = FLEET_DARK();
    expect(fn).toMatch(/\(count \?\? 0\) === 0/);
  });

  it('keeps the floor and its threshold — this widens the alarm, it does not weaken it', () => {
    expect(SRC).toMatch(/FLEET_FLOOR_TABLES = 3/);
    expect(SRC).toMatch(/CONSECUTIVE_BELOW_FLOOR = 3/);
    expect(SRC).toMatch(/belowFloorChecks\+\+/);
    expect(SRC).toMatch(/ClubArenaFleetFloorLost/);
  });
});
