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
 * THE FIRST ANSWER (PR #5026) COULD NOT CLOSE EITHER. It kept the guard at
 * 285000 and ADDED a measured entry budget to the admission threshold. But
 * the countdown is 300000ms and the entry costs ~15000ms of it before the
 * guard's first read, so after one miss the admission demanded a countdown
 * the engine only offers at t=0, and every break deferred instead of dying.
 * Same arithmetic, one gate earlier.
 *
 * THE RECONCILED CONTRACT (this branch's budget plus #5026's deferral):
 *
 *   admission  legacy_checkpoint_countdown       >= 285000 (+ headroom, ceiling 0)
 *   probe      legacy-engine-checkpoint.sh       >= 245000 + 40000 = 285000
 *   guard      reserveMs                          >= 245000 at EVERY check
 *   after      maintenance_certificate 245000     >= 245000, only once attempted
 *
 * The 40000ms LEGACY_CHECKPOINT_BUDGET_SECONDS is what the transaction
 * actually pays after the admission: ~15000ms of entry (the measurement
 * above), 20000ms of publisher work and 5000ms of cleanup. It comes out of
 * the candidate proof (150 -> 110 seconds), never the 135-second rollback
 * reserve. The entry cost is INSIDE the budget, so nothing is added above
 * the 285000 threshold: the break has exactly 15000ms above it and the entry
 * spends that. #5026's headroom argument and measurement survive, with a
 * derived ceiling of 0 for the legacy path.
 *
 * THE TWO RULES THIS PINS
 *
 *  1. The gates form a DESCENDING LADDER. Each one demands the guard's
 *     reserve plus the budget that still follows it, so passing an earlier
 *     gate implies the last one can pass - and the top rung is a figure a
 *     300000ms countdown can actually offer after the entry. The guard's
 *     reserve is the floor at every one of its checks and holds the whole
 *     rollback reserve: this law makes the release arrive in time, it never
 *     relaxes what the release must prove.
 *  2. A refusal that provably did not act is a DEFERRAL, not a death. The
 *     helper exits 75 only above its O_EXCL intent write - no intent file, no
 *     inspector, no write - and the transaction honours 75 only after proving
 *     from the filesystem that the intent is absent. Anything else dies.
 *     "This attempt arrived late" and "this attempt is unsafe" are different
 *     facts and get different names (CLAUDE.md 10.86 rule 1).
 *
 * Every figure here is MEASURED ON THE HOST THAT PAYS IT (run 35615604946,
 * the publisher's own budgets) and clamped to what the break can actually
 * offer - never a hand-tuned millisecond count that outlives its hardware
 * (CLAUDE.md 1.1.7, 10.84).
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

const ENTRY_MS = 285_000;
const LEGACY_BUDGET_MS = 40_000;
const GUARD_RESERVE_MS = ENTRY_MS - LEGACY_BUDGET_MS;
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
MIN_BREAK_REMAINING_MS=${ENTRY_MS}
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
  it('the break really is 300000ms, so the entry threshold leaves only 15000ms above it', () => {
    expect(maintenance).toMatch(/BREAK_DURATION_MS = 5 \* 60 \* 1000/);
    expect(maintenance).toMatch(/LAST_HAND_LEAD_MS = 2 \* 60 \* 1000/);
    expect(transaction).toMatch(/^BREAK_WINDOW_MS=300000$/m);
    // The arithmetic the whole law rests on. If someone widens the entry
    // threshold past the break, every release refuses for ever and this says
    // so here rather than in production.
    const proof = Number(transaction.match(/^BREAK_CUTOVER_PROOF_SECONDS=(\d+)$/m)![1]);
    const rollback = Number(transaction.match(/^BREAK_ROLLBACK_RESERVE_SECONDS=(\d+)$/m)![1]);
    expect((proof + rollback) * 1000).toBe(ENTRY_MS);
    expect(ENTRY_MS).toBeLessThan(300_000);
    expect(300_000 - ENTRY_MS).toBe(15_000);
  });

  it('the legacy budget is what the transaction actually pays, and the entry cost is inside it', () => {
    // 40 s = ~15 s of entry (run 35615604946: detection ~4.7 s, rollback
    // proof ~5.3 s, helper preamble ~5.2 s, then the intent write and the
    // guard's boot) + 20 s of publisher work + 5 s of cleanup.
    expect(transaction).toMatch(/^LEGACY_CHECKPOINT_BUDGET_SECONDS=40$/m);
    expect(transaction).toMatch(/^LEGACY_CHECKPOINT_WORK_MS=25000$/m);
    expect(transaction).toContain(
      'LEGACY_ENTRY_ALLOWANCE_MS=$((LEGACY_CHECKPOINT_BUDGET_SECONDS * 1000 - LEGACY_CHECKPOINT_WORK_MS))'
    );
    expect(LEGACY_BUDGET_MS - 25_000).toBe(15_000);
    // The entry allowance is exactly the 15000ms the break has above the
    // threshold, which is why nothing may be added above it.
    expect(LEGACY_BUDGET_MS - 25_000).toBe(300_000 - ENTRY_MS);
    const transport = read('server/scripts/legacy-engine-checkpoint.mjs');
    expect(transport).toContain('workBudgetMs = 20000');
    expect(transport).toContain('cleanupBudgetMs = 5000');
    // and the post-checkpoint certificate reads the guard's figure, out of
    // candidate proof, never the rollback reserve
    expect(transaction).toContain(
      'LEGACY_MIN_BREAK_REMAINING_MS=$(((BREAK_CUTOVER_PROOF_SECONDS + BREAK_ROLLBACK_RESERVE_SECONDS + BREAK_DEADLINE_SLACK_SECONDS - LEGACY_CHECKPOINT_BUDGET_SECONDS) * 1000))'
    );
    expect((150 + 135 + 0 - 40) * 1000).toBe(GUARD_RESERVE_MS);
    expect(GUARD_RESERVE_MS - 135_000).toBe(110_000);
    expect(transaction).toContain(
      'BREAK_REMAINING_MS="$(maintenance_certificate "$LEGACY_MIN_BREAK_REMAINING_MS")"'
    );
  });

  it('the guard keeps the floor: its reserve holds the whole budget below the entry and nothing relaxes it', () => {
    // This law makes the release ARRIVE in time. It never lowers the bar
    // below what the rollback needs: 245000 still holds the 135-second
    // rollback reserve and 110 seconds of candidate proof.
    expect(guard).toMatch(/const reserveMs = 245000;/);
    expect(GUARD_RESERVE_MS + LEGACY_BUDGET_MS).toBe(ENTRY_MS);
    expect(guard).toContain(
      "require(Number.isFinite(remaining) && remaining >= reserveMs, 'insufficient_reserve')"
    );
    // The safety refusals the brief forbids trading away stay exactly as they
    // are: a moved fleet is still a refusal, never something to tolerate.
    expect(guard).toContain("'fleet_identity_changed'");
    expect(guard).toContain("'maintenance_not_durable_countdown'");
  });

  it('the physical probe demands the guard reserve PLUS the whole budget, and adds nothing above 285000', () => {
    const probe = checkpointShell.slice(
      checkpointShell.indexOf('INSTANCE="$(curl'),
      checkpointShell.indexOf('CHECKPOINT_INTENT="$(python3')
    );
    expect(probe).toContain('reserve=245000+40000');
    expect(245_000 + 40_000).toBe(ENTRY_MS);
    expect(probe).toContain('m.get("remainingMs",0)>=reserve');
    // No measured boot term is added to the threshold: the boot is inside
    // the 40000ms budget. The boot IS still measured and reported, from the
    // runtime check the helper already pays for, as evidence for the next
    // re-derivation rather than as an admission term.
    expect(probe).not.toContain('CHECKPOINT_GUARD_ENTRY_MS');
    expect(probe).not.toContain('sys.argv[2]');
    expect(checkpointShell).toContain('NODE_BOOT_MS=$(( $(date +%s%3N) - NODE_BOOT_STARTED_MS ))');
    expect(checkpointShell).toContain(
      'predecessor runtime check took ${NODE_BOOT_MS}ms; the guard boot it proxies is inside the 40000ms legacy checkpoint budget'
    );
  });

  it('the transaction admission keeps the headroom argument, with a derived ceiling of 0', () => {
    expect(transaction).toMatch(/^BREAK_ENTRY_BUDGET_MS=0$/m);
    expect(transaction).toContain('headroom="${1:-0}"');
    expect(transaction).toContain('MIN_BREAK_MS=$((MIN_BREAK_REMAINING_MS + headroom))');
    // both admission call sites pass it
    const calls = transaction.match(/legacy_checkpoint_countdown "\$BREAK_ENTRY_BUDGET_MS"/g) ?? [];
    expect(calls.length).toBe(2);
    // the rollback proof is still timed on this host and logged against the
    // entry allowance inside the budget
    expect(transaction).toContain('ENTRY_STARTED_MS="$(date +%s%3N)"');
    expect(transaction).toContain('ROLLBACK_PROOF_MS=$(( $(date +%s%3N) - ENTRY_STARTED_MS ))');
    expect(transaction).toContain('BREAK_ENTRY_BUDGET_MS=$(( ROLLBACK_PROOF_MS * 2 ))');
    // and the ceiling is DERIVED: what the break offers above the threshold
    // minus what the budget already reserves for the entry - which is 0, so
    // the legacy admission can never demand more than a 300000ms countdown
    // minus the entry can offer. This is the line #5026 got wrong: its
    // ceiling was the whole 15000ms, which the entry itself spends.
    expect(transaction).toContain(
      'BREAK_ENTRY_BUDGET_CEILING_MS=$((BREAK_WINDOW_MS - MIN_BREAK_REMAINING_MS - LEGACY_ENTRY_ALLOWANCE_MS))'
    );
    expect(300_000 - ENTRY_MS - (LEGACY_BUDGET_MS - 25_000)).toBe(0);
    expect(transaction).toContain(
      '[ "$BREAK_ENTRY_BUDGET_MS" -le "$BREAK_ENTRY_BUDGET_CEILING_MS" ] \\\n      || BREAK_ENTRY_BUDGET_MS="$BREAK_ENTRY_BUDGET_CEILING_MS"'
    );
    expect(transaction).not.toContain(
      'BREAK_ENTRY_BUDGET_MS=$((BREAK_WINDOW_MS - MIN_BREAK_REMAINING_MS))'
    );
  });

  it('the ceiling really evaluates to 0: a measured entry never lifts the admission above 285000', () => {
    // Run the REAL constants block and the REAL clamp with a 12500ms
    // measurement (run 35615604946) and prove the fed-forward headroom is 0.
    const constants = transaction.slice(
      transaction.indexOf('BREAK_CUTOVER_PROOF_SECONDS=150'),
      transaction.indexOf('\ndie() {')
    );
    const clamp = transaction.slice(
      transaction.indexOf('    BREAK_ENTRY_BUDGET_MS=$(( ROLLBACK_PROOF_MS * 2 ))'),
      transaction.indexOf('    LEGACY_CHECKPOINT_ATTEMPTED=1\n    set +e')
    );
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
${constants}
ROLLBACK_PROOF_MS=12500
${clamp}
printf '%s %s %s %s' "$BREAK_ENTRY_BUDGET_MS" "$BREAK_ENTRY_BUDGET_CEILING_MS" "$LEGACY_ENTRY_ALLOWANCE_MS" "$((MIN_BREAK_REMAINING_MS + BREAK_ENTRY_BUDGET_MS))"
`,
      ],
      { encoding: 'utf8', timeout: 10_000 }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('0 0 15000 285000');
  });

  it('admits at the entry threshold and refuses one ms below it, whatever headroom a caller passes within the ceiling', () => {
    // The exact boundary with the legacy path's headroom (0): 285000 admits,
    // 284999 refuses. A 300000ms countdown detected within one 5s poll
    // offers this; nothing above it is ever demanded.
    expect(admit(ENTRY_MS, 0).status).toBe(0);
    expect(admit(ENTRY_MS - 1, 0).status).not.toBe(0);
    // The headroom argument itself still works, for a caller whose ceiling
    // is not 0: reserve + headroom is admissible, one ms less is not.
    expect(admit(ENTRY_MS + 10_000, 10_000).status).toBe(0);
    expect(admit(ENTRY_MS + 10_000 - 1, 10_000).status).not.toBe(0);
    const ok = admit(297_000, 10_000);
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim()).toMatch(/^\d+$/);
  });

  it('the UNCONDITIONAL defer is only ever reachable above the durable intent', () => {
    // NARROWED 2026-09-21 (see tests/a-race-that-touched-nothing-names-it-and-
    // waits.law.test.ts). This pin used to read "below the intent, only `die`",
    // and that sentence is no longer true: there is now exactly ONE further
    // deferral below it, for a receipt that PROVES the guard touched nothing.
    // What this still pins, unchanged, is the rule that mattered - `defer`
    // itself, the unconditional one that fires on a plain shell check, can
    // never be reached once the one-shot intent exists.
    expect(checkpointShell).toContain(
      'defer() { echo "[legacy-engine-checkpoint] $*" >&2; exit 75; }'
    );
    const intentAt = checkpointShell.indexOf('CHECKPOINT_INTENT="$(python3');
    expect(intentAt).toBeGreaterThan(0);
    const defers = [...checkpointShell.matchAll(/^\s*.*\|\| defer /gm)].map((m) => m.index!);
    expect(defers.length).toBeGreaterThan(0);
    for (const at of defers) expect(at).toBeLessThan(intentAt);
    // below the intent, `defer` is unreachable and the ONLY deferral is the
    // proved one, which carries a different name on purpose so neither can be
    // widened into the other by an edit that never read both.
    const below = checkpointShell.slice(intentAt);
    expect(below).not.toMatch(/(?:^|[^_\w])defer(?![_\w])/);
    expect(below).toContain("defer_proved_not_started 'the fleet moved");
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

      // 284.999s left: below the 245000 + 40000 entry threshold. Defer.
      const late = run(ENTRY_MS - 1);
      expect(late.status).toBe(75);
      expect(late.stdout).not.toContain('inspector-boundary-reached');
      // and, decisively, the one-shot intent was never created
      expect(existsSync(join(root, '35615604946-1.legacy-checkpoint-intent'))).toBe(false);

      // exactly 285s left: it fits, so the same code proceeds and does write
      // the intent. Run 35615604946 admitted at this figure and the guard
      // then refused; under the reconciled contract the guard holds 245000.
      const early = run(ENTRY_MS);
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
