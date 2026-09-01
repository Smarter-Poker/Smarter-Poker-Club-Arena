/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SCHEDULED WORKFLOW THAT STOPS FIRING SAYS NOTHING (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MEASURED. auto-deploy-hetzner.yml moved to an hourly cron at 13:00 UTC.
 * Between then and 18:52 sixteen scheduled ticks were due and exactly ONE
 * ran, so the engine served a 03:54 image for fourteen and a half hours with
 * five merged pull requests unshipped. Every run in that window was green,
 * because none of them happened.
 *
 * On its first live run the new check found it was not one workflow but FOUR:
 *
 *   build-for-world-hub.yml   expected every 30m, last scheduled run 156m ago
 *   auto-deploy-hetzner.yml   expected every 50m, last scheduled run 259m ago
 *   agent-autopilot.yml       expected every 30m, last scheduled run 108m ago
 *   publish-watchdog.yml      expected every 60m, last scheduled run 184m ago
 *
 * build-for-world-hub is what publishes the Club Arena bundle, so this was
 * not confined to the engine.
 *
 * The cron arithmetic is the part worth pinning: an expectation that is too
 * tight cries wolf and one that is too loose is the silence it replaced. My
 * own first two expectations here were wrong and the code was right, which is
 * the reason these are written down rather than eyeballed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { maxGapMinutes } from '../.github/scripts/schedule-liveness.mjs';

const ROOT = resolve(__dirname, '..');
const SCRIPT = readFileSync(resolve(ROOT, '.github/scripts/schedule-liveness.mjs'), 'utf8');
const WATCHDOG = readFileSync(resolve(ROOT, '.github/workflows/publish-watchdog.yml'), 'utf8');

describe('the cron arithmetic', () => {
  it('reads the widest hole a schedule leaves, not the narrowest', () => {
    // :40 :45 :50 every hour. The gaps are 5, 5, then FIFTY back round to the
    // next :40 - and it is the fifty that decides when to be worried.
    expect(maxGapMinutes('40,45,50 * * * *')).toBe(50);
  });

  it('handles the ordinary shapes this repo actually uses', () => {
    expect(maxGapMinutes('0 * * * *')).toBe(60);
    expect(maxGapMinutes('*/15 * * * *')).toBe(15);
    expect(maxGapMinutes('35 6 * * *')).toBe(1440);
    // Clustered hours: the overnight wrap is the widest hole, not the 20m step.
    expect(maxGapMinutes('0,20,40 0,3 * * *')).toBe(1220);
  });

  it('refuses to guess at a shape it cannot read', () => {
    // A wrong expectation is a false alarm, and a false alarm is how a real
    // one gets ignored. Anything narrowing the day returns null and is skipped.
    expect(maxGapMinutes('0 9 * * 1')).toBeNull();
    expect(maxGapMinutes('0 9 1 * *')).toBeNull();
    expect(maxGapMinutes('0 9-17 * * *')).toBeNull();
    expect(maxGapMinutes('nonsense')).toBeNull();
    expect(maxGapMinutes('')).toBeNull();
  });
});

describe('the check cannot share a failure domain with what it watches', () => {
  it('runs as a job on workflow_run, never as its own cron', () => {
    // The whole point: a cron that alarms about cron cannot alarm when cron is
    // the thing that broke.
    expect(WATCHDOG).toContain('workflow_run:');
    expect(WATCHDOG).toMatch(/schedules:\s*\n\s*name: The schedules are actually firing/);
    expect(WATCHDOG).toContain('node .github/scripts/schedule-liveness.mjs');
  });

  it('derives its watchlist from the workflow files, with no list to maintain', () => {
    // The same principle as the layer watchlist fixed earlier today: a
    // hand-kept list goes stale and then lies.
    expect(SCRIPT).toContain('readdirSync(DIR)');
    expect(SCRIPT).toMatch(/cron:\s*\\s\*\['"\]/);
  });

  it('never fails the job', () => {
    // GitHub drops ticks often enough that a red X here would be noise within
    // a day, and the engine watchdog beside it is what actually repairs the
    // case that matters.
    expect(SCRIPT).not.toContain('process.exit(1)');
    expect(SCRIPT).toContain('process.exit(0)');
  });

  it('says nothing when it cannot read the answer', () => {
    // No token, or an API that will not answer, must produce silence rather
    // than a fabricated alarm.
    expect(SCRIPT).toContain('SKIP: no token');
    expect(SCRIPT).toMatch(/if \(last === undefined\) continue;/);
  });
});
