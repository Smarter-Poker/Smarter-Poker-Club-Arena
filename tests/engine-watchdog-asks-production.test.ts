/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A GREEN DEPLOY DOES NOT MEAN THE ENGINE IS RUNNING MAIN
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * auto-deploy-hetzner.yml is careful in exactly the ways that make it quiet. It
 * COALESCES a restart inside MIN_RESTART_SPACING_SEC and exits 0, and its drain
 * gate DEFERS while hands are in flight and exits 0. Both are correct. Both
 * report success. So the deploy run being green says nothing about what
 * production is actually running.
 *
 * The twenty-minute catch-up schedule is meant to land the deferred commit, but GitHub
 * schedules are best-effort. On 2026-08-27 a merged engine fix sat unshipped for
 * about two hours behind a green tick on every run and only landed because a
 * human dispatched the workflow by hand - which RULE 5 says should never be the
 * remedy.
 *
 * publish-watchdog already asks this question of the CLIENT bundle. These pin
 * that it now asks it of the ENGINE too, and that the answer has consequences.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const SH = read('.github/scripts/engine-watchdog.sh');
/** Shell comments explain what the script deliberately does NOT do, and they
 *  name those things. A negative assertion has to read the code. */
const SH_CODE = SH.split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');
const WF = read('.github/workflows/publish-watchdog.yml');

describe('the watchdog asks production, not the pipeline', () => {
  it('reads the engine health endpoint for the sha it is serving', () => {
    expect(SH).toContain('$ENGINE_URL/health');
    expect(SH).toContain('"version"');
  });

  it('compares against the newest commit that actually enters the image', () => {
    // Tests and sim never reach the runtime image, and auto-deploy-hetzner
    // excludes them from its trigger. Demanding the engine serve one would be a
    // permanent false alarm.
    expect(SH).toContain("'server/**'");
    expect(SH).toContain(':(exclude)server/**/*.test.ts');
    expect(SH).toContain(':(exclude)server/sim/**');
  });

  it('asks whether the engine is at OR AHEAD of that commit', () => {
    // An equality check would cry wolf every time the engine legitimately ran
    // a newer sha than the last server-touching change.
    expect(SH).toContain('git merge-base --is-ancestor "$REQ_SHA" "$SERVED"');
  });
});

