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
 *
 * 2026-09-10: both the coalescing skip and the catch-up schedule are gone. The
 * :55 break gate is the spacing, every engine push starts its own run, and a
 * run that cannot ship hands the train on itself. What survives from above is
 * the first answer - a run that shipped nothing says so where it is seen -
 * and the Verdict step now makes such a run RED.
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
      /if: steps\.dedupe\.outputs\.skip == 'true' \|\| steps\.drain\.outputs\.skip == 'true'/
    );
  });

  it('annotates a run that shipped nothing as a WARNING, and has no spacing skip left', () => {
    // A notice does not surface on a green run. A warning does.
    expect(HETZNER).toMatch(/::warning title=DID NOT DEPLOY::/);
    expect(HETZNER).not.toMatch(/::notice::Engine restarted only/);
    // 2026-09-10: the 20-minute restart-coalescing skip is GONE. Every restart
    // happens inside the :55 break gate, one run at a time, so the break is
    // the spacing - and with no cron left, a coalesced run would strand the
    // very commit it was asked to ship, because nothing comes back for it.
    const runnable = HETZNER.split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(runnable).not.toMatch(/MIN_RESTART_SPACING_SEC/);
    expect(runnable).not.toMatch(/reason=coalesced/);
    expect(runnable).not.toMatch(/::warning title=NOT DEPLOYED::/);
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
    const supersededAt = block.indexOf('superseded');
    expect(drainAt, 'the break gate is one of the reasons').toBeGreaterThan(-1);
    expect(gateReasonAt, 'and it supplies its own reason').toBeGreaterThan(-1);
    expect(supersededAt, 'superseded is a reason').toBeGreaterThan(-1);
    expect(drainAt, 'the gate that held is read FIRST').toBeLessThan(supersededAt);
    // The spacing skip was deleted on 2026-09-10; a reason that names it
    // would send the reader to investigate a gate that no longer exists.
    expect(block, 'coalescing is not a reason any more').not.toContain('coalescing');

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

    // A skipped run must not advertise an unsafe escape hatch. Dispatching
    // still stages immediately, but only a fresh maintenance certificate may
    // authorize the stop/start transition.
    const step = sliceYamlEntry(HETZNER, "name: 'DID NOT DEPLOY");
    expect(step).not.toMatch(/force=true|voids in-flight hands/);
    expect(step).toMatch(/readyForRestart certificate/);
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

  /**
   * 2026-09-10, Dan: "i do not want any watch dogs, i want hard coded fixes
   * that solve this problem and prevent it from breaking or regressing, i want
   * any and all pushes to be published in the order that they come in!"
   *
   * This test used to pin the opposite - "never restarts on a merge - there is
   * no push trigger" - from the 2026-08-31 rule, when a merge RESTARTED
   * production (263 times in one week). What that rule protects still holds,
   * and is pinned below: a merge starts a run, and the run restarts nothing
   * until the break gate has a fresh certificate.
   */
  it('every engine push starts its own run, and nothing in that run restarts outside the break', () => {
    const triggers = HETZNER.slice(HETZNER.indexOf('\non:'), HETZNER.indexOf('\nconcurrency:'));
    const push = sliceYamlBlock(triggers, '  push:');
    expect(push).toMatch(/branches: \[main\]/);
    // The engine's runtime paths, the same set engine-watchdog.sh measures
    // "behind" against: a test or a sim change never enters the image.
    expect(push).toContain("- 'server/**'");
    expect(push).toContain("- '!server/**/*.test.ts'");
    expect(push).toContain("- '!server/sim/**'");
    expect(triggers).toMatch(/^\s{2}workflow_dispatch:/m);
    // The one queue: one run in flight, the newest push pending behind it.
    expect(HETZNER).toMatch(
      /concurrency:\s*\n\s*group: deploy-hetzner\s*\n\s*cancel-in-progress: false/
    );
    // And the restart is behind the break gate whatever started the run.
    const cutover = sliceYamlEntry(HETZNER, 'name: Cut over to the new image');
    expect(cutover).toMatch(
      /if: steps\.dedupe\.outputs\.skip != 'true' && steps\.drain\.outputs\.skip != 'true'/
    );
  });

  it('has no cron and needs no watchdog: the train hands itself on', () => {
    /**
     * The `35 * * * *` tick was the only scheduled start, and GitHub delivered
     * 3 of ~19 of them on 2026-09-10; engine-watchdog.sh and schedule-liveness
     * dispatched the rest, at whatever minute they ran. Both were band-aids on
     * a trigger that did not work, and Dan asked for neither. The start is now
     * the push itself, and the two ways a started train could stall hand on
     * from inside the run.
     */
    const triggers = HETZNER.slice(HETZNER.indexOf('\non:'), HETZNER.indexOf('\nconcurrency:'));
    expect(triggers).not.toMatch(/^\s{2}schedule:/m);
    expect(HETZNER).not.toMatch(/^\s*- cron:/m);

    // 1. A run that main superseded dispatches current main before it goes,
    //    because the commits that moved main may have started no run.
    const stage = sliceYamlEntry(HETZNER, 'name: Stage the current release proof control');
    expect(stage).toMatch(
      /echo "superseded=true" >> "\$GITHUB_OUTPUT"\s*\n\s*if gh workflow run auto-deploy-hetzner\.yml --repo "\$GITHUB_REPOSITORY" --ref main; then/
    );
    // 2. A run its break gate could not serve dispatches its successor -
    //    and ONLY those: a failed test, build or cutover never retries itself.
    //    A deliberate lease deferral hands on too: its commit still has to ship.
    const verdict = sliceYamlEntry(HETZNER, "name: 'Verdict");
    expect(verdict).toMatch(
      /hand_on\(\) \{\s*\n\s*if gh workflow run auto-deploy-hetzner\.yml --repo "\$GITHUB_REPOSITORY" --ref main; then/
    );
    expect(verdict).toMatch(
      /"\$GATE_KIND" = "staged_deferred" \] \|\| \[ "\$GATE_KIND" = "no_certificate" \]; \}; then\s*\n\s*hand_on/
    );
    expect(verdict).toMatch(
      /"\$GATE_KIND" = "lease_held_elsewhere" \]; then[\s\S]{0,300}?hand_on \|\| exit 1\s*\n\s*exit 0/
    );
    // 3. (2026-09-11) A run that never touched production heals itself: a
    //    cancel hands on, and a failure retries up to DEPLOY_RETRY_LIMIT failed
    //    runs per commit, counted from the API, failing closed when uncounted.
    //    A run whose cutover RAN never hands on - that would restart production
    //    into a broken build every hour.
    const failed = sliceBetween(
      verdict,
      'if [ "$JOB_STATUS" != "success" ]; then',
      '\n          fi\n          if [ "$SHIPPED"'
    );
    expect(failed).toMatch(
      /if \[ -z "\$CUTOVER_OUTCOME" \] \|\| \[ "\$CUTOVER_OUTCOME" = "skipped" \]; then/
    );
    expect(failed).toMatch(
      /if \[ "\$JOB_STATUS" = "cancelled" \]; then[\s\S]{0,200}?hand_on \|\| true/
    );
    expect(failed).toMatch(
      /gh run list --repo "\$GITHUB_REPOSITORY" \\\s*\n\s*--workflow auto-deploy-hetzner\.yml --commit "\$SHA" --status failure/
    );
    expect(failed).toMatch(
      /if \[ "\$FAILED_BEFORE" -lt "\$DEPLOY_RETRY_LIMIT" \]; then[\s\S]{0,300}?hand_on \|\| true/
    );
    expect(failed).toMatch(/::error title=GAVE UP ON/);
    expect(failed, 'an unreadable count stops, never loops').toMatch(
      /''\|\*\[!0-9\]\*\)[\s\S]{0,400}?::error title=TRAIN STOPPED::/
    );
    expect(verdict).toMatch(/CUTOVER_OUTCOME: \$\{\{ steps\.cutover\.outcome \}\}/);
    expect(Number(verdict.match(/DEPLOY_RETRY_LIMIT: '(\d+)'/)![1])).toBeGreaterThan(0);
    // Every hand-on in the failed/cancelled branch sits inside the
    // "production was never touched" guard.
    const guardAt = failed.indexOf('if [ -z "$CUTOVER_OUTCOME" ]');
    for (const at of [...failed.matchAll(/hand_on \|\| true/g)].map((m) => m.index!)) {
      expect(at).toBeGreaterThan(guardAt);
    }
    // All four hand-on sites, and no others: lease deferral, gate decline,
    // cancel, bounded retry.
    const calls = verdict.split('\n').filter((l) => /^\s*hand_on\b(?!\(\))/.test(l));
    expect(calls.length).toBe(4);
    expect(verdict).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
    // A hand-on that could not be made is red, never silent.
    expect(stage).toMatch(/::error title=TRAIN STOPPED::/);
    expect(verdict).toMatch(/::error title=TRAIN STOPPED::/);
    // The token may dispatch, and is named in full.
    const job = sliceYamlBlock(HETZNER, '    permissions:');
    expect(job).toMatch(/actions: write/);
    expect(job).toMatch(/contents: read/);
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

  it('has no force path around the maintenance certificate', () => {
    const gate = HETZNER.slice(
      HETZNER.indexOf('Wait for the maintenance break'),
      HETZNER.indexOf('Cut over to the new image')
    );
    expect(HETZNER).not.toMatch(/github\.event\.inputs\.force|force=true/);
    expect(gate).not.toMatch(/skipping the break gate/);
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
    // The old "a scheduled window means proceed anyway" escape must be gone,
    // or the break is decorative and the restart still lands on live tables.
    expect(gate).not.toMatch(/event_name \}\}" = "schedule"/);
    // Fails CLOSED: a break that never opens defers the deploy rather than
    // restarting outside it. A missed window costs six hours of slightly
    // older code; restarting outside the break costs somebody's hand.
    expect(gate).toMatch(/BREAK NEVER OPENED/);
    expect(gate).toMatch(/skip=true/);
  });

  it('does not treat a legacy health payload as restart authority', () => {
    const gate = HETZNER.slice(
      HETZNER.indexOf('Wait for the maintenance break'),
      HETZNER.indexOf('Cut over to the new image')
    );
    expect(gate).not.toMatch(/LEGACY ENGINE|LEGACY=yes/);
    expect(gate).toMatch(/Missing\/legacy\/straggler states are/);
  });

  it('treats a push and a dispatch the same: no event may skip or bypass anything', () => {
    // The spacing gate's "!= workflow_dispatch" bypass went with the gate.
    // What is left must not branch on who started the run, except for the
    // audited rollback, which exists only on a dispatch.
    const runnable = HETZNER.split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(runnable).not.toContain('!= "workflow_dispatch"');
    expect(runnable).not.toMatch(/github\.event_name \}\}" != /);
  });
});

