import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const transaction = read('server/scripts/engine-release-transaction.sh');
const supervisor = read('server/scripts/engine-supervisor.sh');
const recovery = read('server/scripts/engine-release-recover.sh');

describe('engine release recovery stays inside one honest break boundary', () => {
  it('bounds every protected-main Git read and the pending-owner read', () => {
    const source = transaction.slice(
      transaction.indexOf('source_target_is_current()'),
      transaction.indexOf('health_instance()')
    );
    for (const operation of [
      "fetch --no-tags origin '+refs/heads/main:refs/remotes/origin/main'",
      "rev-parse --verify 'origin/main^{commit}'",
      'cat-file -e "$SHA^{commit}"',
      'merge-base --is-ancestor "$SHA" "$main_sha"',
      'log "$main_sha" -1 --format=%H',
      'rev-parse --verify "$SHA:server"',
    ]) {
      const operationAt = source.indexOf(operation);
      expect(operationAt, operation).toBeGreaterThan(0);
      expect(source.slice(Math.max(0, operationAt - 180), operationAt)).toContain('timeout');
    }

    const pending = transaction.slice(
      transaction.indexOf('read_pending_owner()'),
      transaction.indexOf('recover_pending_owner()')
    );
    expect(pending).toContain('bounded_break_command 10 "$RELEASE_SEAL" pending-owner');
    expect(pending).toContain('timeout --signal=TERM --kill-after=1s "${remaining}s"');
  });

  it('fits one conditional candidate and rollback budget inside the fixed five-minute break', () => {
    expect(transaction).toContain('BREAK_CUTOVER_PROOF_SECONDS=150');
    expect(transaction).toContain('BREAK_ROLLBACK_RESERVE_SECONDS=135');
    expect(transaction).toContain('BREAK_DEADLINE_SLACK_SECONDS=0');
    expect((150 + 135) * 1000).toBeLessThan(5 * 60 * 1000);
    // The exact legacy checkpoint (publisher workBudgetMs 20000 + cleanupBudgetMs
    // 5000) is paid out of the 150-second candidate proof, never the 135-second
    // rollback reserve: 285 - 25 = 260 seconds, 125 of proof left for a
    // candidate that has measured 51-112 seconds in sealed runs.
    expect(transaction).toContain('LEGACY_CHECKPOINT_BUDGET_SECONDS=25');
    expect(transaction).toContain(
      'LEGACY_MIN_BREAK_REMAINING_MS=$(((BREAK_CUTOVER_PROOF_SECONDS + BREAK_ROLLBACK_RESERVE_SECONDS + BREAK_DEADLINE_SLACK_SECONDS - LEGACY_CHECKPOINT_BUDGET_SECONDS) * 1000))'
    );
    expect((150 + 135 + 0 - 25) * 1000).toBe(260_000);
    expect(260_000 - 135_000).toBe(125_000);
    expect(transaction.indexOf('LEGACY_CHECKPOINT_BUDGET_SECONDS')).toBeLessThan(
      transaction.indexOf('MIN_BREAK_REMAINING_MS=$(((')
    );
    // break_proof_seconds subtracts the fixed rollback reserve from whatever
    // certificate was accepted, so the smaller legacy minimum shortens proof
    // time and nothing else.
    expect(transaction).toContain(
      'local remaining=$((BREAK_END_EPOCH - $(date +%s) - BREAK_ROLLBACK_RESERVE_SECONDS))'
    );
    const shortBreak = transaction.indexOf('if [ "$CERTIFICATE_RC" -eq 2 ]');
    const deadline = transaction.indexOf('persist_break_deadline', shortBreak);
    const readiness = transaction.indexOf('prove_rollback_readiness', deadline);
    const prepare = transaction.indexOf('PREPARE_OUTPUT="$(bounded_break_command');
    const candidateStop = transaction.indexOf('docker stop -t 15 sp-autoheal', prepare);
    expect(shortBreak).toBeGreaterThan(0);
    expect(deadline).toBeGreaterThan(shortBreak);
    expect(readiness).toBeGreaterThan(deadline);
    expect(prepare).toBeGreaterThan(shortBreak);
    expect(prepare).toBeGreaterThan(readiness);
    expect(candidateStop).toBeGreaterThan(prepare);
    const readinessBody = transaction.slice(
      transaction.indexOf('prove_rollback_readiness()'),
      transaction.indexOf('emit_already_released()')
    );
    expect(readinessBody).toContain('get desired-image-id');
    expect(readinessBody).toContain('source_instance_for_sha');
    expect(readinessBody).toContain('exact desired database leader');
    expect(readinessBody).toContain('--max-heartbeat-age-seconds 15');
  });

  it('persists one absolute break deadline for transaction exit and ExecStopPost recovery', () => {
    expect(transaction).toContain('BREAK_DEADLINE_FILE="$REQUEST_ROOT/$RUN_ID.break-deadline"');
    expect(transaction).toContain('persist_break_deadline');
    expect(transaction).toContain('ENGINE_RECOVERY_DEADLINE_EPOCH="$recovery_deadline"');
    expect(recovery).toContain('BREAK_DEADLINE_FILE="$REQUEST_ROOT/$RUN_ID.break-deadline"');
    expect(recovery).toContain('RECOVERY_DEADLINE_EPOCH="${BREAK_DEADLINE_LINES[0]}"');
    expect(recovery).toContain('ENGINE_RECOVERY_DEADLINE_EPOCH="$RECOVERY_DEADLINE_EPOCH"');
    expect(recovery).toContain('bounded_recovery_command "$SUPERVISOR_BUDGET"');
  });

  it('force-desired mode evicts a still-authorized pending candidate and proves exact local and public health', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'engine-force-desired-'));
    try {
      const bin = join(sandbox, 'bin');
      const state = join(sandbox, 'state');
      const control = join(sandbox, 'control');
      mkdirSync(bin);
      mkdirSync(state);
      mkdirSync(control);
      const desiredSha = 'a'.repeat(40);
      const desiredImage = `sha256:${'b'.repeat(64)}`;
      const candidateImage = `sha256:${'c'.repeat(64)}`;
      const switched = join(state, 'desired');
      const curlLog = join(state, 'curl.log');

      writeFileSync(
        join(control, 'engine-release-seal.py'),
        `#!/usr/bin/env bash
case "$1" in
  get)
    case "$2" in
      desired-sha) printf '%s\n' '${desiredSha}' ;;
      desired-image-id) printf '%s\n' '${desiredImage}' ;;
      desired-legacy-unlabelled) printf '%s\n' 'false' ;;
      *) exit 2 ;;
    esac
    ;;
  classify-running) printf '%s\n' 'pending ${'d'.repeat(40)}' ;;
  authorize) printf '%s\n' 'desired ${desiredSha} ${desiredImage}' ;;
  *) exit 3 ;;
esac
`
      );
      chmodSync(join(control, 'engine-release-seal.py'), 0o755);
      writeFileSync(
        join(control, 'engine-up.sh'),
        `#!/usr/bin/env bash
touch '${switched}'
`
      );
      chmodSync(join(control, 'engine-up.sh'), 0o755);
      writeFileSync(
        join(bin, 'docker'),
        `#!/usr/bin/env bash
set -eu
if [ "$1" = info ]; then exit 0; fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  if printf '%s' "$*" | grep -q "{{json .Config.Env}}"; then printf '%s\n' '["GIT_COMMIT_SHA=${desiredSha}"]'; fi
  if printf '%s' "$*" | grep -q "{{.Id}}"; then printf '%s\n' '${desiredImage}'; fi
  exit 0
fi
if [ "$1" = container ] && [ "$2" = inspect ]; then
  format=''
  while [ "$#" -gt 0 ]; do
    [ "$1" = -f ] && { format="$2"; shift 2; continue; }
    shift
  done
  case "$format" in
    '{{.State.Status}}') printf '%s\n' 'running' ;;
    '{{.Image}}') [ -e '${switched}' ] && printf '%s\n' '${desiredImage}' || printf '%s\n' '${candidateImage}' ;;
    *sp.release.sha*) [ -e '${switched}' ] && printf '%s\n' '${desiredSha}' || printf '%s\n' '${'d'.repeat(40)}' ;;
    *autoheal*) printf '%s\n' 'true' ;;
    *sp.role*) printf '%s\n' 'engine' ;;
    *RestartPolicy.Name*) [ -e '${switched}' ] && printf '%s\n' 'always' || printf '%s\n' 'no' ;;
    *) exit 0 ;;
  esac
  exit 0
fi
if [ "$1" = start ] || [ "$1" = update ] || [ "$1" = tag ]; then exit 0; fi
exit 4
`
      );
      chmodSync(join(bin, 'docker'), 0o755);
      writeFileSync(
        join(bin, 'curl'),
        `#!/usr/bin/env bash
printf '%s\n' "$*" >> '${curlLog}'
printf '%s\n%s' '{"running":true,"releaseSha":"${desiredSha}","liveness":"ok","instanceId":"12345-deadbeef"}' '503'
`
      );
      chmodSync(join(bin, 'curl'), 0o755);
      writeFileSync(join(bin, 'logger'), '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(join(bin, 'logger'), 0o755);
      writeFileSync(
        join(bin, 'timeout'),
        '#!/usr/bin/env bash\nset -e\nwhile [[ "${1:-}" == --* ]]; do shift; done\n[[ "${1:-}" =~ ^[0-9]+s$ ]] && shift\nexec "$@"\n'
      );
      chmodSync(join(bin, 'timeout'), 0o755);

      const result = spawnSync('bash', [join(root, 'server/scripts/engine-supervisor.sh')], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          ENGINE_CONTROL_DIR: control,
          ENGINE_SUPERVISOR_LOCK_HELD: '1',
          ENGINE_SUPERVISOR_FORCE_DESIRED: '1',
          ENGINE_SUPERVISOR_REQUIRE_EXACT_HEALTH: '1',
          ENGINE_RECOVERY_DEADLINE_EPOCH: String(Math.floor(Date.now() / 1000) + 20),
          ENGINE_URL: 'https://engine.example.invalid',
          STATE_DIR: state,
          TEXTFILE_DIR: state,
          AUTOHEAL_CONTAINER: 'sp-autoheal',
        },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('force-desired recovery is evicting every unsealed runtime');
      expect(result.stdout).toContain('is live and exact locally and publicly as 12345-deadbeef');
      expect(readFileSync(curlLog, 'utf8')).toContain('http://127.0.0.1:8080/health');
      expect(readFileSync(curlLog, 'utf8')).toContain(
        'https://engine.example.invalid/health?nocache='
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('forces desired recovery even when abort returns an uncertain failure', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'engine-abort-uncertain-'));
    try {
      const bin = join(sandbox, 'bin');
      const control = join(sandbox, 'control');
      const requests = join(sandbox, 'requests');
      const pins = join(sandbox, 'pins');
      const leases = join(sandbox, 'leases');
      const marker = join(sandbox, 'supervisor.env');
      mkdirSync(bin);
      mkdirSync(control);
      mkdirSync(requests);
      mkdirSync(pins);
      mkdirSync(leases);
      writeFileSync(join(requests, '77-1.request'), 'must remain on uncertain abort\n');
      writeFileSync(join(control, 'engine-release-recover.sh'), recovery);
      chmodSync(join(control, 'engine-release-recover.sh'), 0o755);
      writeFileSync(
        join(control, 'engine-release-seal.py'),
        '#!/usr/bin/env bash\n[ "$1" = abort ] && exit 91\nexit 92\n'
      );
      chmodSync(join(control, 'engine-release-seal.py'), 0o755);
      writeFileSync(
        join(control, 'engine-supervisor.sh'),
        `#!/usr/bin/env bash
printf '%s\n%s\n%s\n' "$ENGINE_SUPERVISOR_FORCE_DESIRED" "$ENGINE_SUPERVISOR_REQUIRE_EXACT_HEALTH" "$ENGINE_RECOVERY_DEADLINE_EPOCH" > '${marker}'
exit 0
`
      );
      chmodSync(join(control, 'engine-supervisor.sh'), 0o755);
      writeFileSync(
        join(bin, 'id'),
        '#!/usr/bin/env bash\n[ "${1:-}" = -u ] && { printf "0\\n"; exit 0; }\nexit 1\n'
      );
      writeFileSync(join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
      writeFileSync(join(bin, 'docker'), '#!/usr/bin/env bash\n[ "$1" = info ]\n');
      writeFileSync(
        join(bin, 'timeout'),
        '#!/usr/bin/env bash\nset -e\nwhile [[ "${1:-}" == --* ]]; do shift; done\n[[ "${1:-}" =~ ^[0-9]+s$ ]] && shift\nexec "$@"\n'
      );
      for (const command of ['id', 'flock', 'docker', 'timeout']) {
        chmodSync(join(bin, command), 0o755);
      }

      const result = spawnSync(
        'bash',
        [join(control, 'engine-release-recover.sh'), '--run-id', '77-1', '--mode', 'retryable'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            ENGINE_RELEASE_REQUEST_ROOT: requests,
            ENGINE_RELEASE_PIN_ROOT: pins,
            ENGINE_RELEASE_IMAGE_LEASE_ROOT: leases,
            ENGINE_LOCK_FILE: join(sandbox, 'engine.lock'),
          },
        }
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(91);
      const forceEnv = readFileSync(marker, 'utf8').trim().split('\n');
      expect(forceEnv[0]).toBe('1');
      expect(forceEnv[1]).toBe('1');
      expect(Number(forceEnv[2])).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(readFileSync(join(requests, '77-1.request'), 'utf8')).toContain('must remain');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
