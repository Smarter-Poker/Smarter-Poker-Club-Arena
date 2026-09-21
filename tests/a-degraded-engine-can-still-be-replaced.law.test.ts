import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const transaction = readFileSync(
  resolve(root, 'server/scripts/engine-release-transaction.sh'),
  'utf8'
);
const workflow = readFileSync(resolve(root, '.github/workflows/auto-deploy-hetzner.yml'), 'utf8');
const healthHandler = readFileSync(resolve(root, 'server/src/handlers/health.ts'), 'utf8');
const unitWrapper = readFileSync(
  resolve(root, 'server/scripts/engine-release-unit-wrapper.sh'),
  'utf8'
);
const supervisor = readFileSync(resolve(root, 'server/scripts/engine-supervisor.sh'), 'utf8');

function shellFunction(name: string, nextName: string): string {
  const marker = transaction.indexOf(`\n${name}() {`);
  const start = marker < 0 ? -1 : marker + 1;
  const end = transaction.indexOf(`\n${nextName}() {`, start);
  expect(start, `${name} exists`).toBeGreaterThan(-1);
  expect(end, `${nextName} follows ${name}`).toBeGreaterThan(start);
  return transaction.slice(start, end);
}

// Subprocess contract suite: it runs real child processes, so its wall time
// scales with machine load, not with the code under test. Slowest test here
// measured 2916ms solo; vitest's 5s default is a unit-test budget and times
// out under the pre-push hook's 90-file parallel run. 90s is 31x measured,
// well above the worst contention amplification observed (7.1x).
describe('a degraded engine can still be replaced', { timeout: 90_000 }, () => {
  it('the health handler preserves the same certificate body for HTTP 200 and 503', () => {
    expect(healthHandler).toMatch(/sendJSON\(res, dealerReady \? 200 : 503, status\)/);
  });

  it('the root-owned transaction accepts only a 200 or 503 maintenance response', () => {
    const certificate = shellFunction('maintenance_certificate', 'persist_break_deadline');

    expect(certificate).toContain("curl -sS --max-time 10 --write-out $'\\n%{http_code}'");
    expect(certificate).toContain('case "$http_code" in\n    200|503)');
    expect(certificate).not.toMatch(/curl\s+-[^\n]*f/);
    expect(certificate).toContain('m.get("readyForRestart") is True');
    expect(certificate).toContain('m.get("unparkedTables")==0');
  });

  it('rechecks the certificate under the mutation lock before preparing a release', () => {
    const firstCertificate = transaction.indexOf('BREAK_REMAINING_MS="$(maintenance_certificate)"');
    const lock = transaction.indexOf("acquire_engine_lock 'maintenance cutover'", firstCertificate);
    const secondCertificate = transaction.indexOf(
      'BREAK_REMAINING_MS="$(maintenance_certificate)"',
      lock
    );
    const rollbackProof = transaction.indexOf('prove_rollback_readiness', secondCertificate);
    const prepare = transaction.indexOf('PREPARE_OUTPUT=', rollbackProof);

    expect(firstCertificate).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(firstCertificate);
    expect(secondCertificate).toBeGreaterThan(lock);
    expect(rollbackProof).toBeGreaterThan(secondCertificate);
    expect(prepare).toBeGreaterThan(rollbackProof);
  });

  it('admits a degraded exact source and rollback without weakening candidate proof', () => {
    const strictHealth = shellFunction(
      'health_instance_for_sha',
      'parse_sealed_source_instance_for_sha'
    );
    const sourceHealth = shellFunction('source_instance_for_sha', 'health_instance');
    const rollbackReadiness = shellFunction('prove_rollback_readiness', 'emit_already_released');

    expect(strictHealth).toContain("--write-out $'\\n%{http_code}'");
    expect(strictHealth).toContain('[ "$http_code" = 200 ]');
    expect(strictHealth).not.toContain('200|503');
    expect(sourceHealth).toContain('case "$http_code" in\n    200|503)');
    expect(sourceHealth).not.toMatch(/curl\s+-[^\n]*f/);
    expect(rollbackReadiness).toContain('source_instance_for_sha');
    expect(rollbackReadiness).not.toContain('health_instance_for_sha');
    expect(supervisor).toContain('case "$http_code" in\n    200|503)');
    expect(supervisor).not.toMatch(/curl\s+-[^\n]*f/);

    const engineUp = transaction.indexOf('"$ENGINE_UP"');
    const candidateCheck = transaction.indexOf(
      'CANDIDATE_INSTANCE="$(health_instance \'http://127.0.0.1:8080/health\')"',
      engineUp
    );
    expect(engineUp).toBeGreaterThan(-1);
    expect(candidateCheck).toBeGreaterThan(engineUp);
    expect(transaction.slice(engineUp)).not.toContain('source_instance_for_sha');
  });

  // This runs a complete sandboxed transaction and its repeated fsync proofs;
  // allow loaded-suite process startup without weakening any release deadline.
  it('runs the real transaction through rollback proof to prepare from an exact HTTP 503 source', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'engine-degraded-source-'));
    try {
      const generation = join(sandbox, 'generation');
      const requestRoot = join(sandbox, 'requests');
      const leaseRoot = join(sandbox, 'leases');
      const repo = join(sandbox, 'repo');
      const bin = join(sandbox, 'bin');
      const runKey = '4270-1';
      const sourceSha = 'a'.repeat(40);
      const targetSha = 'b'.repeat(40);
      const controlSha = 'c'.repeat(40);
      const sourceTree = 'd'.repeat(40);
      const sourceImage = `sha256:${'e'.repeat(64)}`;
      const targetImage = `sha256:${'f'.repeat(64)}`;
      const containerId = '1'.repeat(64);
      const instanceId = '12345-deadbeef';
      const eventLog = join(sandbox, 'events.log');
      const prepareLog = join(sandbox, 'prepare.log');
      const curlLog = join(sandbox, 'curl.log');
      const databaseLog = join(sandbox, 'database.log');
      const buildMarker = join(sandbox, 'built');
      const databaseMarker = join(sandbox, 'database-proved');
      const mutationMarker = join(sandbox, 'engine-up-called');
      const abortMarker = join(sandbox, 'abort-called');
      for (const path of [generation, requestRoot, leaseRoot, repo, bin]) mkdirSync(path);
      const canonicalGeneration = realpathSync(generation);

      // The production host uses Bash 5. The test host uses macOS Bash 3.2, so
      // add only a fixture-local implementation of the mapfile builtin; the
      // release transaction and every boundary under test remain unchanged.
      const executableFixture = transaction.replace(
        'set -euo pipefail',
        `set -euo pipefail
mapfile() {
  [ "\${1:-}" = -t ] && [ "$#" = 2 ] || return 2
  local target="$2" line
  case "$target" in
    REQUEST_LINES)
      REQUEST_LINES=()
      while IFS= read -r line; do REQUEST_LINES[\${#REQUEST_LINES[@]}]="$line"; done
      ;;
    IMAGE_FIELDS)
      IMAGE_FIELDS=()
      while IFS= read -r line; do IMAGE_FIELDS[\${#IMAGE_FIELDS[@]}]="$line"; done
      ;;
    existing)
      existing=()
      while IFS= read -r line; do existing[\${#existing[@]}]="$line"; done
      ;;
    *) return 2 ;;
  esac
}`
      );
      expect(executableFixture).not.toBe(transaction);
      writeFileSync(join(generation, 'engine-release-transaction.sh'), executableFixture);
      chmodSync(join(generation, 'engine-release-transaction.sh'), 0o755);
      writeFileSync(join(generation, 'control-sha'), `${controlSha}\n`);
      writeFileSync(
        join(requestRoot, `${runKey}.request`),
        `${[
          targetSha,
          'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/4270',
          'degraded-source-test',
          canonicalGeneration,
          controlSha,
          String(Math.floor(Date.now() / 1000) + 1100),
        ].join('\n')}\n`
      );
      writeFileSync(join(sandbox, 'engine.env'), 'DATABASE_URL=test-only\n');

      writeFileSync(
        join(generation, 'engine-release-seal.py'),
        `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}:\${2:-}" in
  pending-owner:) printf '%s\\n' none ;;
  get:desired-sha) printf '%s\\n' '${sourceSha}' ;;
  get:high-water-sha)
    printf '%s\\n' '${sourceSha}'
    printf '%s\\n' 'sealed-high-water-read' >> '${eventLog}'
    ;;
  get:desired-image-id) printf '%s\\n' '${sourceImage}' ;;
  get:desired-legacy-unlabelled) printf '%s\\n' false ;;
  attest-commit:*) exit 1 ;;
  prepare:*)
    printf '%s\\n' "$*" >> '${prepareLog}'
    printf '%s\\n' 'seal-prepare' >> '${eventLog}'
    exit 86
    ;;
  abort:*) touch '${abortMarker}' ;;
  *) exit 87 ;;
esac
`
      );
      writeFileSync(join(generation, 'engine-supervisor.sh'), '#!/usr/bin/env bash\nexit 0\n');
      writeFileSync(
        join(generation, 'build-engine-image.sh'),
        `#!/usr/bin/env bash
touch '${buildMarker}'
printf '%s\\n' builder >> '${eventLog}'
`
      );
      writeFileSync(
        join(generation, 'engine-release-database-proof.py'),
        `#!/usr/bin/env bash
set -euo pipefail
[[ " $* " == *" --sha ${sourceSha} "* ]]
[[ " $* " == *" --instance-id ${instanceId} "* ]]
[[ " $* " == *" --max-heartbeat-age-seconds 15 "* ]]
printf '%s\\n' "$*" > '${databaseLog}'
touch '${databaseMarker}'
printf '%s\\n' database-proof >> '${eventLog}'
`
      );
      writeFileSync(
        join(generation, 'engine-up.sh'),
        `#!/usr/bin/env bash
touch '${mutationMarker}'
printf '%s\\n' MUTATION-engine-up >> '${eventLog}'
exit 88
`
      );
      for (const name of [
        'engine-release-seal.py',
        'engine-supervisor.sh',
        'build-engine-image.sh',
        'engine-release-database-proof.py',
        'engine-up.sh',
      ]) {
        chmodSync(join(generation, name), 0o755);
      }

      const healthBody = JSON.stringify({
        running: true,
        releaseSha: sourceSha,
        liveness: 'ok',
        instanceId,
        maintenance: {
          active: true,
          phase: 'counting_down',
          durableConfirmed: true,
          readyForRestart: true,
          unparkedTables: 0,
          remainingMs: 296_000,
        },
      });
      writeFileSync(join(bin, 'id'), '#!/usr/bin/env bash\n[ "$1" = -u ] && echo 0\n');
      writeFileSync(join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
      writeFileSync(
        join(bin, 'timeout'),
        '#!/usr/bin/env bash\nset -e\nwhile [[ "${1:-}" == --* ]]; do shift; done\n[[ "${1:-}" =~ ^[0-9]+s$ ]] && shift\nexec "$@"\n'
      );
      writeFileSync(
        join(bin, 'curl'),
        `#!/usr/bin/env bash
url=''
has_write=false
has_cache=false
for argument in "$@"; do
  case "$argument" in
    -fsS) exit 22 ;;
    --write-out) has_write=true ;;
    'Cache-Control: no-cache, no-store') has_cache=true ;;
  esac
  url="$argument"
done
[ "$has_write" = true ] || exit 23
printf '503 %s\\n' "$url" >> '${curlLog}'
if [ "$has_cache" = true ]; then
  printf 'source-503:%s\\n' "$url" >> '${eventLog}'
else
  printf 'certificate-503:%s\\n' "$url" >> '${eventLog}'
fi
printf '%s\\n%s' '${healthBody}' 503
`
      );
      writeFileSync(
        join(bin, 'git'),
        `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *' fetch --no-tags '*) exit 0 ;;
  *" rev-parse --verify origin/main^{commit}") printf '%s\\n' '${targetSha}' ;;
  *' cat-file -e '*) exit 0 ;;
  *' merge-base --is-ancestor '*) exit 0 ;;
  *' log '*' -1 --format=%H -- '*) printf '%s\\n' '${targetSha}' ;;
  *" rev-parse --verify ${targetSha}:server") printf '%s\\n' '${sourceTree}' ;;
  *) exit 89 ;;
esac
`
      );
      writeFileSync(
        join(bin, 'docker'),
        `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  run|start|stop|restart|update|unpause|rm|kill)
    printf 'MUTATION-docker-%s\\n' "$1" >> '${eventLog}'
    exit 97
    ;;
esac
if [ "\${1:-}" = info ]; then exit 0; fi
if [ "\${1:-}" = image ] && [ "\${2:-}" = inspect ]; then
  if [ "\${3:-}" = --format ]; then
    if [ "\${4:-}" = '{{json .Config.Env}}' ]; then
      [ "\${5:-}" = '${sourceImage}' ] || exit 92
      printf '%s\\n' '["GIT_COMMIT_SHA=${sourceSha}"]'
      printf '%s\\n' image-source-proof >> '${eventLog}'
      exit 0
    fi
    printf '%s\\n' '{"Id":"${targetImage}","Config":{"Labels":{"org.opencontainers.image.revision":"${targetSha}","com.smarterpoker.engine.source-tree":"${sourceTree}","com.smarterpoker.engine.build-contract":"clean-server-archive-v1"}}}'
  fi
  exit 0
fi
if [ "\${1:-}" = container ] && [ "\${2:-}" = inspect ]; then
  format=''
  while [ "$#" -gt 0 ]; do
    [ "$1" = -f ] && { format="$2"; shift 2; continue; }
    shift
  done
  case "$format" in
    '{{.Id}}') printf '%s\\n' '${containerId}' ;;
    '{{.State.StartedAt}}') printf '%s\\n' '2026-09-11T12:00:00.000000000Z' ;;
    '{{.Image}}') printf '%s\\n' '${sourceImage}' ;;
    '{{.State.Status}}') printf '%s\\n' running ;;
    *sp.release.sha*) printf '%s\\n' '${sourceSha}' ;;
    *autoheal*) printf '%s\\n' true ;;
    *sp.role*) printf '%s\\n' engine ;;
    *RestartPolicy.Name*) printf '%s\\n' always ;;
    *) exit 90 ;;
  esac
  exit 0
fi
if [ "\${1:-}" = ps ]; then exit 0; fi
exit 91
`
      );
      writeFileSync(
        join(bin, 'mv'),
        '#!/usr/bin/env bash\n[ "${1:-}" = -fT ] && shift\nexec /bin/mv "$@"\n'
      );
      writeFileSync(
        join(bin, 'ln'),
        '#!/usr/bin/env bash\n[ "${1:-}" = -- ] && shift\nexec /bin/ln "$@"\n'
      );
      for (const name of ['id', 'flock', 'timeout', 'curl', 'git', 'docker', 'mv', 'ln']) {
        chmodSync(join(bin, name), 0o755);
      }

      const result = spawnSync(
        'bash',
        [join(generation, 'engine-release-transaction.sh'), '--run-id', runKey],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            REPO_DIR: repo,
            ENGINE_RELEASE_REQUEST_ROOT: requestRoot,
            ENGINE_RELEASE_IMAGE_LEASE_ROOT: leaseRoot,
            ENGINE_LOCK_FILE: join(sandbox, 'engine.lock'),
            SOURCE_LOCK_FILE: join(sandbox, 'source.lock'),
            ENV_FILE: join(sandbox, 'engine.env'),
            ENGINE_URL: 'https://engine.example.invalid',
            INVOCATION_ID: '2'.repeat(32),
            ENGINE_RELEASE_MAX_RUNTIME_SECONDS: '1200',
          },
        }
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('release seal refused the candidate');
      expect(result.stdout).toContain(
        `exact desired rollback source ${sourceSha} is live locally and publicly with a fresh database leader as ${instanceId}`
      );
      const prepareCall = readFileSync(prepareLog, 'utf8');
      expect(prepareCall).toContain(`prepare --sha ${targetSha}`);
      expect(prepareCall).toContain(`--image ${targetImage}`);
      expect(prepareCall).toContain(`--run-id ${runKey}`);
      expect(existsSync(buildMarker)).toBe(true);
      expect(existsSync(databaseMarker)).toBe(true);
      const databaseCall = readFileSync(databaseLog, 'utf8');
      expect(databaseCall).toContain(`--sha ${sourceSha}`);
      expect(databaseCall).toContain(`--instance-id ${instanceId}`);
      expect(existsSync(mutationMarker)).toBe(false);
      expect(existsSync(abortMarker)).toBe(false);
      const curlCalls = readFileSync(curlLog, 'utf8');
      expect(curlCalls).toContain('503 http://127.0.0.1:8080/health');
      expect(curlCalls).toContain('503 https://engine.example.invalid/health?nocache=');
      const events = readFileSync(eventLog, 'utf8').trim().split('\n');
      expect(events.indexOf('sealed-high-water-read')).toBeGreaterThan(-1);
      expect(events.indexOf('sealed-high-water-read')).toBeLessThan(events.indexOf('builder'));
      const certificates = events.filter((event) => event.startsWith('certificate-503:'));
      const sourceProofs = events
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => event.startsWith('source-503:'));
      const databaseProof = events.indexOf('database-proof');
      expect(events.indexOf('image-source-proof')).toBeGreaterThan(-1);
      expect(events.indexOf('image-source-proof')).toBeLessThan(sourceProofs[0].index);
      expect(certificates).toHaveLength(2);
      expect(sourceProofs).toHaveLength(4);
      expect(databaseProof).toBeGreaterThan(sourceProofs[1].index);
      expect(databaseProof).toBeLessThan(sourceProofs[2].index);
      expect(events[events.length - 1]).toBe('seal-prepare');
      expect(events.some((event) => event.startsWith('MUTATION'))).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 15_000);

  it('the workflow delegates mutation and independently proves routing-ready health', () => {
    expect(workflow).toContain('server/scripts/install-engine-intake.sh');
    expect(workflow).toContain('$STAGE/server/scripts/install-engine-intake.sh');
    expect(unitWrapper).toContain(
      '"$GENERATION/engine-release-transaction.sh" --run-id "$RUN_KEY"'
    );
    expect(workflow).toMatch(
      /Independently prove the sealed local, public, and leader identity[\s\S]*curl -fsS[\s\S]*\$ENGINE_URL\/health/
    );
    expect(workflow).not.toContain('Wait for the maintenance break to park every table');
  });
});

// The executable 200/503 matrix, transport failures, malformed bodies, false
// predicates, and insufficient-time result are covered once in
// tests/unit/engineReleaseMaintenanceCertificate.test.ts.
