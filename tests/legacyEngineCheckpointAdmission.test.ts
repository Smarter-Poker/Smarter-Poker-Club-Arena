import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceBetween } from './helpers/sourceWindow';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const transaction = read('server/scripts/engine-release-transaction.sh');
const installer = read('server/scripts/install-engine-supervisor.sh');
const checkpointShell = read('server/scripts/legacy-engine-checkpoint.sh');
const checkpointTransport = read('server/scripts/legacy-engine-checkpoint.mjs');
const predecessor758 = '758610f3f844406bbbaee2f5100ced36d84fb943';
const image758 = 'sha256:0190d49e394fd2b12b1462730bb22c4c4d1c4d49564e19b192bb07e3754c5561';
const countdownStart = transaction.indexOf('legacy_checkpoint_countdown() {');
const countdownEnd = transaction.indexOf('\npersist_break_deadline()', countdownStart);
const countdown = transaction.slice(countdownStart, countdownEnd);

function probe(patch: Record<string, unknown> = {}, httpStatus = 200) {
  const maintenance = {
    active: true,
    phase: 'counting_down',
    durableConfirmed: true,
    remainingMs: 299_000,
    breakEndsAt: Date.now() + 299_000,
    readyForRestart: false,
    unparkedTables: 3,
    ...patch,
  };
  return spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
MIN_BREAK_REMAINING_MS=285000
curl() { printf '%s\\n%s' "$CHECKPOINT_TEST_BODY" "$CHECKPOINT_TEST_HTTP"; }
${countdown}
legacy_checkpoint_countdown
`,
    ],
    {
      encoding: 'utf8',
      timeout: 3_000,
      env: {
        ...process.env,
        CHECKPOINT_TEST_BODY: JSON.stringify({ running: true, maintenance }),
        CHECKPOINT_TEST_HTTP: String(httpStatus),
      },
    }
  );
}

describe('the exact legacy checkpoint enters the existing release transaction', () => {
  it.each([
    [predecessor758, image758, 0],
    [
      '2f4e33560bcd23bfb5cc731f31816b2c2e2847e5',
      'sha256:3796b874331fee7d3b0824472df65e9fe613306a5175d3a211fdf8158bdab852',
      0,
    ],
    [predecessor758, 'sha256:' + 'a'.repeat(64), 1],
    ['a'.repeat(40), image758, 1],
  ])('binds sealed predecessor %s to its exact immutable image', (sha, image, status) => {
    const selection = checkpointShell.slice(
      checkpointShell.indexOf('LEGACY_SHA="$(timeout'),
      checkpointShell.indexOf('\nIDENTITY=')
    );
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
CONTROL_DIR=/unexecuted-fixture
die() { exit 1; }
timeout() { case "\${*: -1}" in desired-sha) printf '%s' "$PROFILE_SHA";; desired-image-id) printf '%s' "$PROFILE_IMAGE";; *) exit 2;; esac; }
${selection}
printf '%s' "$LEGACY_IMAGE"
`,
      ],
      {
        encoding: 'utf8',
        timeout: 3000,
        env: { ...process.env, PROFILE_SHA: sha, PROFILE_IMAGE: image },
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(status);
    if (status === 0) expect(result.stdout).toBe(image);
  });

  it.each([predecessor758, '2f4e33560bcd23bfb5cc731f31816b2c2e2847e5'])(
    'retains the existing recovery event only for capable predecessor %s',
    (sha) => {
      const entry = transaction.indexOf(
        '    if ! LEGACY_COUNTDOWN_END=',
        transaction.indexOf('LEGACY_CHECKPOINT_REQUIRED=0')
      );
      const action = transaction.slice(entry, transaction.indexOf('      bounded_sleep 5', entry));
      const result = spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail
CHECKPOINT_PREDECESSOR_SHA="$PROFILE_SHA"
CHECKPOINT_758_SHA=${predecessor758}
CERTIFICATE_RC=2
RECOVERY_ADMISSION_MISSED=0
legacy_checkpoint_countdown() { return 1; }
request_recovery_window() { printf 'existing-event:%s' "$RECOVERY_ADMISSION_MISSED"; }
${action}
fi
`,
        ],
        { encoding: 'utf8', timeout: 3000, env: { ...process.env, PROFILE_SHA: sha } }
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(sha === predecessor758 ? 'existing-event:1' : '');
    }
  );

  it('passes only the seal-selected closed profile into the native transport', () => {
    expect(checkpointShell).toContain('node --input-type=module - "$INSTANCE" "$LEGACY_SHA"');
    const production = checkpointTransport.slice(
      checkpointTransport.indexOf("if (process.argv[1] === '-'")
    );
    expect(production).toContain('const checkpointRelease = process.argv[3]');
    expect(production).toContain('].includes(checkpointRelease)');
    expect(production).toContain(predecessor758);
    expect(production).toContain('releaseSha: checkpointRelease');
  });
  it.each([false, true])(
    'allows a durable countdown with old ready=%s for checkpoint only',
    (ready) => {
      const result = probe({ readyForRestart: ready });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/^[1-9][0-9]*\n$/);
    }
  );

  it('retains the complete degraded-health body for checkpoint admission', () => {
    const result = probe({}, 503);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each<[string, Record<string, unknown>]>([
    ['last hand announcement', { phase: 'last_hand' }],
    ['unconfirmed countdown', { durableConfirmed: false }],
    ['inactive maintenance', { active: false }],
    ['short remaining duration', { remainingMs: 284_999 }],
    ['short absolute boundary', { breakEndsAt: Date.now() + 280_000 }],
    ['string duration', { remainingMs: '299000' }],
    ['boolean boundary', { breakEndsAt: true }],
    ['absent boundary', { breakEndsAt: null }],
  ])('refuses %s before any checkpoint operation', (_label, patch) => {
    const result = probe(patch);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('refuses an unrelated HTTP failure', () => {
    expect(probe({}, 500).status).toBe(1);
  });

  it('binds the exception to the exact sealed predecessor after the immutable image build', () => {
    expect(transaction).toContain('LEGACY_CHECKPOINT_SHA=2f4e33560bcd23bfb5cc731f31816b2c2e2847e5');
    const build = transaction.indexOf('"$IMAGE_BUILDER" "$REPO_DIR" "$SHA" "$IMAGE_REF"');
    const predecessor = transaction.indexOf('CHECKPOINT_PREDECESSOR_SHA=', build);
    const bind = transaction.indexOf(
      '[ "$CHECKPOINT_PREDECESSOR_SHA" = "$LEGACY_CHECKPOINT_SHA" ]',
      predecessor
    );
    const wait = transaction.indexOf('\nwhile :; do', bind);
    expect(build).toBeGreaterThan(0);
    expect(predecessor).toBeGreaterThan(build);
    expect(bind).toBeGreaterThan(predecessor);
    expect(wait).toBeGreaterThan(bind);
  });

  it('holds the engine lock and proves the actual predecessor before invoking exactly once', () => {
    const lock = transaction.indexOf("acquire_engine_lock 'maintenance cutover'");
    const freshness = transaction.indexOf('source_target_is_current', lock);
    const entry = transaction.indexOf('legacy_checkpoint_countdown)', freshness);
    const noReplay = transaction.indexOf('[ "$LEGACY_CHECKPOINT_ATTEMPTED" = 0 ]', entry);
    const readiness = transaction.indexOf('prove_rollback_readiness', noReplay);
    const attempted = transaction.indexOf('LEGACY_CHECKPOINT_ATTEMPTED=1', readiness);
    const invoke = transaction.indexOf('"$LEGACY_CHECKPOINT" "$RUN_ID"', attempted);
    expect(lock).toBeGreaterThan(0);
    expect(freshness).toBeGreaterThan(lock);
    expect(entry).toBeGreaterThan(freshness);
    expect(noReplay).toBeGreaterThan(entry);
    expect(readiness).toBeGreaterThan(noReplay);
    expect(attempted).toBeGreaterThan(readiness);
    expect(invoke).toBeGreaterThan(attempted);
    const reclassification = transaction.slice(freshness, entry);
    expect(reclassification).toContain('"$RELEASE_SEAL" get desired-sha');
    expect(reclassification).toContain(
      '[ "$CHECKPOINT_PREDECESSOR_SHA" != "$LEGACY_CHECKPOINT_SHA" ]'
    );
    expect(reclassification).toContain('LEGACY_CHECKPOINT_REQUIRED=0');
    expect(transaction.slice(lock, invoke)).not.toContain('MUTATION_STARTED=1');
    expect(
      sliceBetween(transaction, '"$LEGACY_CHECKPOINT" "$RUN_ID"', '\n    BREAK_END_EPOCH=0')
    ).toContain("die 'legacy checkpoint or cleanup refused; release cannot continue'");
  });

  it('requires the unchanged strict certificate and full reserve after cleanup before prepare', () => {
    const invoke = transaction.indexOf('"$LEGACY_CHECKPOINT" "$RUN_ID"');
    const certificate = transaction.indexOf('maintenance_certificate)', invoke);
    const refusal = transaction.indexOf(
      '[ "$LEGACY_CHECKPOINT_ATTEMPTED" = 1 ] && [ "$CERTIFICATE_RC" -ne 0 ]',
      certificate
    );
    const persist = transaction.indexOf('\n  persist_break_deadline', refusal);
    const prepare = transaction.indexOf('PREPARE_OUTPUT="$(bounded_break_command', persist);
    expect(certificate).toBeGreaterThan(invoke);
    expect(refusal).toBeGreaterThan(certificate);
    expect(persist).toBeGreaterThan(refusal);
    expect(prepare).toBeGreaterThan(persist);
    const strict = transaction.slice(
      transaction.indexOf('maintenance_certificate() {'),
      countdownStart
    );
    for (const predicate of [
      'm.get("readyForRestart") is True',
      'm.get("durableConfirmed") is True',
      'm.get("unparkedTables")==0',
      'remaining<int(__import__("os").environ["MIN_BREAK_MS"])',
    ]) {
      expect(strict).toContain(predicate);
    }
    expect(transaction).toContain('BREAK_CUTOVER_PROOF_SECONDS=150');
    expect(transaction).toContain('BREAK_ROLLBACK_RESERVE_SECONDS=135');
  });

  it('ships all helper bytes in the immutable generation without rejecting old core generations', () => {
    const required = installer.slice(
      installer.indexOf('REQUIRED_FILES=('),
      installer.indexOf('CORE_FILES=(')
    );
    const core = installer.slice(installer.indexOf('CORE_FILES=('), installer.indexOf('\ndie()'));
    for (const file of [
      'legacy-engine-checkpoint.sh',
      'legacy-engine-checkpoint.mjs',
      'legacy-engine-checkpoint-guard.mjs',
    ]) {
      expect(required).toContain(file);
      expect(core).not.toContain(file);
    }
    const shellChecks = installer.slice(
      installer.indexOf('  for script in \\\n'),
      installer.indexOf('  for script in engine-release-seal.py')
    );
    expect(shellChecks).toContain('legacy-engine-checkpoint.sh');
    expect(shellChecks).toContain('bash -n "$GENERATION_STAGE/$script"');
    const stage = read('.github/workflows/stage-engine-release.yml');
    expect(stage).toContain(
      "'server/**' ':(exclude)server/**/*.test.ts' ':(exclude)server/sim/**'"
    );
  });
});
