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
 * The old client-side flip was guarded `.eq('status', 'REGISTERING')` and then
 * confirmed in separate statements. A zero-row update could look successful,
 * and the confirmation could observe a status written by somebody else. The
 * launch receipt boundary now owns the RUNNING transition and returns the
 * exact status and timestamp from the same atomic completion.
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
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = fs.readFileSync(path.join(HERE, 'TournamentManagerBase.ts'), 'utf8');

describe('the RUNNING transition proves the exact durable start', () => {
  it('requires one atomic completion response to prove status and started_at', () => {
    const complete = sliceMethod(BASE, 'private async completeTournamentLaunch(');
    expect(complete).toContain("result.status === 'RUNNING'");
    expect(complete).toContain('this.launchTimestampMatches(result.started_at, startedAtIso)');
    expect(complete).toContain('result.completed === true');
    expect(complete).toContain('fn_complete_tournament_launch_atomic');
  });

  it('does not perform a second client-side RUNNING update', () => {
    const start = sliceMethod(BASE, 'private async startLifecycle(');
    expect(start).not.toMatch(/\.update\(\{\s*status:\s*'RUNNING'/);
    expect(start).toContain('await this.completeTournamentLaunch(');
  });

  it('admits no dealer when completion cannot be proven', () => {
    const start = sliceMethod(BASE, 'private async startLifecycle(');
    const completion = start.indexOf('await this.completeTournamentLaunch(');
    const refusal = start.indexOf('if (!launchCompleted)', completion);
    const dealer = start.indexOf('this.startManagedTableEngine(', completion);
    expect(completion).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(completion);
    expect(start.slice(refusal, dealer)).toMatch(/this\.running\s*=\s*false;[\s\S]*?return;/);
    expect(dealer).toBeGreaterThan(refusal);
  });
});