describe('it fails in the safe direction', () => {
  it('treats an unreadable /health as unknown, never as behind', () => {
    // Guessing "behind" from silence would dispatch restarts into an outage.
    expect(SH).toContain('ENGINE HEALTH UNREADABLE');
    expect(SH).toMatch(/if \[ -z "\$\{SERVED:-\}" \][\s\S]{0,600}?exit 0/);
  });

  it('gives the catch-up schedule a grace window before raising anything', () => {
    /**
     * One missed twenty-minute tick is ordinary. Three in a row is the failure.
     *
     * READ THE ARITHMETIC, NOT THE PROSE (2026-09-01). This assertion used to
     * be the single sentence the script printed while it waited, `inside the
     * ${GRACE_MIN}m grace window`. #2446 gave the engine a RESTART SCHEDULE and
     * replaced that message. The grace window itself survived -- it is the
     * FLOOR under the new schedule deadline -- but the pin went red on main,
     * and `npx vitest run tests/` is the step that publishes the Club Arena
     * bundle, so the World Hub sync failed on every commit until it was found.
     *
     * A pin on wording fails when the wording improves and passes when the
     * behaviour is deleted, which is backwards. The assertions below read the
     * shape of the calculation instead. Two of them still name a message; if
     * the prose changes again, MOVE those two rather than deleting the
     * arithmetic underneath them.
     */
    /*
     * UPDATED 2026-09-01. This asserted
     * RESTART_HOURS="${RESTART_HOURS:-04 10 14 18 22}" - the five Chicago
     * windows. Dan moved deploys to every hour on the :55 and #2527 changed
     * auto-deploy-hetzner.yml without changing the watchdog, so the pin was
     * holding the DESYNCHRONISED value in place: at 18:32 UTC the engine had
     * been fourteen and a half hours stale and every run reported success.
     *
     * The shape being pinned is unchanged and is the point - a deadline built
     * from the next restart boundary plus deploy time, floored by the grace
     * period. Only the boundary's definition moved, from an hour in a list to
     * a minute in every hour. The agreement with the deploy workflow is now
     * asserted directly, further down, so the two cannot drift again.
     */
    expect(SH).toContain('GRACE_MIN="${GRACE_MIN:-45}"');
    expect(SH).toContain('RESTART_MINUTE="${RESTART_MINUTE:-55}"');
    expect(SH).toContain('DEPLOY_MIN="${DEPLOY_MIN:-25}"');
    // 2026-09-02: the epoch feeding this moved from REQ_EPOCH (the NEWEST
    // engine commit) to BEHIND_SINCE_EPOCH (the oldest one production does not
    // have). The SHAPE this test pins - next restart boundary plus deploy
    // time, floored by the grace - is unchanged; what changed is that the
    // clock no longer restarts every time somebody merges. Anchored to the
    // newest commit, this watchdog was silent through fourteen hours of
    // stranded code, which is the same incident the comment above describes,
    // one level deeper than the RESTART_MINUTE desync that was fixed then.
    expect(SH).toContain('WINDOW_EPOCH=$(window_at_or_after "$BEHIND_SINCE_EPOCH")');
    // Same 2026-09-02 move as WINDOW_EPOCH above: the grace is still
    // GRACE_MIN long and still floors the deadline, but it now starts when
    // production fell behind instead of at the newest merge, so it is spent
    // once rather than renewed by every commit.
    expect(SH).toContain('GRACE_DEADLINE=$(( BEHIND_SINCE_EPOCH + GRACE_MIN * 60 ))');
    expect(SH).toContain('[ "$GRACE_DEADLINE" -gt "$DEADLINE" ] && DEADLINE=$GRACE_DEADLINE');
    expect(SH).toContain('Engine watchdog: waiting for the restart window');
    // ...and inside that deadline the script says its piece and STOPS, before
    // the ENGINE BEHIND warning section 5 raises. Without this, a deadline that
    // is computed and then ignored still passes every assertion above it.
    expect(SH_CODE).toMatch(/if \[ "\$NOW_EPOCH" -lt "\$DEADLINE" \][\s\S]{0,900}?exit 0/);
    expect(SH_CODE.indexOf('NOW_EPOCH" -lt "$DEADLINE')).toBeLessThan(
      SH_CODE.indexOf('ENGINE BEHIND')
    );
  });

  it('does not fail the job, because the alarm is the point', () => {
    // A red workflow nobody can act on faster than the watchdog already has is
    // noise, and noise teaches people to ignore the alarm.
    expect(SH.trimEnd().endsWith('exit 0')).toBe(true);
  });
});

describe('it fixes what it finds, and only then complains', () => {
  it('dispatches the deploy itself rather than telling a human to', () => {
    expect(SH).toContain('gh workflow run "$DEPLOY_WORKFLOW"');
    expect(SH).toContain('DEPLOY_WORKFLOW:-auto-deploy-hetzner.yml');
  });

  it('raises exactly one self-closing issue', () => {
    expect(SH).toContain('ISSUE_TITLE="Engine watchdog: production is not running main"');
    expect(SH).toContain('close_issue');
    // The search index is eventually consistent and duplicated issues in this
    // estate before; the plain list endpoint is current.
    expect(SH_CODE).toContain('gh issue list');
    expect(SH_CODE).not.toContain('--search');
  });

  it('does not dispatch while a deploy run is already in flight', () => {
    /**
     * 2026-09-09. This job runs on every completion of the publisher plus two
     * crons, and the dispatch was unconditional. auto-deploy-hetzner.yml keeps
     * one run active and ONE pending in its concurrency group, and each new
     * dispatch cancels the pending one. So every sweep while the engine was
     * behind cancelled the run that was sitting in the break gate waiting for
     * :55 - the watchdog was the thing keeping the engine from catching up.
     * Measured: nine engine commits, two breaks passed, engine three hours
     * behind, about twenty dispatches.
     */
    // It asks the deploy workflow for runs that are not completed...
    expect(SH_CODE).toContain('gh run list --repo "$REPO" --workflow "$DEPLOY_WORKFLOW"');
    expect(SH_CODE).toContain('select(.status != \\"completed\\")');
    // ...ignores only a run older than the deploy's own ceiling (55m + margin),
    // which GitHub has timed out or which is a pre-queued zombie...
    expect(SH).toContain('INFLIGHT_STALE_MIN=${INFLIGHT_STALE_MIN:-65}');
    // ...and the dispatch is the ELSE branch of finding one. The in-flight run
    // is the fix; a second dispatch would cancel it, not hurry it.
    expect(SH_CODE).toMatch(
      /if \[ -n "\$\{INFLIGHT:-\}" \]; then[\s\S]{0,600}?elif gh workflow run "\$DEPLOY_WORKFLOW"/
    );
    expect(SH_CODE.indexOf('INFLIGHT=$(gh run list')).toBeLessThan(
      SH_CODE.indexOf('gh workflow run "$DEPLOY_WORKFLOW"')
    );
  });

  it('comments on the open issue at most every COMMENT_EVERY_MIN, not every sweep', () => {
    // Forty "Still behind" comments in three hours buried the one table that
    // says why. The alarm is raised once; progress is reported on a clock.
    expect(SH).toContain('COMMENT_EVERY_MIN=${COMMENT_EVERY_MIN:-30}');
    expect(SH_CODE).toMatch(
      /if \[ -n "\$\{LAST_COMMENT_AGE_MIN:-\}" \] && \[ "\$LAST_COMMENT_AGE_MIN" -lt "\$COMMENT_EVERY_MIN" \]; then/
    );
  });

  it('reads and writes issues with the same token', () => {
    // A read on the App token and a write on GITHUB_TOKEN disagreed about who
    // they were and filed six duplicate issues across two repos.
    const reads = SH.match(/GH_TOKEN="\$\{GH_TOKEN_ISSUES:-\$\{GH_TOKEN:-\}\}"/g) ?? [];
    expect(reads.length).toBeGreaterThanOrEqual(2);
  });
});

