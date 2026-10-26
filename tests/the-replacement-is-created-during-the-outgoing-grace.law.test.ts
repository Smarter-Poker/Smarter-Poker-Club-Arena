import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * THE REPLACEMENT IS CREATED DURING THE OUTGOING GRACE (2026-10-24).
 *
 * Releases 735e (04:54 UTC) and f16e (06:17 UTC) both rolled back on the
 * release transaction's bounded 75-second cutover. engine-up.sh paid the old
 * engine's stop and the new container's `docker create` in series: f16e spent
 * 50 s stopping (the outgoing engine reached its 40 s shutdown deadline and
 * Docker used the force at 45 s), then 22 s creating and 4 s starting.
 *
 * Creation runs no process, opens no journal and binds no port, so it now
 * overlaps the unchanged 45 s SIGTERM grace. The replacement still STARTS only
 * after the old process has exited and been renamed away. This runs the real
 * script against a fake Docker whose stop and create each take two seconds.
 */
const root = process.cwd();
const script = join(root, 'server/scripts/engine-up.sh');
const sha = 'a'.repeat(40);
const image = `sha256:${'b'.repeat(64)}`;
const containerId = 'f00dfeed'.repeat(8);

interface Run {
  status: number | null;
  output: string;
  elapsed: number;
  calls: { at: number; pid: number; edge: 'begin' | 'end'; args: string }[];
}

