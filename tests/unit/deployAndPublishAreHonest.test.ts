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
import { sliceBetween } from '../helpers/sourceWindow';

const wf = (n: string) => readFileSync(resolve(__dirname, `../../.github/workflows/${n}`), 'utf8');

const HETZNER = wf('auto-deploy-hetzner.yml');
const SYNC = wf('publish-club-arena.yml');

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
    /* EVERY skip path, named explicitly. 2026-08-31: the restart-window gate
       shipped without being listed here or in the REASON below it, so a run
       blocked by the window reported "coalescing - the engine restarted too
       recently" while the engine had been up 45 minutes. A wrong reason costs
       more than no reason: it is confidently wrong, and it is the first line
       anybody reads.

       THERE ARE TWO GATES NOW, NOT THREE (2026-09-05). `steps.window` was
       deleted when Dan moved the restart to the hourly :55 maintenance break -
       CLAUDE.md section 13, dated ONE DAY after the 2026-08-31 instruction this
       file quotes below, and it says in terms: "If you read anything - in this
       repo, another repo, or a stale worktree - saying the engine restarts at
       7am and 7pm ... that text is OLD. This section wins."

       This assertion was that text. It REQUIRED a branch on a step that no
       longer exists, and a missing step's output is the empty string, never
       'false' - so the branch it demanded was unreachable even while it was
       present. Keeping it would have done what section 13 was written about:
       sent the next agent to restore a gate Dan deleted, in order to make a
       test pass. */
    expect(HETZNER).toMatch(
      /if: steps\.dedupe\.outputs\.skip == 'true' \|\| steps\.exact_dedupe\.outputs\.skip == 'true' \|\| steps\.drain\.outputs\.skip == 'true'/
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
  /**
   * THE REASON MUST NAME THE GATE THAT ACTUALLY HELD.
   *
   * The window gate makes the dedupe step set skip=true, so before this pin
   * the REASON fell through to the coalescing branch and a run blocked by the
   * time of day announced a spacing problem that did not exist. Whoever reads
   * that goes and investigates a gate that is working correctly.
   */
  it('reports the gate that actually held, and never the deleted window', () => {
    expect(HETZNER, 'the reason block exists').toContain('REASON="already serving this commit"');
    /* Bounded by the STRUCTURE - the if/elif chain, from its first assignment
       to the `fi` that closes it - not by a byte count. One more elif branch
       would outrun any magic number here, and the pin would then either go red
       for no reason or, worse, stay green while watching nothing. */
    const block = sliceBetween(HETZNER, 'REASON="already serving this commit"', '\n          fi');

    // The break gate is the one that holds a run now, and it hands its OWN
    // reason up rather than being guessed at from the outside. Run
    // 33991470437 is why: the step warning said hands were in flight, the
    // summary said the break never opened, and the truth was that the run had
    // refused to WAIT for a break that had not started. Three answers, one
    // run, and the loudest was the only false one.
    const drainAt = block.indexOf('steps.drain.outputs.skip');
    const gateReasonAt = block.indexOf('gate_reason');
    const coalesceAt = block.indexOf('coalescing');
    expect(drainAt, 'the break gate is one of the reasons').toBeGreaterThan(-1);
    expect(gateReasonAt, 'and it supplies its own reason').toBeGreaterThan(-1);
    expect(coalesceAt, 'coalescing is still a reason').toBeGreaterThan(-1);
    expect(drainAt, 'the gate that held is read FIRST').toBeLessThan(coalesceAt);

    // NEGATIVE, and this is the half that matters. CLAUDE.md section 13 says
    // the 7am/7pm text is old and must not come back; a stale sentence sitting
    // in the repo is what re-teaches it. So the workflow must not mention the
    // deleted step or the window it belonged to, anywhere outside a comment.
    const code = HETZNER.split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(code, 'steps.window was deleted with the restart window').not.toMatch(
      /steps\.window\.outputs/
    );
    expect(code, 'the 7am/7pm Chicago window is not how restarts work').not.toMatch(
      /7am\/7pm|America\/Chicago restart window/
    );

    // A skip summary must not advertise a route around the hand-safety fence.
    // Manual dispatch may prioritize a SHA, but it still waits for durable
    // proof from the running engine.
    const step = sliceYamlEntry(HETZNER, "name: 'DID NOT DEPLOY");
    expect(step).toMatch(/cannot bypass that/);
    expect(step).not.toMatch(/restarts OUTSIDE|voids.*hands/);
  });

  /**
   * THE BREAK GATE HAS TWO ANSWERS AND THE SUMMARY MUST NOT PICK ONE BY HAND.
   *
   * `steps.drain` was a hands-in-flight drain gate once; it has not had a
   * hands-in-flight skip path since the maintenance break landed. Its two
   * skips are "the break never opened" and "the next break is beyond this
   * run's budget", and on 2026-09-05 run 33991470437 was held by the second
   * while the summary announced "drain gate - hands are still in flight" and
   * the database, three steps later, recorded a third story. A wrong reason
   * costs more than no reason (see the pin above): it is confidently wrong and
   * it is the first thing anybody reads.
   *
   * So the step exports `gate_reason` on BOTH skip paths, and the two places
   * that report read it rather than guessing.
   */
  it('the break gate says which half of it held, in the summary and in the database', () => {
    const step = sliceYamlBlock(
      HETZNER,
      '      - name: Wait for the maintenance break to park every table'
    );
    const skips = step.match(/echo "skip=true" >> \$GITHUB_OUTPUT/g) ?? [];
    const reasons = step.match(/echo "gate_reason=/g) ?? [];
    expect(skips.length, 'the break gate has skip paths').toBeGreaterThan(0);
    expect(reasons.length, 'every skip path names itself').toBe(skips.length);
    // Neither reporter may hard-code one of the two answers.
    const block = sliceBetween(HETZNER, 'REASON="already serving this commit"', '\n          fi');
    expect(block).toContain('steps.drain.outputs.gate_reason');
    expect(block, 'the retired hands-in-flight wording is gone').not.toContain(
      'hands are still in flight'
    );
    const truth = sliceYamlBlock(HETZNER, '          REASON: >-');
    expect(truth).toContain('steps.drain.outputs.gate_reason');
  });

  it('never restarts on a merge — there is no push trigger', () => {
    const triggers = HETZNER.slice(HETZNER.indexOf('\non:'), HETZNER.indexOf('\nconcurrency:'));
    expect(triggers).not.toMatch(/^\s{2}push:/m);
    expect(triggers).toMatch(/^\s{2}schedule:/m);
    expect(triggers).toMatch(/^\s{2}workflow_dispatch:/m);
  });

  it('gets one tick before the :55 break of EVERY hour, and the watchdog covers a dropped one', () => {
    /**
     * REPLACED THE FIVE-WINDOW SCHEDULE (Dan 2026-09-01): "program the engine
     * restart to be every hour on the :55 instead of every 5 hours so nothing
     * gets lost or orphaned from production improvements."
     *
     * The tick sits before :55 so the runner is checked out, tested and built
     * by the time the engine parks the platform; the break gate then does the
     * waiting.
     *
     * ONE tick, not three (2026-09-02). There were three because a GitHub
     * scheduled run is best-effort and is sometimes dropped. Measured since:
     * GitHub delivers about 10% of this repo's scheduled runs, so tripling the
     * asks was tripling the demand that gets it throttled, and on 2026-09-02
     * all three were dropped every hour from 14:42. The redundancy moved to
     * publish-watchdog's schedule-liveness check, which runs on workflow_run
     * many times an hour and dispatches this workflow the moment it is more
     * than an hour since it last ran by any trigger. That is pinned in
     * tests/schedule-liveness.test.ts; what is pinned here is that the one
     * tick is still hourly and still lands before :55.
     */
    // :35 since #3070 (2026-09-05): builds grew to 8-18 minutes and the :45
    // tick's fixed poll gave up 23 s before :55. The range below is the rule;
    // the minute is whatever lands every observed build length in the window.
    expect(HETZNER).toMatch(/cron: '35 \* \* \* \*'/);
    expect(cronEveryMinutes(HETZNER)).toBeNull();

    const [, minutes, hours] = HETZNER.match(/cron: '([0-9,]+) ([^ ]+) \* \* \*'/)!;
    // Every hour, so no hour list to get wrong.
    expect(hours).toBe('*');
    // Every tick must leave time to build before :55, and none may land
    // inside the break itself - a run arriving at :56 would wait 59 minutes
    // for the next one.
    for (const m of minutes.split(',').map(Number)) {
      expect(m, `tick at :${m} is too late to build before the break`).toBeLessThanOrEqual(50);
      expect(m, `tick at :${m} is needlessly early`).toBeGreaterThanOrEqual(35);
    }
  });

  it('has no timezone left to get wrong', () => {
    // The Chicago window gate was deleted with the five-window schedule. It
    // existed only to turn ten UTC cron hours into five local ones, which is
    // a DST bug waiting for the two days a year the clocks move. Every hour
    // is a window now, so there is nothing to convert.
    //
    // Asserted on the RUNNABLE lines, not on the appearance of the strings:
    // the comment that removed the gate names it in order to explain what
    // changed, and a test that forbids naming the bug forbids documenting it.
    // (Same reasoning as drainProtectsEveryHand's humansSeatedTotal check.)
    const runnable = HETZNER.split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(runnable).not.toMatch(/HOUR=\$\(TZ=America\/Chicago/);
    expect(runnable).not.toMatch(/case "\$HOUR" in/);
    expect(runnable).not.toMatch(/::warning title=OUTSIDE THE RESTART WINDOW::/);
  });

  it('manual dispatch cannot bypass the durable break gate', () => {
    const gate = HETZNER.slice(
      HETZNER.indexOf('Wait for the maintenance break'),
      HETZNER.indexOf('Cut over to the new image')
    );
    expect(gate).not.toMatch(/github\.event\.inputs\.force/);
    expect(gate).not.toMatch(/skipping the break gate/);
    expect(gate).toMatch(/durableConfirmed/);
  });

  it('waits for the announced break instead of racing the hands', () => {
    /**
     * REPLACED THE DRAIN RACE (Dan 2026-09-01). This test used to pin the
     * opposite behaviour - "inside a window the deploy proceeds regardless" -
     * because the old gate polled for a moment when no table was mid-hand and
     * a fleet dealing ~290 hands a minute never reports one. The only path
     * that ever actually deployed was a 45-minute staleness cap that restarted
     * straight through live play.
     *
     * The engine now DECLARES a stop rather than the workflow hunting for one:
     * every table is parked between hands at :55 and `readyForRestart` opens.
     * That is not a snapshot that can go stale between the read and the
     * SIGTERM - the platform is held still, on purpose, for five minutes.
     */
    const gate = HETZNER.slice(
      HETZNER.indexOf('Wait for the maintenance break'),
      HETZNER.indexOf('Cut over to the new image')
    );
    expect(gate).toMatch(/maintenance/);
    expect(gate).toMatch(/readyForRestart/);
    expect(gate).toMatch(/durableConfirmed/);
    // The old "a scheduled window means proceed anyway" escape must be gone,
    // or the break is decorative and the restart still lands on live tables.
    expect(gate).not.toMatch(/event_name \}\}" = "schedule"/);
    // Fails CLOSED: a break that never opens defers the deploy rather than
    // restarting outside it. A missed window costs six hours of slightly
    // older code; restarting outside the break costs somebody's hand.
    expect(gate).toMatch(/BREAK NEVER OPENED/);
    expect(gate).toMatch(/skip=true/);
  });

  it('fails closed when the running engine cannot publish the durable contract', () => {
    const gate = HETZNER.slice(
      HETZNER.indexOf('Wait for the maintenance break'),
      HETZNER.indexOf('Cut over to the new image')
    );
    expect(gate).toMatch(/INCOMPATIBLE/);
    expect(gate).toMatch(/DURABLE CERTIFICATE UNAVAILABLE/);
    expect(gate).toMatch(/skip=true/);
    expect(gate).not.toMatch(/LEGACY/);
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
    /* publish-to-origin needs BOTH heavy jobs, so a deduped cycle skips it for
       free: GitHub skips a job whose dependencies were skipped. That is also
       what stops it failing on a dist that was never built - no `always()`
       anywhere near it. */
    expect(SYNC).toMatch(/needs: \[build-and-store, client-tests\]/);
    const sync = sliceYamlBlock(SYNC, '  publish-to-origin:');
    expect(sync).not.toMatch(/if: always\(\)/);
  });
});
