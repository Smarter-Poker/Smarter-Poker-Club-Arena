/**
 * LAW: a release enters the break only with time left to FINISH, and an
 *      attempt that arrives too late waits for the next break instead of
 *      ending the release.
 * ═══════════════════════════════════════════════════════════════════════════
 * 2026-09-21. `auto-deploy-hetzner` failed about fifteen times in one day and
 * the engine sat on 8825af51 for sixty-five hours with 49 players' seats and
 * 4,908,000 chips stranded behind it. Every substantive code blocker had been
 * merged. The release simply could not win its window.
 *
 * FOUR gates demanded the SAME 285000ms against the same break:
 *
 *   1. maintenance_certificate                        (engine-release-transaction.sh)
 *   2. legacy_checkpoint_countdown                    (engine-release-transaction.sh)
 *   3. the physical countdown probe                   (legacy-engine-checkpoint.sh)
 *   4. reserveMs in legacyEngineCheckpointGuard       (legacy-engine-checkpoint-guard.mjs)
 *
 * and between them sat the engine lock, a sealed-SHA read, prove_rollback_
 * readiness (about twenty bounded host round trips, a loopback probe, a public
 * HTTPS probe and a database leader proof), a durable intent write with two
 * fsyncs, and a cold `docker exec ... node --input-type=module` boot.
 * BREAK_DEADLINE_SLACK_SECONDS was 0, so NONE of that work was budgeted.
 *
 * The engine's break is 300000ms (MaintenanceBreak.BREAK_DURATION_MS), so the
 * reserve leaves 15000ms for all of it. Gate 2 would therefore admit happily
 * at 285001ms remaining and hand gate 4 a deficit it was obliged to refuse -
 * and that refusal was TERMINAL, because the checkpoint is a one-shot.
 *
 * Measured, from run 35615604946: the recovery break was announced at
 * 15:03:04.288Z, so it froze at 15:05:04.288Z (LAST_HAND_LEAD_MS = 120000)
 * and ended at 15:10:04.288Z. The guard's refusal reached the runner at
 * 15:05:31.77Z with about 272500ms remaining. Gate 2 had admitted with at
 * least 285000ms. The entry therefore cost AT LEAST 12500ms of its 15000ms
 * allowance, which left a winning slice of at most 2500ms to be hit by a
 * five-second poll. Runs 35613147982 and 35614192763 died the same way one
 * gate later, and all three receipts said `attemptedTables: 0`,
 * `completedCalls: 0`, `checkpointOutcome: "not_started"` - nothing had been
 * touched, and the release ended anyway.
 *
 * THE TWO RULES THIS PINS
 *
 *  1. The gates form a DESCENDING LADDER. Each one demands the guard's
 *     reserve plus the cost of the work that still follows it, so passing an
 *     earlier gate implies the last one can pass. The guard's own reserve is
 *     the floor and does NOT move: this law makes the release arrive in time,
 *     it never relaxes what the release must prove.
 *  2. A refusal that provably did not act is a DEFERRAL, not a death. The
 *     helper exits 75 only above its O_EXCL intent write - no intent file, no
 *     inspector, no write - and the transaction honours 75 only after proving
 *     from the filesystem that the intent is absent. Anything else dies.
 *     "This attempt arrived late" and "this attempt is unsafe" are different
 *     facts and get different names (CLAUDE.md 10.86 rule 1).
 *
 * Every budget here is MEASURED ON THE HOST THAT WILL PAY IT and clamped to
 * what the break can actually offer - never a hand-tuned millisecond count
 * that outlives its hardware (CLAUDE.md 1.1.7, 10.84).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Subprocess contract suite: these drive REAL child processes, so wall time
// scales with machine load rather than with the code under test. Same budget
// and same reasoning as tests/legacyEngineCheckpointAdmission.test.ts.
vi.setConfig({ testTimeout: 90_000 });

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const transaction = read('server/scripts/engine-release-transaction.sh');
const checkpointShell = read('server/scripts/legacy-engine-checkpoint.sh');
const guard = read('server/scripts/legacy-engine-checkpoint-guard.mjs');
const maintenance = read('server/src/maintenance/MaintenanceBreak.ts');

const RESERVE_MS = 285_000;
const PREDECESSOR = '8825af51817f379c4261658ca29ecc9d8d81932d';

const countdown = transaction.slice(
  transaction.indexOf('legacy_checkpoint_countdown() {'),
  transaction.indexOf('\npersist_break_deadline()')
);

/** Drive the REAL countdown admission with a stubbed /health body. */
function admit(remainingMs: number, headroomMs: number) {
  const body = JSON.stringify({
    running: true,
    maintenance: {
      active: true,
      phase: 'counting_down',
      durableConfirmed: true,
      remainingMs,
      // The absolute boundary is given a cushion on purpose: this suite pins
      // what `remainingMs` must be, and the countdown's second predicate
      // (breakEndsAt - now) would otherwise lose a few milliseconds to the
      // subprocess start and turn an exact-boundary assertion into a race.
      breakEndsAt: Date.now() + remainingMs + 60_000,
    },
  });
  return spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
MIN_BREAK_REMAINING_MS=${RESERVE_MS}
curl() { printf '%s\\n%s' "$PROBE_BODY" "200"; }
${countdown}
legacy_checkpoint_countdown "$PROBE_HEADROOM"
`,
    ],
    {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, PROBE_BODY: body, PROBE_HEADROOM: String(headroomMs) },
    }
  );
}

describe('the release enters the break with time to finish', () => {
  it('the break really is 300000ms, so the reserve leaves only 15000ms for entry', () => {
    expect(maintenance).toMatch(/BREAK_DURATION_MS = 5 \* 60 \* 1000/);
    expect(maintenance).toMatch(/LAST_HAND_LEAD_MS = 2 \* 60 \* 1000/);
    expect(transaction).toMatch(/^BREAK_WINDOW_MS=300000$/m);
    // The arithmetic the whole law rests on. If someone widens the reserve
    // past the break, every release refuses for ever and this says so here
    // rather than in production.
    const proof = Number(transaction.match(/^BREAK_CUTOVER_PROOF_SECONDS=(\d+)$/m)![1]);
    const rollback = Number(transaction.match(/^BREAK_ROLLBACK_RESERVE_SECONDS=(\d+)$/m)![1]);
    expect((proof + rollback) * 1000).toBe(RESERVE_MS);
    expect(RESERVE_MS).toBeLessThan(300_000);
  });

  it('the guard keeps the floor: its reserve is unchanged and nothing relaxes it', () => {
    // This law makes the release ARRIVE in time. It never lowers the bar.
    expect(guard).toMatch(/const reserveMs = 285000;/);
    expect(guard).toContain(
      "require(Number.isFinite(remaining) && remaining >= reserveMs, 'insufficient_reserve')"
    );
    // The safety refusals the brief forbids trading away stay exactly as they
    // are: a moved fleet is still a refusal, never something to tolerate.
    expect(guard).toContain("'fleet_identity_changed'");
    expect(guard).toContain("'maintenance_not_durable_countdown'");
  });

  it('the physical probe demands the reserve PLUS the boot that still follows it', () => {
    const probe = checkpointShell.slice(
      checkpointShell.indexOf('INSTANCE="$(curl'),
      checkpointShell.indexOf('CHECKPOINT_INTENT="$(python3')
    );
    expect(probe).toContain('reserve=285000+int(sys.argv[2])');
    expect(probe).toContain('m.get("remainingMs",0)>=reserve');
    // and the added term is MEASURED, not chosen
    expect(probe).toContain('"$CHECKPOINT_GUARD_ENTRY_MS"');
    expect(checkpointShell).toContain('NODE_BOOT_MS=$(( $(date +%s%3N) - NODE_BOOT_STARTED_MS ))');
    expect(checkpointShell).toContain('CHECKPOINT_GUARD_ENTRY_MS=$(( NODE_BOOT_MS * 3 ))');
    // clamped to what the break can actually offer, so a slow probe can never
    // demand headroom no break could satisfy
    expect(checkpointShell).toMatch(/CHECKPOINT_GUARD_ENTRY_MS" -le 9000 \]/);
    expect(checkpointShell).toMatch(/CHECKPOINT_GUARD_ENTRY_MS" -ge 1500 \]/);
  });

  it('the transaction admission demands the reserve PLUS a measured entry budget', () => {
    expect(transaction).toMatch(/^BREAK_ENTRY_BUDGET_MS=0$/m);
    expect(transaction).toContain('headroom="${1:-0}"');
    expect(transaction).toContain('MIN_BREAK_MS=$((MIN_BREAK_REMAINING_MS + headroom))');
    // both admission call sites pass it
    const calls = transaction.match(/legacy_checkpoint_countdown "\$BREAK_ENTRY_BUDGET_MS"/g) ?? [];
    expect(calls.length).toBe(2);
    // and the budget is timed on this host, then clamped to the break
    expect(transaction).toContain('ENTRY_STARTED_MS="$(date +%s%3N)"');
    expect(transaction).toContain(
      'BREAK_ENTRY_BUDGET_MS=$(( ( $(date +%s%3N) - ENTRY_STARTED_MS ) * 2 ))'
    );
    expect(transaction).toContain(
      'BREAK_ENTRY_BUDGET_MS=$((BREAK_WINDOW_MS - MIN_BREAK_REMAINING_MS))'
    );
  });

  it('refuses a break that cannot fit the reserve plus the entry, and admits one that can', () => {
    // 290s left, 10s of entry still to pay: the guard would see 280s. Refuse.
    expect(admit(290_000, 10_000).status).not.toBe(0);
    // 297s left and the same 10s of entry: the guard would see 287s. Admit.
    const ok = admit(297_000, 10_000);
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim()).toMatch(/^\d+$/);
    // The exact boundary: reserve + headroom is admissible, one ms less is not.
    expect(admit(RESERVE_MS + 10_000, 10_000).status).toBe(0);
    expect(admit(RESERVE_MS + 10_000 - 1, 10_000).status).not.toBe(0);
  });

  it('keeps the historical contract when nothing follows the admission', () => {
    // headroom defaults to 0, so a caller with no entry left behaves exactly
    // as it did before this law. An admission can never become MORE permissive.
    expect(admit(RESERVE_MS, 0).status).toBe(0);
    expect(admit(RESERVE_MS - 1, 0).status).not.toBe(0);
  });

  it('exit 75 means nothing was attempted, and is only reachable above the durable intent', () => {
    expect(checkpointShell).toContain(
      'defer() { echo "[legacy-engine-checkpoint] $*" >&2; exit 75; }'
    );
    const intentAt = checkpointShell.indexOf('CHECKPOINT_INTENT="$(python3');
    expect(intentAt).toBeGreaterThan(0);
    // every `defer` sits ABOVE the O_EXCL intent write; below it, only `die`
    const defers = [...checkpointShell.matchAll(/^\s*.*\|\| defer /gm)].map((m) => m.index!);
    expect(defers.length).toBeGreaterThan(0);
    for (const at of defers) expect(at).toBeLessThan(intentAt);
    expect(checkpointShell.slice(intentAt)).not.toContain('defer ');
  });

  it('the physical probe DEFERS on a short break and writes no intent', () => {
    // Behaviour, not text: drive the real probe with a break that cannot fit
    // the reserve plus the boot still to come, and prove it exits 75 having
    // created nothing. This is the exact shape that ended run 35615604946.
    const block = checkpointShell.slice(
      checkpointShell.indexOf('INSTANCE="$(curl'),
      checkpointShell.indexOf('{ cat "$CONTROL_DIR/legacy-engine-checkpoint-guard.mjs";')
    );
    const root = mkdtempSync(join(tmpdir(), 'release-window-defer-'));
    try {
      const health = (remainingMs: number) =>
        JSON.stringify({
          running: true,
          version: PREDECESSOR.slice(0, 8),
          releaseSha: PREDECESSOR,
          instanceId: '1-3846b8bb',
          maintenance: {
            active: true,
            phase: 'counting_down',
            durableConfirmed: true,
            remainingMs,
          },
        });
      const run = (remainingMs: number) =>
        spawnSync(
          'bash',
          [
            '-c',
            `set -euo pipefail
die() { echo "$*" >&2; exit 1; }
defer() { echo "$*" >&2; exit 75; }
curl() { printf '%s' "$PROBE_HEALTH"; }
CHECKPOINT_GUARD_ENTRY_MS=9000
CONTROL_DIR=/immutable-reviewed-control
LEGACY_SHA=${PREDECESSOR}
REQUEST_ROOT="$PROBE_ROOT"
RUN_ID=35615604946-1
REQUEST=(unused unused unused unused aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)
CONTAINER_ID=c63b254ee71b76aa26f4d1394d96189963774310244b046bc91186e219ca3f66
STARTED_AT=2026-09-18T21:55:50.88305198Z
HOST_PID=1231816
${block}
printf '%s' inspector-boundary-reached
`,
          ],
          {
            encoding: 'utf8',
            timeout: 10_000,
            env: { ...process.env, PROBE_HEALTH: health(remainingMs), PROBE_ROOT: root },
          }
        );

      // 290s left, 9s of boot still to pay: the guard would see 281s. Defer.
      const late = run(290_000);
      expect(late.status).toBe(75);
      expect(late.stdout).not.toContain('inspector-boundary-reached');
      // and, decisively, the one-shot intent was never created
      expect(existsSync(join(root, '35615604946-1.legacy-checkpoint-intent'))).toBe(false);

      // 299s left: it fits, so the same code proceeds and does write the intent.
      const early = run(299_000);
      expect(early.status, early.stderr).toBe(0);
      expect(early.stdout).toContain('inspector-boundary-reached');
      expect(existsSync(join(root, '35615604946-1.legacy-checkpoint-intent'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the transaction defers on 75 only after PROVING the intent is absent', () => {
    const block = transaction.slice(
      transaction.indexOf('LEGACY_CHECKPOINT_RC=$?'),
      transaction.indexOf("|| die 'legacy checkpoint or cleanup refused; release cannot continue'")
    );
    expect(block).toContain('if [ "$LEGACY_CHECKPOINT_RC" = 75 ]; then');
    // file-proved, not exit-code-trusted
    expect(block).toContain('[ ! -e "$REQUEST_ROOT/$RUN_ID.legacy-checkpoint-intent" ]');
    expect(block).toContain(
      "die 'legacy checkpoint deferred but its durable intent exists; refusing a retry'"
    );
    // and only then may the run try again in a later break
    expect(block).toContain('LEGACY_CHECKPOINT_ATTEMPTED=0');
    expect(block).toContain('release_engine_lock');
    expect(block).toContain('continue');
    // fail closed: anything that is not a clean 75 still ends the release
    expect(transaction).toContain('[ "$LEGACY_CHECKPOINT_RC" = 0 ] \\');
  });

  it('still refuses a retry once the checkpoint has actually been attempted', () => {
    expect(transaction).toContain(
      "die 'legacy checkpoint was already attempted; refusing a retry'"
    );
    // the one-shot flag is raised BEFORE the helper runs, so a crash mid-call
    // can never be mistaken for a deferral
    const raise = transaction.indexOf('LEGACY_CHECKPOINT_ATTEMPTED=1\n    set +e');
    const invoke = transaction.indexOf('"$LEGACY_CHECKPOINT" "$RUN_ID"\n    LEGACY_CHECKPOINT_RC');
    expect(raise).toBeGreaterThan(0);
    expect(raise).toBeLessThan(invoke);
  });
});
