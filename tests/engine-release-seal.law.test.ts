import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');
const sealScript = resolve(ROOT, 'server/scripts/engine-release-seal.py');
const imageBuilder = resolve(ROOT, 'server/scripts/build-engine-image.sh');
const protocolV1 = read('server/scripts/engine-release-protocol-v1.schema');
const protocolV1Digest = createHash('sha256').update(protocolV1).digest('hex');

const A_SHA = 'a'.repeat(40);
const B_SHA = 'b'.repeat(40);
const C_SHA = 'c'.repeat(40);
const A_IMAGE = `sha256:${'a'.repeat(64)}`;
const B_IMAGE = `sha256:${'b'.repeat(64)}`;
const C_IMAGE = `sha256:${'c'.repeat(64)}`;

const fixtureGitEnvironment = (
  emptyGlobalConfig: string,
  inherited: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => {
  // Git hooks can export repository paths and config selectors independently.
  // Keep every Git subprocess inside its disposable repository and config.
  const env = Object.fromEntries(
    Object.entries(inherited).filter(([name]) => !name.startsWith('GIT_'))
  );
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyGlobalConfig };
};

describe('disposable Git fixtures preserve the calling repository', () => {
  it.each(['repository pointers', 'configuration file', 'injected configuration'])(
    'keeps init, identity and commit writes local with inherited %s',
    (contamination) => {
      const sandbox = mkdtempSync(join(tmpdir(), 'release-git-isolation-'));
      try {
        const sentinel = join(sandbox, 'sentinel.git');
        const repo = join(sandbox, 'fixture');
        const emptyGlobalConfig = join(sandbox, 'empty-global.gitconfig');
        mkdirSync(repo);
        writeFileSync(emptyGlobalConfig, '');
        const cleanEnv = fixtureGitEnvironment(emptyGlobalConfig);
        const initialized = spawnSync('git', ['init', '--bare', '-q', sentinel], {
          cwd: sandbox,
          encoding: 'utf8',
          env: cleanEnv,
        });
        expect(initialized.status, initialized.stderr).toBe(0);
        const sentinelConfig = readFileSync(join(sentinel, 'config'));
        const sentinelHead = readFileSync(join(sentinel, 'HEAD'));
        const inherited: NodeJS.ProcessEnv = { ...process.env };

        if (contamination === 'repository pointers') {
          Object.assign(inherited, {
            GIT_DIR: sentinel,
            GIT_COMMON_DIR: sentinel,
            GIT_WORK_TREE: repo,
            GIT_INDEX_FILE: join(sentinel, 'index'),
            GIT_OBJECT_DIRECTORY: join(sentinel, 'objects'),
            GIT_ALTERNATE_OBJECT_DIRECTORIES: join(sentinel, 'objects'),
            GIT_PREFIX: 'caller/',
          });
        } else if (contamination === 'configuration file') {
          inherited.GIT_CONFIG = join(sentinel, 'config');
        } else {
          Object.assign(inherited, {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'core.bare',
            GIT_CONFIG_VALUE_0: 'true',
            GIT_CONFIG_PARAMETERS: "'core.bare=true'",
            GIT_CONFIG_GLOBAL: join(sentinel, 'config'),
            GIT_CONFIG_SYSTEM: join(sentinel, 'config'),
          });
        }

        const env = fixtureGitEnvironment(emptyGlobalConfig, inherited);
        const runGit = (args: string[]) =>
          spawnSync('git', args, { cwd: repo, encoding: 'utf8', env });
        expect(runGit(['init', '-q']).status).toBe(0);
        expect(runGit(['config', 'user.name', 'Release Law']).status).toBe(0);
        expect(runGit(['config', 'user.email', 'release-law@example.invalid']).status).toBe(0);
        writeFileSync(join(repo, 'owned.txt'), 'Only the disposable fixture owns this commit.\n');
        expect(runGit(['add', 'owned.txt']).status).toBe(0);
        const committed = runGit(['commit', '-qm', 'isolated fixture']);
        expect(committed.status, committed.stderr).toBe(0);
        expect(runGit(['rev-parse', '--is-bare-repository']).stdout.trim()).toBe('false');
        expect(runGit(['log', '-1', '--format=%ae']).stdout.trim()).toBe(
          'release-law@example.invalid'
        );
        expect(readFileSync(join(sentinel, 'config'))).toEqual(sentinelConfig);
        expect(readFileSync(join(sentinel, 'HEAD'))).toEqual(sentinelHead);
        expect(existsSync(join(sentinel, 'index'))).toBe(false);
        expect(
          spawnSync('git', ['--git-dir', sentinel, 'rev-parse', '--verify', 'HEAD'], {
            cwd: sandbox,
            encoding: 'utf8',
            env: cleanEnv,
          }).status
        ).not.toBe(0);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    }
  );
});

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
    `https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/${runId.split('-', 1)[0]}`,
    '--actor',
    'release-test',
    '--reason',
    reason,
  ];

  const runSeal = (
    args: string[],
    overrides: NodeJS.ProcessEnv = {},
    input?: string
  ): { status: number | null; stdout: string; stderr: string } => {
    const result = spawnSync('python3', [sealScript, ...args], {
      encoding: 'utf8',
      env: { ...baseEnv, ...overrides },
      input,
    });
    return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  };

  const authorize = (image: string, token: string, overrides: NodeJS.ProcessEnv = {}) =>
    runSeal(['authorize', '--image', image, '--token-stdin'], overrides, `${token}\n`);

  const state = () =>
    JSON.parse(readFileSync(join(sandbox, 'state', 'seal.json'), 'utf8')) as {
      desired: { sha: string; imageId: string; legacyUnlabelled: boolean };
      highWaterSha: string;
      pending: null | { used: boolean; mode: string; expiresAt: number; runId: string };
      finalization: null | { runId: string; sha: string; imageId: string };
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

    expect(authorize('candidate-ref', prepared.stdout).stdout).toBe(`pending ${B_SHA} ${B_IMAGE}`);
    const replay = authorize('candidate-ref', prepared.stdout);
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

    const candidate = spawnSync(
      'bash',
      ['-c', 'exec 3<<<"$TEST_RELEASE_TOKEN"; exec "$TEST_ENGINE_UP"'],
      {
        encoding: 'utf8',
        env: {
          ...common,
          ENGINE_RELEASE_TOKEN_FD: '3',
          IMAGE: 'candidate-ref',
          TEST_ENGINE_UP: engineUp,
          TEST_RELEASE_TOKEN: prepared.stdout,
        },
      }
    );
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

  it('preserves the exact sealed pre-label container during causal desired recovery', () => {
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
    // SHA are nevertheless sealed. Exact release recovery must prove that
    // already-authoritative runtime without replacing it.
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
    '{{json .Config.Env}}') printf '%s\\n' '["GIT_COMMIT_SHA=${A_SHA}"]' ;;
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
  '{{index .Config.Labels "sp.role"}}') printf 'engine\\n' ;;
  '{{.HostConfig.RestartPolicy.Name}}') printf 'always\\n' ;;
  '{{.State.StartedAt}}') printf '\\n' ;;
  *) exit 1 ;;
esac
`
    );
    chmodSync(join(bin, 'docker'), 0o755);
    writeFileSync(
      join(bin, 'curl'),
      `#!/usr/bin/env bash
printf '%s\\n%s' '{"running":true,"releaseSha":"${A_SHA}","liveness":"ok","instanceId":"12345-deadbeef"}' '200'
`
    );
    chmodSync(join(bin, 'curl'), 0o755);
    writeFileSync(join(bin, 'logger'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(bin, 'logger'), 0o755);
    writeFileSync(join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(bin, 'flock'), 0o755);
    writeFileSync(
      join(bin, 'timeout'),
      `#!/usr/bin/env bash
while [ "$#" -gt 0 ]; do
  case "$1" in --signal=*|--kill-after=*|[0-9]*s) shift ;; *) break ;; esac
done
exec "$@"
`
    );
    chmodSync(join(bin, 'timeout'), 0o755);

    const supervisor = spawnSync('bash', [resolve(ROOT, 'server/scripts/engine-supervisor.sh')], {
      encoding: 'utf8',
      env: {
        ...baseEnv,
        CONTAINER: 'club-arena-engine',
        ENGINE_RELEASE_SEAL: sealScript,
        FAKE_MUTATION_LOG: mutationLog,
        IMAGE_REPO: 'club-arena-engine',
        LOCK_FILE: join(sandbox, 'engine-up.lock'),
        UP_SCRIPT: upScript,
        ENGINE_SUPERVISOR_LOCK_HELD: '1',
        ENGINE_SUPERVISOR_FORCE_DESIRED: '1',
        ENGINE_SUPERVISOR_REQUIRE_EXACT_HEALTH: '1',
        ENGINE_RECOVERY_DEADLINE_EPOCH: String(Math.floor(Date.now() / 1000) + 20),
        ENGINE_URL: 'https://engine.example.invalid',
      },
    });
    expect(supervisor.status, supervisor.stderr).toBe(0);
    expect(supervisor.stdout).toContain('is live and exact locally and publicly as 12345-deadbeef');
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
    authorize('candidate-ref', prepared.stdout);

    const mutationLog = join(sandbox, 'pending-policy-mutations.log');
    const autohealState = join(sandbox, 'autoheal-state');
    const containerState = join(sandbox, 'engine-state');
    const switched = join(sandbox, 'desired-runtime');
    const upScript = join(sandbox, 'engine-up-stub.sh');
    writeFileSync(mutationLog, '');
    writeFileSync(autohealState, 'exited\n');
    writeFileSync(containerState, 'running\n');
    writeFileSync(
      upScript,
      '#!/usr/bin/env bash\nprintf \'engine-up %s\\n\' "$IMAGE" >> "$FAKE_MUTATION_LOG"\ntouch "$FAKE_SWITCHED"\n'
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
  case "$format" in
    '{{.Id}}') printf '%s\\n' "$id" ;;
    '{{json .Config.Env}}') [ "$id" = '${A_IMAGE}' ] && printf '%s\\n' '["GIT_COMMIT_SHA=${A_SHA}"]' || printf '%s\\n' '["GIT_COMMIT_SHA=${B_SHA}"]' ;;
    *) printf '{"Id":"%s"}\\n' "$id" ;;
  esac
  exit 0
fi
if [ "$kind" = container ] && [ "$action" = inspect ] && [ "$ref" = club-arena-engine ]; then
  case "$format" in
    '{{json .}}'|'') printf '{"Image":"%s","State":{"Status":"%s"}}\\n' '${B_IMAGE}' "$(tr -d '\\n' < "$FAKE_CONTAINER_STATE")" ;;
    '{{.Image}}') [ -e "$FAKE_SWITCHED" ] && printf '%s\\n' '${A_IMAGE}' || printf '%s\\n' '${B_IMAGE}' ;;
    '{{.State.Status}}') tr -d '\\n' < "$FAKE_CONTAINER_STATE"; printf '\\n' ;;
    '{{index .Config.Labels "autoheal"}}') printf 'true\\n' ;;
    '{{index .Config.Labels "sp.release.sha"}}') [ -e "$FAKE_SWITCHED" ] && printf '%s\\n' '${A_SHA}' || printf '%s\\n' '${B_SHA}' ;;
    '{{index .Config.Labels "sp.role"}}') printf 'engine\\n' ;;
    '{{.HostConfig.RestartPolicy.Name}}') printf 'always\\n' ;;
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
if [ "$kind" = start ] && [ "$action" = club-arena-engine ]; then
  printf 'running\\n' > "$FAKE_CONTAINER_STATE"
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
    writeFileSync(
      join(bin, 'timeout'),
      `#!/usr/bin/env bash
while [ "$#" -gt 0 ]; do
  case "$1" in --signal=*|--kill-after=*|[0-9]*s) shift ;; *) break ;; esac
done
exec "$@"
`
    );
    chmodSync(join(bin, 'timeout'), 0o755);
    writeFileSync(
      join(bin, 'curl'),
      `#!/usr/bin/env bash
