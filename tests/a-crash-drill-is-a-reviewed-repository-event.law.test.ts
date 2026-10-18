/**
 * A live engine crash drill is a reviewed repository event, never a workstation.
 *
 * docs/runbooks/maintenance-break-fire-drill.md retired the direct-SSH
 * container kill and listed what a live crash drill must have instead. The
 * DA08 launch gate (docs/changelog/2026-10-17-diamond-launch-gates-what-each-requires.md)
 * could not close until that route existed. These pins keep the route the
 * runbook describes:
 *
 *   - one trigger: a default-branch repository event, no inputs, no timer;
 *   - the workflow only transports and observes - it never touches Docker or
 *     signals a process itself;
 *   - the host script mutates exactly once (SIGKILL to the serving process),
 *     only after the release transaction's own table-safe certificate holds,
 *     under the same engine mutation lock a release cutover holds;
 *   - recovery is production supervision's job, the forced desired-runtime
 *     restore is only the fallback, and every witness is checked.
 *
 * The behavioural harnesses run the REAL script against a stubbed host.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');
const runnable = (source: string): string =>
  source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

const workflow = read('.github/workflows/engine-drill.yml');
const drill = read('server/scripts/engine-crash-drill.sh');
const transaction = read('server/scripts/engine-release-transaction.sh');

describe('the crash drill route', () => {
  it('runs only as the named default-branch repository event', () => {
    expect(workflow).toMatch(
      /^on:\n {2}repository_dispatch:\n {4}types: \[drill-club-arena-engine\]\n/m
    );
    expect(workflow).not.toMatch(/^\s*(workflow_dispatch|schedule|push|pull_request\w*):/m);
    expect(workflow).not.toContain('github.event.inputs');
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    expect(workflow).toContain('group: club-arena-engine-drill');
    expect(workflow).toContain('cancel-in-progress: false');
  });

  it('pins the host key and stages only protected-main control bytes', () => {
    expect(workflow).toContain('-o StrictHostKeyChecking=yes');
    expect(workflow).toContain('HOST_KEY: ${{ secrets.HETZNER_HOST_KEY }}');
    expect(workflow).toContain('ref: ${{ github.sha }}');
    expect(workflow).toContain('merge-base --is-ancestor "$CONTROL_SHA"');
    expect(workflow).toContain('show "$CONTROL_SHA:server/scripts/$file"');
    expect(workflow).toContain('[ "$DRILL" = crash ]');
  });

  it('never touches the engine from the workflow itself', () => {
    const lines = runnable(workflow);
    expect(lines).not.toMatch(/\bdocker\b/);
    expect(lines).not.toMatch(/\bkill\s+-/);
    expect(lines).not.toMatch(/engine-supervisor|engine-up|engine-release-seal/);
    // The host script runs as a durable unit, so a dropped SSH session cannot
    // interrupt it mid-recovery.
    expect(lines).toContain('systemd-run --unit="$UNIT"');
    expect(lines).toContain('--no-block');
  });

  it('mutates exactly once, by SIGKILL, never through Docker', () => {
    const lines = runnable(drill);
    expect(lines.match(/\bkill -KILL\b/g)).toHaveLength(1);
    expect(lines).toContain('kill -KILL "$TARGET_PID"');
    expect(lines).not.toMatch(/docker\s+(kill|stop|restart|rm|start|run|update)\b/);
    expect(lines).not.toMatch(/systemctl\s+(start|stop|restart|kill)\b/);
    // The kill comes after the final certificate read, never before admission.
    expect(lines.indexOf('kill -KILL')).toBeGreaterThan(
      lines.indexOf('certificate "$BODY" "$KILL_MIN_REMAINING_MS"')
    );
    expect(lines.indexOf('kill -KILL')).toBeGreaterThan(lines.indexOf('flock -w 10 9'));
  });

  it('admits only through the release transaction certificate and its rungs', () => {
    // Evaluate the transaction's own rung arithmetic, then require the drill
    // to admit at exactly those rungs.
    const names = [
      'BREAK_CUTOVER_PROOF_SECONDS',
      'BREAK_ROLLBACK_RESERVE_SECONDS',
      'BREAK_DEADLINE_SLACK_SECONDS',
      'MIN_BREAK_REMAINING_MS',
      'BREAK_CERTIFICATE_LAG_SECONDS',
      'BREAK_LOCKED_ENTRY_SECONDS',
      'BREAK_ADMISSION_MIN_BREAK_MS',
      'BREAK_LOCKED_MIN_BREAK_MS',
    ];
    const assignments = names.map((name) => {
      const line = transaction.split('\n').find((l) => l.startsWith(`${name}=`));
      expect(line, name).toBeTruthy();
      return line as string;
    });
    const rungs = spawnSync(
      'bash',
      [
        '-c',
        `${assignments.join('\n')}\necho "$BREAK_ADMISSION_MIN_BREAK_MS $BREAK_LOCKED_MIN_BREAK_MS"`,
      ],
      { encoding: 'utf8' }
    );
    const [admission, locked] = rungs.stdout.trim().split(' ');
    expect(drill).toContain(`ADMIT_MIN_REMAINING_MS=${admission}`);
    expect(drill).toContain(`LOCKED_MIN_REMAINING_MS=${locked}`);
    for (const predicate of [
      'm.get("phase") == "counting_down"',
      'm.get("durableConfirmed") is True',
      'm.get("readyForRestart") is True',
      'm.get("unparkedTables") == 0',
      'hands == 0',
      'm.get("reason") != "Scheduled Engine Maintenance"',
    ]) {
      expect(drill).toContain(predicate);
    }
  });

  it('shares the release lane and stands aside for any release', () => {
    expect(drill).toContain(
      'ENGINE_LOCK="${ENGINE_LOCK_FILE:-/var/lock/club-arena-engine-up.lock}"'
    );
    expect(transaction).toContain(
      'ENGINE_LOCK="${ENGINE_LOCK_FILE:-/var/lock/club-arena-engine-up.lock}"'
    );
    expect(drill).toContain("'club-arena-engine-release-v1@*' 'club-arena-engine-intake-v1@*'");
    expect(drill).toContain('"$RELEASE_SEAL" pending-owner');
    expect(drill).toContain('[ "$pending" = none ]');
  });

  it('falls back only to the existing forced desired-runtime restore', () => {
    expect(drill).toContain('ENGINE_SUPERVISOR_LOCK_HELD=1 ENGINE_SUPERVISOR_FORCE_DESIRED=1');
    expect(drill).toContain('ENGINE_SUPERVISOR_REQUIRE_EXACT_HEALTH=1');
    // Overrides may only shorten the waits, never lengthen a break.
    expect(drill).toContain('[ "$CONTAINER_RESTART_SECONDS" -le 60 ]');
    expect(drill).toContain('[ "$HEALTH_RECOVERY_SECONDS" -le 180 ]');
  });

  it('runs the real drill script through refusal, failure and success on a stubbed host', () => {
    const result = spawnSync(
      'python3',
      ['-B', resolve(ROOT, 'tests/operations/engine-crash-drill.py')],
      {
        encoding: 'utf8',
        timeout: 600_000,
      }
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toContain('Ran 8 tests');
  }, 620_000);

  it('witnesses leader, thaw and hand progression from the database', () => {
    const result = spawnSync(
      'python3',
      ['-B', resolve(ROOT, 'tests/operations/engine-drill-database-proof.py')],
      {
        encoding: 'utf8',
      }
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toContain('Ran 2 tests');
  });
});
