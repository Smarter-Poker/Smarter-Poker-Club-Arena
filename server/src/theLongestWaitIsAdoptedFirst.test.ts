/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A STABLE ORDER IS A STARVATION ORDER (2026-09-09)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `discoverTournaments` re-adopts every RUNNING tournament that has no manager
 * in this process. The read that finds them carried no ORDER BY, so the order
 * was whatever PostgREST returned - stable in practice, which is worse than
 * random: the same events sit at the end of the list on every pass.
 *
 * Adoption is not free. Each one spins up a manager and an engine per table,
 * against a database where a single bounty-evidence read measured 8,523 ms. So
 * when the fleet cannot all be adopted at once, the tail is not just late - it
 * is ALWAYS the same tail.
 *
 * Measured on production 2026-09-09. After the 05:55 maintenance restart,
 * tournaments that had dealt a hand in the last ten minutes fell from 86 to
 * EIGHT of 126 RUNNING, while THIRTEEN had been stalled for more than an hour -
 * across several hourly restarts, so they had lost the race every time. The
 * oldest had not dealt a hand in 903 minutes with players still seated.
 *
 * The pin is on the ordering, because that is the whole fix: the same set is
 * adopted in the same number of passes, and the event that has waited longest
 * is no longer the one that waits again.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceEnclosingBlock, sliceStatement } from './testHelpers/sourceWindow.js';

const SRC = readFileSync(resolve(__dirname, './GameServer.ts'), 'utf8');

/**
 * The read is a chained PostgREST builder, so the honest window is the
 * STATEMENT: from the declaration to the semicolon that closes the chain,
 * however many `.eq()`/`.order()` links it grows. Never a byte count
 * (tests/unit/noFixedSizeSourceWindows.test.ts).
 */
const RESUME_READ = sliceStatement(SRC, 'const { data: running, error: runningErr }');
/** The refusal beside it: the `if (runningErr)` block, by its own braces. */
const RESUME_REFUSAL = sliceEnclosingBlock(SRC, 'GameServer.running_board_read_failed');

describe('the longest-waiting tournament is adopted first', () => {
  it('the window under test is the RUNNING resume read', () => {
    expect(RESUME_READ).toContain("from('tournaments')");
    expect(RESUME_READ).toContain("eq('status', 'RUNNING')");
  });

  it('orders the RUNNING board by start time, oldest first', () => {
    expect(RESUME_READ, 'an unordered board starves the same events every pass').toMatch(
      /\.order\(\s*'started_at'\s*,\s*\{[^}]*ascending:\s*true/
    );
  });

  it('puts a tournament with no start time last, not first', () => {
    // A NULL start_time is not evidence of a long wait, and letting it sort to
    // the front would hand the queue to exactly the rows that prove nothing.
    expect(RESUME_READ).toMatch(/nullsFirst:\s*false/);
  });

  it('still treats an unreadable board as UNKNOWN rather than an empty one', () => {
    // The ordering must not disturb the older fix beside it: reading a failed
    // query as "nothing is running" silently stops every re-adoption.
    expect(RESUME_REFUSAL).toContain('RUNNING board read failed');
    expect(RESUME_REFUSAL).toContain('GameServer.running_board_read_failed');
  });

  it('the cash fleet still has its own per-sweep adoption budget', () => {
    expect(SRC).toContain('if (startedThisSweep >= budgetThisSweep) break;');
  });

  it('RUNNING re-adoption is bounded too, and the order still decides which', () => {
    // Moved 2026-09-10. This pin used to record a deliberate asymmetry: cash
    // adoption was bounded per sweep by C20 and tournament adoption was not,
    // so ORDER alone protected the tail. On 2026-09-10 the unbounded side
    // resumed ~740 tournaments per pass, starved the lease heartbeats and
    // re-adopted the same fenced set on every pass (tournamentResumeBudget.ts).
    // It now has the same AIMD budget. The budget decides HOW MANY per pass;
    // this board's started_at order still decides WHICH, so both pins stand.
    expect(SRC).toMatch(/selectRunningResumes\(\s*running \|\| \[\]/);
    expect(SRC).toContain('budget: this.tournamentResumeBudget');
  });
});