printf '%s\\n%s' '{"running":true,"releaseSha":"${A_SHA}","liveness":"ok","instanceId":"12345-deadbeef"}' '200'
`
    );
    chmodSync(join(bin, 'curl'), 0o755);

    const supervisorEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      CONTAINER: 'club-arena-engine',
      ENGINE_RELEASE_SEAL: sealScript,
      FAKE_AUTOHEAL_STATE: autohealState,
      FAKE_CONTAINER_STATE: containerState,
      FAKE_MUTATION_LOG: mutationLog,
      FAKE_SWITCHED: switched,
      IMAGE_REPO: 'club-arena-engine',
      LOCK_FILE: join(sandbox, 'engine-up.lock'),
      UP_SCRIPT: upScript,
      ENGINE_SUPERVISOR_LOCK_HELD: '1',
      ENGINE_SUPERVISOR_FORCE_DESIRED: '1',
      ENGINE_SUPERVISOR_REQUIRE_EXACT_HEALTH: '1',
      ENGINE_RECOVERY_DEADLINE_EPOCH: String(Math.floor(Date.now() / 1000) + 20),
      ENGINE_URL: 'https://engine.example.invalid',
    };
    const supervisor = spawnSync('bash', [resolve(ROOT, 'server/scripts/engine-supervisor.sh')], {
      encoding: 'utf8',
      env: supervisorEnv,
    });
    expect(supervisor.status, supervisor.stderr).toBe(0);
    expect(supervisor.stdout).toContain('restoring exact sealed desired release');
    const mutations = readFileSync(mutationLog, 'utf8');
    expect(mutations).toContain(`engine-up ${A_IMAGE}`);
    expect(mutations).not.toContain('update --restart no');

    writeFileSync(containerState, 'exited\n');
    writeFileSync(mutationLog, '');
    const stoppedDesiredRecovery = spawnSync(
      'bash',
      [resolve(ROOT, 'server/scripts/engine-supervisor.sh')],
      {
        encoding: 'utf8',
        env: {
          ...supervisorEnv,
          ENGINE_RECOVERY_DEADLINE_EPOCH: String(Math.floor(Date.now() / 1000) + 20),
        },
      }
    );
    expect(stoppedDesiredRecovery.status, stoppedDesiredRecovery.stderr).toBe(0);
    expect(stoppedDesiredRecovery.stdout).toContain(
      'is live and exact locally and publicly as 12345-deadbeef'
    );
    expect(readFileSync(mutationLog, 'utf8')).toContain('docker start club-arena-engine');
    expect(readFileSync(mutationLog, 'utf8')).not.toContain('engine-up');

    rmSync(switched, { force: true });
    writeFileSync(containerState, 'running\n');
    writeFileSync(mutationLog, '');
    writeFileSync(upScript, '#!/usr/bin/env bash\nexit 42\n');
    chmodSync(upScript, 0o755);
    const failedRecovery = spawnSync(
      'bash',
      [resolve(ROOT, 'server/scripts/engine-supervisor.sh')],
      {
        encoding: 'utf8',
        env: {
          ...supervisorEnv,
          ENGINE_RECOVERY_DEADLINE_EPOCH: String(Math.floor(Date.now() / 1000) + 20),
        },
      }
    );
    expect(failedRecovery.status).toBe(1);
    expect(failedRecovery.stdout).toContain('exact sealed desired release could not be restored');
  }, 15_000);

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
    expect(runSeal(['pending-owner']).stdout).toMatch(/^expired 161 false [1-9][0-9]*$/);
    const expired = authorize('candidate-ref', prepared.stdout);
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
    authorize('candidate-ref', forward.stdout);
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
    expect(
      runSeal([
        'record-result',
        '--sha',
        B_SHA,
        '--image-id',
        B_IMAGE,
        '--result',
        'sealed',
        '--instance-id',
        '20202-feedface',
        '--container-id',
        '2'.repeat(64),
        '--started-at',
        '2026-09-10T04:00:00.000000000Z',
        '--run-id',
        '202',
        '--control-sha',
        C_SHA,
        '--invocation-id',
        '2'.repeat(32),
      ]).status
    ).toBe(0);

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
    authorize('desired-ref', rollback.stdout);
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
    authorize('candidate-ref', prepared.stdout);
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
    authorize('candidate-ref', prepared.stdout);

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

  it('reconstructs a durable per-run result after a crash between seal commit and result write', () => {
    runSeal([
      'bootstrap-running',
      '--container',
      'club-arena-engine',
      ...auditArgs('308-1', 'bootstrap existing production'),
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
      ...auditArgs('309-1', 'normal deployment from origin main'),
    ]);
    expect(authorize('candidate-ref', prepared.stdout).status).toBe(0);
    expect(
      runSeal(
        [
          'commit',
          '--sha',
          B_SHA,
          '--image',
          'candidate-ref',
          '--container',
          'club-arena-engine',
          ...auditArgs('309-1', 'all compatibility proofs passed'),
        ],
        { FAKE_CONTAINER_IMAGE: B_IMAGE }
      ).status
    ).toBe(0);

    const resultPath = join(sandbox, 'state', 'engine-release-results', '309-1.json');
    expect(existsSync(resultPath), 'commit itself must not fabricate a result receipt').toBe(false);
    expect(state().finalization).toEqual({ runId: '309-1', sha: B_SHA, imageId: B_IMAGE });
    const overtakingPrepare = runSeal([
      'prepare',
      '--sha',
      B_SHA,
      '--image',
      'candidate-ref',
      '--mode',
      'deploy',
      '--repo',
      sandbox,
      ...auditArgs('309-2', 'attempt to overtake committed finalization'),
    ]);
    expect(overtakingPrepare.status).toBe(1);
    expect(overtakingPrepare.stderr).toContain(
      'committed run 309-1 owns durable result finalization'
    );

    const firstContainer = 'd'.repeat(64);
    const firstInvocation = 'e'.repeat(32);
    const firstStartedAt = '2026-09-10T04:00:00.000000000Z';
    const record = runSeal([
      'record-result',
      '--sha',
      B_SHA,
      '--image-id',
      B_IMAGE,
      '--result',
      'sealed',
      '--instance-id',
      '12345-deadbeef',
      '--container-id',
      firstContainer,
      '--started-at',
      firstStartedAt,
      '--run-id',
      '309-1',
      '--control-sha',
      C_SHA,
      '--invocation-id',
      firstInvocation,
    ]);
    expect(record.status, record.stderr).toBe(0);
    expect(record.stdout).toBe('sealed');
    expect(state().finalization).toBeNull();

    // A systemd retry after reboot may observe a new container/process
    // generation. It must preserve who originally committed while appending
    // the exact retry invocation and refreshing only the live observation.
    const secondContainer = 'f'.repeat(64);
    const secondInvocation = '1'.repeat(32);
    const replay = runSeal([
      'record-result',
      '--sha',
      B_SHA,
      '--image-id',
      B_IMAGE,
      '--result',
      'sealed',
      '--instance-id',
      '23456-feedface',
      '--container-id',
      secondContainer,
      '--started-at',
      '2026-09-10T04:01:00.000000000Z',
      '--run-id',
      '309-1',
      '--control-sha',
      C_SHA,
      '--invocation-id',
      secondInvocation,
    ]);
    expect(replay.status, replay.stderr).toBe(0);
    expect(replay.stdout).toBe('sealed');

    const receipt = JSON.parse(readFileSync(resultPath, 'utf8'));
    expect(receipt).toMatchObject({
      result: 'sealed',
      sha: B_SHA,
      imageId: B_IMAGE,
      containerId: secondContainer,
      instanceId: '23456-feedface',
      controlSha: C_SHA,
      invocationIds: [firstInvocation, secondInvocation],
      completionRuntime: {
        containerId: firstContainer,
        instanceId: '12345-deadbeef',
        startedAt: firstStartedAt,
        invocationId: firstInvocation,
      },
    });
    const attested = runSeal(['attest-result', '--sha', B_SHA, '--run-id', '309-1']);
    expect(attested.status, attested.stderr).toBe(0);
    expect(attested.stdout).toContain(`sealed ${B_SHA} ${B_IMAGE} ${secondContainer}`);
    expect(
      runSeal(['attest-terminal', '--sha', B_SHA, '--run-id', '309-1', '--control-sha', C_SHA])
        .stdout
    ).toBe('sealed');
  });

  it('fsyncs one immutable terminal failure after desired recovery and never aliases it with success', () => {
    expect(
      runSeal([
        'bootstrap-running',
        '--container',
        'club-arena-engine',
        ...auditArgs('310-1', 'bootstrap existing production'),
      ]).status
    ).toBe(0);

    const invocation = 'e'.repeat(32);
    const failureArgs = [
      'record-failure',
      '--sha',
      B_SHA,
      '--run-id',
      '311-1',
      '--control-sha',
      C_SHA,
      '--invocation-id',
      invocation,
      '--exit-status',
      '1',
      '--container',
      'club-arena-engine',
    ];
    const recorded = runSeal(failureArgs);
    expect(recorded.status, recorded.stderr).toBe(0);
    expect(recorded.stdout).toBe('failed');

    const resultPath = join(sandbox, 'state', 'engine-release-results', '311-1.json');
    const firstBytes = readFileSync(resultPath, 'utf8');
    expect(JSON.parse(firstBytes)).toMatchObject({
      schema: 1,
      runId: '311-1',
      result: 'failed',
      sha: B_SHA,
      controlSha: C_SHA,
      invocationId: invocation,
      transactionExitStatus: 1,
      recoveredDesiredSha: A_SHA,
      recoveredDesiredImageId: A_IMAGE,
    });

    // An uncertain response may retry the recorder, but it cannot rewrite or
    // append to the already-fsynced terminal outcome.
    const duplicate = runSeal(failureArgs);
    expect(duplicate.status, duplicate.stderr).toBe(0);
    expect(duplicate.stdout).toBe('failed');
    expect(readFileSync(resultPath, 'utf8')).toBe(firstBytes);

    // Simulate power loss after the result file fsync but before the audit
    // append. The next reboot/observer attestation must repair that one audit
    // before returning, even when the recorder itself is never replayed.
    const auditPath = join(sandbox, 'state', 'audit.jsonl');
    rmSync(auditPath);
    const attestationArgs = [
      'attest-failure',
      '--sha',
      B_SHA,
      '--run-id',
      '311-1',
      '--control-sha',
      C_SHA,
      '--invocation-id',
      invocation,
    ];
    expect(runSeal(attestationArgs).status).toBe(0);
    expect(runSeal(attestationArgs).status).toBe(0);
    const repairedFailureEvents = readFileSync(auditPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.eventKey === 'failure_recorded:311-1');
    expect(repairedFailureEvents).toHaveLength(1);

    const attested = runSeal(attestationArgs);
    expect(attested.status, attested.stderr).toBe(0);
    expect(attested.stdout).toBe(`failed ${B_SHA} ${C_SHA} ${invocation} 1 ${A_SHA} ${A_IMAGE}`);
    const terminalArgs = [
      'attest-terminal',
      '--sha',
      B_SHA,
      '--run-id',
      '311-1',
      '--control-sha',
      C_SHA,
    ];
    rmSync(auditPath);
    expect(runSeal(terminalArgs).stdout).toBe('failed');
    expect(runSeal(terminalArgs).stdout).toBe('failed');
    const terminalRepairEvents = readFileSync(auditPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.eventKey === 'failure_recorded:311-1');
    expect(terminalRepairEvents).toHaveLength(1);

    const rebound = runSeal([
      ...failureArgs.slice(0, failureArgs.indexOf('--invocation-id') + 1),
      '1'.repeat(32),
      '--exit-status',
      '1',
      '--container',
      'club-arena-engine',
    ]);
    expect(rebound.status).toBe(1);
    expect(rebound.stderr).toContain('different attempt bytes');
    expect(readFileSync(resultPath, 'utf8')).toBe(firstBytes);

    const cannotBecomeSuccess = runSeal([
      'record-result',
      '--sha',
      A_SHA,
      '--image-id',
      A_IMAGE,
      '--result',
      'already-released',
      '--instance-id',
      '12345-deadbeef',
      '--container-id',
      'd'.repeat(64),
      '--started-at',
      '2026-09-10T04:00:00.000000000Z',
      '--run-id',
      '311-1',
      '--control-sha',
      C_SHA,
      '--invocation-id',
      invocation,
    ]);
    expect(cannotBecomeSuccess.status).toBe(1);
    expect(cannotBecomeSuccess.stderr).toContain('result outcome is invalid');

    const transient = runSeal([
      ...failureArgs.slice(0, failureArgs.indexOf('--exit-status') + 1),
      '75',
      '--container',
      'club-arena-engine',
    ]);
    expect(transient.status).toBe(1);
    expect(transient.stderr).toContain('not permanent');
  });

  it('will not overwrite a successful result with a terminal failure tombstone', () => {
    runSeal([
      'bootstrap-running',
      '--container',
      'club-arena-engine',
      ...auditArgs('312-1', 'bootstrap existing production'),
    ]);
    const invocation = 'f'.repeat(32);
    expect(
      runSeal([
        'record-result',
        '--sha',
        A_SHA,
        '--image-id',
        A_IMAGE,
        '--result',
        'already-released',
        '--instance-id',
        '12345-deadbeef',
        '--container-id',
        'd'.repeat(64),
        '--started-at',
        '2026-09-10T04:00:00.000000000Z',
        '--run-id',
        '313-1',
        '--control-sha',
        C_SHA,
        '--invocation-id',
        invocation,
      ]).status
    ).toBe(0);
    const resultPath = join(sandbox, 'state', 'engine-release-results', '313-1.json');
    const successBytes = readFileSync(resultPath, 'utf8');
    const failure = runSeal([
      'record-failure',
      '--sha',
      B_SHA,
      '--run-id',
      '313-1',
      '--control-sha',
      C_SHA,
      '--invocation-id',
      invocation,
      '--exit-status',
      '1',
    ]);
    expect(failure.status).toBe(1);
    expect(failure.stderr).toContain('failure outcome is invalid');
    expect(readFileSync(resultPath, 'utf8')).toBe(successBytes);
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

  it('isolates GitHub rerun attempts that share one run id', () => {
    expect(
      runSeal([
        'bootstrap-running',
        '--container',
        'club-arena-engine',
        ...auditArgs('400-1', 'bootstrap existing production'),
      ]).status
    ).toBe(0);
    const firstAttempt = runSeal([
      'prepare',
      '--sha',
      B_SHA,
      '--image',
      'candidate-ref',
      '--mode',
      'deploy',
      '--repo',
      sandbox,
      ...auditArgs('401-1', 'normal deployment from origin main'),
    ]);
    expect(firstAttempt.status).toBe(0);
    expect(state().pending?.runId).toBe('401-1');
    expect(runSeal(['pending-owner']).stdout).toMatch(/^active 401-1 false [1-9][0-9]*$/);

    const rerun = runSeal([
      'prepare',
      '--sha',
      B_SHA,
      '--image',
      'candidate-ref',
      '--mode',
      'deploy',
      '--repo',
      sandbox,
      ...auditArgs('401-2', 'rerun of the same GitHub Actions run'),
    ]);
    expect(rerun.status).toBe(1);
    expect(rerun.stderr).toContain('another audited cutover is still active (run 401-1)');

    expect(runSeal(['abort', '--run-id', '401-2']).status).toBe(0);
    expect(state().pending?.runId).toBe('401-1');
    expect(runSeal(['abort', '--run-id', '401-1']).status).toBe(0);
    expect(state().pending).toBeNull();
    expect(runSeal(['pending-owner']).stdout).toBe('none');
  });
});

describe('every host mutation path obeys the durable release authority', () => {
  const workflow = read('.github/workflows/auto-deploy-hetzner.yml');
  const sealSource = read('server/scripts/engine-release-seal.py');
  const imageBuilderSource = read('server/scripts/build-engine-image.sh');
  const engineUp = read('server/scripts/engine-up.sh');
  const supervisor = read('server/scripts/engine-supervisor.sh');
  const installer = read('server/scripts/install-engine-supervisor.sh');
  const transaction = read('server/scripts/engine-release-transaction.sh');
  const recovery = read('server/scripts/engine-release-recover.sh');
  const launcher = read('server/scripts/launch-engine-release.sh');
  const intakeInstaller = read('server/scripts/install-engine-intake.sh');
  const intake = read('server/scripts/engine-release-intake.sh');
  const retention = read('server/scripts/retain-engine-images.sh');
  const observer = read('server/scripts/observe-engine-release.sh');
  const unitWrapper = read('server/scripts/engine-release-unit-wrapper.sh');
  const databaseProof = read('server/scripts/engine-release-database-proof.py');
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

  it('fully writes durable JSON and removes every abandoned atomic temporary', () => {
    expect(sealSource).toContain('def write_all(fd: int, payload: bytes) -> None:');
    expect(sealSource).toContain('while remaining:');
    expect(sealSource).toContain('written = os.write(fd, remaining)');
    expect(sealSource).toContain('temporary_path.unlink(missing_ok=True)');
    const stateWriter = sealSource.slice(
      sealSource.indexOf('def write_json_atomic'),
      sealSource.indexOf('def audit(')
    );
    expect(stateWriter).toContain('write_all(fd, payload)');
    const auditWriter = sealSource.slice(
      sealSource.indexOf('def audit('),
      sealSource.indexOf('def audit_once(')
    );
    expect(auditWriter).toContain('write_all(');
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

    const prove = transaction.indexOf('"$DATABASE_PROOF" --env-file');
    const publicRecheck = transaction.indexOf('PRECOMMIT_PUBLIC_INSTANCE=', prove);
    const commit = transaction.indexOf('"$RELEASE_SEAL" commit', publicRecheck);
    const promote = transaction.indexOf('docker update --restart always', commit);
    const autoheal = transaction.indexOf('docker start sp-autoheal', commit);
    expect(prove).toBeGreaterThan(0);
    expect(publicRecheck).toBeGreaterThan(prove);
    expect(commit).toBeGreaterThan(publicRecheck);
    expect(promote).toBeGreaterThan(commit);
    expect(autoheal).toBeGreaterThan(promote);
    expect(transaction.slice(commit, promote)).toContain('--container "$CONTAINER"');
    expect(transaction.slice(prove, commit)).toContain('ACTUAL_STARTED_AT');
  });

  it('installs the control plane outside the rollbackable application checkout', () => {
    expect(installer).toContain('/usr/local/lib/club-arena/engine-control');
    expect(installer).toContain(
      'GIT_NO_REPLACE_OBJECTS=1 git -C "$REPO_DIR" archive "$CONTROL_SHA"'
    );
    expect(installer).not.toContain('ENGINE_CONTROL_SOURCE_DIR');
    expect(installer).not.toContain('ExecStart=$CONTROL_DIR/engine-supervisor.sh');
    expect(installer).toContain('ExecStart=$UNIT_WRAPPER_V1 start %i');
    expect(installer).toContain('ExecStart=/bin/bash $CONTROL_DIR/verify-recovery-stack.sh');
    expect(workflow).toContain('STAGE="/var/lib/club-arena/control-staging/$RUN_KEY"');
    expect(workflow).toContain('git -C "$REPO_DIR" archive "$CONTROL_SHA" server/scripts');
    expect(workflow).toContain('"$STAGE/server/scripts/install-engine-intake.sh"');
    expect(installer).toContain(
      'UNIT_WRAPPER_V1="$CONTROL_PARENT/engine-release-unit-wrapper-v1.sh"'
    );
    expect(unitWrapper).toContain('GENERATION="${REQUEST_LINES[3]}"');
    expect(unitWrapper).toContain('GENERATION="${PIN_LINES[0]}"');
  });

  it('accepts the canonical engine checkout regardless of GitHub owner casing', () => {
    const hostStage = workflow.slice(
      workflow.indexOf('name: Stage exact control bytes'),
      workflow.indexOf('name: Dispatch the staged SHA through the durable Hetzner intake')
    );

    expect(hostStage).toContain("grep -Fi 'smarter-poker/smarter-poker-club-arena'");
    expect(hostStage).not.toContain("grep -F 'Smarter-Poker/Smarter-Poker-Club-Arena'");
  });

  it('accepts single-digit run attempts while rejecting malformed or traversing stage paths', () => {
    const hostStage = workflow.slice(
      workflow.indexOf('name: Stage exact control bytes'),
      workflow.indexOf('name: Dispatch the staged SHA through the durable Hetzner intake')
    );
    const guard = hostStage.match(
      /^\s*(\[\[ "\$STAGE" =~ \^\/var\/lib\/club-arena\/control-staging\/[^\n]+ \]\])$/m
    )?.[1];

    expect(guard).toBe(
      '[[ "$STAGE" =~ ^/var/lib/club-arena/control-staging/[1-9][0-9]*-[1-9][0-9]*$ ]]'
    );
    expect(hostStage).not.toContain('case "$STAGE" in');
    expect(hostStage.indexOf('STAGE="/var/lib/club-arena/control-staging/$RUN_KEY"')).toBeLessThan(
      hostStage.indexOf(guard ?? 'missing stage guard')
    );
    expect(hostStage.indexOf(guard ?? 'missing stage guard')).toBeLessThan(
      hostStage.indexOf('rm -rf -- "$STAGE"')
    );

    const accepts = (stage: string) =>
      spawnSync('bash', ['-c', guard ?? 'exit 99'], {
        encoding: 'utf8',
        env: { ...process.env, STAGE: stage },
      }).status === 0;

    expect(accepts('/var/lib/club-arena/control-staging/34613015733-1')).toBe(true);
    for (const invalid of [
      '/var/lib/club-arena/control-staging/34613015733-',
      '/var/lib/club-arena/control-staging/34613015733-01',
      '/var/lib/club-arena/control-staging/0-1',
      '/var/lib/club-arena/control-staging/34613015733-1-extra',
      '/var/lib/club-arena/control-staging/34613015733-1/../../escape',
      join(tmpdir(), 'control-staging/34613015733-1'),
    ]) {
      expect(accepts(invalid), invalid).toBe(false);
    }
  });

  it('uses exact numeric guards throughout intake, recovery, and image-lease cleanup', () => {
    const extractGuard = (source: string, variable: string) => {
      const marker = `[[ "$${variable}" =~ `;
      const line = source.split('\n').find((candidate) => candidate.includes(marker));
      expect(line, `missing ${variable} guard`).toBeDefined();
      return line!.slice(line!.indexOf('[['), line!.indexOf(']]') + 2);
    };
    const accepts = (guard: string, env: NodeJS.ProcessEnv) =>
      spawnSync('bash', ['-c', guard], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
      }).status === 0;

    const intakeLockGuard =
      '[[ "$INTAKE_LOCK" =~ ^/var/lock/club-arena-engine-intake-[1-9][0-9]*-[1-9][0-9]*\\.lock$ ]]';
    for (const [name, source] of [
      ['install-engine-intake.sh', intakeInstaller],
      ['engine-release-intake.sh', intake],
    ] as const) {
      const guard = extractGuard(source, 'INTAKE_LOCK');
      expect(guard, name).toBe(intakeLockGuard);
      expect(
        accepts(guard, {
          INTAKE_LOCK: '/var/lock/club-arena-engine-intake-34613015733-1.lock',
        }),
        name
      ).toBe(true);
      for (const invalid of [
        '/var/lock/club-arena-engine-intake-34613015733-01.lock',
        '/var/lock/club-arena-engine-intake-34613015733-1-extra.lock',
        '/var/lock/club-arena-engine-intake-34613015733-1/../../escape.lock',
        join(tmpdir(), 'club-arena-engine-intake-34613015733-1.lock'),
      ]) {
        expect(accepts(guard, { INTAKE_LOCK: invalid }), `${name}: ${invalid}`).toBe(false);
      }
    }

    for (const [pathVariable, rootVariable, root, suffix] of [
      ['PIN_FILE', 'PIN_ROOT', '/var/lib/club-arena/engine-release-generation-pins', 'generation'],
      ['LEASE_FILE', 'LEASE_ROOT', '/var/lib/club-arena/engine-image-leases', 'lease'],
      [
        'BREAK_DEADLINE_FILE',
        'REQUEST_ROOT',
        '/var/lib/club-arena/engine-release-requests',
        'break-deadline',
      ],
      ['INTENT_FILE', 'REQUEST_ROOT', '/var/lib/club-arena/engine-release-requests', 'intent'],
      ['REQUEST_FILE', 'REQUEST_ROOT', '/var/lib/club-arena/engine-release-requests', 'request'],
    ] as const) {
      const guard = extractGuard(recovery, pathVariable);
      const rootEnv = { [rootVariable]: root };
      expect(
        accepts(guard, { ...rootEnv, [pathVariable]: `${root}/34613015733-1.${suffix}` })
      ).toBe(true);
      expect(accepts(guard, { ...rootEnv, [pathVariable]: `${root}/34613015733.${suffix}` })).toBe(
        true
      );
      for (const invalid of [
        `${root}/34613015733-01.${suffix}`,
        `${root}/34613015733-1-extra.${suffix}`,
        `${root}/34613015733-1/../../escape.${suffix}`,
        join(tmpdir(), `34613015733-1.${suffix}`),
      ]) {
        expect(accepts(guard, { ...rootEnv, [pathVariable]: invalid }), invalid).toBe(false);
      }
    }

    const leaseNameGuard = extractGuard(retention, 'lease_name');
    expect(accepts(leaseNameGuard, { lease_name: '34613015733-1.lease' })).toBe(true);
    expect(accepts(leaseNameGuard, { lease_name: '34613015733.lease' })).toBe(true);
    for (const invalid of [
      '34613015733-01.lease',
      '34613015733-1-extra.lease',
      '34613015733-1/../../escape.lease',
      'prefix-34613015733-1.lease',
    ]) {
      expect(accepts(leaseNameGuard, { lease_name: invalid }), invalid).toBe(false);
    }

    for (const [name, source] of [
      ['workflow', workflow],
      ['install-engine-intake.sh', intakeInstaller],
      ['engine-release-intake.sh', intake],
      ['engine-release-recover.sh', recovery],
      ['retain-engine-images.sh', retention],
    ] as const) {
      for (const caseBlock of source.match(/\bcase\b[\s\S]*?\besac\b/g) ?? []) {
        expect(caseBlock, `${name} retains a numeric pseudo-regex in a case glob`).not.toMatch(
          /\[1-9\]\[0-9\]\*/
        );
      }
    }
  });

  it('admits only generations compatible with the frozen release v1 wire contract', () => {
    expect(protocolV1).toBe(
      [
        'protocol=club-arena-engine-release-v1',
        'protocol-schema=1',
        'intake-activation-units=club-arena-engine-intake-v1@.path,club-arena-engine-intake-v1@.service',
        'intake-request-fields=target-sha,control-sha,run-url,actor,not-after-epoch',
        'release-request-fields=sha,run-url,actor,generation-path,control-sha,not-after-epoch',
        'release-intent-contract=byte-identical-to-release-request',
        'generation-pin-fields=generation-path,control-sha',
        'launcher-dispatch-cli=--sha,sha,--run-id,run-key,--actor,actor,--not-after-epoch,epoch',
        'launcher-dispatch-output-fields=ENGINE_RELEASE_HANDOFF,ENGINE_RELEASE_SHA',
        'launcher-handoff-values=durable,completed,failed',
        'launcher-terminal-failure-output-fields=ENGINE_RELEASE_HANDOFF,ENGINE_RELEASE_SHA,ENGINE_RELEASE_RESULT',
        'wrapper-start-cli=start,run-key',
        'wrapper-recover-cli=recover,run-key,service-result,exit-code,exit-status',
        'systemd-terminal-outcomes=success:exited:0,exit-code:exited:1',
        'systemd-unknown-outcome=retryable',
        'systemd-recovery-timeout-seconds=330',
        'transaction-cli=--run-id,run-key',
        'recovery-cli=--run-id,run-key,--mode,terminal-or-retryable',
        'transaction-terminal-statuses=0,1',
        'transaction-retry-status=75',
        'release-result-schema=1',
        'release-result-attestation-fields=result,sha,image-id,container-id,started-at,instance-id,control-sha',
        'release-failure-attestation-fields=result,sha,control-sha,invocation-id,transaction-exit-status,recovered-desired-sha,recovered-desired-image-id',
        'release-seal-state-schema=1',
        'release-seal-finalization-fields=run-id,sha,image-id',
        'release-seal-get-cli=get,desired-image-id',
        'release-seal-attest-commit-cli=attest-commit,--sha,sha,--image-id,image-id,--run-id,run-key',
        'release-seal-record-result-cli=record-result,--sha,sha,--image-id,image-id,--result,result,--instance-id,instance-id,--container-id,container-id,--started-at,started-at,--run-id,run-key,--control-sha,control-sha,--invocation-id,invocation-id',
        'release-seal-attest-result-cli=attest-result,--sha,sha,--run-id,run-key,--invocation-id,optional-invocation-id',
        'release-seal-record-failure-cli=record-failure,--sha,sha,--run-id,run-key,--control-sha,control-sha,--invocation-id,invocation-id,--exit-status,transaction-exit-status,--container,container',
        'release-seal-attest-failure-cli=attest-failure,--sha,sha,--run-id,run-key,--control-sha,optional-control-sha,--invocation-id,optional-invocation-id',
        'release-seal-attest-terminal-cli=attest-terminal,--sha,sha,--run-id,run-key,--control-sha,control-sha',
        'release-seal-abort-cli=abort,--run-id,run-key',
        '',
      ].join('\n')
    );
    expect(protocolV1Digest).toBe(
      '7c5aba4d2bc572edc5ef84c5280e1ffe517e5949b41788c18eeb003abea74044'
    );
    for (const consumer of [installer, unitWrapper]) {
      expect(consumer).toContain('PROTOCOL_V1_FILE="engine-release-protocol-v1.schema"');
      expect(consumer).toContain(`PROTOCOL_V1_SHA256="${protocolV1Digest}"`);
      expect(consumer).toContain('validate_v1_protocol()');
      expect(consumer).toContain('incompatible with the frozen release v1 protocol');
    }
    expect(installer).toMatch(
      /REQUIRED_FILES=\([\s\S]*engine-release-protocol-v1\.schema[\s\S]*\)/
    );
    expect(installer).toMatch(/CORE_FILES=\([\s\S]*engine-release-protocol-v1\.schema[\s\S]*\)/);
    expect(installer.indexOf('validate_v1_protocol "$active"')).toBeLessThan(
      installer.indexOf('mapfile -t ACTIVE_FILES')
    );
    expect(installer.indexOf('validate_v1_protocol "$SOURCE_DIR"')).toBeGreaterThan(
      installer.indexOf('git -C "$REPO_DIR" archive "$CONTROL_SHA"')
    );
    expect(installer.indexOf('validate_v1_protocol "$GENERATION_STAGE"')).toBeLessThan(
      installer.indexOf('mv -T "$GENERATION_STAGE" "$GENERATION_DIR"')
    );
    expect(installer).toContain('[ "$file" = "$PROTOCOL_V1_FILE" ]');
    expect(installer).toContain('install -m 0644 "$SOURCE_DIR/$file" "$GENERATION_STAGE/$file"');
    expect(unitWrapper).toContain(
      'pinned generation manifest does not declare the release v1 protocol exactly once'
    );

    const wrapperGenerationValidation = unitWrapper.slice(
      unitWrapper.indexOf('validate_generation()'),
      unitWrapper.indexOf('[ "$(id -u)" = 0 ]')
    );
    expect(wrapperGenerationValidation).toContain('validate_v1_protocol "$canonical"');
    expect(wrapperGenerationValidation.indexOf('validate_v1_protocol "$canonical"')).toBeLessThan(
      wrapperGenerationValidation.indexOf('engine-release-transaction.sh')
    );
    expect(wrapperGenerationValidation.indexOf('validate_v1_protocol "$canonical"')).toBeLessThan(
      wrapperGenerationValidation.indexOf('engine-release-recover.sh')
    );
  });

  it('migrates the unmanifested predecessor without executing any of its bytes', () => {
    const legacy = installer.slice(
      installer.indexOf('elif [ -L "$CONTROL_DIR" ]; then'),
      installer.indexOf('elif [ -e "$CONTROL_DIR" ]; then')
    );
    expect(legacy).toContain('migrating unmanifested predecessor control generation');
    expect(legacy).not.toMatch(/"\$ACTIVE_TARGET\/[^"\n]+\.sh"/);
    expect(legacy).not.toMatch(/(?:source|exec|bash)\s+"?\$ACTIVE_TARGET/);
    expect(installer.indexOf('archive "$CONTROL_SHA" server/scripts')).toBeGreaterThan(
      installer.indexOf('migrating unmanifested predecessor control generation')
    );
  });

  it('does not orphan a staged release merely because main advances during its build', () => {
    const queuedRecheck = workflow.slice(
      workflow.indexOf('name: Recheck freshness after the FIFO wait'),
      workflow.indexOf('name: Establish pinned ephemeral SSH transport')
    );
    const hostStage = workflow.slice(
      workflow.indexOf('name: Stage exact control bytes'),
      workflow.indexOf('name: Dispatch the staged SHA through the durable Hetzner intake')
    );
    expect(workflow).toContain(
      'group: club-arena-engine-request-${{ github.event.client_payload.ref_sha }}'
    );
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).not.toContain('queue: max');
    expect(queuedRecheck).toContain('git merge-base --is-ancestor "$CONTROL_SHA" "$MAIN_SHA"');
    expect(queuedRecheck).toContain('[ "$LATEST_REQUIRED" = "$SHA" ]');
    expect(hostStage).toContain(
      'git -C "$REPO_DIR" merge-base --is-ancestor "$commit" "$MAIN_SHA"'
    );
    expect(installer).toContain('ACTIVE_IS_CURRENT_GENERATION=1');
    expect(installer).toContain(
      'control generation $ACTIVE_CONTROL_SHA is newer; refusing downgrade'
    );
    expect(installer).toContain('ENGINE_CONTROL_INSTALL_GENERATION=$ACTIVE_TARGET');
    expect(intake).toContain('INSTALLED_GENERATION=');
    expect(intake).toContain('"$CANONICAL_GENERATION/launch-engine-release.sh"');
  });

  it('activates one complete control-plane generation atomically under the engine lock', () => {
    const lock = installer.indexOf('flock -w 600 9');
    const sourceLock = installer.indexOf('flock -w 90 8', lock);
    const archive = installer.indexOf('git -C "$REPO_DIR" archive "$CONTROL_SHA"');
    const stage = installer.indexOf('GENERATION_STAGE="$(mktemp -d', archive);
    const validateShell = installer.indexOf('bash -n "$GENERATION_STAGE/$script"', stage);
    const durableGeneration = installer.indexOf(
      'fsync_paths "$GENERATION_STAGE"/* "$GENERATION_STAGE" "$GENERATION_ROOT"',
      validateShell
    );
    const publishGeneration = installer.indexOf('mv -T "$GENERATION_STAGE" "$GENERATION_DIR"');
    const nextLink = installer.indexOf('ln -s "$GENERATION_DIR" "$NEXT_LINK"', publishGeneration);
    const activate = installer.indexOf('mv -Tf "$NEXT_LINK" "$CONTROL_DIR"', nextLink);
    const durableActivation = installer.indexOf('fsync_paths "$CONTROL_PARENT"', activate);
    expect(lock).toBeGreaterThan(0);
    expect(sourceLock).toBeGreaterThan(lock);
    expect(archive).toBeGreaterThan(sourceLock);
    expect(stage).toBeGreaterThan(archive);
    expect(validateShell).toBeGreaterThan(stage);
    expect(durableGeneration).toBeGreaterThan(validateShell);
    expect(publishGeneration).toBeGreaterThan(durableGeneration);
    expect(nextLink).toBeGreaterThan(publishGeneration);
    expect(activate).toBeGreaterThan(nextLink);
    expect(durableActivation).toBeGreaterThan(activate);
    expect(installer).toContain('"$GENERATION_DIR/engine-release-seal.py" bootstrap-running');
    expect(installer).not.toContain('install -d -m 0755 "$CONTROL_DIR"');
    expect(installer.indexOf('ACTIVE_CONTROL_SHA=', sourceLock)).toBeLessThan(stage);
    expect(installer).toContain('ExecStart=$UNIT_WRAPPER_V1 start %i');
    expect(installer).toContain('ExecStopPost=$UNIT_WRAPPER_V1 recover %i');
    expect(installer).toContain('club-arena-engine-release-v1@.service');
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
    expect(supervisor).toContain(
      'DESIRED_IMAGE_ID="$(bounded_recovery_command 10 "$RELEASE_SEAL" get desired-image-id)"'
    );
    expect(supervisor).toContain('IMAGE="$DESIRED_IMAGE_ID"');
    expect(supervisor).not.toContain('IMAGE="${IMAGE:-club-arena-engine:current}"');
    expect(supervisor).not.toContain('docker tag');
    expect(supervisor).toContain('ENGINE_SUPERVISOR_FORCE_DESIRED');
    expect(supervisor).toContain('ENGINE_SUPERVISOR_REQUIRE_EXACT_HEALTH');
    expect(supervisor).toContain('ENGINE_SUPERVISOR_LOCK_HELD');
    expect(supervisor).toContain('[ "$RUNNING_IMAGE_ID" != "$DESIRED_IMAGE_ID" ]');
    expect(supervisor).toContain('[ "$RUNNING_RELEASE" != "$DESIRED_SHA" ]');
    expect(supervisor).toContain('restoring exact sealed desired release');
    expect(supervisor).toContain('docker update --restart always "$CONTAINER"');
    expect(supervisor).toContain('prove_exact_desired_recovery');
  });

  it('commits the seal only after HTTP, proxy, and strict database proof', () => {
    const local = transaction.indexOf('CANDIDATE_INSTANCE="$(health_instance');
    const publicProxy = transaction.indexOf('PUBLIC_INSTANCE="$(health_instance', local);
    const freshness = transaction.indexOf('source_target_is_current', publicProxy);
    const localAgain = transaction.indexOf('PRECOMMIT_LOCAL_INSTANCE=', freshness);
    const publicAgain = transaction.indexOf('PRECOMMIT_PUBLIC_INSTANCE=', localAgain);
    const database = transaction.indexOf('"$DATABASE_PROOF" --env-file', publicAgain);
    const commit = transaction.indexOf('"$RELEASE_SEAL" commit', database);
    expect(local).toBeGreaterThan(0);
    expect(publicProxy).toBeGreaterThan(local);
    expect(freshness).toBeGreaterThan(publicProxy);
    expect(localAgain).toBeGreaterThan(freshness);
    expect(publicAgain).toBeGreaterThan(localAgain);
    expect(database).toBeGreaterThan(publicAgain);
    expect(commit).toBeGreaterThan(database);
    expect(databaseProof).toContain('engine_version,instance_id,heartbeat_at');
    expect(databaseProof).toContain('leader_instance == instance_id');
    expect(databaseProof).toContain('-30 <= age <= args.max_heartbeat_age_seconds');
    expect(transaction.slice(database, commit)).toContain('--max-heartbeat-age-seconds 15');
    expect(workflow).toContain('Independently prove the sealed local, public, and leader identity');
  });

  it('queues frozen intake before request publication and lets the host complete the handoff', () => {
    const unit = 'club-arena-engine-intake-v1@';
    const intakeServiceUnit = intakeInstaller.slice(
      intakeInstaller.indexOf('cat > "$UNIT_STAGE"'),
      intakeInstaller.indexOf('cat > "$PATH_STAGE"')
    );
    expect(intakeInstaller).toContain('UNIT_BASENAME="club-arena-engine-intake-v1@.service"');
    expect(intakeInstaller).toContain('ln -- "$NEXT_UNIT" "$UNIT_PATH"');
    expect(intakeInstaller).toContain('cmp -s "$NEXT_UNIT" "$UNIT_PATH"');
    expect(intakeInstaller).not.toMatch(/mv -T[^\n]*engine-intake/);
    expect(intake).toContain(unit);
    expect(observer).toContain(unit);
    expect(workflow).toContain(unit);
    const publishIntent = intakeInstaller.indexOf('ln -- "$TMP_REQUEST" "$INTENT_FILE"');
    const durableIntent = intakeInstaller.indexOf('fsync_paths "$INTAKE_ROOT"', publishIntent);
    const enable = intakeInstaller.indexOf('systemctl enable "$UNIT"');
    const durableEnable = intakeInstaller.indexOf('fsync_paths "$WANTS_DIR"', enable);
    const armPath = intakeInstaller.indexOf('systemctl start "$PATH_UNIT"', durableEnable);
    const start = intakeInstaller.indexOf('systemctl start --no-block "$UNIT"', durableIntent);
    const authenticatedEntrypoint = intakeInstaller.indexOf(
      '[ -x "$STAGE/server/scripts/engine-release-intake.sh" ]'
    );
    const verifyCopy = intakeInstaller.indexOf('VERIFY_UNIT_STAGE=');
    const verifyInstance = intakeInstaller.indexOf(
      'systemd-analyze verify "$VERIFY_UNIT_STAGE" "$VERIFY_PATH_STAGE"',
      verifyCopy
    );
    const removeVerifyCopies = intakeInstaller.indexOf(
      'rm -f -- "$VERIFY_UNIT_STAGE" "$VERIFY_PATH_STAGE"',
      verifyInstance
    );
    const fsyncCanonicalTemplates = intakeInstaller.indexOf(
      'fsync_paths "$UNIT_STAGE" "$PATH_STAGE"',
      removeVerifyCopies
    );
    const installCanonicalTemplate = intakeInstaller.indexOf(
      'install -m 0644 "$UNIT_STAGE" "$NEXT_UNIT"',
      fsyncCanonicalTemplates
    );
    expect(publishIntent).toBeGreaterThan(0);
    expect(durableIntent).toBeGreaterThan(publishIntent);
    expect(enable).toBeGreaterThan(0);
    expect(durableEnable).toBeGreaterThan(enable);
    expect(armPath).toBeGreaterThan(durableEnable);
    expect(publishIntent).toBeGreaterThan(armPath);
    expect(durableIntent).toBeGreaterThan(publishIntent);
    expect(start).toBeGreaterThan(durableIntent);
    expect(verifyCopy).toBeGreaterThan(authenticatedEntrypoint);
    expect(verifyInstance).toBeGreaterThan(verifyCopy);
    expect(removeVerifyCopies).toBeGreaterThan(verifyInstance);
    expect(fsyncCanonicalTemplates).toBeGreaterThan(removeVerifyCopies);
    expect(installCanonicalTemplate).toBeGreaterThan(fsyncCanonicalTemplates);
    expect(intakeInstaller.indexOf('ln -- "$TMP_REQUEST" "$REQUEST_FILE"')).toBe(-1);
    expect(intakeInstaller).toContain('PATH_BASENAME="club-arena-engine-intake-v1@.path"');
    expect(intakeInstaller).toContain(
      'PathExists=/var/lib/club-arena/engine-intake-requests/%i.intent'
    );
    expect(intakeServiceUnit).toContain('Type=oneshot');
    expect(intakeServiceUnit).toContain('Restart=on-failure');
    expect(intakeServiceUnit).not.toContain('RestartForceExitStatus=');
    expect(intakeServiceUnit).toContain('RestartPreventExitStatus=1');
    expect(intakeInstaller).not.toContain('Requires=docker.service');
    expect(intakeInstaller).toContain(
      'VERIFY_UNIT_STAGE="$UNIT_STAGE_DIR/club-arena-engine-intake-v1@$RUN_ID.service"'
    );
    expect(intakeInstaller).toContain(
      'VERIFY_PATH_STAGE="$UNIT_STAGE_DIR/club-arena-engine-intake-v1@$RUN_ID.path"'
    );
    expect(intakeInstaller).toContain(
      'systemd-analyze verify "$VERIFY_UNIT_STAGE" "$VERIFY_PATH_STAGE"'
    );
    expect(intakeInstaller).not.toContain('systemd-analyze verify "$UNIT_STAGE" "$PATH_STAGE"');
    expect(intakeInstaller).toContain('flock -w 30 7');
    expect(intake).toContain('flock -w 30 7');
    expect(intakeInstaller).toContain('fsync_paths "$INTAKE_ROOT" "$(dirname "$INTAKE_ROOT")"');
    expect(intakeInstaller).toContain('if [ "$DURABLE_STATE_EXISTS" = 1 ]');
    expect(intakeInstaller).toContain(
      'it must not reset,\n  # re-enable, or retrigger a transaction'
    );
    expect(intake).toContain('[ "$INSTALLED_SHA" = "$CONTROL_SHA" ]');
    const missingRequest = intake.slice(
      intake.indexOf('if [ ! -e "$REQUEST_FILE" ]'),
      intake.indexOf('mapfile -t REQUEST_LINES')
    );
    expect(missingRequest).toContain('ln -- "$INTENT_FILE" "$REQUEST_FILE"');
    expect(missingRequest).toContain('fsync_directory "$INTAKE_ROOT"');
    expect(missingRequest).toContain('systemctl disable "$INTAKE_UNIT"');
  });

  it('hard-bounds every database proof request and retry sleep', () => {
    expect(databaseProof).toContain('min(15.0, remaining)');
    expect(databaseProof).toContain('time.sleep(min(float(args.poll_seconds), remaining))');
    expect(transaction).toMatch(
      /timeout --signal=TERM --kill-after=1s "\$\{(?:proof_timeout|DB_TIMEOUT)\}s"/m
    );
    expect(workflow).toContain('timeout --signal=TERM --kill-after=1s 62s');
  });

  it('immediately repeats the idempotent intake after an uncertain transport handoff', () => {
    const uncertain = workflow.slice(
      workflow.indexOf('if uncertain_status "$SSH_RC"; then'),
      workflow.indexOf('RESULT="$(sed -n', workflow.indexOf('if uncertain_status "$SSH_RC"; then'))
    );
    expect(workflow).toContain('uncertain_status()');
    expect(workflow).toContain('[ "$status" -eq 124 ]');
    expect(workflow).toContain('[ "$status" -ge 128 ]');
    expect(uncertain).toContain('if uncertain_status "$SSH_RC"; then');
    expect(workflow).toContain('RELEASE_DISPATCH_DEADLINE_EPOCH - $(date +%s)');
    expect(workflow).toContain('timeout --signal=TERM --kill-after=5s "${transport_timeout}s"');
    expect(uncertain).toContain('RETRY_REMAINING=$((RELEASE_DISPATCH_DEADLINE_EPOCH - $(date +%s)');
    expect(uncertain).toContain('sleep "$RETRY_DELAY"');
    const retryIntake = uncertain.indexOf('run_remote_intake | tee -a');
    const retryObserve = uncertain.indexOf('observe_remote_release | tee -a');
    expect(retryIntake).toBeGreaterThan(0);
    expect(retryObserve).toBeGreaterThan(retryIntake);
  });

  it('binds every host retry to the workflow-owned immutable not-after epoch', () => {
    expect(workflow).toContain("NOT_AFTER_EPOCH='$RELEASE_DISPATCH_DEADLINE_EPOCH'");
    expect(workflow).toContain('--not-after-epoch "$NOT_AFTER_EPOCH"');
    expect(intakeInstaller).toContain('"$ACTOR" "$NOT_AFTER_EPOCH" > "$TMP_REQUEST"');
    expect(intake).toContain('NOT_AFTER_EPOCH="${REQUEST_LINES[4]}"');
    expect(intake).toContain('--not-after-epoch "$NOT_AFTER_EPOCH"');
    expect(launcher).toContain('NOT_AFTER_EPOCH="$8"');
    expect(launcher).toContain('"$NOT_AFTER_EPOCH" > "$TMP_FILE"');
    expect(transaction).toContain('REQUEST_NOT_AFTER_EPOCH="${REQUEST_LINES[5]}"');
    expect(transaction).toContain('MUTATION_DEADLINE_EPOCH="$REQUEST_NOT_AFTER_EPOCH"');
    expect(transaction).toContain(
      "die 'immutable release not-after epoch expired before new release mutation'"
    );
    const finalization = transaction.indexOf('attest-commit');
    const deadlineFence = transaction.indexOf(
      'immutable release not-after epoch expired before new release mutation',
      finalization
    );
    const freshness = transaction.indexOf('source_target_is_current', deadlineFence);
    expect(deadlineFence).toBeGreaterThan(finalization);
    expect(freshness).toBeGreaterThan(deadlineFence);
    expect(transaction).not.toContain('REQUEST_NOT_AFTER_EPOCH=$(( $(date +%s)');
  });

  it('executes the exact full-SHA/process health predicate and rejects empty identities', () => {
    const helper = transaction.slice(
      transaction.indexOf('parse_health_instance_for_sha()'),
      transaction.indexOf('\nhealth_instance_for_sha()')
    );
    const python = helper.match(/python3 -c '\n([\s\S]*?)\n' 2>\/dev\/null/)?.[1];
    expect(python).toContain('d.get("releaseSha")==os.environ["EXPECTED_SHA"]');
    expect(python).toContain('re.fullmatch(r"[1-9][0-9]*-[0-9a-f]{8}",instance)');
    expect(
      spawnSync('python3', ['-c', python!], {
        input: JSON.stringify({
          running: true,
          releaseSha: B_SHA,
          liveness: 'ok',
          instanceId: '12345-deadbeef',
        }),
        env: { ...process.env, EXPECTED_SHA: B_SHA },
      }).status
    ).toBe(0);
    expect(
      spawnSync('python3', ['-c', python!], {
        input: JSON.stringify({ running: true, releaseSha: B_SHA, liveness: 'ok', instanceId: '' }),
        env: { ...process.env, EXPECTED_SHA: B_SHA },
      }).status
    ).not.toBe(0);
  });

  it('prepares one-use authority only after the long drain wait and immediately before cutover', () => {
    const releaseLoop = transaction.indexOf(
      'while :; do',
      transaction.indexOf('source_target_is_current')
    );
    const certificate = transaction.indexOf('maintenance_certificate)', releaseLoop);
    const lock = transaction.indexOf("acquire_engine_lock 'maintenance cutover'", certificate);
    const lockedCertificate = transaction.indexOf('maintenance_certificate)', lock);
    const prepare = transaction.indexOf(
      'PREPARE_OUTPUT="$(bounded_break_command',
      lockedCertificate
    );
    const cutover = transaction.indexOf('docker stop -t 15 sp-autoheal', prepare);
    expect(certificate).toBeGreaterThan(0);
    expect(lock).toBeGreaterThan(certificate);
    expect(lockedCertificate).toBeGreaterThan(lock);
    expect(prepare).toBeGreaterThan(lockedCertificate);
    expect(cutover).toBeGreaterThan(prepare);
    expect(transaction.slice(prepare, cutover)).toContain('PREPARED=1');
    expect(transaction.slice(prepare, cutover)).toContain('MUTATION_STARTED=1');
  });

  it('builds every target from its exact server tree and reuses only that proven build contract', () => {
    const lease = transaction.indexOf('create_image_lease');
    const build = transaction.indexOf('"$IMAGE_BUILDER" "$REPO_DIR" "$SHA" "$IMAGE_REF"', lease);
    const freshness = transaction.indexOf('source_target_is_current', build);
    const certificateWait = transaction.indexOf('while :; do', freshness);
    expect(lease).toBeGreaterThan(0);
    expect(build).toBeGreaterThan(lease);
    expect(freshness).toBeGreaterThan(build);
    expect(certificateWait).toBeGreaterThan(freshness);
    expect(transaction.slice(lease, freshness)).toContain(
      'timeout --signal=TERM --kill-after=15s "${BUILD_TIMEOUT}s"'
    );
    expect(transaction).toContain(
      'MAX_RUNTIME_SECONDS="${ENGINE_RELEASE_MAX_RUNTIME_SECONDS:-8400}"'
    );
    expect(installer).toContain('TimeoutStartSec=145min');
    expect(observer).toContain('OBSERVE_SECONDS="${ENGINE_RELEASE_OBSERVE_SECONDS:-10200}"');
    // 15m invocation assignment + 145m host unit still leaves ten minutes for
    // ExecStopPost retirement and the observer's exact live proof.
    expect(15 * 60 + 145 * 60).toBeLessThanOrEqual(10200 - 600);
    expect(workflow).not.toMatch(/\bdocker build\b/);
    expect(statSync(imageBuilder).mode & 0o111).not.toBe(0);
    expect(imageBuilderSource).toContain('GIT_NO_REPLACE_OBJECTS=1 git -C "$REPO_DIR" archive');
    expect(imageBuilderSource).toContain('"${TARGET_SHA}:server"');
    expect(imageBuilderSource).toContain('com.smarterpoker.engine.source-tree');
    expect(imageBuilderSource).toContain('com.smarterpoker.engine.build-contract');
    expect(imageBuilderSource).toContain("BUILD_CONTRACT='clean-server-archive-v1'");
    expect(imageBuilderSource).toContain("trap 'exit 130' INT");
    expect(imageBuilderSource).toContain("trap 'exit 143' HUP TERM");
    expect(imageBuilderSource.indexOf('EXISTING_REVISION')).toBeLessThan(
      imageBuilderSource.indexOf("echo 'ENGINE_IMAGE_REUSED=true'")
    );
    expect(imageBuilderSource.indexOf('EXISTING_TREE')).toBeLessThan(
      imageBuilderSource.indexOf("echo 'ENGINE_IMAGE_REUSED=true'")
    );
    expect(imageBuilderSource.indexOf('EXISTING_CONTRACT')).toBeLessThan(
      imageBuilderSource.indexOf("echo 'ENGINE_IMAGE_REUSED=true'")
    );
  });

  // Builds a repository sandbox and runs the real image builder, so it is
  // subprocess-bound like the provenance case above; it timed out at 5046ms in
  // a loaded full-suite run with every assertion holding. Budget, not behaviour.
  it('excludes mutable host files and credentials from the executable image build path', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'engine-clean-build-'));
    try {
      const repo = join(sandbox, 'repo');
      const server = join(repo, 'server');
      const source = join(server, 'src');
      const bin = join(sandbox, 'bin');
      const dockerState = join(sandbox, 'docker-state');
      const contextRoot = join(sandbox, 'contexts');
      mkdirSync(source, { recursive: true });
      mkdirSync(bin);
      mkdirSync(dockerState);
      writeFileSync(join(server, 'Dockerfile'), 'FROM scratch\n');
      writeFileSync(join(server, 'package.json'), '{"name":"exact-tree"}\n');
      writeFileSync(join(server, 'tsconfig.json'), '{}\n');
      writeFileSync(join(source, 'tracked.ts'), 'export const tracked = true;\n');

      const emptyGlobalConfig = join(sandbox, 'empty-global.gitconfig');
      writeFileSync(emptyGlobalConfig, '');
      const isolatedEnv = fixtureGitEnvironment(emptyGlobalConfig);
      const runGit = (args: string[]) =>
        spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: isolatedEnv });
      expect(runGit(['init', '-q']).status).toBe(0);
      expect(runGit(['config', 'user.email', 'release-law@example.invalid']).status).toBe(0);
      expect(runGit(['config', 'user.name', 'Release Law']).status).toBe(0);
      expect(runGit(['add', 'server']).status).toBe(0);
      expect(runGit(['commit', '-qm', 'exact committed server tree']).status).toBe(0);
      const targetSha = runGit(['rev-parse', 'HEAD']).stdout.trim();
      const serverTree = runGit(['rev-parse', 'HEAD:server']).stdout.trim();

      // These are the production defect: files present beside the checkout but
      // absent from the target commit must be impossible for Docker to ingest.
      writeFileSync(
        join(source, 'untracked-sentinel.ts'),
        'throw new Error("host contamination");\n'
      );
      writeFileSync(join(server, '.env'), 'DATABASE_URL=must-never-enter-the-image\n');

      const fakeDocker = `#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="$FAKE_DOCKER_STATE_DIR"
mkdir -p "$STATE_DIR"
if [ "$1" = image ] && [ "$2" = inspect ]; then
  shift 2
  [ -f "$STATE_DIR/built" ] || exit 1
  if [ "$#" -ge 1 ] && [ "$1" = -f ]; then
    FORMAT="$2"
    case "$FORMAT" in
      '{{.Id}}') printf '%s\\n' 'sha256:${'d'.repeat(64)}' ;;
      *org.opencontainers.image.revision*) [ -f "$STATE_DIR/revision" ] && cat "$STATE_DIR/revision" ;;
      *com.smarterpoker.engine.source-tree*) [ -f "$STATE_DIR/source-tree" ] && cat "$STATE_DIR/source-tree" ;;
      *com.smarterpoker.engine.build-contract*) [ -f "$STATE_DIR/build-contract" ] && cat "$STATE_DIR/build-contract" ;;
      *) exit 2 ;;
    esac
  fi
  exit 0
