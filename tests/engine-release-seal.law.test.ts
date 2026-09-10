import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');
const sealScript = resolve(ROOT, 'server/scripts/engine-release-seal.py');

const A_SHA = 'a'.repeat(40);
const B_SHA = 'b'.repeat(40);
const C_SHA = 'c'.repeat(40);
const A_IMAGE = `sha256:${'a'.repeat(64)}`;
const B_IMAGE = `sha256:${'b'.repeat(64)}`;
const C_IMAGE = `sha256:${'c'.repeat(64)}`;

describe('the durable engine release seal', () => {
  let sandbox = '';
  let bin = '';
  let baseEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'engine-release-seal-'));
    bin = join(sandbox, 'bin');
    mkdirSync(bin);

    const docker = `#!/usr/bin/env bash
set -euo pipefail
kind="$1"; action="$2"; shift 2
[ "$action" = inspect ]
while [ "$1" = --format ]; do shift 2; done
ref="$1"
if [ "$kind" = image ]; then
  case "$ref" in
    desired-ref|${A_IMAGE}) id='${A_IMAGE}'; sha='${A_SHA}' ;;
    candidate-ref|${B_IMAGE}) id='${B_IMAGE}'; sha='${B_SHA}' ;;
    divergent-ref|${C_IMAGE}) id='${C_IMAGE}'; sha='${C_SHA}' ;;
    *) exit 1 ;;
  esac
  if [ "\${FAKE_LEGACY_IMAGE:-0}" = 1 ] && [ "$id" = '${A_IMAGE}' ]; then
    printf '{"Id":"%s","Config":{"Labels":{},"Env":["GIT_COMMIT_SHA=%s"]}}\\n' "$id" "$sha"
  else
    printf '{"Id":"%s","Config":{"Labels":{"org.opencontainers.image.revision":"%s"},"Env":["GIT_COMMIT_SHA=%s"]}}\\n' "$id" "$sha" "$sha"
  fi
elif [ "$kind" = container ]; then
  [ "$ref" = club-arena-engine ] || exit 1
  printf '{"Image":"%s","State":{"Status":"%s"}}\\n' "\${FAKE_CONTAINER_IMAGE:-${A_IMAGE}}" "\${FAKE_CONTAINER_STATUS:-running}"
else
  exit 1
fi
`;
    writeFileSync(join(bin, 'docker'), docker);
    chmodSync(join(bin, 'docker'), 0o755);

    const git = `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = -C ]; then shift 2; fi
case "$1" in
  cat-file) exit 0 ;;
  merge-base)
    [ "$2" = --is-ancestor ]
    older="$3"; newer="$4"
    [ "$older" = "$newer" ] && exit 0
    [ "$newer" = origin/main ] && exit 0
    [ "$older" = '${A_SHA}' ] && [ "$newer" = '${B_SHA}' ] && exit 0
    exit 1
    ;;
  *) exit 1 ;;
esac
`;
    writeFileSync(join(bin, 'git'), git);
    chmodSync(join(bin, 'git'), 0o755);

    baseEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      ENGINE_RELEASE_STATE_DIR: join(sandbox, 'state'),
      ENGINE_RELEASE_STATE_FILE: join(sandbox, 'state', 'seal.json'),
      ENGINE_RELEASE_AUDIT_FILE: join(sandbox, 'state', 'audit.jsonl'),
      ENGINE_RELEASE_LOCK_FILE: join(sandbox, 'seal.lock'),
    };
  });

  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  const auditArgs = (runId: string, reason: string) => [
    '--run-id',
    runId,
    '--run-url',
    `https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/${runId}`,
    '--actor',
    'release-test',
    '--reason',
    reason,
  ];

  const runSeal = (
    args: string[],
    overrides: NodeJS.ProcessEnv = {}
  ): { status: number | null; stdout: string; stderr: string } => {
    const result = spawnSync('python3', [sealScript, ...args], {
      encoding: 'utf8',
      env: { ...baseEnv, ...overrides },
    });
    return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  };

  const state = () =>
    JSON.parse(readFileSync(join(sandbox, 'state', 'seal.json'), 'utf8')) as {
      desired: { sha: string; imageId: string; legacyUnlabelled: boolean };
      highWaterSha: string;
      pending: null | { used: boolean; mode: string; expiresAt: number };
      generation: number;
    };

  it('blocks a retag/reset start unless the exact prepared SHA and image ID consume one token', () => {
    expect(
      runSeal([
        'bootstrap-running',
        '--container',
        'club-arena-engine',
        ...auditArgs('101', 'bootstrap existing production'),
      ]).status
    ).toBe(0);
    expect(state()).toMatchObject({
      desired: { sha: A_SHA, imageId: A_IMAGE },
      highWaterSha: A_SHA,
      pending: null,
    });

    const directRetag = runSeal(['authorize', '--image', 'candidate-ref']);
    expect(directRetag.status).toBe(1);
    expect(directRetag.stderr).toContain('no live cutover authorization exists');

    const prepared = runSeal([
      'prepare',
      '--sha',
      B_SHA,
      '--image',
      'candidate-ref',
      '--mode',
      'deploy',
      '--repo',
      sandbox,
      ...auditArgs('102', 'normal deployment from origin main'),
    ]);
    expect(prepared.status).toBe(0);
    expect(prepared.stdout).toMatch(/^[0-9a-f]{64}$/);

    expect(
      runSeal(['authorize', '--image', 'candidate-ref', '--token', prepared.stdout]).stdout
    ).toBe(`pending ${B_SHA} ${B_IMAGE}`);
    const replay = runSeal(['authorize', '--image', 'candidate-ref', '--token', prepared.stdout]);
    expect(replay.status).toBe(1);
    expect(replay.stderr).toContain('already consumed');

    const committed = runSeal(
      [
        'commit',
        '--sha',
        B_SHA,
        '--image',
        'candidate-ref',
        '--container',
        'club-arena-engine',
        ...auditArgs('102', 'all compatibility proofs passed'),
      ],
      { FAKE_CONTAINER_IMAGE: B_IMAGE }
    );
    expect(committed.status).toBe(0);
    expect(state()).toMatchObject({
      desired: { sha: B_SHA, imageId: B_IMAGE, legacyUnlabelled: false },
      highWaterSha: B_SHA,
      pending: null,
      generation: 2,
    });
  });

  it('bootstraps the first seal from the currently running pre-label b4 image', () => {
    const bootstrapped = runSeal(
      [
        'bootstrap-running',
        '--container',
        'club-arena-engine',
        ...auditArgs('150', 'bootstrap current b4 production'),
      ],
      { FAKE_LEGACY_IMAGE: '1' }
    );
    expect(bootstrapped.status).toBe(0);
    expect(bootstrapped.stdout).toBe(A_SHA);
    expect(state()).toMatchObject({
      desired: { sha: A_SHA, imageId: A_IMAGE, legacyUnlabelled: true },
      highWaterSha: A_SHA,
      pending: null,
    });
    expect(runSeal(['get', 'desired-legacy-unlabelled']).stdout).toBe('true');
  });

  it('executes candidates with restart=no and desired recovery with restart=always', () => {
    expect(
      runSeal([
        'bootstrap-running',
        '--container',
        'club-arena-engine',
        ...auditArgs('140', 'bootstrap existing production'),
      ]).status
    ).toBe(0);
    const prepared = runSeal([
      'prepare',
      '--sha',
      B_SHA,
      '--image',
      'candidate-ref',
      '--mode',
      'deploy',
      '--repo',
      sandbox,
      ...auditArgs('141', 'normal deployment from origin main'),
    ]);
    expect(prepared.status).toBe(0);

    const runLog = join(sandbox, 'docker-runs.log');
    writeFileSync(runLog, '');
    writeFileSync(
      join(bin, 'docker'),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = image ] && [ "$2" = inspect ]; then
  shift 2
  formatted=0
  if [ "\${1:-}" = --format ]; then formatted=1; shift 2; fi
  ref="\${1:-}"
  case "$ref" in
    desired-ref|${A_IMAGE}) id='${A_IMAGE}'; sha='${A_SHA}' ;;
    candidate-ref|${B_IMAGE}) id='${B_IMAGE}'; sha='${B_SHA}' ;;
    *) exit 1 ;;
  esac
  if [ "$formatted" = 1 ]; then
    printf '{"Id":"%s","Config":{"Labels":{"org.opencontainers.image.revision":"%s"},"Env":["GIT_COMMIT_SHA=%s"]}}\\n' "$id" "$sha" "$sha"
  else
    printf '{}\\n'
  fi
  exit 0
