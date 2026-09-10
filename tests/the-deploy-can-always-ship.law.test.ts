/**
 * THE DEPLOY CAN ALWAYS SHIP.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT HAPPENED (2026-09-05, all figures read from production, none inferred)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `ca_engine_deploy_attempts`, 72 hours:
 *
 *   deployed and verified                          46
 *   the maintenance break never opened             23
 *   coalesced or already serving                   22
 *   run ended without a verified cutover            7
 *   ───────────────────────────────────────────────────
 *   98 attempts, 52 of which shipped NOTHING (53%)
 *
 * Every one of those 52 was a GREEN run. `gh run list` showed success.
 *
 * Three independent defects, each of which made a run report success while
 * deploying nothing, and each of which is pinned below:
 *
 *  1. THE COALESCING GATE READ THE WRONG CLOCK. It compared `/health.uptime`
 *     against a 20-minute spacing threshold. Uptime says when the PROCESS
 *     started; the gate wanted to know when the PIPELINE last restarted
 *     production. sp-autoheal bounced the engine five times that day (16:06,
 *     16:42, 17:49, 18:26, 19:04 UTC), each bounce resetting uptime, and every
 *     deploy in the following twenty minutes coalesced against a commit
 *     production was not serving. Run 33981313111 is the recorded case.
 *
 *  2. THE BREAK GATE COULD NOT AFFORD TO WAIT. Its budget is the job timeout
 *     minus the elapsed build minus a cutover reserve, and it refuses to wait
 *     when the next :55 is further away than that. With timeout 40 and an
 *     8-minute build the budget was 27 minutes, so any run arriving before :28
 *     quit — which is exactly where an off-cycle dispatch lands, and an
 *     off-cycle dispatch is what publish-watchdog fires when it notices the
 *     engine is behind. The recovery path was arithmetically incapable of
 *     recovering. Runs 33985138036 and 33986167969, back to back, both
 *     carrying aa6b6387, both green, both shipped nothing — after building it.
 *
 *  3. THE RUN NAMED THE WRONG GATE. One run gave three different answers: the
 *     step warning said "drain gate — hands are still in flight", the summary
 *     and the database said "the maintenance break never opened", and the
 *     truth was that it had declined to wait for a break that had not started.
 *     The `steps.window` branch it fell through was dead code for a gate
 *     deleted days earlier, and it advertised a 7am/7pm Chicago window that
 *     §13 abolished — the exact shape of stale text §13 was written about.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THESE ARE PINNED AS ONE LAW
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * All three are the same failure: a number or a string that was correct when
 * it was written, in a pipeline whose other numbers moved underneath it. The
 * build grew from 5 minutes to 18 and the budget did not. The restart moved
 * from twice a day to every hour and the reason text did not. The engine
 * acquired a sidecar that restarts it and the spacing clock did not.
 *
 * So this file does not check that the numbers are any particular value. It
 * checks that the numbers still AGREE WITH EACH OTHER, which is the property
 * that actually broke, and the one a human reviewer cannot hold in their head.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-09-10: THE ARITHMETIC ONLY CHECKED THE CALLER THAT HAD STOPPED CALLING
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  4. This file proved every CRON minute could reach the break, with a staged
 *     run assumed to reach the gate in 6 minutes. Neither held. The server
 *     suite runs before the gate on every run (~9 minutes; staged runs reached
 *     the gate after 10.3-11.7 minutes), and the cron was no longer the caller:
 *     GitHub delivered 3 of ~19 ticks that day and the DB dispatcher had been
 *     retired, so every run was an engine-watchdog or agent dispatch at an
 *     arbitrary minute. Any run that started before :10 or after :44 staged
 *     its image, went green and shipped nothing - five of them in one
 *     afternoon (34491811148, 34493149950, 34505100894, 34511390657,
 *     34516171966) - while production crash-looped on 7732b971 through three
 *     breaks with the fix merged. The law now covers EVERY start minute, cold
 *     and staged, and the watchdog's idea of a stale run must outlast the
 *     longest legitimate wait.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const WORKFLOW = join(ROOT, '.github/workflows/auto-deploy-hetzner.yml');
const yml = readFileSync(WORKFLOW, 'utf8');
const imageBuilder = readFileSync(join(ROOT, 'server/scripts/build-engine-image.sh'), 'utf8');

/** The step that decides whether to coalesce. */
function dedupeStep(): string {
  const start = yml.indexOf('- name: Skip if production already serves this commit');
  const end = yml.indexOf('- name: Setup Node 22', start);
  expect(start, 'the dedupe step has been renamed - re-point this law').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return yml.slice(start, end);
}

