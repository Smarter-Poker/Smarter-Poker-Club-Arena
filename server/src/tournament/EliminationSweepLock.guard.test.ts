/**
 * A warned elimination sweep keeps its physical scheduler slot until its own
 * promise settles. Force-releasing a live promise admits overlapping money
 * writes behind a healthy-looking gauge, so lifecycle teardown aborts work
 * cooperatively and capacity remains quarantined meanwhile.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ELIMINATION_SWEEP_STUCK_MS } from './eliminationLock.js';
import { DEFAULT_SWEEP_WARN_MS } from './TournamentEliminationScheduler.js';

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
const SCHEDULER = read('src/tournament/TournamentEliminationScheduler.ts');
const SWEEP = read('src/tournament/TournamentManagerEliminations.ts');

describe('physical elimination sweep ownership', () => {
  it('warns promptly but exposes no force-release contract', () => {
    expect(ELIMINATION_SWEEP_STUCK_MS).toBeGreaterThan(0);
    expect(ELIMINATION_SWEEP_STUCK_MS).toBeLessThanOrEqual(120_000);
    expect(DEFAULT_SWEEP_WARN_MS).toBeGreaterThan(ELIMINATION_SWEEP_STUCK_MS);
    expect(SCHEDULER).not.toContain('FORCE_RELEASE');
    expect(SCHEDULER).not.toContain("outcome: 'forced'");
    expect(SCHEDULER).not.toContain('runSafetySweep');
  });

  it('keeps a warned promise counted until its completion callback', () => {
    const warningStart = SCHEDULER.indexOf('warningTimer = setTimeout');
    const warningEnd = SCHEDULER.indexOf('Promise.resolve()', warningStart);
    const warning = SCHEDULER.slice(warningStart, warningEnd);
    expect(warning).toContain("dispatchTotal.inc(1, { outcome: 'timed_out' })");
    expect(warning).not.toMatch(/runningCount\s*=|runningCount--|activeEntries\.delete/);

    const finishStart = SCHEDULER.indexOf("const finish = (outcome: 'completed' | 'failed')");
    const finishEnd = SCHEDULER.indexOf('if (this.sweepWarnMs > 0)', finishStart);
    const finish = SCHEDULER.slice(finishStart, finishEnd);
    expect(finish).toContain('this.activeEntries.delete(entry)');
    expect(finish).toContain('this.runningCount = Math.max(0, this.runningCount - 1)');
  });

  it('aborts a removed generation and checks that signal after awaited phases', () => {
    expect(SCHEDULER).toContain('entry.abortController?.abort()');
    expect(SWEEP).toContain('const sweepStopped = (): boolean => !this.running || signal.aborted;');
    expect(SWEEP).toContain('this.eliminationWorkBudgetExpired()');
    expect(SWEEP).toContain('this.requestEliminationSweep()');
    expect((SWEEP.match(/if \(sweepStopped\(\)\) return;/g) ?? []).length).toBeGreaterThan(12);
    expect(SWEEP).toContain('await this.finishTournament(winner.user_id);');
  });

  it('does not overlap a replacement while the old physical promise unwinds', () => {
    expect(SCHEDULER).toContain('private readonly activeTournamentIds = new Set<string>()');
    expect(SCHEDULER).toContain('if (this.activeTournamentIds.has(entry.tournamentId))');
    expect(SCHEDULER).toContain('this.activeTournamentIds.delete(entry.tournamentId)');
  });
});