function runEngineUp(fake: Record<string, string> = {}): Run {
  const sandbox = mkdtempSync(join(tmpdir(), 'engine-up-overlap-'));
  try {
    const bin = join(sandbox, 'bin');
    const state = join(sandbox, 'state');
    const control = join(sandbox, 'control');
    const horses = join(sandbox, 'horses');
    for (const dir of [bin, state, control]) mkdirSync(dir);
    mkdirSync(horses, { mode: 0o700 });
    const calls = join(state, 'calls');
    mkdirSync(calls);
    const envFile = join(sandbox, 'engine.env');
    writeFileSync(envFile, 'SUPABASE_URL=https://example.invalid\n');
    writeFileSync(
      join(control, 'engine-release-seal.py'),
      `#!/usr/bin/env bash\n[ "$1" = authorize ] && { printf '%s\\n' 'desired ${sha} ${image}'; exit 0; }\nexit 3\n`
    );
    chmodSync(join(control, 'engine-release-seal.py'), 0o755);
    writeFileSync(
      join(bin, 'docker'),
      `#!/usr/bin/env bash
now() { perl -MTime::HiRes=time -e 'printf "%.0f\\n", time*1000'; }
# One file per edge: a long argument list must never interleave with another
# process's record, which stdio may split across several writes.
record() { local edge="$1"; shift; printf '%s' "$*" > '${calls}'/"$(now)-$$-$edge-$RANDOM"; }
record begin "$@"
finish() { record end "$@"; }
case "$1" in
  image) ;;
  stop) sleep 2; : > '${state}/stopped' ;;
  create)
    sleep 2
    if [ -n "\${FAKE_CREATE_FAIL:-}" ]; then finish "$@"; exit 1; fi
    finish "$@"; printf '%s\\n' '${containerId}'; exit 0 ;;
  rename)
    case "$2" in club-arena-engine-incoming-*)
      if [ -n "\${FAKE_INCOMING_RENAME_FAIL:-}" ]; then finish "$@"; exit 1; fi ;;
    *) : > '${state}/renamed' ;;
    esac ;;
  start) [ -e '${state}/stopped' ] || { finish "$@"; exit 9; } ;;
  update|rm|logs) ;;
  container)
    if [ "$2" = ls ]; then
      case "$*" in *incoming-*) [ -z "\${FAKE_ABANDONED:-}" ] || printf '%s\\n' "\${FAKE_ABANDONED}" ;; esac
    elif [ "$2" = inspect ]; then
      [ -e '${state}/renamed' ] && { finish "$@"; exit 1; }
    fi ;;
  inspect)
    case "$3" in
      '{{.Id}}') printf '%s\\n' '0123456789abcafe' ;;
      '{{.State.Status}}') [ -e '${state}/stopped' ] && printf '%s\\n' exited || printf '%s\\n' running ;;
    esac ;;
esac
finish "$@"
exit 0
`
    );
    chmodSync(join(bin, 'docker'), 0o755);
    writeFileSync(join(bin, 'logger'), '#!/usr/bin/env bash\ncat >/dev/null\n');
    chmodSync(join(bin, 'logger'), 0o755);
    if (spawnSync('bash', ['-c', 'command -v timeout']).status !== 0) {
      writeFileSync(
        join(bin, 'timeout'),
        '#!/usr/bin/env bash\nwhile [[ "${1:-}" == --* ]]; do shift; done\nshift\nexec "$@"\n'
      );
      chmodSync(join(bin, 'timeout'), 0o755);
    }
    const started = Date.now();
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        ...fake,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        ENGINE_UP_LOCK_HELD: '1',
        ENGINE_CONTROL_DIR: control,
        ENV_FILE: envFile,
        IMAGE: image,
        LOG_DIR: join(sandbox, 'logs'),
        ENGINE_ALERT_JOURNAL_HOST_DIR: join(sandbox, 'alerts'),
        ENGINE_HORSE_JOURNAL_HOST_DIR: horses,
      },
    });
    const elapsed = Date.now() - started;
    // A successful launch retires the renamed outgoing container in the
    // background; let that dump finish before reading and removing the sandbox.
    const deadline = Date.now() + 10_000;
    while (
      result.status === 0 &&
      !readdirSync(calls).some(
        (name) =>
          name.includes('-end-') &&
          readFileSync(join(calls, name), 'utf8').startsWith('rm club-arena-engine-outgoing-')
      ) &&
      Date.now() < deadline
    ) {
      spawnSync('sleep', ['0.1']);
    }
    const parsed = readdirSync(calls)
      .map((name) => {
        const [at, pid, edge] = name.split('-');
        return {
          at: Number(at),
          pid: Number(pid),
          edge: edge as 'begin' | 'end',
          args: readFileSync(join(calls, name), 'utf8'),
        };
      })
      .sort((a, b) => a.at - b.at || a.pid - b.pid || (a.edge === 'begin' ? -1 : 1));
    return {
      status: result.status,
      output: `${result.stdout}\n${result.stderr}`,
      elapsed,
      calls: parsed,
    };
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const find = (run: Run, edge: 'begin' | 'end', prefix: string) =>
  run.calls.find((call) => call.edge === edge && call.args.startsWith(prefix));

