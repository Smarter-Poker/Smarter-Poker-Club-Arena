/**
 * LAW: an off-cycle maintenance break needs a reason, the newest release owns
 * it, and there is at most one per rolling hour.
 * ═══════════════════════════════════════════════════════════════════════════
 * 2026-09-25/26, measured in engine_maintenance_break_log: busy hours held
 * 4-5 breaks and 29-36 of their 60 minutes with every table parked; hands/min
 * fell from ~550 to ~200. Every autopilot merge's release reserved its own
 * "Deployment Recovery" window, because a release that watched a sibling take
 * a break read the rest of it as a missed certificate. The escape hatch stays
 * (it is how the 09-18..09-25 fixes shipped); this law keeps it proportionate
 * and keeps it away from everything that makes a cutover safe.
 *
 * What the policy DOES is executed in tests/operations/engine-release-
 * recovery-window.py and engine-release-window-queue.py (run from
 * engine-release-seal.law.test.ts) and by the real seal in that same file.
 * This file pins the three things no behavioural test can see on its own.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');
const transaction = read('server/scripts/engine-release-transaction.sh');
const seal = read('server/scripts/engine-release-seal.py');
const workflow = read('.github/workflows/auto-deploy-hetzner.yml');

const between = (source: string, from: string, to: string) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  expect(start, from).toBeGreaterThanOrEqual(0);
  expect(end, to).toBeGreaterThan(start);
  return source.slice(start, end);
};
const code = (source: string) =>
  source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
const integer = (source: string, pattern: RegExp) => {
  const match = source.match(pattern);
  expect(match, String(pattern)).not.toBeNull();
  return Number(match![1]);
};

const policy = code(between(transaction, 'RECOVERY_REQUESTED=0', '\npersist_break_deadline() {'));
const reserve = between(seal, 'def cmd_reserve_recovery_window(', '\ndef cmd_pending_owner(');

describe('an off-cycle break needs a reason, and the newest release owns it', () => {
  it('changes when a release asks for a break, never what admits a cutover', () => {
    // The policy reads the ladder; it never writes a rung, a reserve or the
    // certificate, and it never reads the certificate itself.
    for (const constant of [
      'MIN_BREAK_REMAINING_MS',
      'BREAK_ADMISSION_MIN_BREAK_MS',
      'BREAK_LOCKED_MIN_BREAK_MS',
      'LEGACY_MIN_BREAK_REMAINING_MS',
      'BREAK_ROLLBACK_RESERVE_SECONDS',
      'BREAK_CUTOVER_PROOF_SECONDS',
      'BREAK_WINDOW_MS',
      'BREAK_END_EPOCH',
      'CERTIFICATE_DEADLINE',
    ]) {
      expect(policy, constant).not.toMatch(new RegExp(`(^|[\\s;])${constant}=`, 'm'));
    }
    expect(policy).not.toContain('maintenance_certificate');
    expect(policy).not.toContain('prove_rollback_readiness');
    // Both ordinary certificate reads still name their unchanged rungs.
    expect(transaction).toContain(
      'BREAK_REMAINING_MS="$(maintenance_certificate "$ADMISSION_MIN_BREAK_MS")"'
    );
    expect(transaction).toContain(
      'BREAK_REMAINING_MS="$(maintenance_certificate "$BREAK_LOCKED_MIN_BREAK_MS")"'
    );
  });

  it('asks the seal only after a reason and the newest-release check, under the engine lock', () => {
    const request = between(policy, 'request_recovery_window() {', '\n}');
    const order = [
      'stoppedCustodyStuckTables',
      'recovery_window_reason "$health"',
      "acquire_engine_lock 'one recovery announcement'",
      'source_target_is_current',
      'newer_release_in_flight',
      'reserve-recovery-window',
      'docker exec',
    ].map((step) => {
      const at = request.indexOf(step);
      expect(at, step).toBeGreaterThanOrEqual(0);
      return at;
    });
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // An ordinary short read is judged by when the release arrived, not
    // counted as a missed break outright.
    const queue = code(
      transaction.slice(transaction.indexOf('RECOVERY_WAIT_STARTED_EPOCH="$(date +%s)"'))
    );
    expect(queue.match(/note_missed_admission "\$\{BREAK_REMAINING_MS:-0\}"/g)).toHaveLength(2);
  });

  it('allows one off-cycle window per rolling hour, decided by the seal under its lock', () => {
    expect(seal).toContain('RECOVERY_WINDOW_MIN_INTERVAL_MS = 3600 * 1000');
    const cause = reserve.indexOf('if not cause:');
    const limit = reserve.indexOf('if recent_recovery_window(run_id, now_ms):');
    const write = reserve.indexOf('write_json_atomic(path, value)');
    expect(reserve.indexOf('with SealLock():')).toBeLessThan(cause);
    expect(cause).toBeLessThan(limit);
    expect(limit).toBeLessThan(write);
    expect(reserve).toContain('print("rate-limited")');
  });

  it('gives a release that waits for the scheduled break the time to reach one', () => {
    // From the moment its build ends, a release must still see a whole hour
    // of scheduled breaks plus one admission before its certificate deadline,
    // even when the build used its whole bound.
    const runtime = integer(transaction, /ENGINE_RELEASE_MAX_RUNTIME_SECONDS:-(\d+)/);
    const reserveSeconds = integer(transaction, /^CERTIFICATE_RESERVE_SECONDS=(\d+)$/m);
    const build = integer(transaction, /BUILD_TIMEOUT" -le (\d+) \] \|\| BUILD_TIMEOUT=/);
    // The ordinary admission accepts a certificate while at least
    // BREAK_ADMISSION_MIN_BREAK_MS of the countdown remains: the first
    // (window - admission floor) of every break.
    const window = integer(transaction, /^BREAK_WINDOW_MS=(\d+)$/m);
    const floor =
      (integer(transaction, /^BREAK_CUTOVER_PROOF_SECONDS=(\d+)$/m) +
        integer(transaction, /^BREAK_ROLLBACK_RESERVE_SECONDS=(\d+)$/m) +
        integer(transaction, /^BREAK_DEADLINE_SLACK_SECONDS=(\d+)$/m) -
        integer(transaction, /^BREAK_CERTIFICATE_LAG_SECONDS=(\d+)$/m)) *
      1000;
    const admission = window - floor;
    expect(admission).toBe(40000);
    expect(runtime - reserveSeconds - build).toBeGreaterThanOrEqual(3600 + admission / 1000);
    // The runner's own not-after is never the shorter clock.
    const budget = integer(workflow, /DEPLOY_JOB_BUDGET_SECONDS=(\d+)/);
    const post = integer(workflow, /POST_RELEASE_RESERVE_SECONDS=(\d+)/);
    expect(budget - post).toBeGreaterThanOrEqual(runtime);
  });
});
