/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * A GREEN TICK MUST NOT MEAN "SHIPPED NOTHING"
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * On 2026-08-26 a merged engine fix was believed live for thirteen minutes.
 * `auto-deploy-hetzner.yml` had reported `completed/success` while deliberately
 * deploying nothing:
 *
 *   Engine restarted only 20s ago (< 1200s) and is healthy with 2 tables
 *   — coalescing.
 *
 * The coalescing is correct: a restart voids in-flight hands, so a merge train
 * must not restart the engine five times in an hour. What was wrong is that the
 * only way to learn a run had shipped nothing was to read the log of a run that
 * had not failed — and nobody reads the log of a green run.
 *
 * Two structural answers, both pinned here because both are one careless edit
 * from being undone:
 *
 *   THE SKIP IS VISIBLE. A step that runs ONLY on the skip paths, named so that
 *   `gh api .../jobs` cannot be misread, plus a warning annotation rather than
 *   a notice.
 *
 *   THE SKIP IS TEMPORARY. The catch-up schedule must fire at least as often as
 *   the coalescing window, or a commit that defers at minute 18 waits for the
 *   next hour despite becoming eligible at minute 38.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const wf = (n: string) => readFileSync(resolve(__dirname, `../../.github/workflows/${n}`), 'utf8');

const HETZNER = wf('auto-deploy-hetzner.yml');
const SYNC = wf('build-for-world-hub.yml');

/** Reads the every-N-minutes cron cadence out of a workflow. */
function cronEveryMinutes(yaml: string): number | null {
  const m = yaml.match(/cron:\s*'\*\/(\d+) \* \* \* \*'/);
  return m ? Number(m[1]) : null;
}

describe('the engine deploy tells the truth when it skips', () => {
  it('has a step that exists only to be seen on the skip path', () => {
    expect(HETZNER).toMatch(/name: 'DID NOT DEPLOY — this run shipped nothing'/);
    // It must be conditional on the skip paths, or it is just noise on a
    // successful deploy.
    expect(HETZNER).toMatch(
      /if: steps\.dedupe\.outputs\.skip == 'true' \|\| steps\.drain\.outputs\.skip == 'true'/
    );
  });

  it('annotates the coalesce as a WARNING, not a notice', () => {
    // A notice does not surface on a green run. A warning does.
    expect(HETZNER).toMatch(/::warning title=NOT DEPLOYED::/);
    expect(HETZNER).not.toMatch(/::notice::Engine restarted only/);
  });

  it('the catch-up fires at least as often as the coalescing window', () => {
    const spacing = Number(HETZNER.match(/MIN_RESTART_SPACING_SEC=(\d+)/)![1]);
    const everyMin = cronEveryMinutes(HETZNER);
    expect(spacing).toBeGreaterThan(0);
    expect(everyMin).not.toBeNull();
    // The whole point: a commit that defers becomes eligible after `spacing`,
    // so the catch-up must come round by then. Hourly against a 20-minute
    // window left a 40-minute dead zone.
    expect(everyMin! * 60).toBeLessThanOrEqual(spacing);
  });

  it('still bypasses the spacing gate for a manual dispatch', () => {
    // This is the lever an agent uses to land a commit now. Losing it would
    // mean waiting out the window with no way to override.
    expect(HETZNER).toContain('!= "workflow_dispatch"');
  });
});

describe('the publish path cannot be left waiting on a push that never comes', () => {
  it('has a catch-up schedule of its own', () => {
    // `push` was the ONLY trigger. GitHub cancels the run that was PENDING in
    // the concurrency group when a newer push arrives, so a publish can be
    // cancelled and never retried if the pushes stop right afterwards.
    expect(cronEveryMinutes(SYNC)).not.toBeNull();
  });

  it('a scheduled cycle costs nothing when production is already current', () => {
    // Without this the catch-up would install, test and build a bundle that is
    // already published, every cycle, forever.
    expect(SYNC).toMatch(/id: dedupe/);
    expect(SYNC).toMatch(/if: github\.event_name == 'schedule'/);
    expect(SYNC).toMatch(/build-info\.json/);
  });

  it('a push and a manual dispatch are NEVER deduped', () => {
    // A push is by definition new work; a human dispatching this is usually
    // forcing a republish of something that looks stuck. Deduping either would
    // be the publish bug this is meant to prevent.
    const dedupe = SYNC.slice(SYNC.indexOf('id: dedupe'));
    expect(dedupe.slice(0, 200)).toMatch(/if: github\.event_name == 'schedule'/);
  });

  it('an unreadable build-info publishes rather than assuming it is current', () => {
    // Fail OPEN. A stale CDN or a broken build-info is exactly the moment this
    // needs to run, and treating "cannot tell" as "up to date" would make the
    // safety net silently useless.
    expect(SYNC).toMatch(/unreadable - publishing rather than assuming/);
  });

  it('the sync job is gated at JOB level, on the JOB output', () => {
    /* The second job runs on a different runner and cannot see the first
       job's step outputs. Gating its STEPS on `steps.dedupe...` would silently
       evaluate against an empty value, so every step would run and the job
       would then fail trying to download a dist that a deduped run never
       built. Job level, job output. */
    expect(SYNC).toMatch(/if: needs\.build-and-store\.outputs\.skip != 'true'/);
    expect(SYNC).toMatch(/outputs:\s*\n\s*skip: \$\{\{ steps\.dedupe\.outputs\.skip \}\}/);
  });
});