fi
if [ "$1" = buildx ]; then
  if [ "$2" = create ]; then
    printf '%s\\n' "$@" > "$STATE_DIR/builder-create"
    touch "$STATE_DIR/builder"
    exit 0
  fi
  if [ "$2" = inspect ]; then
    [ -f "$STATE_DIR/builder" ] || exit 1
    printf 'Driver: %s\\n' "\${FAKE_BUILDER_DRIVER:-docker-container}"
    exit 0
  fi
  if [ "$2" = stop ]; then printf 'stop\\n' >> "$STATE_DIR/builder-stops"; exit 0; fi
fi
if [ "$1" = inspect ]; then
  printf '%s\\n' 'moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8 1073741824 1073741824 100000 100000 no'
  exit 0
fi
if [ "$1" = exec ]; then
  case "$4" in
    */memory.max) printf '%s\\n' "\${FAKE_CGROUP_MEMORY:-1073741824}" ;;
    */memory.peak) printf '1048576000\\n' ;;
    */memory.swap.max) printf '0\\n' ;;
    */cpu.max) printf '100000 100000\\n' ;;
    /etc/buildkit/buildkitd.toml)
      printf '[worker.oci]\\nmax-parallelism = %s\\ngc = true\\nreservedSpace = "512MB"\\nmaxUsedSpace = "%s"\\nminFreeSpace = "2GB"\\n' "\${FAKE_WORKER_PARALLELISM:-1}" "\${FAKE_CACHE_TARGET:-2GB}"
      ;;
    *) exit 9 ;;
  esac
  exit 0