fi
if [ "$1" = container ] && [ "$2" = inspect ]; then exit 1; fi
if [ "$1" = run ]; then
  shift
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_RUN_LOG"
  printf '%s\\n' '${'1'.repeat(64)}'
  exit 0
fi
if [ "$1" = inspect ]; then printf '%s\\n' '${'1'.repeat(64)}'; exit 0; fi
exit 1
`
    );
    chmodSync(join(bin, 'docker'), 0o755);
    writeFileSync(join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(bin, 'flock'), 0o755);
    const envFile = join(sandbox, 'engine.env');
    writeFileSync(envFile, 'DATABASE_URL=postgres://example.invalid/db\n');
    const engineUp = resolve(ROOT, 'server/scripts/engine-up.sh');
    const common = {
      ...baseEnv,
      CONTAINER: 'club-arena-engine',
      ENGINE_RELEASE_SEAL: sealScript,
      ENV_FILE: envFile,
      FAKE_DOCKER_RUN_LOG: runLog,
      LOCK_FILE: join(sandbox, 'engine-up.lock'),
      LOG_DIR: join(sandbox, 'logs'),
    };

    const candidate = spawnSync('bash', [engineUp], {
      encoding: 'utf8',
      env: {
        ...common,
        ENGINE_RELEASE_TOKEN: prepared.stdout,
        IMAGE: 'candidate-ref',
      },
    });
    expect(candidate.status, candidate.stderr).toBe(0);
    expect(readFileSync(runLog, 'utf8')).toContain('--restart no');

    writeFileSync(runLog, '');
    const desired = spawnSync('bash', [engineUp], {
      encoding: 'utf8',
      env: { ...common, IMAGE: 'desired-ref' },
    });
    expect(desired.status, desired.stderr).toBe(0);
    expect(readFileSync(runLog, 'utf8')).toContain('--restart always');
  });

  it('preserves the exact sealed pre-label container when the first supervisor tick runs', () => {
    expect(
      runSeal(
        [
          'bootstrap-running',
          '--container',
          'club-arena-engine',
          ...auditArgs('151', 'bootstrap current b4 production before supervisor activation'),
        ],
        { FAKE_LEGACY_IMAGE: '1' }
      ).status
    ).toBe(0);

    const mutationLog = join(sandbox, 'mutations.log');
    const upScript = join(sandbox, 'engine-up-stub.sh');
    writeFileSync(mutationLog, '');
    writeFileSync(
      upScript,
      `#!/usr/bin/env bash
printf 'engine-up invoked\\n' >> "$FAKE_MUTATION_LOG"
exit 0
`
    );
    chmodSync(upScript, 0o755);

    // The first production image has no OCI revision label and its existing
    // container has no sp.release.sha label. Its immutable image ID and baked
    // SHA are nevertheless sealed. Any start/stop/rm/run call here would be an
    // off-break replacement caused solely by installing the supervisor.
    writeFileSync(
      join(bin, 'docker'),
      `#!/usr/bin/env bash
set -eo pipefail
if [ "$1" = info ]; then exit 0; fi
kind="$1"; action="$2"; shift 2
if [ "$action" != inspect ]; then
  printf 'docker %s %s %s\\n' "$kind" "$action" "$*" >> "$FAKE_MUTATION_LOG"
  exit 0