/** The step that waits for the announced :55 break. */
function breakGateStep(): string {
  const start = yml.indexOf('- name: Wait for the maintenance break to park every table');
  const end = yml.indexOf('- name: Cut over to the new image', start);
  expect(start, 'the break gate step has been renamed - re-point this law').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return yml.slice(start, end);
}

function num(pattern: RegExp, hay: string, what: string): number {
  const m = hay.match(pattern);
  expect(m, `${what} not found - this law reads it to check the arithmetic`).toBeTruthy();
  return Number(m![1]);
}

describe('the wait budget can actually reach the break', () => {
  /**
   * The build has been measured at 8-18 minutes (docs/changelog/
   * 2026-09-04-push-to-live-under-six-minutes.md, and the runs above). 18 is
   * the worst observed, so it is what the budget must survive.
   */
  const WORST_BUILD_MIN = 18;
  /**
   * A run that adopts an already-staged image: checkout, the server suite,
   * pull, adopt, supervisor, gate. MEASURED 2026-09-10, not assumed: 10.3-11.7
   * minutes (runs 34505100894, 34511390657, 34512893031, 34516171966); the
   * server suite alone is ~9. It was 6 here, which is how a 55-minute ceiling
   * looked sufficient for starts it could not serve.
   */
  const REUSED_ELAPSED_MIN = 12;
  /** A run that builds cold: everything above plus the worst observed build. */
  const COLD_ELAPSED_MIN = REUSED_ELAPSED_MIN + WORST_BUILD_MIN;
  /** The gate polls until the next :56 — one minute past the flag opening. */
  const GATE_MINUTE = 56;

  const timeoutMin = num(/^\s*timeout-minutes:\s*(\d+)\s*$/m, yml, 'job timeout-minutes');
  const gate = breakGateStep();
  const budgetTimeoutMin = num(
    /JOB_TIMEOUT_S=\$\(\(\s*(\d+)\s*\*\s*60\s*\)\)/,
    gate,
    'JOB_TIMEOUT_S'
  );
  const reserveS = num(/CUTOVER_RESERVE_S=(\d+)/, gate, 'CUTOVER_RESERVE_S');

  const cronMinutes = [...yml.matchAll(/^\s*-\s*cron:\s*'(\d+(?:,\d+)*)\s/gm)].flatMap((m) =>
    m[1].split(',').map(Number)
  );

  /** Minutes from `at` to the next occurrence of GATE_MINUTE. */
  const minutesToGate = (at: number) => (((GATE_MINUTE - at) % 60) + 60) % 60;

  it('the job timeout and the budget formula are the same number', () => {
    // They were 40 and `40 * 60` in two files-worth of context apart, and the
    // whole class of defect here is one of them being changed alone.
    expect(
      budgetTimeoutMin,
      `timeout-minutes is ${timeoutMin} but the break gate budgets for ${budgetTimeoutMin} minutes`
    ).toBe(timeoutMin);
  });

  it('at least one scheduled tick can build from cold AND still reach the break', () => {
    expect(cronMinutes.length, 'no cron schedule found').toBeGreaterThan(0);
    const budgetMin = timeoutMin - WORST_BUILD_MIN - reserveS / 60;
    const survivors = cronMinutes.filter(
      (m) => minutesToGate((m + WORST_BUILD_MIN) % 60) <= budgetMin
    );
    expect(
      survivors.length,
      `no cron minute (${cronMinutes.join(', ')}) can build for ${WORST_BUILD_MIN}m and still ` +
        `wait ${budgetMin}m for :${GATE_MINUTE}. This is the 2026-09-05 defect: a run that ` +
        `does all the work and then refuses to spend the last three minutes.`
    ).toBeGreaterThan(0);
  });

  it('EVERY scheduled tick reaches the break once the image is staged', () => {
    // The staged-image path is the one that must never fail, because it is the
    // path a retry takes: the previous run (or an off-cycle dispatch) built the
    // image, so this run's only job is to be present at :55.
    const budgetMin = timeoutMin - REUSED_ELAPSED_MIN - reserveS / 60;
    for (const m of cronMinutes) {
      const wait = minutesToGate((m + REUSED_ELAPSED_MIN) % 60);
      expect(
        wait,
        `a :${m} tick reusing a staged image reaches the gate with ${wait}m to wait but only ` +
          `${budgetMin}m of budget`
      ).toBeLessThanOrEqual(budgetMin);
    }
  });

  it('EVERY start minute reaches the next break, staged or cold', () => {
    // The caller is not the cron. engine-watchdog.sh and agents dispatch at
    // whatever minute they happen to run, so the budget has to serve all
    // sixty. +1 because a run reaching the gate at :56:59 waits 59m59s, not 59m.
    for (const elapsed of [REUSED_ELAPSED_MIN, COLD_ELAPSED_MIN]) {
      const budgetMin = timeoutMin - elapsed - reserveS / 60;
      for (let start = 0; start < 60; start++) {
        const wait = minutesToGate((start + elapsed) % 60) + 1;
        expect(
          wait,
          `a run started at :${String(start).padStart(2, '0')} reaches the gate after ${elapsed}m ` +
            `and must wait ${wait}m for :${GATE_MINUTE}, but only has ${budgetMin}m of budget - ` +
            `it would stage its image, go green and ship nothing (the 2026-09-10 defect)`
        ).toBeLessThanOrEqual(budgetMin);
      }
    }
  });

  it('the watchdog never treats a run waiting for its break as stale', () => {
    // A run can now legitimately hold the deploy group for up to an hour. If
    // the watchdog's in-flight window were shorter than the job ceiling, it
    // would decide that run was a zombie and dispatch another behind it.
    const sh = readFileSync(join(ROOT, '.github/scripts/engine-watchdog.sh'), 'utf8');
    const stale = num(
      /INFLIGHT_STALE_MIN=\$\{INFLIGHT_STALE_MIN:-(\d+)\}/,
      sh,
      'INFLIGHT_STALE_MIN'
    );
    expect(
      stale,
      `engine-watchdog.sh treats runs older than ${stale}m as stale, but a deploy may run ${timeoutMin}m`
    ).toBeGreaterThan(timeoutMin);
  });

  it('refusing to wait says the image is staged, and does not blame the break', () => {
    // The refusal is legitimate. Reporting it as "the maintenance break never
    // opened" is not: 23 rows in ca_engine_deploy_attempts blamed a break that
    // had never been reached, which is where two hours of investigation went.
    const refusal = gate.slice(gate.indexOf('SECS_TO_GATE" -gt "$BUDGET_CAP_S'));
    expect(refusal).toMatch(/gate_reason=image staged/);
    expect(refusal.slice(0, refusal.indexOf('exit 0'))).not.toMatch(/break never opened/i);
  });
});

describe('the coalescing gate asks when WE last restarted production', () => {
  const step = dedupeStep();

  it('the spacing decision does not read /health.uptime', () => {
    // THE REGRESSION, BY NAME. Uptime is reset by anything that restarts the
    // container - sp-autoheal did it five times in one day - so a gate keyed on
    // it defers to events that are not deploys and cannot tell the difference.
    const decision = step.slice(step.indexOf('github.event_name'), step.indexOf('skip=false'));
    expect(
      decision,
      'the spacing gate is comparing UPTIME again - it must compare the last SHIPPED deploy'
    ).not.toMatch(/\$UPTIME"?\s*-lt\s*"?\$MIN_RESTART_SPACING_SEC/);
    expect(decision).toMatch(/SINCE_SHIPPED_N"?\s*-lt\s*"?\$MIN_RESTART_SPACING_SEC/);
  });

  it('the spacing clock comes from the deploy ledger', () => {
    expect(step).toMatch(/last-shipped-engine-deploy\.mjs/);
    expect(existsSync(join(ROOT, 'scripts/ci/last-shipped-engine-deploy.mjs'))).toBe(true);
  });

  it('an unreadable ledger does NOT coalesce', () => {
    // Failing closed here means declining to ship, which is the failure this
    // whole change exists to remove. The break gate downstream is what keeps a
    // restart inside an announced window; spacing is only a courtesy.
    const script = readFileSync(join(ROOT, 'scripts/ci/last-shipped-engine-deploy.mjs'), 'utf8');
    expect(script).toMatch(/'ERR'/);
    expect(script).toMatch(/'NEVER'/);
    // Non-numeric answers become -1, and the gate requires >= 0 to coalesce.
    expect(step).toMatch(/SINCE_SHIPPED_N=-1/);
    expect(step).toMatch(/SINCE_SHIPPED_N"?\s*-ge\s*0/);
  });

  it('a restart nobody asked for is reported', () => {
    // An engine younger than our own last deploy was restarted by something
    // else, outside the announced break, voiding live hands (§13, §10.5).
    // Until 2026-09-05 that was visible only as a deploy that mysteriously
    // coalesced - it was never once stated out loud.
    expect(step).toMatch(/unplanned_restart=true/);
    expect(step).toMatch(/UNPLANNED RESTART/);
  });
});

describe('a run that ships nothing names the gate that actually held', () => {
  it('the deleted restart-window gate is not referenced anywhere', () => {
    // `steps.window` has not existed since the hourly :55 break replaced the
    // Chicago windows. A missing step's output is '' and never 'false', so the
    // branch was unreachable while reading as a live gate - and it told every
    // agent who got that far that a 7am/7pm window still governs deploys.
    const code = yml.replace(/^\s*#.*$/gm, '');
    expect(code, 'steps.window was deleted with the restart-window gate').not.toMatch(
      /steps\.window/
    );
    expect(
      code,
      '§13: the 7am/7pm Chicago window is gone. Do not describe it as live.'
    ).not.toMatch(/7am\/7pm/);
  });

  it('every path that declines the cutover records why', () => {
    const gate = breakGateStep();
    const skips = [...gate.matchAll(/echo "skip=true" >> \$GITHUB_OUTPUT/g)].length;
    const reasons = [...gate.matchAll(/echo "gate_reason=/g)].length;
    expect(
      reasons,
      `${skips} paths in the break gate set skip=true but only ${reasons} record a gate_reason. ` +
        `A path that skips without saying why is how one run came to give three different answers.`
    ).toBe(skips);
  });

  it('the warning, the summary and the database all read the same reason', () => {
    // Three consumers, one string. They disagreed on run 33986167969 and the
    // loudest of the three was the only one that was false.
    const didNotDeploy = yml.slice(
      yml.indexOf("- name: 'DID NOT DEPLOY"),
      yml.indexOf('- name: Post-deploy summary')
    );
    expect(didNotDeploy).toMatch(/steps\.drain\.outputs\.gate_reason/);
    const truth = yml.slice(yml.indexOf('- name: Record deploy truth in the database'));
    expect(truth).toMatch(/steps\.drain\.outputs\.gate_reason/);
    expect(
      truth,
      'the ledger must not hard-code a break failure for every way the gate can decline'
    ).not.toMatch(/skip == 'true' && 'the maintenance break never opened for a restart'/);
  });
});

describe('an unannounced restart is an incident, and something watches for one', () => {
  const rules = readFileSync(join(ROOT, 'infra/monitoring/engine-freeze-rules.yml'), 'utf8');

  it('a single restart outside a maintenance break alerts', () => {
    // NOTHING watched for this before 2026-09-05. EngineTableRebuildChurn
    // needs FOUR restarts in thirty minutes; the real pattern was one every
    // 35-70 minutes - five unannounced restarts in a day, every one under the
    // threshold and therefore silent. They were found only because they were
    // also breaking deploys, which is a coincidence, not a detector.
    expect(rules).toMatch(/alert:\s*EngineRestartedOutsideTheBreak/);
    const alert = rules.slice(rules.indexOf('alert: EngineRestartedOutsideTheBreak'));
    const expr = alert.slice(0, alert.indexOf('for:'));
    // resets(), not changes(): changes() counts every scrape of a monotonic
    // counter and fires forever on a healthy engine (measured 2026-08-16,
    // changes()=118 vs resets()=3), which trains people to ignore it.
    expect(expr).toMatch(/resets\(poker_uptime_seconds/);
    expect(expr).not.toMatch(/changes\(poker_uptime_seconds/);
    // Guarded by the break, or it pages every hour about a stop we scheduled
    // (§13 rule 6).
    expect(expr).toMatch(/poker_maintenance_break_active/);
    // ONE restart. A threshold here re-creates the blind spot it was written
    // to close.
    expect(expr).toMatch(/>\s*0\b/);
  });
});

describe('the watchdog can say WHY production is behind', () => {
  const sh = readFileSync(join(ROOT, '.github/scripts/engine-watchdog.sh'), 'utf8');

  it('the staleness issue quotes the pipeline ledger', () => {
    // Staleness said "the engine is behind" and never once said why, while
    // ca_engine_deploy_attempts held the pipeline's own recorded reason for
    // every one of the 52 runs that shipped nothing.
    expect(existsSync(join(ROOT, '.github/scripts/deploy-ship-rate.mjs'))).toBe(true);
    expect(sh).toMatch(/deploy-ship-rate\.mjs/);
    expect(sh).toMatch(/\$LEDGER/);
  });

  it('the evidence is optional and can never fail the watchdog', () => {
    // A watchdog that dies because its optional evidence was unavailable is
    // worse than one that reports without it.
    const script = readFileSync(join(ROOT, '.github/scripts/deploy-ship-rate.mjs'), 'utf8');
    expect(script).toMatch(/process\.exit\(0\)/);
    expect(sh).toMatch(/if \[ -n "\$\{DATABASE_URL:-\}" \]/);
  });

  it('being behind always dispatches a deploy, even far from the break', () => {
    // It used to refuse unless the next :55 was within 13 minutes, because a
    // run that cannot reach the break "provably ships nothing". That rule was
    // concentrating every dispatch into :42-:47, where the build then outlived
    // the break it was aimed at. Since 2026-09-10 the deploy's ceiling lets a
    // run started at ANY minute wait in its gate for the next :55 it can
    // reach, so a dispatch always ships at a break - the only question is
    // which one, and the watchdog says so.
    const block = sh.slice(sh.indexOf('MINS_TO_WINDOW='), sh.indexOf('BODY=$(cat'));
    expect(block).toMatch(/gh workflow run/);
    expect(
      block,
      'a dispatch must no longer be gated on the break being close - it stages the image either way'
    ).not.toMatch(/if \[ "\$MINS_TO_WINDOW" -le \d+ \]; then\s*\n\s*if gh workflow run/);
    expect(block).toMatch(/waits in the break gate/);
    expect(block, 'the :35 tick is not a caller anyone can rely on').not.toMatch(
      /:35 tick cuts over/
    );
  });
});

describe('an image is built once per commit', () => {
  it('a staged image is adopted instead of rebuilt', () => {
    // The revision, exact server-tree ID and clean-build contract together
    // prove the bytes are identical. Rebuilding is 8-18 minutes spent
    // reproducing a proven image, and those are the minutes the break gate
    // then does not have. This is what makes a retry cheap enough to succeed.
    const start = yml.indexOf('- name: Build immutable image');
    expect(start, 'the build step has been renamed - re-point this law').toBeGreaterThan(-1);
    const step = yml.slice(start, yml.indexOf('- name: Install/refresh host supervisor', start));
    expect(step).toMatch(/build-engine-image\.sh/);
    expect(imageBuilder).toMatch(/docker image inspect "\$IMAGE_REF"/);
    expect(imageBuilder).toMatch(/EXISTING_REVISION/);
    expect(imageBuilder).toMatch(/EXISTING_TREE/);
    expect(imageBuilder).toMatch(/EXISTING_CONTRACT/);
    expect(imageBuilder).toMatch(/ENGINE_IMAGE_REUSED=true/);
    // The adoption must come BEFORE the build, or it is decoration.
    expect(imageBuilder.indexOf('ENGINE_IMAGE_REUSED=true')).toBeLessThan(
      imageBuilder.indexOf('docker build')
    );
  });
});