fi
if [ "$1" = buildx ] && [ "$2" = build ]; then
  shift 2
  [ -f "$PWD/src/tracked.ts" ]
  [ ! -e "$PWD/src/untracked-sentinel.ts" ]
  [ ! -e "$PWD/.env" ]
  printf '%s\\n' "$PWD" > "$STATE_DIR/context-path"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --builder) [ "$2" = club-arena-engine-bounded-v1 ]; shift 2 ;;
      --load) shift ;;
      --progress) [ "$2" = plain ]; shift 2 ;;
      --build-arg) printf '%s' "$2" > "$STATE_DIR/build-arg"; shift 2 ;;
      --label)
        case "$2" in
          org.opencontainers.image.revision=*) printf '%s' "$2" | cut -d= -f2- > "$STATE_DIR/revision" ;;
          com.smarterpoker.engine.source-tree=*) printf '%s' "$2" | cut -d= -f2- > "$STATE_DIR/source-tree" ;;
          com.smarterpoker.engine.build-contract=*) printf '%s' "$2" | cut -d= -f2- > "$STATE_DIR/build-contract" ;;
          *) exit 3 ;;
        esac
        shift 2
        ;;
      -t) printf '%s' "$2" > "$STATE_DIR/image-ref"; shift 2 ;;
      .) shift ;;
      *) exit 4 ;;
    esac
  done
  printf 'build\\n' >> "$STATE_DIR/builds"
  touch "$STATE_DIR/built"
  exit 0
