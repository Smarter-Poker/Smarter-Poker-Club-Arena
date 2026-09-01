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
import { sliceYamlBlock, sliceYamlEntry } from '../helpers/sourceWindow';

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

  /**
   * 2026-08-31, Dan, binding: "STOP THE ENGINE FROM RESTARTING. IT SHOULD ONLY
   * BE RESTARTING AT 7AM AND 7PM FROM NOW ON."
   *
   * This replaces the old cadence pin, which asserted that an every-20-minutes
   * catch-up came round at least as often as the coalescing window. There is no
   * catch-up any more and no merge-triggered restart at all: the engine
   * restarts on a schedule, and merged engine code waits for the next window.
   */
  it('never restarts on a merge — there is no push trigger', () => {
    const triggers = HETZNER.slice(HETZNER.indexOf('\non:'), HETZNER.indexOf('\nconcurrency:'));
    expect(triggers).not.toMatch(/^\s{2}push:/m);
    expect(triggers).toMatch(/^\s{2}schedule:/m);
    expect(triggers).toMatch(/^\s{2}workflow_dispatch:/m);
  });

  it('fires only at the hours that can be 6pm, 10pm, 4am, 10am, 2pm in Chicago', () => {
    // Ten UTC hours for five local windows: CDT and CST put each window an
    // hour apart, so both must be declared or the window silently disappears
    // for half the year. The gate keeps whichever five are genuinely 04, 10,
    // 14, 18 or 22 o'clock in Chicago.
    expect(HETZNER).toMatch(/cron: '0,20,40 0,3,4,9,10,15,16,19,20,23 \* \* \*'/);
    expect(cronEveryMinutes(HETZNER)).toBeNull();

    // Asserted as the PAIRING rather than as a literal, because the literal is
    // what a future edit gets wrong: dropping one hour leaves a cron that still
    // looks plausible and a window that stops firing when the clocks change.
    const utcHours = new Set(
      HETZNER.match(/cron: '0,20,40 ([0-9,]+) \* \* \*'/)![1]
        .split(',')
        .map(Number)
    );
    const gate = HETZNER.match(/case "\$HOUR" in\s*\n\s*([0-9|]+)\)/)![1]
      .split('|')
      .map(Number);
    expect(gate.sort((a, b) => a - b)).toEqual([4, 10, 14, 18, 22]);
    for (const local of gate) {
      expect(utcHours.has((local + 5) % 24), `CDT hour missing for ${local}:00 local`).toBe(true);
      expect(utcHours.has((local + 6) % 24), `CST hour missing for ${local}:00 local`).toBe(true);
    }
  });

  it('resolves the window from the tz database, not from a baked offset', () => {
    expect(HETZNER).toMatch(/TZ=America\/Chicago date \+%H/);
    expect(HETZNER).toMatch(/case "\$HOUR" in\s*\n\s*18\|22\|04\|10\|14\)/);
  });

  it('a plain dispatch is subject to the window; only force overrides it', () => {
    // publish-watchdog.yml dispatches this workflow when the engine is behind
    // main. That must keep alarming without being able to bounce production
    // at three in the morning.
    const gate = HETZNER.slice(
      HETZNER.indexOf('Restart window'),
      HETZNER.indexOf('Skip if production')
    );
    expect(gate).toMatch(/FORCED="\$\{\{ github\.event\.inputs\.force \}\}"/);
    expect(gate).toMatch(/if \[ "\$FORCED" = "true" \]/);
    // The refusal is a notice on the run, not a silent no-op.
    expect(gate).toMatch(/OUTSIDE THE RESTART WINDOW/);
  });

  it('inside a window the deploy actually lands rather than polling forever', () => {
    // The drain poll waits for handsInFlightTotal to hit zero, which a fleet
    // dealing ~290 hands a minute never reports. Three runs in a row reported
    // success and shipped nothing the day this was written; with two windows a
    // day that would mean the engine never updates at all.
    const drain = HETZNER.slice(
      HETZNER.indexOf('Drain gate'),
      HETZNER.indexOf('Pull the exact commit')
    );
    expect(drain).toMatch(/github\.event_name \}\} " *= *"schedule"|event_name \}\}" = "schedule"/);
    expect(drain).toMatch(/drains itself at a hand boundary on SIGTERM/);
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
    expect(SYNC).toMatch(/publish-needed:/);
    expect(SYNC).toMatch(/id: dedupe/);
    expect(SYNC).toMatch(/if: github\.event_name == 'schedule'/);
    expect(SYNC).toMatch(/build-info\.json/);
  });

  it('the check is a JOB, so the TEST SUITE skips with the build', () => {
    /* The work this guards lives in TWO parallel jobs. A step output cannot
       cross a runner, so a dedupe living inside build-and-store would have let
       `client-tests` run the whole suite anyway on a cycle with nothing to
       publish - most of the cost it exists to save. */
    expect(SYNC).toMatch(/publish-needed:\s*\n\s*runs-on:/);
    expect(SYNC).toMatch(/outputs:\s*\n\s*skip: \$\{\{ steps\.dedupe\.outputs\.skip \}\}/);
    for (const job of ['client-tests', 'build-and-store']) {
      const block = sliceYamlBlock(SYNC, `  ${job}:`);
      expect(block, `${job} must wait on publish-needed`).toMatch(/needs: publish-needed/);
      expect(block, `${job} must skip with it`).toMatch(
        /if: needs\.publish-needed\.outputs\.skip != 'true'/
      );
    }
  });

  it('a push and a manual dispatch are NEVER deduped', () => {
    // A push is by definition new work; a human dispatching this is usually
    // forcing a republish of something that looks stuck. Deduping either would
    // be the publish bug this is meant to prevent.
    const dedupe = sliceYamlEntry(SYNC, 'id: dedupe');
    expect(dedupe).toMatch(/if: github\.event_name == 'schedule'/);
  });

  it('an unreadable build-info publishes rather than assuming it is current', () => {
    // Fail OPEN. A stale CDN or a broken build-info is exactly the moment this
    // needs to run, and treating "cannot tell" as "up to date" would make the
    // safety net silently useless.
    expect(SYNC).toMatch(/unreadable - publishing rather than assuming/);
  });

  it('the publisher cannot run without both the bundle and the tests', () => {
    /* sync-to-world-hub needs BOTH heavy jobs, so a deduped cycle skips it for
       free: GitHub skips a job whose dependencies were skipped. That is also
       what stops it failing on a dist that was never built - no `always()`
       anywhere near it. */
    expect(SYNC).toMatch(/needs: \[build-and-store, client-tests\]/);
    const sync = sliceYamlBlock(SYNC, '  sync-to-world-hub:');
    expect(sync).not.toMatch(/if: always\(\)/);
  });
});