describe('and it is actually scheduled to run', () => {
  it('is a job in the publish watchdog, which runs on a real schedule', () => {
    expect(WF).toContain('bash .github/scripts/engine-watchdog.sh');
    // 2026-09-01 (cost audit): the watchdog schedule went */30 -> hourly. The
    // workflow_run trigger still fires after every publish attempt, and
    // engine deploy truth is now ALSO watched database-side every 10 minutes
    // by fn_ca_engine_deploy_truth_watch() via pg_cron, which is the net that
    // still works when Actions itself is the outage. The pin asserts a
    // schedule EXISTS, so the job can never quietly lose its cron entirely.
    expect(WF).toMatch(/cron: '\S+ \* \* \* \*'/);
  });

  it('is its own job, so an engine problem cannot hide behind a bundle problem', () => {
    expect(WF).toMatch(/^ {2}engine:$/m);
    expect(WF).toMatch(/^ {2}watch:$/m);
  });

  it('has the permissions it needs to dispatch and to speak', () => {
    expect(WF).toContain('issues: write');
    expect(WF).toContain('actions: write');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE WATCHDOG MUST AGREE WITH THE DEPLOY SCHEDULE (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan: "WE DO DEPLOYMENTS EVERY HOUR ON THE :55 NOW." #2527 landed that in
 * auto-deploy-hetzner.yml at 13:00 UTC and did not touch this watchdog, which
 * still carried RESTART_HOURS="04 10 14 18 22" under a comment claiming it
 * "matches auto-deploy-hetzner.yml". It did not match, and the mismatch is the
 * whole failure.
 *
 * MEASURED. At 18:32 UTC the engine was serving the 03:54 image with five
 * merged pull requests unshipped for fourteen and a half hours, and the job
 * reported SUCCESS on every run. The arithmetic that produced that silence:
 * the newest server-touching commit was rounded up to the next FIVE-HOUR
 * window (14:00 Chicago, 19:00 UTC), the deadline became 19:25 UTC, and every
 * run before that was "behind by design". The watchdog was patiently waiting
 * for a window the deploy workflow had already stopped having.
 *
 * That is the third instrument found this way in one day - the league runner
 * and the layer watchlist were the other two - and the shape is identical: a
 * job that looks the same whether or not it is doing its work.
 *
 * These pin the agreement itself, not just the current number, so the next
 * schedule change cannot silently desynchronise them again.
 */
describe('the watchdog agrees with the deploy schedule', () => {
  const DEPLOY_YML = readFileSync(
    resolve(__dirname, '..', '.github', 'workflows', 'auto-deploy-hetzner.yml'),
    'utf8'
  );

  it('no longer rations restarts to five Chicago hours', () => {
    // The literal that made it blind. If it returns, so does the blindness.
    expect(SH_CODE).not.toMatch(/RESTART_HOURS="?\$\{RESTART_HOURS:-04 10 14 18 22\}/);
    expect(SH_CODE).not.toContain('04 10 14 18 22');
  });

  it('measures its deadline from the same minute the deploy restarts on', () => {
    const shMinute = /RESTART_MINUTE="?\$\{RESTART_MINUTE:-(\d+)\}/.exec(SH_CODE);
    expect(shMinute, 'the watchdog must declare the restart minute').not.toBeNull();

    // The deploy's cron ticks BEFORE the break so the runner can build; the
    // break itself is the minute the watchdog must measure from.
    const cron = /- cron: '([^']+)'/.exec(DEPLOY_YML);
    expect(cron, 'the deploy workflow must have a schedule').not.toBeNull();
    const ticks = cron![1].split(' ')[0].split(',').map(Number);
    const breakMinute = Number(shMinute![1]);

    // Every tick has to land in the same hour as, and before, the break -
    // otherwise the runner is building for a break that has already passed.
    for (const t of ticks) {
      expect(t, `tick :${t} must precede the :${breakMinute} break`).toBeLessThan(breakMinute);
    }
    expect(breakMinute).toBeGreaterThan(0);
    expect(breakMinute).toBeLessThan(60);
  });

  it('treats every hour as a restart window', () => {
    // Not "every hour is in a list" - the list is gone. is_restart_hour is now
    // unconditionally true, and that is what makes the dispatch branch reachable
    // at any hour rather than only at five of them.
    expect(SH_CODE).toMatch(/is_restart_hour\(\)\s*\{\s*return 0;\s*\}/);
  });

  it('rounds a commit up to the next break, not the next rationed hour', () => {
    const fn = SH_CODE.slice(
      SH_CODE.indexOf('window_at_or_after()'),
      SH_CODE.indexOf('window_at_or_after()') + 400
    );
    expect(fn).toContain('RESTART_MINUTE');
    // The hour-walking loop is what produced the five-hour deadline.
    expect(fn).not.toContain('seq 0 47');
  });
});

describe('the grace is spent once, not renewed by every merge', () => {
  /**
   * 2026-09-02: this watchdog stayed quiet through FOURTEEN HOURS of stranded
   * engine code, printing "Behind by design" on every run while production sat
   * on 93d167b5 and the deploy fail-closed at every window.
   *
   * Both deadlines were anchored to REQ_EPOCH - the NEWEST engine commit on
   * main - so every new engine merge pushed the deadline forward another
   * GRACE_MIN. This fleet merges engine changes far more often than every 45
   * minutes, so NOW was permanently below DEADLINE and the alarm/dispatch
   * branch was unreachable. The busier the repo got, the quieter its own
   * staleness alarm became.
   */
  it('anchors the deadline to when production fell behind, not to the newest merge', () => {
    expect(
      /BEHIND_SINCE_EPOCH/.test(SH_CODE),
      'the deadline is anchored to the newest engine commit, so every merge renews the ' +
        'grace and this watchdog can never reach its own alarm on a busy repo.'
    ).toBe(true);

    // The grace and the window must BOTH hang off that anchor. Leaving either
    // on REQ_EPOCH re-opens the bug through the other deadline.
    expect(SH_CODE).toMatch(/GRACE_DEADLINE=\$\(\(\s*BEHIND_SINCE_EPOCH/);
    expect(SH_CODE).toMatch(/window_at_or_after "\$BEHIND_SINCE_EPOCH"/);
  });

  it('finds that anchor as the oldest engine commit production does not have', () => {
    // Oldest, not newest: the instant it fell behind does not move when
    // somebody merges again.
    expect(SH_CODE).toMatch(/git log --reverse[\s\S]{0,120}SERVED\}\.\.origin\/main/);
  });

  it('falls back to the old anchor when it cannot tell what production serves', () => {
    // Unknown must stay quiet, never louder. An unresolvable or missing sha
    // keeps the previous behaviour rather than guessing "behind".
    expect(SH_CODE).toMatch(/BEHIND_SINCE_EPOCH=\$REQ_EPOCH/);
    expect(SH_CODE).toMatch(/git cat-file -e "\$\{SERVED\}\^\{commit\}"/);
  });
});