describe('a green engine deploy means production serves the commit (2026-09-10)', () => {
  /**
   * The skip was visible, and it was still green. On 2026-09-10 five runs in
   * one afternoon ended "IMAGE STAGED, CUTOVER DEFERRED" or "BREAK NEVER
   * OPENED", every one GREEN, while production crash-looped on 7732b971 with
   * the fix merged. Only ca_engine_deploy_attempts said shipped=false, and
   * nobody reads a ledger when the Actions tab is green. The colour now carries
   * the outcome, decided once, at the very end, from the ledger's own
   * expression.
   */
  const code = HETZNER.split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const verdictAt = code.indexOf("- name: 'Verdict");
  const verdict = code.slice(verdictAt);
  const shippedOf = (hay: string) => {
    const m = hay.match(/^\s*SHIPPED: (\$\{\{.*\}\})\s*$/m);
    expect(m, 'a SHIPPED expression was not found').toBeTruthy();
    return m![1];
  };

  it('the verdict is the last step of the job and always runs', () => {
    expect(verdictAt, 'the Verdict step is missing').toBeGreaterThan(-1);
    expect(verdict.slice(1), 'no step may run after the verdict').not.toMatch(/\n\s*- name:/);
    expect(verdict).toMatch(/if: always\(\)/);
  });

  it('it decides from the SAME shipped expression the ledger records', () => {
    const ledger = code.slice(
      code.indexOf('- name: Record deploy truth in the database'),
      code.indexOf('- name: Cleanup SSH key')
    );
    expect(shippedOf(verdict)).toBe(shippedOf(ledger));
  });

  it('a run the break gate declined is red; already-live and superseded are green', () => {
    const script = verdict.slice(verdict.indexOf('run: |'));
    // Shipped -> exit 0 before anything else is considered.
    expect(script).toMatch(/if \[ "\$SHIPPED" = "true" \]; then[\s\S]{0,200}?exit 0/);
    // Deliberate stand-downs (already serving, superseded and handed on).
    expect(script).toMatch(/if \[ "\$DEDUPE_SKIP" = "true" \]; then[\s\S]{0,300}?exit 0/);
    // Everything else that reaches the end of a green job shipped nothing and
    // should have: that is a failure, and it says so in an error annotation.
    const tail = script.slice(script.lastIndexOf('::error title=DID NOT SHIP::'));
    expect(tail).toMatch(/^::error title=DID NOT SHIP::/);
    expect(tail.trim().endsWith('exit 1')).toBe(true);
    // Handing the train on happens on the way to red; it never turns it green.
    expect(tail).not.toMatch(/exit 0/);
    // An earlier failure is already red; the verdict never double-reports it
    // and never turns a red run green.
    const failedBranch = sliceBetween(
      script,
      'if [ "$JOB_STATUS" != "success" ]; then',
      '\n          fi\n          if [ "$SHIPPED"'
    );
    expect(failedBranch.trim().endsWith('exit 0')).toBe(true);
    expect(failedBranch, 'the verdict never turns a failed run red twice or green').not.toMatch(
      /exit 1/
    );
    expect(verdict).toMatch(/JOB_STATUS: \$\{\{ job\.status \}\}/);
  });

  it('a deliberate deferral names itself; a decline that should have shipped never does', () => {
    const script = verdict.slice(verdict.indexOf('run: |'));
    expect(script).toMatch(
      /if \[ "\$DRAIN_SKIP" = "true" \] && \[ "\$GATE_KIND" = "lease_held_elsewhere" \]; then[\s\S]{0,300}?exit 0/
    );
    // Budget and certificate declines are failures to ship. They are named in
    // the script for ONE reason only - to hand the train on - and that branch
    // sits after the DID NOT SHIP error, on the way to `exit 1`.
    const redAt = script.lastIndexOf('::error title=DID NOT SHIP::');
    expect(redAt).toBeGreaterThan(-1);
    for (const kind of ['staged_deferred', 'no_certificate']) {
      const at = script.indexOf(`"${kind}"`);
      expect(at, `${kind} is handed on`).toBeGreaterThan(redAt);
    }
    const gate = sliceYamlBlock(
      HETZNER,
      '      - name: Wait for the maintenance break to park every table'
    );
    expect((gate.match(/echo "gate_kind=[a-z_]+" >> \$GITHUB_OUTPUT/g) ?? []).length).toBe(
      (gate.match(/echo "skip=true" >> \$GITHUB_OUTPUT/g) ?? []).length
    );
  });

  it('every dedupe skip says which one it was, and already-live never claims the commit is missing', () => {
    const d = sliceYamlBlock(
      HETZNER,
      '      - name: Skip if production already serves this commit'
    );
    expect(
      (d.match(/echo "reason=(already_live|superseded)" >> \$GITHUB_OUTPUT/g) ?? []).length
    ).toBe((d.match(/echo "skip=true" >> \$GITHUB_OUTPUT/g) ?? []).length);
    expect(sliceYamlEntry(HETZNER, "name: 'DID NOT DEPLOY")).toMatch(
      /"already_live" \]; then\s*\n\s*echo "::notice title=ALREADY LIVE::/
    );
  });

  it('a superseded run stands down green instead of failing red', () => {
    // 8 of 8 red deploy runs on 2026-09-10 were runs whose workflow commit was
    // no longer main's tip - none a ship failure - and one opened a false
    // "train is failing" alarm (#4109).
    const stage = sliceYamlEntry(HETZNER, 'name: Stage the current release proof control');
    expect(stage).toMatch(
      /git merge-base --is-ancestor "\$CONTROL_SHA" "\$REMOTE_MAIN"[\s\S]{0,1200}?echo "superseded=true" >> "\$GITHUB_OUTPUT"[\s\S]{0,800}?exit 0/
    );
    // 2026-09-10: main moving is not the control plane moving. With a push
    // trigger the pending run is the newest ENGINE push and main keeps moving
    // under it with client merges; an ancestor whose deploy control plane is
    // byte-identical to main's ships its own commit instead of standing down.
    expect(stage).toMatch(
      /if git diff --quiet "\$CONTROL_SHA" "\$REMOTE_MAIN" -- \$CONTROL_PLANE; then\s*\n\s*echo "superseded=false" >> "\$GITHUB_OUTPUT"/
    );
    for (const path of [
      '.github/workflows/auto-deploy-hetzner.yml',
      'scripts/ci',
      'server/scripts',
    ]) {
      expect(stage, `${path} is part of the control plane`).toContain(path);
    }
    // A commit that is NOT an ancestor of main is still refused, red.
    expect(stage).toMatch(
      /not dispatched from current main; refusing rollbackable control-plane code"\s*\n\s*exit 1/
    );
    const d = sliceYamlBlock(
      HETZNER,
      '      - name: Skip if production already serves this commit'
    );
    expect(d).toMatch(
      /steps\.control\.outputs\.superseded \}\}" = "true" \]; then[\s\S]{0,120}?echo "skip=true"/
    );
  });

  it('the verdict reads production before it paints a run red', () => {
    const script = verdict.slice(verdict.indexOf('run: |'));
    const read = script.indexOf('/health?nocache=');
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(script.lastIndexOf('::error title=DID NOT SHIP::'));
  });

  it('nothing keyed on failure() can react to the verdict', () => {
    // The rollback is `if: failure() && ...`. A red verdict placed before it
    // would read as a failed deploy and could restore an image nobody replaced.
    const rollbackAt = code.indexOf('- name: ROLLBACK');
    expect(rollbackAt).toBeGreaterThan(-1);
    expect(rollbackAt).toBeLessThan(verdictAt);
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
