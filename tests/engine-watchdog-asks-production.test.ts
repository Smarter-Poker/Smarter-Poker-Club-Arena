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
    // One missed twenty-minute tick is ordinary. Three in a row is the failure.
    //
    // THE PIN MOVED, 2026-09-01. This used to assert the literal sentence
    // "inside the ${GRACE_MIN}m grace window". The watchdog stopped saying it
    // when the deadline became window-aware: the engine does not restart on
    // merge, it restarts at $RESTART_HOURS Chicago, so a flat 45 minutes from
    // the commit was never a deadline the platform was trying to meet and this
    // fired every morning about a system behaving exactly as designed.
    //
    // The replacement is strictly MORE patient, and that is what is pinned now
    // rather than a sentence: the deadline is the first restart window at or
    // after the commit plus one deploy, floored at GRACE_MIN so it can never
    // become less patient than the rule it replaced, and inside it the script
    // says so and exits 0 without raising.
    expect(SH).toContain('GRACE_MIN="${GRACE_MIN:-45}"');
    expect(SH).toContain('GRACE_DEADLINE=$(( REQ_EPOCH + GRACE_MIN * 60 ))');
    expect(SH, 'the grace window must be a floor, never a ceiling').toContain(
      '[ "$GRACE_DEADLINE" -gt "$DEADLINE" ] && DEADLINE=$GRACE_DEADLINE'
    );
    // Inside the window: report, and stop. Raising here is the bug this guards.
    expect(SH).toMatch(/if \[ "\$NOW_EPOCH" -lt "\$DEADLINE" \]; then[\s\S]{0,900}?\n {2}exit 0\nfi/);
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

  it('reads and writes issues with the same token', () => {
    // A read on the App token and a write on GITHUB_TOKEN disagreed about who
    // they were and filed six duplicate issues across two repos.
    const reads = SH.match(/GH_TOKEN="\$\{GH_TOKEN_ISSUES:-\$\{GH_TOKEN:-\}\}"/g) ?? [];
    expect(reads.length).toBeGreaterThanOrEqual(2);
  });
});

describe('and it is actually scheduled to run', () => {
  it('is a job in the publish watchdog, which already runs every 30 minutes', () => {
    expect(WF).toContain('bash .github/scripts/engine-watchdog.sh');
    expect(WF).toContain("cron: '*/30 * * * *'");
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
