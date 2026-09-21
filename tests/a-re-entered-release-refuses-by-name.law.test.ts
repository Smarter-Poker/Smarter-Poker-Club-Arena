/**
 * LAW: an interrupted release never enters the one-shot checkpoint twice, and
 *      "this already ran" is a NAMED refusal, not a traceback.
 * ═══════════════════════════════════════════════════════════════════════════
 * Run 35626149078, 2026-09-21. The durable systemd transaction made a first
 * checkpoint attempt in the ~16:41 break, wrote its one-shot O_EXCL intent,
 * was interrupted ("transient release interruption recovered; durable request
 * retained"), and then re-entered the helper UNDER THE SAME RUN ID. What
 * reached the operator was:
 *
 *     FileExistsError: [Errno 17] File exists:
 *       /var/lib/club-arena/engine-release-requests/
 *         35626149078-1.legacy-checkpoint-intent
 *     ##[error]could not reattach to the durable Hetzner release transaction (1)
 *
 * TWO things were wrong and only the first is a defect.
 *
 * (a) THE SECOND INVOCATION HAPPENED AT ALL. `LEGACY_CHECKPOINT_ATTEMPTED` is
 *     process memory. A boot-resumed or re-entered unit is a fresh process, so
 *     it starts back at 0 and the in-memory one-shot forgets. The DURABLE
 *     one-shot - the intent file - was never consulted on entry. That is the
 *     root cause (CLAUDE.md 10.11) and the fix reads it, once, at startup.
 *
 * (b) AN EXPECTED CONDITION WORE NO NAME. O_EXCL did exactly its job; the
 *     operator was shown a Python traceback that reads identically to a full
 *     disk, a permission fault or a broken interpreter. CLAUDE.md 10.86 rule
 *     1: "this attempt already ran" is a distinct outcome and needs its own
 *     name and its own code. It is 70.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE
 * ----------------------------------
 * The O_EXCL guard is NOT weakened. It is what makes the checkpoint one-shot,
 * and one-shot is what stops a half-applied cutover being retried over live
 * chips. The intent is NOT retired by this path either: nothing durable
 * records whether an interrupted entry completed, "I could not tell" is a
 * refusal (10.86 rule 1), and a later break cannot make it knowable. So the
 * run ENDS, by name, and the next dispatch gets a new run key. This is not a
 * retry, a sweep or a repair job (CLAUDE.md 10.12).
 *
 * It composes with #5036, which retires the intent only when the guard came
 * back and proved in its own fields that it touched nothing: after that the
 * file is absent, so the seed below reads 0 and a later break may enter.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const checkpointShell = readFileSync(
  join(ROOT, 'server', 'scripts', 'legacy-engine-checkpoint.sh'),
  'utf8'
);
const transaction = readFileSync(
  join(ROOT, 'server', 'scripts', 'engine-release-transaction.sh'),
  'utf8'
);
const workflow = readFileSync(
  join(ROOT, '.github', 'workflows', 'auto-deploy-hetzner.yml'),
  'utf8'
);

const PREDECESSOR = '8825af51817f379c4261658ca29ecc9d8d81932d';
const INTENT_NAME = '35626149078-1.legacy-checkpoint-intent';

describe('a re-entered release refuses by name', () => {
  it('the O_EXCL one-shot is intact and nothing removes the intent to get past it', () => {
    expect(checkpointShell).toContain('os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600');
    const write = checkpointShell.slice(
      checkpointShell.indexOf('CHECKPOINT_INTENT="$(python3'),
      checkpointShell.indexOf('CHECKPOINT_INTENT_RC=$?')
    );
    expect(write).not.toContain('O_TRUNC');
    expect(write).not.toContain('exist_ok');
    expect(write).not.toContain('os.unlink');
    expect(write).not.toContain('os.remove');
  });

  it('the transaction seeds its one-shot from the DURABLE record, not process memory', () => {
    expect(transaction).toContain(
      'LEGACY_CHECKPOINT_INTENT_FILE="$REQUEST_ROOT/$RUN_ID.legacy-checkpoint-intent"'
    );
    const seed = transaction.slice(
      transaction.indexOf('LEGACY_CHECKPOINT_ATTEMPTED=0'),
      transaction.indexOf('recover_on_exit() {')
    );
    expect(seed).toContain('if [ -e "$LEGACY_CHECKPOINT_INTENT_FILE" ]');
    expect(seed).toContain('LEGACY_CHECKPOINT_ATTEMPTED=1');
  });

  it('refuses before the break is entered, and before the helper is invoked', () => {
    const refusal = transaction.indexOf(
      "die 'this run key already opened the one-shot legacy checkpoint"
    );
    expect(refusal).toBeGreaterThan(0);
    // before the cutover lock, so no window and no lock is consumed
    expect(refusal).toBeLessThan(transaction.indexOf("acquire_engine_lock 'maintenance cutover'"));
    // and long before the helper could be asked a second time
    expect(refusal).toBeLessThan(transaction.indexOf('"$LEGACY_CHECKPOINT" "$RUN_ID"'));
    // it ENDS the run: no continue, no sleep, no later break
    const block = transaction.slice(
      transaction.lastIndexOf('if [', refusal),
      transaction.indexOf('\nfi', refusal)
    );
    expect(block).not.toContain('continue');
    expect(block).not.toContain('bounded_sleep');
  });

  it('the helper names the re-entry itself, with its own exit code', () => {
    expect(checkpointShell).toContain('except FileExistsError:');
    expect(checkpointShell).toContain('raise SystemExit(70)');
    expect(checkpointShell).toContain('[legacy-engine-checkpoint] ALREADY ENTERED:');
    expect(checkpointShell).toContain('exit 70');
    // 70 is its OWN answer: the helper's existing three are untouched
    expect(checkpointShell).toContain(
      'die() { echo "[legacy-engine-checkpoint] $*" >&2; exit 1; }'
    );
    expect(checkpointShell).toContain(
      'defer() { echo "[legacy-engine-checkpoint] $*" >&2; exit 75; }'
    );
    // and the caller names it too rather than folding it into a generic refusal
    expect(transaction).toContain('if [ "$LEGACY_CHECKPOINT_RC" = 70 ]; then');
    expect(transaction).toContain(
      "die 'the legacy checkpoint refused as already entered under this run key"
    );
  });

  it('70 is never treated as uncertain, so the workflow cannot replay it', () => {
    const uncertain = workflow.slice(
      workflow.indexOf('uncertain_status() {'),
      workflow.indexOf('run_remote_intake() {')
    );
    expect(uncertain).toContain('-eq 255');
    expect(uncertain).not.toContain('-eq 70');
    // the three that ARE uncertain stay uncertain
    for (const code of ['-eq 124', '-eq 76', '-eq 75']) expect(uncertain).toContain(code);
  });

  it('BEHAVIOUR: the second entry exits 70 and leaves the first intent untouched', () => {
    // Drive the real intent-write block twice, exactly as a re-entered
    // transaction would, and read the answers rather than the source.
    const block = checkpointShell.slice(
      checkpointShell.indexOf('# Persist intent before opening debugger access.'),
      checkpointShell.indexOf('{ cat "$CONTROL_DIR/legacy-engine-checkpoint-guard.mjs";')
    );
    expect(block).toContain('O_EXCL');
    const root = mkdtempSync(join(tmpdir(), 'release-reentry-'));
    try {
      const run = () =>
        spawnSync(
          'bash',
          [
            '-c',
            `set -euo pipefail
die() { echo "$*" >&2; exit 1; }
REQUEST_ROOT="$PROBE_ROOT"
RUN_ID=35626149078-1
INSTANCE=1-3846b8bb
LEGACY_SHA=${PREDECESSOR}
CONTAINER_ID=c63b254ee71b76aa26f4d1394d96189963774310244b046bc91186e219ca3f66
STARTED_AT=2026-09-18T21:55:50.88305198Z
HOST_PID=1231816
REQUEST=(unused unused unused unused aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)
${block}
printf '%s' inspector-boundary-reached
`,
          ],
          { encoding: 'utf8', timeout: 10_000, env: { ...process.env, PROBE_ROOT: root } }
        );

      const first = run();
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain('inspector-boundary-reached');
      expect(existsSync(join(root, INTENT_NAME))).toBe(true);
      const written = readFileSync(join(root, INTENT_NAME), 'utf8');

      const second = run();
      // named, not a traceback, and not the generic `die` 1
      expect(second.status).toBe(70);
      expect(second.stderr).toContain('ALREADY ENTERED');
      expect(second.stderr).not.toContain('Traceback');
      expect(second.stdout).not.toContain('inspector-boundary-reached');
      // the first attempt's durable record is preserved byte for byte
      expect(readFileSync(join(root, INTENT_NAME), 'utf8')).toBe(written);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