fi
if [ "$1" = tag ]; then exit 0; fi
if [ "$1" = image ] && [ "$2" = rm ]; then exit 0; fi
exit 5
`;
      writeFileSync(join(bin, 'docker'), fakeDocker);
      chmodSync(join(bin, 'docker'), 0o755);
      writeFileSync(
        join(bin, 'awk'),
        '#!/usr/bin/env bash\nprintf "%s\\n" "${FAKE_AVAILABLE_KIB:-2097152}"\n'
      );
      chmodSync(join(bin, 'awk'), 0o755);
      writeFileSync(join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(join(bin, 'flock'), 0o755);
      writeFileSync(join(bin, 'setsid'), '#!/usr/bin/env bash\nexec "$@"\n');
      chmodSync(join(bin, 'setsid'), 0o755);
      writeFileSync(
        join(bin, 'timeout'),
        '#!/usr/bin/env bash\nset -e\nwhile [[ "${1:-}" == --* ]]; do shift; done\n[[ "${1:-}" =~ ^[0-9]+s$ ]] && shift\nexec "$@"\n'
      );
      chmodSync(join(bin, 'timeout'), 0o755);

      // A tar reader may finish at end markers before its producer finishes
      // trailing block padding. Force that race beyond the pipe buffer so a
      // successful extraction cannot hide a failed archive producer.
      const realGit = spawnSync('which', ['git'], {
        encoding: 'utf8',
        env: isolatedEnv,
      }).stdout.trim();
      expect(realGit.startsWith('/')).toBe(true);
      writeFileSync(
        join(bin, 'git'),
        `#!/usr/bin/env python3