fi
format=''
if [ "\${1:-}" = -f ] || [ "\${1:-}" = --format ]; then
  format="$2"
  shift 2
fi
ref="\${1:-}"
if [ "$kind" = image ]; then
  case "$ref" in '${A_IMAGE}'|club-arena-engine:current) ;; *) exit 1 ;; esac
  case "$format" in
    '{{.Id}}') printf '%s\\n' '${A_IMAGE}' ;;
    *) printf '{"Id":"%s"}\\n' '${A_IMAGE}' ;;
  esac
  exit 0
fi
[ "$kind" = container ] && [ "$ref" = sp-autoheal ] && [ "$format" = '{{.State.Status}}' ] \
  && { printf 'running\\n'; exit 0; }
[ "$kind" = container ] && [ "$ref" = club-arena-engine ] || exit 1
case "$format" in
  '{{json .}}'|'') printf '{"Image":"%s","State":{"Status":"running"}}\\n' '${A_IMAGE}' ;;
  '{{.Image}}') printf '%s\\n' '${A_IMAGE}' ;;
  '{{.State.Status}}') printf 'running\\n' ;;
  '{{index .Config.Labels "autoheal"}}') printf 'true\\n' ;;
  '{{index .Config.Labels "sp.release.sha"}}') printf '\\n' ;;
  '{{.HostConfig.RestartPolicy.Name}}') printf 'always\\n' ;;
  '{{.State.StartedAt}}') printf '\\n' ;;
  *) exit 1 ;;
esac
`
    );
    chmodSync(join(bin, 'docker'), 0o755);
    writeFileSync(
      join(bin, 'curl'),
      '#!/usr/bin/env bash\nprintf \'{"running":true,"liveness":"ok"}\\n\'\n'
    );
    chmodSync(join(bin, 'curl'), 0o755);
    writeFileSync(join(bin, 'logger'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(bin, 'logger'), 0o755);
    writeFileSync(join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(bin, 'flock'), 0o755);

    const supervisor = spawnSync('bash', [resolve(ROOT, 'server/scripts/engine-supervisor.sh')], {
      encoding: 'utf8',
      env: {
        ...baseEnv,
        CONTAINER: 'club-arena-engine',
        ENGINE_RELEASE_SEAL: sealScript,
        FAKE_MUTATION_LOG: mutationLog,
        IMAGE_REPO: 'club-arena-engine',
        LOCK_FILE: join(sandbox, 'engine-up.lock'),
        STATE_DIR: join(sandbox, 'supervisor-state'),
        TEXTFILE_DIR: join(sandbox, 'metrics'),
        UP_SCRIPT: upScript,
      },
    });
    expect(supervisor.status, supervisor.stderr).toBe(0);
    expect(supervisor.stdout).toContain(
      'preserving its exact image until the first certified cutover'
    );
    expect(readFileSync(mutationLog, 'utf8')).toBe('');
  });

  it('restores desired instead of accepting a reboot-persistent pending candidate', () => {
    runSeal([
      'bootstrap-running',
      '--container',
      'club-arena-engine',
      ...auditArgs('152', 'bootstrap existing production'),
    ]);
    const prepared = runSeal([
      'prepare',
      '--sha',
      B_SHA,
      '--image',
      'candidate-ref',
      '--mode',
      'deploy',
      '--repo',
      sandbox,
      ...auditArgs('153', 'normal deployment from origin main'),
    ]);
    runSeal(['authorize', '--image', 'candidate-ref', '--token', prepared.stdout]);

    const mutationLog = join(sandbox, 'pending-policy-mutations.log');
    const autohealState = join(sandbox, 'autoheal-state');
    const upScript = join(sandbox, 'engine-up-stub.sh');
    writeFileSync(mutationLog, '');
    writeFileSync(autohealState, 'exited\n');
    writeFileSync(
      upScript,
      '#!/usr/bin/env bash\nprintf \'engine-up %s\\n\' "$IMAGE" >> "$FAKE_MUTATION_LOG"\n'
    );
    chmodSync(upScript, 0o755);
    writeFileSync(
      join(bin, 'docker'),
      `#!/usr/bin/env bash
set -eo pipefail
if [ "$1" = info ]; then exit 0; fi
kind="$1"; action="$2"; shift 2
format=''
if [ "\${1:-}" = -f ] || [ "\${1:-}" = --format ]; then format="$2"; shift 2; fi
ref="\${1:-}"
if [ "$kind" = image ] && [ "$action" = inspect ]; then
  case "$ref" in
    ${A_IMAGE}) id='${A_IMAGE}' ;;
    ${B_IMAGE}|club-arena-engine:current) id='${B_IMAGE}' ;;
    *) exit 1 ;;
  esac
  case "$format" in '{{.Id}}') printf '%s\\n' "$id" ;; *) printf '{"Id":"%s"}\\n' "$id" ;; esac
  exit 0
fi
if [ "$kind" = container ] && [ "$action" = inspect ] && [ "$ref" = club-arena-engine ]; then
  case "$format" in
    '{{json .}}'|'') printf '{"Image":"%s","State":{"Status":"%s"}}\\n' '${B_IMAGE}' "\${FAKE_CONTAINER_STATUS:-running}" ;;
    '{{.Image}}') printf '%s\\n' '${B_IMAGE}' ;;
    '{{.State.Status}}') printf '%s\\n' "\${FAKE_CONTAINER_STATUS:-running}" ;;
    '{{index .Config.Labels "autoheal"}}') printf 'true\\n' ;;
    '{{index .Config.Labels "sp.release.sha"}}') printf '%s\\n' '${B_SHA}' ;;
    '{{.HostConfig.RestartPolicy.Name}}') printf '%s\\n' "\${FAKE_RESTART_POLICY:-always}" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "$kind" = container ] && [ "$action" = inspect ] && [ "$ref" = sp-autoheal ]; then
  printf '%s\\n' "$(tr -d '\\n' < "$FAKE_AUTOHEAL_STATE")"
  exit 0