describe('engine-up creates the replacement while the outgoing engine drains', () => {
  it('pays max(stop, create) rather than their sum, and starts only after the old process exited', () => {
    const run = runEngineUp();
    expect(run.status, run.output).toBe(0);
    const stopBegin = find(run, 'begin', 'stop -t 45 club-arena-engine')!;
    const stopEnd = find(run, 'end', 'stop -t 45 club-arena-engine')!;
    const createBegin = find(run, 'begin', 'create ')!;
    const createEnd = find(run, 'end', 'create ')!;
    const publish = find(run, 'begin', 'rename club-arena-engine-incoming-')!;
    const outgoing = find(run, 'begin', 'rename club-arena-engine club-arena-engine-outgoing-')!;
    const start = find(run, 'begin', 'start club-arena-engine')!;
    for (const call of [stopBegin, stopEnd, createBegin, createEnd, publish, outgoing, start]) {
      expect(call, run.output).toBeDefined();
    }
    // Overlap: creation began before the outgoing stop returned.
    expect(createBegin.at).toBeLessThan(stopEnd.at);
    // From the stop to the start: serial work is at least 4 s, the overlap ~2 s.
    expect(start.at - stopBegin.at, run.output).toBeLessThan(3_500);
    // One process: the start follows the old exit and both renames.
    expect(start.at).toBeGreaterThanOrEqual(stopEnd.at);
    expect(publish.at).toBeGreaterThanOrEqual(outgoing.at);
    expect(start.at).toBeGreaterThanOrEqual(publish.at);
    expect(run.calls.some((call) => call.args.startsWith('run '))).toBe(false);
    expect(run.output).toContain(`[engine-up] started ${containerId.slice(0, 12)}`);
  });

  it('creates with the complete canonical run-spec and the authorized image ID', () => {
    const run = runEngineUp();
    expect(run.status, run.output).toBe(0);
    const create = find(run, 'begin', 'create ')!.args;
    expect(create).toMatch(/--name club-arena-engine-incoming-aaaaaaaaaaaa-[1-9][0-9]* /);
    for (const flag of [
      '--restart always',
      '--health-start-period=300s',
      '--label sp.engine-up.prepared=1',
      '--label autoheal=true',
      '--label sp.role=engine',
      `--label sp.release.sha=${sha}`,
      '--log-opt max-size=100m',
      '--log-opt max-file=24',
      '-p 8080:8080',
      '--env-file ',
      'ENGINE_ALERT_JOURNAL_DIR=/var/lib/club-arena/engine-alerts',
      'HORSE_DECISION_JOURNAL_DIR=/var/lib/club-arena/horse-decisions',
    ]) {
      expect(create).toContain(flag);
    }
    expect(create.endsWith(` ${image}`)).toBe(true);
    expect(
      find(run, 'begin', `rename ${create.match(/--name (\S+)/)![1]} club-arena-engine`)
    ).toBeDefined();
  });

  it('a failed create waits for the outgoing stop, starts nothing and leaves recovery to the original owner', () => {
    const run = runEngineUp({ FAKE_CREATE_FAIL: '1' });
    expect(run.status).not.toBe(0);
    expect(find(run, 'end', 'stop -t 45 club-arena-engine'), run.output).toBeDefined();
    expect(find(run, 'begin', 'start '), run.output).toBeUndefined();
    expect(find(run, 'begin', 'rename club-arena-engine-incoming-'), run.output).toBeUndefined();
  });

  it('a prepared container that cannot take the serving name is removed, never started', () => {
    const run = runEngineUp({ FAKE_INCOMING_RENAME_FAIL: '1' });
    expect(run.status).not.toBe(0);
    expect(find(run, 'begin', 'start '), run.output).toBeUndefined();
    expect(
      find(run, 'begin', 'rm club-arena-engine-incoming-aaaaaaaaaaaa-'),
      run.output
    ).toBeDefined();
    expect(find(run, 'begin', 'rm -f club-arena-engine-incoming-'), run.output).toBeUndefined();
  });

  it('retires a never-started prepared container from an interrupted attempt before touching the engine', () => {
    const abandoned = 'club-arena-engine-incoming-0123456789ab-4242';
    const run = runEngineUp({ FAKE_ABANDONED: abandoned });
    expect(run.status, run.output).toBe(0);
    const retired = find(run, 'begin', `rm ${abandoned}`)!;
    expect(retired, run.output).toBeDefined();
    expect(retired.at).toBeLessThanOrEqual(find(run, 'begin', 'stop -t 45')!.at);
  });

  it('never removes a prepared name it does not own, and still replaces the engine', () => {
    const run = runEngineUp({ FAKE_ABANDONED: 'club-arena-engine-incoming-not-ours' });
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('prepared container owner is ambiguous');
    expect(
      find(run, 'begin', 'rm club-arena-engine-incoming-not-ours'),
      run.output
    ).toBeUndefined();
    expect(find(run, 'begin', 'start club-arena-engine'), run.output).toBeDefined();
  });
});