import os, subprocess, sys
real_git = ${JSON.stringify(realGit)}
args = sys.argv[1:]
if 'archive' not in args:
    os.execv(real_git, [real_git, *args])
result = subprocess.run([real_git, *args])
if result.returncode:
    sys.exit(result.returncode)
sys.stdout.buffer.write(bytes(1024 * 1024))
sys.stdout.buffer.flush()
sys.exit(int(os.environ.get('FAKE_GIT_ARCHIVE_FAILURE', '0')))
`
      );
      chmodSync(join(bin, 'git'), 0o755);

      // A legacy revision-only tag must rebuild once; revision alone never
      // proves which bytes the mutable checkout contributed.
      writeFileSync(join(dockerState, 'built'), '');
      writeFileSync(join(dockerState, 'revision'), targetSha);
      const env = {
        ...isolatedEnv,
        PATH: `${bin}:${isolatedEnv.PATH ?? ''}`,
        FAKE_DOCKER_STATE_DIR: dockerState,
        ENGINE_BUILD_CONTEXT_ROOT: contextRoot,
        ENGINE_BUILD_LOCK_FILE: join(sandbox, 'engine-build.lock'),
      };
      const first = spawnSync(
        'bash',
        [imageBuilder, repo, targetSha, `club-arena-engine:${targetSha}`],
        { encoding: 'utf8', env }
      );
      expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
      expect(first.stdout).toContain('ENGINE_IMAGE_REUSED=false');
      expect(readFileSync(join(dockerState, 'source-tree'), 'utf8').trim()).toBe(serverTree);
      expect(readFileSync(join(dockerState, 'build-contract'), 'utf8').trim()).toBe(
        'clean-server-archive-v1'
      );
      expect(readFileSync(join(dockerState, 'build-arg'), 'utf8')).toBe(
        `GIT_COMMIT_SHA=${targetSha}`
      );
      const usedContext = readFileSync(join(dockerState, 'context-path'), 'utf8').trim();
      expect(existsSync(usedContext)).toBe(false);
      expect(readFileSync(join(dockerState, 'builds'), 'utf8')).toBe('build\n');

      const second = spawnSync(
        'bash',
        [imageBuilder, repo, targetSha, `club-arena-engine:${targetSha}`],
        { encoding: 'utf8', env }
      );
      expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
      expect(second.stdout).toContain('ENGINE_IMAGE_REUSED=true');
      expect(readFileSync(join(dockerState, 'builds'), 'utf8')).toBe('build\n');

      // Consuming padding must not turn an archive producer failure into a
      // successful Docker build, even after tar extracted every required file.
      rmSync(join(dockerState, 'source-tree'));
      const failedArchive = spawnSync(
        'bash',
        [imageBuilder, repo, targetSha, `club-arena-engine:${targetSha}`],
        { encoding: 'utf8', env: { ...env, FAKE_GIT_ARCHIVE_FAILURE: '47' } }
      );
      expect(failedArchive.status, failedArchive.stderr).toBe(47);
      expect(readFileSync(join(dockerState, 'builds'), 'utf8')).toBe('build\n');
      expect(readdirSync(contextRoot)).toEqual([]);

      // Failed cgroup readback never enters Docker's build operation. It stops
      // the owned builder and removes the source staging directory.
      const noLimit = spawnSync(
        'bash',
        [imageBuilder, repo, targetSha, `club-arena-engine:${targetSha}`],
        {
          encoding: 'utf8',
          env: { ...env, FAKE_CGROUP_MEMORY: 'max' },
        }
      );
      expect(noLimit.status).toBe(1);
      expect(noLimit.stderr).toContain('cgroup limits are not enforced');
      expect(readFileSync(join(dockerState, 'builds'), 'utf8')).toBe('build\n');
      expect(readFileSync(join(dockerState, 'builder-stops'), 'utf8')).toBe('stop\nstop\n');
      expect(readdirSync(contextRoot)).toEqual([]);
      const noHeadroom = spawnSync(
        'bash',
        [imageBuilder, repo, targetSha, `club-arena-engine:${targetSha}`],
        {
          encoding: 'utf8',
          env: { ...env, FAKE_AVAILABLE_KIB: '40000' },
        }
      );
      expect(noHeadroom.status).toBe(1);
      expect(noHeadroom.stderr).toContain('insufficient memory headroom');
      expect(readFileSync(join(dockerState, 'builds'), 'utf8')).toBe('build\n');
      expect(readdirSync(contextRoot)).toEqual([]);
      const wrongDriver = spawnSync(
        'bash',
        [imageBuilder, repo, targetSha, `club-arena-engine:${targetSha}`],
        {
          encoding: 'utf8',
          env: { ...env, FAKE_BUILDER_DRIVER: 'docker' },
        }
      );
      expect(wrongDriver.status).toBe(1);
      expect(wrongDriver.stderr).toContain('not the dedicated container driver');
      expect(readFileSync(join(dockerState, 'builds'), 'utf8')).toBe('build\n');
      expect(readdirSync(contextRoot)).toEqual([]);
      for (const drift of [{ FAKE_WORKER_PARALLELISM: '4' }, { FAKE_CACHE_TARGET: '20GB' }]) {
        const changedWorker = spawnSync(
          'bash',
          [imageBuilder, repo, targetSha, `club-arena-engine:${targetSha}`],
          { encoding: 'utf8', env: { ...env, ...drift } }
        );
        expect(changedWorker.status).toBe(1);
        expect(changedWorker.stderr).toContain('worker configuration could not be verified');
        expect(readFileSync(join(dockerState, 'builds'), 'utf8')).toBe('build\n');
        expect(readdirSync(contextRoot)).toEqual([]);
      }
      expect(readFileSync(join(dockerState, 'builder-stops'), 'utf8')).toBe(
        'stop\nstop\nstop\nstop\n'
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 15_000);

  it('revalidates restart authority under the shared lock and starts in that same shell', () => {
    const releaseLoop = transaction.indexOf(
      'while :; do',
      transaction.indexOf('source_target_is_current')
    );
    const lock = transaction.indexOf("acquire_engine_lock 'maintenance cutover'", releaseLoop);
    const freshness = transaction.indexOf('source_target_is_current', lock);
    const certificate = transaction.indexOf('maintenance_certificate)', freshness);
    const prepare = transaction.indexOf('PREPARE_OUTPUT="$(bounded_break_command', certificate);
    const autohealFence = transaction.indexOf('docker stop -t 15 sp-autoheal', prepare);
    const start = transaction.indexOf('ENGINE_UP_LOCK_HELD=1', autohealFence);
    expect(lock).toBeGreaterThan(0);
    expect(freshness).toBeGreaterThan(lock);
    expect(certificate).toBeGreaterThan(freshness);
    expect(prepare).toBeGreaterThan(certificate);
    expect(autohealFence).toBeGreaterThan(prepare);
    expect(start).toBeGreaterThan(autohealFence);
    expect(transaction).toContain('m.get("active") is True');
    expect(transaction).toContain('m.get("phase")=="counting_down"');
    expect(transaction).toContain('m.get("durableConfirmed") is True');
    expect(transaction).toContain('m.get("unparkedTables")==0');
    expect(transaction).toContain('if remaining<int(__import__("os").environ["MIN_BREAK_MS"]):');
    expect(transaction).toContain('MIN_BREAK_MS="$MIN_BREAK_REMAINING_MS"');
  });

  it('guarantee and rollback can only recover the durable desired image', () => {
    const abort = recovery.indexOf('engine-release-seal.py" abort');
    const reconcile = recovery.indexOf('engine-supervisor.sh', abort);
    expect(abort).toBeGreaterThan(0);
    expect(reconcile).toBeGreaterThan(abort);
    expect(recovery.indexOf('set +e')).toBeLessThan(abort);
    expect(recovery).toContain('ENGINE_SUPERVISOR_LOCK_HELD=1');
    expect(recovery).not.toMatch(/ENGINE_RELEASE_TOKEN|IMAGE=.*\$SHA|engine-up\.sh/);
    expect(recovery).toContain('ENGINE_SUPERVISOR_FORCE_DESIRED=1');
    expect(recovery).toContain('ENGINE_SUPERVISOR_REQUIRE_EXACT_HEALTH=1');
    expect(transaction).toContain('ENGINE_SUPERVISOR_FORCE_DESIRED=1');
    expect(transaction).toContain('ENGINE_SUPERVISOR_REQUIRE_EXACT_HEALTH=1');
    expect(unitWrapper).toContain('ExecStopPost');
    expect(unitWrapper).toContain('recovery failed; preserving the immutable generation pin');
  });

  it('uses the five-minute lane only after a fresh healthy rollback-source readiness proof', () => {
    expect(transaction).toContain('BREAK_CUTOVER_PROOF_SECONDS=150');
    expect(transaction).toContain('BREAK_ROLLBACK_RESERVE_SECONDS=135');
    expect(transaction).toContain('BREAK_DEADLINE_SLACK_SECONDS=0');
    expect(transaction).toContain(
      'MIN_BREAK_REMAINING_MS=$(((BREAK_CUTOVER_PROOF_SECONDS + BREAK_ROLLBACK_RESERVE_SECONDS + BREAK_DEADLINE_SLACK_SECONDS) * 1000))'
    );
    expect((150 + 135) * 1000).toBeLessThan(5 * 60 * 1000);
    expect(transaction).toContain('if [ "$CERTIFICATE_RC" -eq 2 ]');
    expect(transaction).toContain('refusing before mutation');
    const readiness = transaction.indexOf(
      'prove_rollback_readiness',
      transaction.indexOf('persist_break_deadline')
    );
    const prepare = transaction.indexOf('PREPARE_OUTPUT="$(bounded_break_command', readiness);
    expect(readiness).toBeGreaterThan(0);
    expect(prepare).toBeGreaterThan(readiness);
    expect(transaction).toContain(
      'rollback readiness found no fresh exact desired database leader'
    );
  });

  it('reads the final systemd invocation before accepting its result receipt', () => {
    const retryLoop = observer.slice(
      observer.indexOf('if [ -z "$COMPLETED_ATTESTATION" ]; then'),
      observer.indexOf('unit_completed_and_disabled()')
    );
    const invocation = retryLoop.indexOf('CURRENT_INVOCATION="$(systemctl show');
    const receipt = retryLoop.indexOf('COMPLETED_ATTESTATION="$("$CONTROL_DIR');
    expect(invocation).toBeGreaterThan(0);
    expect(receipt).toBeGreaterThan(invocation);
    expect(retryLoop.slice(invocation, receipt)).toContain('INVOCATION_ID="$CURRENT_INVOCATION"');
  });

  it('a rejected locked certificate cannot mark mutation or trigger a blind restart', () => {
    const releaseLoop = transaction.indexOf(
      'while :; do',
      transaction.indexOf('source_target_is_current')
    );
    const certificate = transaction.indexOf('maintenance_certificate)', releaseLoop);
    const lockedCertificate = transaction.indexOf('maintenance_certificate)', certificate + 1);
    const prepared = transaction.indexOf('PREPARED=1', lockedCertificate);
    const mutated = transaction.indexOf('MUTATION_STARTED=1', prepared);
    const engineStart = transaction.indexOf('ENGINE_UP_LOCK_HELD=1', mutated);
    expect(certificate).toBeGreaterThan(0);
    expect(lockedCertificate).toBeGreaterThan(certificate);
    expect(prepared).toBeGreaterThan(lockedCertificate);
    expect(mutated).toBeGreaterThan(prepared);
    expect(engineStart).toBeGreaterThan(mutated);
    expect(transaction.slice(certificate, prepared)).not.toContain('docker stop');
    expect(transaction).toContain('if [ "$rc" -ne 0 ] && [ "$MUTATION_STARTED" = 1 ]');
  });

  it('resumes one exact release across reboot and retires it only after durable recovery', () => {
    const intent = launcher.indexOf('ln -- "$TMP_FILE" "$INTENT_FILE"');
    const enable = launcher.indexOf('systemctl enable "$UNIT"', intent);
    const start = launcher.indexOf('systemctl start --no-block "$UNIT"');
    const request = launcher.indexOf('ln -- "$TMP_FILE" "$REQUEST_FILE"', start);
    expect(intent).toBeGreaterThan(0);
    expect(enable).toBeGreaterThan(intent);
    expect(start).toBeGreaterThan(enable);
    expect(request).toBe(-1);
    expect(installer).toContain('[Install]\nWantedBy=multi-user.target');
    expect(launcher).toContain('UNIT="club-arena-engine-release-v1@$RUN_ID.service"');
    const completed = launcher.indexOf('attest-result');
    expect(completed).toBeGreaterThan(0);
    expect(completed).toBeLessThan(intent);
    expect(launcher).toContain("echo 'ENGINE_RELEASE_HANDOFF=completed'");
    expect(intake).toContain('case "$HANDOFF" in');
    expect(intake).toContain('completed)');

    const startupLock = transaction.indexOf("acquire_engine_lock 'duplicate certification'");
    const pending = transaction.indexOf('read_pending_owner', startupLock);
    const recoverOwn = transaction.indexOf('recover_pending_owner "$PENDING_RUN"', pending);
    const source = transaction.indexOf('source_target_is_current', recoverOwn);
    expect(pending).toBeGreaterThan(startupLock);
    expect(recoverOwn).toBeGreaterThan(pending);
    expect(source).toBeGreaterThan(recoverOwn);

    const abort = recovery.indexOf('engine-release-seal.py" abort');
    const supervisorRepair = recovery.indexOf('engine-supervisor.sh', abort);
    const terminalReceipt = recovery.indexOf('attest-terminal', supervisorRepair);
    const pinCleanup = recovery.indexOf('rm -f -- "$PIN_FILE"', supervisorRepair);
    const leaseCleanup = recovery.indexOf('rm -f -- "$LEASE_FILE"', pinCleanup);
    const breakDeadlineCleanup = recovery.indexOf('rm -f -- "$BREAK_DEADLINE_FILE"', leaseCleanup);
    const intentCleanup = recovery.indexOf('rm -f -- "$INTENT_FILE"', breakDeadlineCleanup);
    const requestCleanup = recovery.indexOf('rm -f -- "$REQUEST_FILE"', intentCleanup);
    const durableCleanup = recovery.indexOf('fsync_directory "$REQUEST_ROOT"', requestCleanup);
    const disable = recovery.indexOf('systemctl disable "$UNIT"', durableCleanup);
    expect(supervisorRepair).toBeGreaterThan(abort);
    expect(terminalReceipt).toBeGreaterThan(supervisorRepair);
    expect(pinCleanup).toBeGreaterThan(terminalReceipt);
    expect(pinCleanup).toBeGreaterThan(supervisorRepair);
    expect(leaseCleanup).toBeGreaterThan(pinCleanup);
    expect(breakDeadlineCleanup).toBeGreaterThan(leaseCleanup);
    expect(intentCleanup).toBeGreaterThan(breakDeadlineCleanup);
    expect(requestCleanup).toBeGreaterThan(intentCleanup);
    expect(durableCleanup).toBeGreaterThan(requestCleanup);
    expect(disable).toBeGreaterThan(durableCleanup);
    expect(observer).toContain('[ ! -e "$REQUEST_ROOT/$RUN_ID.break-deadline" ]');
    expect(unitWrapper).toContain('recovery failed; preserving the immutable generation pin');
  });

  it('retains the immutable request when durability fails immediately after pin removal', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'engine-terminal-pin-fsync-'));
    try {
      const generation = join(sandbox, 'generation');
      const requestRoot = join(sandbox, 'requests');
      const pinRoot = join(sandbox, 'pins');
      const leaseRoot = join(sandbox, 'leases');
      const bin = join(sandbox, 'bin');
      const runKey = '880-1';
      for (const path of [generation, requestRoot, pinRoot, leaseRoot, bin]) {
        mkdirSync(path, { recursive: true });
      }
      const executableRecovery = recovery.replace(
        'mapfile -t TERMINAL_REQUEST_LINES < "$REQUEST_FILE" \\\n  || { echo \'[engine-release-recover] FATAL: terminal cleanup request is unreadable\' >&2; exit 1; }',
        'TERMINAL_REQUEST_LINES=(); while IFS= read -r line; do TERMINAL_REQUEST_LINES[${#TERMINAL_REQUEST_LINES[@]}]="$line"; done < "$REQUEST_FILE"'
      );
      expect(executableRecovery).not.toBe(recovery);
      const recoveryPath = join(generation, 'engine-release-recover.sh');
      writeFileSync(recoveryPath, executableRecovery);
      chmodSync(recoveryPath, 0o755);
      writeFileSync(
        join(generation, 'engine-release-seal.py'),
        '#!/usr/bin/env bash\ncase "$1" in abort|attest-terminal) exit 0 ;; *) exit 91 ;; esac\n'
      );
      writeFileSync(join(generation, 'engine-supervisor.sh'), '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(join(generation, 'engine-release-seal.py'), 0o755);
      chmodSync(join(generation, 'engine-supervisor.sh'), 0o755);

      const requestPath = join(requestRoot, `${runKey}.request`);
      const intentPath = join(requestRoot, `${runKey}.intent`);
      const pinPath = join(pinRoot, `${runKey}.generation`);
      writeFileSync(
        requestPath,
        [
          B_SHA,
          'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/880',
          'release-test',
          generation,
          C_SHA,
          String(Math.floor(Date.now() / 1000) - 1),
          '',
        ].join('\n'),
        { mode: 0o600 }
      );
      writeFileSync(intentPath, readFileSync(requestPath), { mode: 0o600 });
      writeFileSync(pinPath, `${generation}\n${C_SHA}\n`, { mode: 0o600 });

      writeFileSync(join(bin, 'id'), '#!/usr/bin/env bash\n[ "$1" = -u ] && echo 0\n');
      writeFileSync(join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
      writeFileSync(join(bin, 'docker'), '#!/usr/bin/env bash\n[ "$1" = info ]\n');
      writeFileSync(join(bin, 'stat'), '#!/usr/bin/env bash\necho 0:600\n');
      writeFileSync(
        join(bin, 'timeout'),
        '#!/usr/bin/env bash\nset -e\nwhile [[ "${1:-}" == --* ]]; do shift; done\n[[ "${1:-}" =~ ^[0-9]+s$ ]] && shift\nexec "$@"\n'
      );
      writeFileSync(join(bin, 'python3'), `#!/usr/bin/env bash\n[ "\${2:-}" != '${pinRoot}' ]\n`);
      for (const name of ['id', 'flock', 'docker', 'stat', 'timeout', 'python3']) {
        chmodSync(join(bin, name), 0o755);
      }

      const result = spawnSync('bash', [recoveryPath, '--run-id', runKey, '--mode', 'terminal'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          ENGINE_RELEASE_REQUEST_ROOT: requestRoot,
          ENGINE_RELEASE_PIN_ROOT: pinRoot,
          ENGINE_RELEASE_IMAGE_LEASE_ROOT: leaseRoot,
          ENGINE_LOCK_FILE: join(sandbox, 'engine.lock'),
          CONTAINER: 'club-arena-engine',
        },
      });
      expect(result.status).not.toBe(0);
      expect(existsSync(pinPath)).toBe(false);
      expect(existsSync(requestPath), 'request must survive pin-directory fsync failure').toBe(
        true
      );
      expect(existsSync(intentPath), 'intent must survive pin-directory fsync failure').toBe(true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('does not rebind an already-completed run to a newer compatible control generation', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'engine-release-launch-replay-'));
    try {
      const generations = join(sandbox, 'generations');
      const generation = join(generations, C_SHA);
      const requestRoot = join(sandbox, 'requests');
      const bin = join(sandbox, 'bin');
      const systemctlLog = join(sandbox, 'systemctl.log');
      mkdirSync(generation, { recursive: true });
      mkdirSync(bin);
      writeFileSync(join(generation, 'control-sha'), `${C_SHA}\n`);
      writeFileSync(join(generation, 'launch-engine-release.sh'), launcher);
      chmodSync(join(generation, 'launch-engine-release.sh'), 0o755);
      writeFileSync(
        join(generation, 'engine-release-seal.py'),
        `#!/usr/bin/env bash\n[ "$1" = attest-result ] || exit 92\nprintf '%s\\n' 'sealed ${B_SHA} ${B_IMAGE} ${'d'.repeat(64)} 2026-09-10T04:00:00Z 12345-deadbeef ${A_SHA}'\n`
      );
      chmodSync(join(generation, 'engine-release-seal.py'), 0o755);
      writeFileSync(
        join(bin, 'id'),
        '#!/usr/bin/env bash\n[ "${1:-}" = -u ] && { printf "0\\n"; exit 0; }\nexec /usr/bin/id "$@"\n'
      );
      writeFileSync(
        join(bin, 'readlink'),
        '#!/usr/bin/env bash\npython3 - "$@" <<\'PY\'\nimport os, sys\nprint(os.path.realpath(sys.argv[-1]))\nPY\n'
      );
      writeFileSync(
        join(bin, 'systemctl'),
        `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${systemctlLog}'\nexit 91\n`
      );
      for (const command of ['id', 'readlink', 'systemctl']) chmodSync(join(bin, command), 0o755);

      const replay = spawnSync(
        join(generation, 'launch-engine-release.sh'),
        [
          '--sha',
          B_SHA,
          '--run-id',
          '777-1',
          '--actor',
          'release-replay-test',
          '--not-after-epoch',
          '9999999999',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            ENGINE_CONTROL_GENERATION_ROOT: generations,
            ENGINE_RELEASE_REQUEST_ROOT: requestRoot,
          },
        }
      );
      expect(replay.status, replay.stderr).toBe(0);
      expect(replay.stdout).toContain('ENGINE_RELEASE_HANDOFF=completed');
      expect(replay.stdout).toContain(`ENGINE_RELEASE_SHA=${B_SHA}`);
      expect(existsSync(systemctlLog), 'completed replay must not queue another unit').toBe(false);
      expect(
        readdirSync(requestRoot),
        'completed replay must not create intent/request state'
      ).toEqual([]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('reports a durable terminal failure without creating or starting another request', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'engine-release-launch-failure-replay-'));
    try {
      const generations = join(sandbox, 'generations');
      const generation = join(generations, C_SHA);
      const requestRoot = join(sandbox, 'requests');
      const bin = join(sandbox, 'bin');
      const systemctlLog = join(sandbox, 'systemctl.log');
      mkdirSync(generation, { recursive: true });
      mkdirSync(bin);
      writeFileSync(join(generation, 'control-sha'), `${C_SHA}\n`);
      writeFileSync(join(generation, 'launch-engine-release.sh'), launcher);
      chmodSync(join(generation, 'launch-engine-release.sh'), 0o755);
      writeFileSync(
        join(generation, 'engine-release-seal.py'),
        `#!/usr/bin/env bash
case "\${1:-}" in
  attest-failure)
    printf '%s\n' 'failed ${B_SHA} ${C_SHA} ${'e'.repeat(32)} 1 ${A_SHA} ${A_IMAGE}'
    ;;
  *) exit 92 ;;
esac
`
      );
      chmodSync(join(generation, 'engine-release-seal.py'), 0o755);
      writeFileSync(
        join(bin, 'id'),
        '#!/usr/bin/env bash\n[ "${1:-}" = -u ] && { printf "0\\n"; exit 0; }\nexec /usr/bin/id "$@"\n'
      );
      writeFileSync(
        join(bin, 'readlink'),
        '#!/usr/bin/env bash\npython3 - "$@" <<\'PY\'\nimport os, sys\nprint(os.path.realpath(sys.argv[-1]))\nPY\n'
      );
      writeFileSync(
        join(bin, 'systemctl'),
        `#!/usr/bin/env bash
printf '%s\n' "$*" >> '${systemctlLog}'
exit 91
`
      );
      for (const command of ['id', 'readlink', 'systemctl']) chmodSync(join(bin, command), 0o755);

      const replay = spawnSync(
        join(generation, 'launch-engine-release.sh'),
        [
          '--sha',
          B_SHA,
          '--run-id',
          '778-1',
          '--actor',
          'release-replay-test',
          '--not-after-epoch',
          '9999999999',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            ENGINE_CONTROL_GENERATION_ROOT: generations,
            ENGINE_RELEASE_REQUEST_ROOT: requestRoot,
          },
        }
      );
      expect(replay.status).toBe(1);
      expect(replay.stdout).toContain('ENGINE_RELEASE_HANDOFF=failed');
      expect(replay.stdout).toContain('ENGINE_RELEASE_RESULT=failed');
      expect(replay.stderr).toContain('refusing replay');
      expect(existsSync(systemctlLog), 'failed replay must not queue another unit').toBe(false);
      expect(readdirSync(requestRoot), 'failed replay must not create request state').toEqual([]);

      const intakeReplay = spawnSync(
        join(generation, 'launch-engine-release.sh'),
        [
          '--sha',
          B_SHA,
          '--run-id',
          '778-1',
          '--actor',
          'release-replay-test',
          '--not-after-epoch',
          '9999999999',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            ENGINE_CONTROL_GENERATION_ROOT: generations,
            ENGINE_RELEASE_REQUEST_ROOT: requestRoot,
            ENGINE_RELEASE_DISPATCH_ONLY: '1',
          },
        }
      );
      expect(intakeReplay.status, intakeReplay.stderr).toBe(0);
      expect(intakeReplay.stdout).toContain('ENGINE_RELEASE_HANDOFF=completed');
      expect(intakeReplay.stdout).toContain('ENGINE_RELEASE_RESULT=failed');
      expect(existsSync(systemctlLog), 'failed intake replay must not queue another unit').toBe(
        false
      );

      writeFileSync(join(generation, 'observe-engine-release.sh'), observer);
      chmodSync(join(generation, 'observe-engine-release.sh'), 0o755);
      const journalLog = join(sandbox, 'journal.log');
      const timeoutLog = join(sandbox, 'timeout.log');
      writeFileSync(
        join(bin, 'timeout'),
        `#!/usr/bin/env bash
printf '%s\n' "$*" >> '${timeoutLog}'
[ "\${TEST_JOURNAL_TIMEOUT:-0}" = 1 ] && exit 124
shift 3
exec "$@"
`
      );
      writeFileSync(
        join(bin, 'journalctl'),
        `#!/usr/bin/env bash
printf '%s\n' "$*" >> '${journalLog}'
[ "\${TEST_JOURNAL_UNAVAILABLE:-0}" = 1 ] && exit 1
printf '%s\n' '[engine-release-transaction] FATAL: target is stale; protected main requires a newer release'
`
      );
      for (const command of ['timeout', 'journalctl']) chmodSync(join(bin, command), 0o755);
      const observed = spawnSync(
        join(generation, 'observe-engine-release.sh'),
        ['--sha', B_SHA, '--run-id', '778-1'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            ENGINE_RELEASE_OBSERVE_SECONDS: '1',
            ENGINE_RELEASE_INVOCATION_WAIT_SECONDS: '1',
          },
        }
      );
      expect(observed.status).toBe(1);
      expect(observed.stderr).toContain('release attempt failed permanently (status=1)');
      expect(observed.stderr).toContain(`sealed desired runtime ${A_SHA} was recovered`);
      expect(observed.stdout).toContain('target is stale; protected main requires a newer release');
      expect(readFileSync(journalLog, 'utf8').trim()).toBe(
        `_SYSTEMD_INVOCATION_ID=${'e'.repeat(32)} --no-pager -o cat -n 200`
      );
      expect(readFileSync(timeoutLog, 'utf8')).toContain(
        `--signal=TERM --kill-after=1s 5s journalctl _SYSTEMD_INVOCATION_ID=${'e'.repeat(32)}`
      );
      for (const failure of ['TEST_JOURNAL_UNAVAILABLE', 'TEST_JOURNAL_TIMEOUT']) {
        const unavailable = spawnSync(
          join(generation, 'observe-engine-release.sh'),
          ['--sha', B_SHA, '--run-id', '778-1'],
          {
            encoding: 'utf8',
            env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, [failure]: '1' },
          }
        );
        expect(unavailable.status).toBe(1);
        expect(unavailable.stderr).toContain('failure journal unavailable within its bounded read');
        expect(unavailable.stderr).toContain('release attempt failed permanently (status=1)');
      }
      const readsBeforeMalformedReceipt = readFileSync(journalLog, 'utf8');
      writeFileSync(
        join(generation, 'engine-release-seal.py'),
        `#!/usr/bin/env bash\nprintf '%s\\n' 'failed ${A_SHA} ${C_SHA} ${'e'.repeat(32)} 1 ${A_SHA} ${A_IMAGE}'\n`
      );
      const malformed = spawnSync(
        join(generation, 'observe-engine-release.sh'),
        ['--sha', B_SHA, '--run-id', '778-1'],
        { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } }
      );
      expect(malformed.status).toBe(1);
      expect(malformed.stderr).toContain('durable failure attestation is malformed');
      expect(readFileSync(journalLog, 'utf8')).toBe(readsBeforeMalformedReceipt);
      expect(existsSync(systemctlLog), 'failed observation must not query systemd').toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('retries only the frozen transient status and terminally cleans ordinary release failures', () => {
    const releaseUnit = installer.slice(
      installer.indexOf('cat > "$UNIT_STAGE/club-arena-engine-release-v1@.service"'),
      installer.indexOf('systemd-analyze verify')
    );
    expect(releaseUnit).toContain('Type=oneshot');
    expect(releaseUnit).toContain('Restart=on-failure');
    expect(releaseUnit).not.toContain('RestartForceExitStatus=');
    expect(releaseUnit).toContain('RestartPreventExitStatus=1');
    expect(releaseUnit).toContain('TimeoutStopSec=330s');
    expect(releaseUnit).not.toContain('Requires=docker.service');
    expect(observer).toContain('systemd_outcome_is_retryable "$RESULT" "$MAIN_STATUS"');
    expect(observer).toContain('systemctl is-enabled "$UNIT"');
    expect(observer).toContain('systemd_outcome_is_retryable "$INTAKE_RESULT" "$INTAKE_STATUS"');
    expect(observer).toContain('systemctl is-enabled "$INTAKE_UNIT"');
    expect(observer).toContain('success:0|exit-code:1) return 1');
    expect(observer).toContain('*) return 0');
    expect(recovery).toContain('RECOVERY_MAX_SECONDS=300');

    const missingRequest = unitWrapper.slice(
      unitWrapper.indexOf('if [ ! -e "$REQUEST_FILE" ]; then'),
      unitWrapper.indexOf('mapfile -t REQUEST_LINES')
    );
    expect(missingRequest).toContain('ln -- "$INTENT_FILE" "$REQUEST_FILE"');
    expect(missingRequest).toContain('fsync_path "$REQUEST_ROOT"');
    expect(missingRequest).toContain('exit 75');
    expect(missingRequest).toContain(
      'systemctl disable "club-arena-engine-release-v1@$RUN_KEY.service"'
    );
    expect(unitWrapper).toContain('[ "$TRANSACTION_RC" -eq 75 ] && exit 75');
    expect(unitWrapper).toContain('attest-commit');
    expect(unitWrapper).toContain('[ "$TERMINAL_RECOVERY_RC" -eq 0 ] || exit 75');
    expect(unitWrapper).toContain('if [ "$TRANSACTION_RC" -eq 0 ]; then');
    expect(unitWrapper).toContain('exit 1');
    expect(unitWrapper).toContain(
      'recovery failed; preserving the immutable generation pin for diagnosis'
    );
    expect(unitWrapper.slice(unitWrapper.lastIndexOf('recovery failed'))).toContain('exit 75');

    const replayFence = unitWrapper.indexOf('attest-failure');
    const transactionStart = unitWrapper.indexOf('engine-release-transaction.sh', replayFence);
    const retainedRecovery = unitWrapper.indexOf('--mode retryable', transactionStart);
    const failureReceipt = unitWrapper.indexOf('record-failure', retainedRecovery);
    const terminalCleanup = unitWrapper.indexOf('--mode terminal', failureReceipt);
    expect(replayFence).toBeGreaterThan(0);
    expect(transactionStart).toBeGreaterThan(replayFence);
    expect(retainedRecovery).toBeGreaterThan(transactionStart);
    expect(failureReceipt).toBeGreaterThan(retainedRecovery);
    expect(terminalCleanup).toBeGreaterThan(failureReceipt);
    expect(observer).toContain('fail_if_terminal_failure');
    expect(launcher.indexOf('attest-failure')).toBeLessThan(launcher.indexOf('attest-result'));
  });

  it('reconstructs a run-owned commit before freshness and preserves unknown systemd failures', () => {
    const startupRepair = transaction.indexOf(
      "die 'sealed desired runtime could not be restored before release work'"
    );
    const committedImage = transaction.indexOf('COMMITTED_IMAGE="$(timeout', startupRepair);
    const committedAttestation = transaction.indexOf('attest-commit', committedImage);
    const committedRuntime = transaction.indexOf('exact_runtime_instance)', committedAttestation);
    const committedResult = transaction.indexOf('emit_already_released', committedRuntime);
    const mutableFreshness = transaction.indexOf('source_target_is_current', committedResult);
    expect(startupRepair).toBeGreaterThan(0);
    expect(committedImage).toBeGreaterThan(startupRepair);
    expect(committedAttestation).toBeGreaterThan(committedImage);
    expect(committedRuntime).toBeGreaterThan(committedAttestation);
    expect(committedResult).toBeGreaterThan(committedRuntime);
    expect(mutableFreshness).toBeGreaterThan(committedResult);

    const tupleFence = unitWrapper.slice(
      unitWrapper.indexOf('case "$SERVICE_RESULT:$EXIT_CODE:$EXIT_STATUS" in'),
      unitWrapper.indexOf(
        'esac',
        unitWrapper.indexOf('case "$SERVICE_RESULT:$EXIT_CODE:$EXIT_STATUS" in')
      )
    );
    expect(tupleFence).toContain('success:exited:0|exit-code:exited:1');
    expect(tupleFence).toContain('*) RECOVERY_MODE=retryable');
    expect(tupleFence).not.toContain('*) RECOVERY_MODE=terminal');

    const releaseUnit = installer.slice(
      installer.indexOf('cat > "$UNIT_STAGE/club-arena-engine-release-v1@.service"'),
      installer.indexOf('systemd-analyze verify')
    );
    expect(releaseUnit).toContain('recover %i \\${SERVICE_RESULT} \\${EXIT_CODE} \\${EXIT_STATUS}');
  });

  it('executes committed-run result reconstruction without consulting advanced protected main', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'engine-committed-replay-'));
    try {
      const generation = join(sandbox, 'generation');
      const requestRoot = join(sandbox, 'requests');
      const bin = join(sandbox, 'bin');
      const gitLog = join(sandbox, 'git.log');
      const runKey = '991-2';
      const controlSha = C_SHA;
      const instanceId = '12345-deadbeef';
      const containerId = 'd'.repeat(64);
      mkdirSync(generation);
      const canonicalGeneration = realpathSync(generation);
      mkdirSync(requestRoot);
      mkdirSync(bin);
      // macOS still ships Bash 3.2 without mapfile. Adapt only the fixture's
      // request reader; the committed-replay control flow remains byte-for-byte
      // identical to the production script and is separately asserted above.
      const executableFixture = transaction.replace(
        'mapfile -t REQUEST_LINES < "$REQUEST_FILE" || die \'release request is missing\'',
        'REQUEST_LINES=(); while IFS= read -r line; do REQUEST_LINES[${#REQUEST_LINES[@]}]="$line"; done < "$REQUEST_FILE"'
      );
      expect(executableFixture).not.toBe(transaction);
      writeFileSync(join(generation, 'engine-release-transaction.sh'), executableFixture);
      chmodSync(join(generation, 'engine-release-transaction.sh'), 0o755);
      writeFileSync(join(generation, 'control-sha'), `${controlSha}\n`);
      writeFileSync(
        join(requestRoot, `${runKey}.request`),
        [
          B_SHA,
          'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/991',
          'release-test',
          canonicalGeneration,
          controlSha,
          String(Math.floor(Date.now() / 1000) - 1),
          '',
        ].join('\n')
      );

      writeFileSync(
        join(generation, 'engine-release-seal.py'),
        `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}:\${2:-}" in
  pending-owner:) echo none ;;
  get:desired-sha) echo '${B_SHA}' ;;
  get:desired-image-id) echo '${B_IMAGE}' ;;
  attest-commit:*) echo '2 ${B_SHA} ${B_IMAGE} ${runKey}' ;;
  record-result:*) echo sealed ;;
  abort:*) ;;
  *) exit 91 ;;
esac
`
      );
      writeFileSync(join(generation, 'engine-supervisor.sh'), '#!/usr/bin/env bash\nexit 0\n');
      writeFileSync(
        join(generation, 'engine-release-database-proof.py'),
        '#!/usr/bin/env bash\nexit 0\n'
      );
      writeFileSync(join(generation, 'engine-up.sh'), '#!/usr/bin/env bash\nexit 92\n');
      writeFileSync(join(generation, 'build-engine-image.sh'), '#!/usr/bin/env bash\nexit 93\n');
      for (const name of [
        'engine-release-seal.py',
        'engine-supervisor.sh',
        'engine-release-database-proof.py',
        'engine-up.sh',
        'build-engine-image.sh',
      ]) {
        chmodSync(join(generation, name), 0o755);
      }

      writeFileSync(join(bin, 'id'), '#!/usr/bin/env bash\n[ "$1" = -u ] && echo 0\n');
      writeFileSync(join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
      writeFileSync(
        join(bin, 'timeout'),
        '#!/usr/bin/env bash\nset -e\nwhile [[ "${1:-}" == --* ]]; do shift; done\n[[ "${1:-}" =~ ^[0-9]+s$ ]] && shift\nexec "$@"\n'
      );
      writeFileSync(
        join(bin, 'curl'),
        `#!/usr/bin/env bash
printf '%s\n%s' '{"running":true,"releaseSha":"${B_SHA}","liveness":"ok","instanceId":"${instanceId}"}' '200'
`
      );
      writeFileSync(
        join(bin, 'git'),
        `#!/usr/bin/env bash
printf '%s\n' "$*" >> '${gitLog}'
exit 99
`
      );
      writeFileSync(
        join(bin, 'docker'),
        `#!/usr/bin/env bash
set -euo pipefail
[ "$1" = container ] && [ "$2" = inspect ] && [ "$3" = -f ]
case "$4" in
  '{{index .Config.Labels "sp.release.sha"}}') echo '${B_SHA}' ;;
  '{{.State.Status}}') echo running ;;
  '{{.Image}}') echo '${B_IMAGE}' ;;
  '{{.Id}}') echo '${containerId}' ;;
  '{{.State.StartedAt}}') echo '2026-09-10T04:00:00.000000000Z' ;;
  *) exit 94 ;;
esac
`
      );
      for (const name of ['id', 'flock', 'timeout', 'curl', 'git', 'docker'])
        chmodSync(join(bin, name), 0o755);

      const replay = spawnSync(
        'bash',
        [join(generation, 'engine-release-transaction.sh'), '--run-id', runKey],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            REPO_DIR: join(sandbox, 'repo-with-advanced-main'),
            ENGINE_RELEASE_REQUEST_ROOT: requestRoot,
            ENGINE_LOCK_FILE: join(sandbox, 'engine.lock'),
            SOURCE_LOCK_FILE: join(sandbox, 'source.lock'),
            ENV_FILE: join(sandbox, 'engine.env'),
            INVOCATION_ID: 'e'.repeat(32),
            ENGINE_RELEASE_MAX_RUNTIME_SECONDS: '1200',
          },
        }
      );
      expect(replay.status, `${replay.stdout}\n${replay.stderr}`).toBe(0);
      expect(replay.stdout).toContain('ENGINE_RELEASE_RESULT=sealed');
      expect(replay.stdout).toContain(`ENGINE_RELEASE_SHA=${B_SHA}`);
      expect(existsSync(gitLog), 'committed replay consulted mutable protected main').toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('has no alternate workflow that can mutate the live engine outside the sealed cutover', () => {
    const workflowDir = resolve(ROOT, '.github/workflows');
    const workflowFiles = readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name));
    expect(workflowFiles).not.toContain('update-hetzner-env.yml');

    const mutationOwners = workflowFiles.filter((name) => {
      const source = readFileSync(resolve(workflowDir, name), 'utf8');
      return source.split('\n').some((line) => {
        if (line.trimStart().startsWith('#')) return false;
        return (
          /engine-up\.sh(?:["']|\s|$)/.test(line) ||
          /docker\s+(?:run|stop|start|restart|unpause|rm)\b.*club-arena-engine/.test(line)
        );
      });
    });
    expect(mutationOwners).toEqual([]);
    expect(workflow).toContain('"$STAGE/server/scripts/install-engine-intake.sh"');
    expect(workflow).not.toMatch(/(?:engine-up|engine-supervisor)\.sh/);

    for (const name of workflowFiles.filter((file) => file !== 'auto-deploy-hetzner.yml')) {
      const runnable = readFileSync(resolve(workflowDir, name), 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');
      expect(runnable, `${name} invokes a sealed engine controller`).not.toMatch(
        /(?:engine-up|engine-supervisor)\.sh/
      );
      expect(runnable, `${name} touches canonical engine configuration`).not.toMatch(
        /(?:\/opt\/club-arena|\$?REPO_DIR)\/server\/\.env/
      );
      expect(runnable, `${name} mutates the live engine process`).not.toMatch(
        /docker\s+(?:container\s+)?(?:run|start|stop|kill|rm|restart|unpause|update)\b[^\n]*club-arena-engine/
      );
    }
  });
});
