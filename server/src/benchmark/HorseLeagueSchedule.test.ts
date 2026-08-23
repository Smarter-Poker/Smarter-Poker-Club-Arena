/**
 * V13.1 — the scheduler, pinned.
 *
 * The nightly league did not run on the night of 2026-08-23. Not late, not
 * partially: the engine's own container logs contained no league line at all,
 * ninety minutes after its window opened. The cause was not the window and not
 * the job — it was that both nightly jobs scheduled themselves ONLY with
 * setInterval, and an interval is reset by every process restart. The engine
 * redeploys on any merge touching server/**, which that night meant roughly
 * every ten to twenty minutes, so a ten-minute interval never survived to its
 * first tick.
 *
 * These tests pin the two properties that fix makes true:
 *   1. a restart TRIGGERS the run (there is a boot check), rather than
 *      resetting the clock that would have triggered it;
 *   2. the "already ran tonight" guard survives a restart, because it asks the
 *      database rather than an in-memory flag that boot has just cleared.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const leagueSrc = readFileSync(join(__dirname, 'HorseLeague.ts'), 'utf8');
const tunerSrc = readFileSync(join(__dirname, '..', 'services', 'HorseSelfTuner.ts'), 'utf8');

describe('nightly jobs — a restart must trigger the run, not prevent it', () => {
  it('the league checks at boot, not only on an interval', () => {
    const start = leagueSrc.slice(leagueSrc.indexOf('export function startHorseLeague'));
    const body = start.slice(0, start.indexOf('\n}\n') + 3);
    expect(body).toContain('setInterval');
    // The boot check is the whole point: without it, an interval longer than
    // the gap between deploys never fires.
    expect(body).toContain('setTimeout');
    expect(body).toContain('maybeRunLeague');
  });

  it('the self-tuner checks at boot too', () => {
    const start = tunerSrc.slice(tunerSrc.indexOf('export function startHorseSelfTuner'));
    const body = start.slice(0, start.indexOf('\n}\n') + 3);
    expect(body).toContain('setInterval');
    expect(body).toContain('setTimeout');
    expect(body).toContain('maybeRunSelfTune');
  });

  it('the "already ran" guard asks the database, not an in-memory flag', () => {
    // An in-memory flag is empty again after every restart, so a boot check
    // guarded only by it would re-run the job on every single deploy.
    expect(leagueSrc).toContain('alreadyRanToday');
    expect(leagueSrc).toContain("from('horse_league_results')");
    expect(tunerSrc).toContain('alreadyTunedToday');
    expect(tunerSrc).toContain("from('horse_self_tune_log')");
  });

  it('a partial league card is treated as NOT done, so it resumes', () => {
    expect(leagueSrc).toContain('>= LEAGUE_MATCHUPS.length');
  });

  it('a failed guard lookup fails OPEN — a skipped night is worse than a duplicate', () => {
    const fn = leagueSrc.slice(leagueSrc.indexOf('async function alreadyRanToday'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
    expect(body).toContain('return false');
    const tf = tunerSrc.slice(tunerSrc.indexOf('async function alreadyTunedToday'));
    expect(tf.slice(0, tf.indexOf('\n}\n') + 3)).toContain('return false');
  });

  it('both jobs accept a catch-up window rather than a single hour', () => {
    expect(leagueSrc).toContain('LEAGUE_CATCHUP_HOURS');
    expect(tunerSrc).toContain('TUNER_CATCHUP_HOURS');
  });
});