fi
if [ "$kind" = start ] && [ "$action" = sp-autoheal ]; then
  printf 'running\\n' > "$FAKE_AUTOHEAL_STATE"
fi
if [ "$kind" = stop ] && [ "$action" = -t ]; then
  printf 'exited\\n' > "$FAKE_AUTOHEAL_STATE"
fi
printf 'docker %s %s %s\\n' "$kind" "$action" "$*" >> "$FAKE_MUTATION_LOG"
exit 0
`
    );
    chmodSync(join(bin, 'docker'), 0o755);
    writeFileSync(join(bin, 'logger'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(bin, 'logger'), 0o755);
    writeFileSync(join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(bin, 'flock'), 0o755);

    const supervisorEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      CONTAINER: 'club-arena-engine',
      ENGINE_RELEASE_SEAL: sealScript,
      FAKE_AUTOHEAL_STATE: autohealState,
      FAKE_MUTATION_LOG: mutationLog,
      IMAGE_REPO: 'club-arena-engine',
      LOCK_FILE: join(sandbox, 'engine-up.lock'),
      STATE_DIR: join(sandbox, 'supervisor-state'),
      TEXTFILE_DIR: join(sandbox, 'metrics'),
      UP_SCRIPT: upScript,
    };
    const supervisor = spawnSync('bash', [resolve(ROOT, 'server/scripts/engine-supervisor.sh')], {
      encoding: 'utf8',
      env: supervisorEnv,
    });
    expect(supervisor.status, supervisor.stderr).toBe(0);
    expect(supervisor.stdout).toContain('restoring sealed desired release');
    const mutations = readFileSync(mutationLog, 'utf8');
    expect(mutations).toContain(`engine-up ${A_IMAGE}`);
    expect(mutations).not.toContain('update --restart no');

    writeFileSync(mutationLog, '');
    writeFileSync(
      upScript,
      '#!/usr/bin/env bash\nprintf \'engine-up %s\\n\' "$IMAGE" >> "$FAKE_MUTATION_LOG"\n'
    );
    chmodSync(upScript, 0o755);
    const rebootRecovery = spawnSync(
      'bash',
      [resolve(ROOT, 'server/scripts/engine-supervisor.sh')],
      {
        encoding: 'utf8',
        env: {
          ...supervisorEnv,
          FAKE_CONTAINER_STATUS: 'exited',
          FAKE_RESTART_POLICY: 'no',
        },
      }
    );
    expect(rebootRecovery.status, rebootRecovery.stderr).toBe(0);
    expect(rebootRecovery.stdout).toContain('disagrees with sealed desired');
    expect(rebootRecovery.stdout).toContain('restoring sealed release');
    expect(readFileSync(mutationLog, 'utf8')).toContain(`engine-up ${A_IMAGE}`);
    expect(readFileSync(mutationLog, 'utf8')).not.toContain('start club-arena-engine');

    writeFileSync(upScript, '#!/usr/bin/env bash\nexit 42\n');
    chmodSync(upScript, 0o755);
    const failedRecovery = spawnSync(
      'bash',
      [resolve(ROOT, 'server/scripts/engine-supervisor.sh')],
      { encoding: 'utf8', env: supervisorEnv }
    );
    expect(failedRecovery.status).toBe(1);
    expect(failedRecovery.stdout).toContain('exact sealed desired release could not be restored');
  });

  it('expires a prepared token at its TTL boundary before it can authorize a start', () => {
    runSeal([
      'bootstrap-running',
      '--container',
      'club-arena-engine',
      ...auditArgs('160', 'bootstrap existing production'),
    ]);
    const prepared = runSeal(
      [
        'prepare',
        '--sha',
        B_SHA,
        '--image',
        'candidate-ref',
        '--mode',
        'deploy',
        '--repo',
        sandbox,
        ...auditArgs('161', 'normal deployment from origin main'),
      ],
      { ENGINE_RELEASE_PENDING_TTL_SECONDS: '0' }
    );
    expect(prepared.status).toBe(0);
    const expired = runSeal(['authorize', '--image', 'candidate-ref', '--token', prepared.stdout]);
    expect(expired.status).toBe(1);
    expect(expired.stderr).toContain('no live cutover authorization exists');
  });

  it('rejects a normal downgrade but permits an explicit audited rollback without lowering high-water', () => {
    runSeal([
      'bootstrap-running',
      '--container',
      'club-arena-engine',
      ...auditArgs('201', 'bootstrap existing production'),
    ]);
    const forward = runSeal([
      'prepare',
      '--sha',
      B_SHA,
      '--image',
      'candidate-ref',
      '--mode',
      'deploy',
      '--repo',
      sandbox,
      ...auditArgs('202', 'normal deployment from origin main'),
    ]);
    runSeal(['authorize', '--image', 'candidate-ref', '--token', forward.stdout]);
    runSeal(
      [
        'commit',
        '--sha',
        B_SHA,
        '--image',
        'candidate-ref',
        '--container',
        'club-arena-engine',
        ...auditArgs('202', 'all compatibility proofs passed'),
      ],
      { FAKE_CONTAINER_IMAGE: B_IMAGE }
    );

    const accidental = runSeal([
      'prepare',
      '--sha',
      A_SHA,
      '--image',
      'desired-ref',
      '--mode',
      'deploy',
      '--repo',
      sandbox,
      ...auditArgs('203', 'ordinary deploy accidentally named old ref'),
    ]);
    expect(accidental.status).toBe(1);
    expect(accidental.stderr).toContain('move behind or diverge');

    const rollback = runSeal([
      'prepare',
      '--sha',
      A_SHA,
      '--image',
      'desired-ref',
      '--mode',
      'rollback',
      '--repo',
      sandbox,
      ...auditArgs('204', 'incident rollback after failed engine release'),
    ]);
    expect(rollback.status).toBe(0);
    runSeal(['authorize', '--image', 'desired-ref', '--token', rollback.stdout]);
    expect(
      runSeal(
        [
          'commit',
          '--sha',
          A_SHA,
          '--image',
          'desired-ref',
          '--container',
          'club-arena-engine',
          ...auditArgs('204', 'rollback compatibility proofs passed'),
        ],
        { FAKE_CONTAINER_IMAGE: A_IMAGE }
      ).status
    ).toBe(0);

    expect(state()).toMatchObject({
      desired: { sha: A_SHA, imageId: A_IMAGE },
      highWaterSha: B_SHA,
      pending: null,
      generation: 3,
    });
    expect(runSeal(['authorize', '--image', 'desired-ref']).stdout).toBe(
      `desired ${A_SHA} ${A_IMAGE}`
    );

    const events = readFileSync(join(sandbox, 'state', 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).event);
    expect(events).toContain('prepare');
    expect(events).toContain('candidate_start_authorized');
    expect(events).toContain('commit');
  });

  it('will not seal a target whose image identity or running container disagrees', () => {
    runSeal([
      'bootstrap-running',
      '--container',
      'club-arena-engine',
      ...auditArgs('301', 'bootstrap existing production'),
    ]);
    const wrongRevision = runSeal([
      'prepare',
      '--sha',
      B_SHA,
      '--image',
      'divergent-ref',
      '--mode',
      'deploy',
      '--repo',
      sandbox,
      ...auditArgs('302', 'normal deployment from origin main'),
    ]);
    expect(wrongRevision.status).toBe(1);
    expect(wrongRevision.stderr).toContain('does not equal requested commit');

    const prepared = runSeal([
      'prepare',
      '--sha',
      B_SHA,
      '--image',
      'candidate-ref',
      '--mode',
      'deploy',
      '--repo',
      sandbox,
      ...auditArgs('303', 'normal deployment from origin main'),
    ]);
    runSeal(['authorize', '--image', 'candidate-ref', '--token', prepared.stdout]);
    const notRunning = runSeal([
      'commit',
      '--sha',
      B_SHA,
      '--image',
      'candidate-ref',
      '--container',
      'club-arena-engine',
      ...auditArgs('303', 'all compatibility proofs passed'),
    ]);
    expect(notRunning.status).toBe(1);
    expect(notRunning.stderr).toContain('not the running container');
    expect(state().desired.sha).toBe(A_SHA);
  });

  it('attests the fsynced commit receipt when the append-only audit response is uncertain', () => {
    runSeal([
      'bootstrap-running',
      '--container',
      'club-arena-engine',
      ...auditArgs('304', 'bootstrap existing production'),
    ]);
    const prepared = runSeal([
      'prepare',
      '--sha',
      B_SHA,
      '--image',
      'candidate-ref',
      '--mode',
      'deploy',
      '--repo',
      sandbox,
      ...auditArgs('305', 'normal deployment from origin main'),
    ]);
    runSeal(['authorize', '--image', 'candidate-ref', '--token', prepared.stdout]);

    const auditPath = join(sandbox, 'state', 'audit.jsonl');
    rmSync(auditPath, { force: true });
    mkdirSync(auditPath);
    const uncertain = runSeal(
      [
        'commit',
        '--sha',
        B_SHA,
        '--image',
        'candidate-ref',
        '--container',
        'club-arena-engine',
        ...auditArgs('305', 'all compatibility proofs passed'),
      ],
      { FAKE_CONTAINER_IMAGE: B_IMAGE }
    );
    expect(uncertain.status).toBe(1);
    expect(state()).toMatchObject({
      desired: { sha: B_SHA, imageId: B_IMAGE },
      pending: null,
      generation: 2,
    });
    expect(
      runSeal(['attest-commit', '--sha', B_SHA, '--image-id', B_IMAGE, '--run-id', '305']).stdout
    ).toBe(`2 ${B_SHA} ${B_IMAGE} 305`);
  });

  it('durably revokes a candidate even if the abort audit response is uncertain', () => {
    runSeal([
      'bootstrap-running',
      '--container',
      'club-arena-engine',
      ...auditArgs('306', 'bootstrap existing production'),
    ]);
    runSeal([
      'prepare',
      '--sha',
      B_SHA,
      '--image',
      'candidate-ref',
      '--mode',
      'deploy',
      '--repo',
      sandbox,
      ...auditArgs('307', 'normal deployment from origin main'),
    ]);

    const auditPath = join(sandbox, 'state', 'audit.jsonl');
    rmSync(auditPath, { force: true });
    mkdirSync(auditPath);
    const uncertain = runSeal(['abort', '--run-id', '307']);
    expect(uncertain.status).toBe(1);
    expect(state().pending).toBeNull();
  });
});

describe('every host mutation path obeys the durable release authority', () => {
  const workflow = read('.github/workflows/auto-deploy-hetzner.yml');
  const envWorkflow = read('.github/workflows/update-hetzner-env.yml');
  const engineUp = read('server/scripts/engine-up.sh');
  const supervisor = read('server/scripts/engine-supervisor.sh');
  const installer = read('server/scripts/install-engine-supervisor.sh');
  const recoveryVerifier = read('server/scripts/verify-recovery-stack.sh');
  const dockerfile = read('server/Dockerfile');

  it('authorizes immutable identity before engine-up stops the serving container', () => {
    const authorize = engineUp.indexOf('authorize --image');
    const stop = engineUp.indexOf('docker stop -t 45', authorize);
    expect(authorize).toBeGreaterThan(0);
    expect(authorize).toBeLessThan(stop);
    expect(engineUp).toContain('GIT_COMMIT_SHA|ENGINE_VERSION');
    expect(engineUp).toContain('--label "sp.release.sha=$AUTHORIZED_SHA"');
    expect(dockerfile).toContain('LABEL org.opencontainers.image.revision=$GIT_COMMIT_SHA');
  });

  it('runs the authorized image ID, so retagging the requested name after authorization is inert', () => {
    const authorize = engineUp.indexOf('AUTHORIZATION="$("$RELEASE_SEAL"');
    const immutable = engineUp.indexOf('AUTHORIZED_IMAGE_ID', authorize);
    const run = engineUp.indexOf('docker run -d');
    const runBlock = engineUp.slice(run, engineUp.indexOf('\n\nlog "started', run));
    expect(authorize).toBeGreaterThan(0);
    expect(immutable).toBeGreaterThan(authorize);
    expect(run).toBeGreaterThan(immutable);
    expect(runBlock).toContain('"$AUTHORIZED_IMAGE_ID"');
    expect(runBlock).not.toMatch(/^\s*"\$IMAGE"\s*$/m);
  });

  it('does not make a candidate reboot-persistent until every proof commits the seal', () => {
    const classBranch = engineUp.slice(
      engineUp.indexOf('case "$AUTHORIZED_CLASS" in'),
      engineUp.indexOf('[[ "$AUTHORIZED_SHA"', engineUp.indexOf('case "$AUTHORIZED_CLASS" in'))
    );
    const run = engineUp.slice(
      engineUp.indexOf('docker run -d'),
      engineUp.indexOf('\n\nlog "started', engineUp.indexOf('docker run -d'))
    );
    expect(classBranch).toContain('desired) RESTART_POLICY=always');
    expect(classBranch).toContain('pending)');
    expect(classBranch).toContain('RESTART_POLICY=no');
    expect(run).toContain('--restart "$RESTART_POLICY"');
    expect(run).not.toContain('--restart always');

    const prove = workflow.indexOf("name: 'PROVE the version moved");
    const commit = workflow.indexOf('name: Commit the verified SHA/image-ID release seal');
    const promote = workflow.indexOf('docker update --restart always', commit);
    const autoheal = workflow.indexOf('docker start sp-autoheal', commit);
    expect(prove).toBeGreaterThan(0);
    expect(commit).toBeGreaterThan(prove);
    expect(promote).toBeGreaterThan(commit);
    expect(autoheal).toBeGreaterThan(promote);
    expect(workflow.slice(commit, promote)).toContain('engine-release-seal.py commit');
    expect(workflow.slice(commit, promote)).toContain('steps.cutover.outputs.candidate_started_at');
  });

  it('installs the control plane outside the rollbackable application checkout', () => {
    expect(installer).toContain('/usr/local/lib/club-arena/engine-control');
    expect(installer).toContain('ENGINE_CONTROL_SOURCE_DIR');
    expect(installer).toMatch(/ExecStart=\$SUPERVISOR/);
    expect(workflow).toContain(
      "CONTROL_STAGE='/var/lib/club-arena/control-staging/${{ github.run_id }}'"
    );
    expect(workflow).toContain('git archive \\"\\$CONTROL_SHA\\"');
    expect(workflow).toContain('/usr/local/lib/club-arena/engine-control/engine-up.sh');
  });

  it('does not orphan a staged release merely because main advances during its build', () => {
    const stageControl = workflow.slice(
      workflow.indexOf('name: Stage the current release proof control'),
      workflow.indexOf('name: Stamp the job start')
    );
    const pull = workflow.slice(
      workflow.indexOf('name: Pull the exact commit onto the host'),
      workflow.indexOf('name: Build immutable image')
    );
    expect(stageControl).toContain('[ "$CONTROL_SHA" = "$REMOTE_MAIN" ]');
    expect(pull).toContain('git merge-base --is-ancestor \\"\\$CONTROL_SHA\\" origin/main');
    expect(pull).not.toContain('workflow control SHA is no longer current origin/main');
    expect(pull).not.toContain('\\$(git rev-parse origin/main)');
  });

  it('activates one complete control-plane generation atomically under the engine lock', () => {
    const lock = installer.indexOf('flock -w 180 9');
    const stage = installer.indexOf('GENERATION_DIR=');
    const validateShell = installer.indexOf('bash -n "$GENERATION_DIR/$script"');
    const nextLink = installer.indexOf('ln -s "$GENERATION_DIR" "$NEXT_LINK"');
    const durableNextLink = installer.indexOf('fsync_paths "$CONTROL_PARENT"', nextLink);
    const activate = installer.indexOf('mv -Tf "$NEXT_LINK" "$CONTROL_DIR"');
    const durableActivation = installer.indexOf('fsync_paths "$CONTROL_PARENT"', activate);
    expect(lock).toBeGreaterThan(0);
    expect(stage).toBeGreaterThan(lock);
    expect(validateShell).toBeGreaterThan(stage);
    expect(nextLink).toBeGreaterThan(validateShell);
    expect(durableNextLink).toBeGreaterThan(nextLink);
    expect(activate).toBeGreaterThan(nextLink);
    expect(activate).toBeGreaterThan(durableNextLink);
    expect(durableActivation).toBeGreaterThan(activate);
    expect(installer).toContain('"$GENERATION_DIR/engine-release-seal.py" \\');
    expect(installer.indexOf('fsync_paths \\')).toBeLessThan(nextLink);
    expect(installer).not.toContain('install -d -m 0755 "$CONTROL_DIR"');
  });

  it('verifies the sealed recovery image without treating mutable tags as authority', () => {
    expect(recoveryVerifier).toContain('sealed desired image exists locally');
    expect(recoveryVerifier).toContain(':current is a repairable cache');
    expect(recoveryVerifier).toContain('pending candidate is non-persistent');
    expect(recoveryVerifier).toContain("desired release restart policy is 'always'");
    expect(recoveryVerifier).not.toContain('a bad deploy could NOT be rolled back');
    expect(recoveryVerifier).not.toContain('the supervisor cannot recreate the container');
  });

  it('makes the supervisor restore the sealed image ID, never mutable current', () => {
    expect(supervisor).toContain('DESIRED_IMAGE_ID=$("$RELEASE_SEAL" get desired-image-id');
    expect(supervisor).toContain('IMAGE="$DESIRED_IMAGE_ID"');
    expect(supervisor).toContain('if [ "$RELEASE_CLASS" = "drift" ]');
    expect(supervisor).toContain('docker tag "$DESIRED_IMAGE_ID" "$IMAGE_REPO:current"');
    expect(supervisor).not.toContain('IMAGE="${IMAGE:-club-arena-engine:current}"');
    expect(supervisor).toContain('RELEASE_LABEL" != "$EXPECTED_RELEASE_SHA');
    expect(supervisor).toContain(
      '[ "$RELEASE_CLASS" = "pending" ] && [ "$RESTART_POLICY" != "no" ]'
    );
    expect(supervisor).toContain('restoring sealed desired release');
    expect(supervisor).toContain(
      '[ "$RELEASE_CLASS" = "desired" ] && [ "$RESTART_POLICY" != "always" ]'
    );
    expect(supervisor).toContain('docker update --restart always "$CONTAINER"');
  });

  it('commits the seal only after HTTP, proxy, and strict database proof', () => {
    const verify = workflow.indexOf('name: Verify — liveness');
    const prove = workflow.indexOf("name: 'PROVE the version moved");
    const commit = workflow.indexOf('name: Commit the verified SHA/image-ID release seal');
    expect(verify).toBeGreaterThan(0);
    expect(prove).toBeGreaterThan(verify);
    expect(commit).toBeGreaterThan(prove);
    expect(workflow).toContain("STRICT_PROOF: '1'");
    expect(workflow).toContain('rollback:');
    expect(workflow).toContain('rollback_reason:');
    expect(workflow).toContain("steps.cutover.outputs.attempted == 'true'");
    expect(workflow).toContain("steps.seal_commit.outcome == 'success'");
    const healthBlock = workflow.slice(verify, prove);
    expect(healthBlock).toContain('[ "$LIVE" = "ok" ]');
    const commitBlock = workflow.slice(commit, workflow.indexOf('name: ROLLBACK', commit));
    expect(commitBlock).toContain('d.get(\\"liveness\\")==\\"ok\\"');
  });

  it('renders and executes the nested locked health proof with its Python quotes intact', () => {
    const commit = workflow.indexOf('name: Commit the verified SHA/image-ID release seal');
    const rollback = workflow.indexOf('name: ROLLBACK', commit);
    const commitBlock = workflow.slice(commit, rollback);
    const remoteStart = commitBlock.indexOf('~/hssh "');
    const remoteEnd = commitBlock.indexOf(
      '\n          echo "Durable release authority',
      remoteStart
    );
    expect(remoteStart).toBeGreaterThan(0);
    expect(remoteEnd).toBeGreaterThan(remoteStart);

    const renderSandbox = mkdtempSync(join(tmpdir(), 'engine-release-render-'));
    const renderedHome = join(renderSandbox, 'render-home');
    const renderedPath = join(renderSandbox, 'rendered-remote-command.sh');
    mkdirSync(renderedHome);
    writeFileSync(
      join(renderedHome, 'hssh'),
      '#!/usr/bin/env bash\nset -euo pipefail\n[ "$#" -eq 1 ]\nprintf \'%s\' "$1" > "$CAPTURE"\n'
    );
    chmodSync(join(renderedHome, 'hssh'), 0o755);

    const localInvocation = commitBlock
      .slice(remoteStart, remoteEnd)
      .trim()
      .replaceAll('${{ steps.cutover.outputs.candidate_cid }}', 'c'.repeat(64))
      .replaceAll('${{ steps.cutover.outputs.candidate_started_at }}', '2026-09-09T02:00:00Z')
      .replaceAll('${{ github.run_id }}', '12345')
      .replaceAll('${{ github.server_url }}', 'https://github.com')
      .replaceAll('${{ github.repository }}', 'Smarter-Poker/Smarter-Poker-Club-Arena')
      .replaceAll('${{ github.actor }}', 'release-law');
    const render = spawnSync('bash', ['-c', localInvocation], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CAPTURE: renderedPath,
        CONTAINER: 'club-arena-engine',
        HOME: renderedHome,
        IMAGE_REPO: 'club-arena-engine',
        PORT: '8080',
        SHA: B_SHA,
      },
    });
    expect(render.status, `${render.stdout}\n${render.stderr}`).toBe(0);

    const rendered = readFileSync(renderedPath, 'utf8');
    expect(spawnSync('bash', ['-n'], { input: rendered }).status).toBe(0);
    const healthLine = rendered
      .split('\n')
      .find((line) => line.includes("python3 -c 'import json,sys; d=json.load"));
    expect(healthLine).toBeDefined();
    const python = healthLine?.match(/python3 -c '([^']+)'/)?.[1];
    expect(python).toContain('d.get("running") is True');
    expect(python).toContain(`d.get("version")=="${B_SHA.slice(0, 8)}"`);
    expect(python).toContain('d.get("liveness")=="ok"');
    expect(
      spawnSync('python3', ['-c', python!], {
        input: JSON.stringify({ running: true, version: B_SHA.slice(0, 8), liveness: 'ok' }),
      }).status
    ).toBe(0);
    expect(
      spawnSync('python3', ['-c', python!], {
        input: JSON.stringify({ running: true, version: B_SHA.slice(0, 8), liveness: 'dead' }),
      }).status
    ).toBe(75);
  });

  it('prepares one-use authority only after the long drain wait and immediately before cutover', () => {
    const drain = workflow.indexOf('name: Wait for the maintenance break to park every table');
    const prepare = workflow.indexOf('name: Prepare one-use sealed cutover authority');
    const cutover = workflow.indexOf('name: Cut over to the new image');
    expect(drain).toBeGreaterThan(0);
    expect(prepare).toBeGreaterThan(drain);
    expect(cutover).toBeGreaterThan(prepare);
    const prepareBlock = workflow.slice(prepare, cutover);
    expect(prepareBlock).toContain(
      "if: steps.dedupe.outputs.skip != 'true' && steps.drain.outputs.skip != 'true'"
    );
    expect(prepareBlock).not.toMatch(/sleep\s|for i in|ATTEMPTS=/);
  });

  it('builds every target, including pre-seal rollback commits, with immutable revision metadata', () => {
    const build = workflow.slice(
      workflow.indexOf('name: Build immutable image'),
      workflow.indexOf('name: Install/refresh host supervisor')
    );
    expect(build).toContain('--label org.opencontainers.image.revision=$SHA');
    const equality = build
      .split('\n')
      .find((line) => line.includes("= '$SHA' ") && line.includes('REV'));
    expect(equality).toContain('\\$REV');
    expect(build.indexOf('--label org.opencontainers.image.revision=$SHA')).toBeLessThan(
      build.indexOf(equality!)
    );
  });

  it('revalidates restart authority under the shared lock and starts in that same shell', () => {
    const cutover = workflow.slice(
      workflow.indexOf('name: Cut over to the new image'),
      workflow.indexOf('name: Verify — liveness')
    );
    const lock = cutover.indexOf('exec 9>/var/lock/club-arena-engine-up.lock');
    const localHealth = cutover.indexOf('http://127.0.0.1:8080/health');
    const certificate = cutover.indexOf('m.get(\\"readyForRestart\\") is True');
    const mutationMarker = cutover.indexOf("echo '$MUTATION_MARKER'");
    const autohealFence = cutover.indexOf('docker stop -t 15 sp-autoheal');
    const start = cutover.indexOf('ENGINE_UP_LOCK_HELD=1');
    const attempted = cutover.indexOf('echo "attempted=true"');
    expect(lock).toBeGreaterThan(0);
    expect(localHealth).toBeGreaterThan(lock);
    expect(certificate).toBeGreaterThan(localHealth);
    expect(mutationMarker).toBeGreaterThan(certificate);
    expect(autohealFence).toBeGreaterThan(mutationMarker);
    expect(start).toBeGreaterThan(autohealFence);
    expect(attempted).toBeGreaterThan(start);
    expect(cutover).toContain('m.get(\\"active\\") is True');
    expect(cutover).toContain('m.get(\\"phase\\")==\\"counting_down\\"');
    expect(cutover).toContain('m.get(\\"durableConfirmed\\") is True');
    expect(cutover).toContain('m.get(\\"unparkedTables\\")==0');
    expect(cutover).toContain('int(m.get(\\"remainingMs\\") or 0)>=180000');
  });

  it('guarantee and rollback can only recover the durable desired image', () => {
    const rollback = workflow.slice(
      workflow.indexOf('name: ROLLBACK'),
      workflow.indexOf('name: Revoke unused authority and GUARANTEE')
    );
    const guarantee = workflow.slice(
      workflow.indexOf('name: Revoke unused authority and GUARANTEE'),
      workflow.indexOf('name: Retention')
    );
    const abort = rollback.indexOf('engine-release-seal.py abort');
    const reconcile = rollback.indexOf('engine-supervisor.sh');
    expect(abort).toBeGreaterThan(0);
    expect(reconcile).toBeGreaterThan(abort);
    expect(rollback).not.toContain('ENGINE_RELEASE_TOKEN');
    expect(rollback).not.toMatch(/\\$CONTROL\/engine-up\.sh/);
    expect(guarantee).toContain('engine-supervisor.sh');
    expect(guarantee).toContain("steps.seal.outcome == 'success'");
    expect(guarantee.indexOf('engine-release-seal.py abort')).toBeLessThan(
      guarantee.indexOf('engine-supervisor.sh')
    );
    expect(guarantee.indexOf('set +e')).toBeLessThan(
      guarantee.indexOf('engine-release-seal.py abort')
    );
    expect(guarantee.indexOf('engine-supervisor.sh')).toBeLessThan(
      guarantee.indexOf('release authority was reconciled')
    );
    expect(guarantee).toContain('ENGINE_SUPERVISOR_LOCK_HELD=1');
    expect(guarantee).not.toMatch(/ENGINE_RELEASE_TOKEN|IMAGE=.*\$SHA|engine-up\.sh/);
  });

  it('a rejected locked certificate cannot mark mutation or trigger a blind restart', () => {
    const cutover = workflow.slice(
      workflow.indexOf('name: Cut over to the new image'),
      workflow.indexOf('name: Verify — liveness')
    );
    const certificate = cutover.indexOf('m.get(\\"readyForRestart\\") is True');
    const remoteMarker = cutover.indexOf("echo '$MUTATION_MARKER'");
    const localAttempted = cutover.indexOf('echo "attempted=true"');
    expect(certificate).toBeGreaterThan(0);
    expect(remoteMarker).toBeGreaterThan(certificate);
    expect(localAttempted).toBeGreaterThan(remoteMarker);

    const rollback = workflow.slice(
      workflow.indexOf('name: ROLLBACK'),
      workflow.indexOf('name: Retention')
    );
    expect(rollback).toContain("steps.cutover.outputs.attempted == 'true'");
    expect(rollback.match(/engine-supervisor\.sh/g)).toHaveLength(2);
    expect(rollback).not.toMatch(/\\$CONTROL\/engine-up\.sh/);
  });

  it('does not let the env editor forge image identity', () => {
    expect(envWorkflow).toMatch(/GIT_COMMIT_SHA \| ENGINE_VERSION/);
    expect(envWorkflow).toContain('engine-release-seal.py get desired-image-id');
    expect(envWorkflow).not.toContain('IMAGE=club-arena-engine:current');
  });
});
