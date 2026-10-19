import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * A RECOVERY POLL OUTLIVES ITS FIRST PROBE (2026-10-19).
 *
 * engine-supervisor.sh proves an exact desired recovery by polling local and
 * public /health until the deadline. Its pause between probes was
 * `bounded_recovery_command 5 sleep 5 || break` - `timeout 5s sleep 5` - and
 * timeout's clock starts before sleep's, so it returned 124 every time
 * (measured on engine-01: 3 of 3) and the loop gave up after one probe. On
 * 2026-10-19 the restored engine was declared failed five seconds after it
 * started at 16:57:07 and 17:57:57 UTC, while it was live a moment later.
 *
 * This runs the real script with the REAL `timeout` (the older harness in
 * engine-release-break-recovery.law.test.ts replaces it with a pass-through,
 * which is exactly why the race was invisible) and an engine that answers
 * healthy only on its second probe.
 */
const root = process.cwd();
const deadlineSeconds = 20;

describe('the exact desired recovery keeps polling until its deadline', () => {
  it('does not race its pause against its own timeout', () => {
    const supervisor = readFileSync(join(root, 'server/scripts/engine-supervisor.sh'), 'utf8');
    expect(supervisor).not.toMatch(/bounded_recovery_command\s+(\d+)\s+sleep\s+\1\b/);
  });

  it(
    'proves an engine that is unhealthy on the first probe and healthy on the second',
    () => {
      const sandbox = mkdtempSync(join(tmpdir(), 'engine-recovery-poll-'));
      try {
        const bin = join(sandbox, 'bin');
        const state = join(sandbox, 'state');
        const control = join(sandbox, 'control');
        mkdirSync(bin);
        mkdirSync(state);
        mkdirSync(control);
        const desiredSha = 'a'.repeat(40);
        const desiredImage = `sha256:${'b'.repeat(64)}`;
        const probes = join(state, 'local-probes');

        writeFileSync(
          join(control, 'engine-release-seal.py'),
          `#!/usr/bin/env bash
case "$1" in
  get)
    case "$2" in
      desired-sha) printf '%s\\n' '${desiredSha}' ;;
      desired-image-id) printf '%s\\n' '${desiredImage}' ;;
      desired-legacy-unlabelled) printf '%s\\n' 'false' ;;
      *) exit 2 ;;
    esac
    ;;
  classify-running) printf '%s\\n' 'desired ${desiredSha}' ;;
  authorize) printf '%s\\n' 'desired ${desiredSha} ${desiredImage}' ;;
  *) exit 3 ;;
esac
`
        );
        chmodSync(join(control, 'engine-release-seal.py'), 0o755);
        writeFileSync(join(control, 'engine-up.sh'), '#!/usr/bin/env bash\nexit 0\n');
        chmodSync(join(control, 'engine-up.sh'), 0o755);
        writeFileSync(
          join(bin, 'docker'),
          `#!/usr/bin/env bash
set -eu
if [ "$1" = info ]; then exit 0; fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  if printf '%s' "$*" | grep -q "{{json .Config.Env}}"; then printf '%s\\n' '["GIT_COMMIT_SHA=${desiredSha}"]'; fi
  if printf '%s' "$*" | grep -q "{{.Id}}"; then printf '%s\\n' '${desiredImage}'; fi
  exit 0
fi
if [ "$1" = container ] && [ "$2" = inspect ]; then
  format=''
  while [ "$#" -gt 0 ]; do
    [ "$1" = -f ] && { format="$2"; shift 2; continue; }
    shift
  done
  case "$format" in
    '{{.State.Status}}') printf '%s\\n' 'running' ;;
    '{{.Image}}') printf '%s\\n' '${desiredImage}' ;;
    *sp.release.sha*) printf '%s\\n' '${desiredSha}' ;;
    *autoheal*) printf '%s\\n' 'true' ;;
    *sp.role*) printf '%s\\n' 'engine' ;;
    *RestartPolicy.Name*) printf '%s\\n' 'always' ;;
    *) exit 0 ;;
  esac
  exit 0
fi
if [ "$1" = start ] || [ "$1" = update ] || [ "$1" = tag ]; then exit 0; fi
exit 4
`
        );
        chmodSync(join(bin, 'docker'), 0o755);
        // The local probe is still booting the first time it is asked.
        writeFileSync(
          join(bin, 'curl'),
          `#!/usr/bin/env bash
case "$*" in
  *127.0.0.1*)
    printf 'x' >> '${probes}'
    if [ "$(wc -c < '${probes}' | tr -d ' ')" -lt 2 ]; then
      printf '%s\\n%s' '{"running":false}' '503'
      exit 0
    fi
    ;;
esac
printf '%s\\n%s' '{"running":true,"releaseSha":"${desiredSha}","liveness":"ok","instanceId":"12345-deadbeef"}' '200'
`
        );
        chmodSync(join(bin, 'curl'), 0o755);
        writeFileSync(join(bin, 'logger'), '#!/usr/bin/env bash\nexit 0\n');
        chmodSync(join(bin, 'logger'), 0o755);
        // Production and CI run GNU timeout. A workstation without it gets an
        // emulation with the same shape - the timer is armed BEFORE the command
        // starts, and a fired timer answers 124 - never a pass-through.
        const hasTimeout =
          spawnSync('bash', ['-c', 'command -v timeout'], { encoding: 'utf8' }).status === 0;
        if (!hasTimeout) {
          writeFileSync(
            join(bin, 'timeout'),
            `#!/usr/bin/env bash
while [[ "\${1:-}" == --* ]]; do shift; done
limit="\${1%s}"; shift
marker="$(mktemp)"; rm -f "$marker"
( exec </dev/null >/dev/null 2>&1; sleep "$limit"; : > "$marker"; kill -TERM "$$" ) &
killer=$!
"$@" &
child=$!
trap 'kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; rm -f "$marker"; exit 124' TERM
wait "$child"; rc=$?
kill "$killer" 2>/dev/null; wait "$killer" 2>/dev/null
if [ -e "$marker" ]; then rm -f "$marker"; exit 124; fi
exit "$rc"
`
          );
          chmodSync(join(bin, 'timeout'), 0o755);
        }

        const started = Date.now();
        const result = spawnSync('bash', [join(root, 'server/scripts/engine-supervisor.sh')], {
          encoding: 'utf8',
          timeout: (deadlineSeconds + 2) * 1000,
          killSignal: 'SIGKILL',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            ENGINE_CONTROL_DIR: control,
            ENGINE_SUPERVISOR_LOCK_HELD: '1',
            ENGINE_SUPERVISOR_FORCE_DESIRED: '1',
            ENGINE_SUPERVISOR_REQUIRE_EXACT_HEALTH: '1',
            ENGINE_RECOVERY_DEADLINE_EPOCH: String(Math.floor(Date.now() / 1000) + deadlineSeconds),
            ENGINE_URL: 'https://engine.example.invalid',
            STATE_DIR: state,
            TEXTFILE_DIR: state,
            AUTOHEAL_CONTAINER: 'sp-autoheal',
          },
        });
        const output = `${result.stdout}\n${result.stderr}`;
        expect(result.error, output).toBeUndefined();
        expect(output).not.toContain('did not become live and exact locally and publicly');
        expect(result.status, output).toBe(0);
        expect(result.stdout).toContain('is live and exact locally and publicly as 12345-deadbeef');
        expect(Number(readFileSync(probes, 'utf8').length)).toBeGreaterThanOrEqual(2);
        // One pause of at most five seconds separated the two probes.
        expect(Date.now() - started).toBeLessThan((deadlineSeconds - 5) * 1000);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    },
    (deadlineSeconds + 8) * 1000
  );
});
