/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A TOURNAMENT THAT PLAYED HAS A START ON ITS ROW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-09-05. Measured on production: 53 tournaments across FOUR variants
 * (30 sng, 21 spin, 1 satellite, 1 freezeout) that dealt hands and ended, every
 * one of them carrying `started_at` NULL - and not one `running_flip_failed`
 * report between them. 47 of the 53 landed on 2026-09-01 alone.
 *
 * The flip is guarded `.eq('status', 'REGISTERING')`, and `start()` has no
 * status gate at the top: it reads the row and proceeds. So it genuinely runs
 * against rows that are already RUNNING - a second engine winning the race, a
 * recovery driver, a restart re-entering start(). PostgREST then updates ZERO
 * rows and returns NO ERROR, and the confirmation only ever asked about
 * `status`. An already-RUNNING row answers "not REGISTERING", the flip is
 * declared a success, and nobody ever writes the start.
 *
 * A null start is not cosmetic:
 *   - `late_reg_mins` is arithmetic ON this column, in the footer countdown
 *     and in `make_interval(mins => late_reg_mins)` server side;
 *   - every duration ever reported for the event comes from it;
 *   - the repair sweeps bound themselves on it, and `NULL > now() - interval`
 *     is NULL, which is not true - so the row is invisible to the very jobs
 *     written to rescue it. That is how four spins sat un-stamped for four
 *     days while a quarter-hour cron ran over them.
 *
 * Every pin below is that bug.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = fs.readFileSync(path.join(HERE, 'TournamentManagerBase.ts'), 'utf8');

/** The flip loop, bounded by the block that encloses it. */
const flipLoop = () => sliceEnclosingBlock(BASE, "'status', 'REGISTERING'", 0, 2);

describe('the RUNNING flip confirms that a start was actually written', () => {
  it('the confirmation reads started_at, not only status', () => {
    // `select('status')` alone is what made a lost race look like a win.
    expect(flipLoop()).toMatch(/\.select\(\s*'status,\s*started_at'\s*\)/);
  });

  it('a live row with no start gets one, guarded so it cannot overwrite', () => {
    const loop = flipLoop();
    expect(loop).toContain('if (!confirmRow?.started_at)');
    expect(loop).toMatch(/\.is\(\s*'started_at',\s*null\s*\)/);
  });

  it('losing the flip is reported rather than swallowed', () => {
    // The whole failure mode was silence: 53 rows, zero reports.
    expect(flipLoop()).toContain('Tournament.started_at_stamped_after_lost_flip');
  });

  it('a finished row is never given an invented start', () => {
    // CLAUDE.md 10.9: correct forward, never write an inferred value onto a
    // settled record to tidy a column.
    const loop = flipLoop();
    expect(loop).toContain("if (confirmed === 'RUNNING')");
    expect(loop).toContain('Tournament.started_at_missing_on_finished_row');
  });
});
