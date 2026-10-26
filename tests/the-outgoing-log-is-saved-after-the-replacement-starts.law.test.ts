import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

/**
 * THE OUTGOING LOG IS SAVED AFTER THE REPLACEMENT STARTS (2026-10-19).
 *
 * engine-up.sh dumped the stopped engine's whole json-file log between
 * `docker stop` and `docker run`. Every second of that dump was a second of the
 * five-minute maintenance break with no engine serving, spent inside the
 * release transaction's 75-second cutover budget. Measured on engine-01 on
 * 2026-10-19: 8-10 s for a 6-9 MB log, 28 s for a 15 MB one. At 16:55 UTC those
 * 28 s exhausted the budget and release 06b920c0 aborted; at 17:55 release
 * 41deda4d missed its final database proof by about a second.
 *
 * The log is still kept, in full: the stopped container is renamed out of the
 * way with its restart policy cleared, the replacement is started at once, and
 * the rename is dumped and removed in the background. This runs the real
 * script against a fake Docker whose `logs` cannot finish until the test opens
 * a gate, and requires engine-up to have started the replacement and returned
 * while every dump is still held at that gate.
 *
 * ORDER, NOT A STOPWATCH (2026-10-26). The proof used to give the fake dump two
 * seconds and require engine-up to return in under 2000 ms. On a busy shared
 * runner the script's own fake-Docker work took 3425 ms with nothing waiting on
 * a dump, and publisher run 40316088773 failed on that number alone. A gate
 * proves the same property with no clock in it: a script that waited on a dump
 * or on the stalled inspection would block until the gate's 30 s ceiling and be
 * killed by spawnSync's 20 s timeout, and a returned script must leave no saved
 * log behind, because no dump can finish before the test opens the gate.
 */
const root = process.cwd();
const script = join(root, 'server/scripts/engine-up.sh');

describe('engine-up starts the replacement before it saves the outgoing log', () => {
  it('pins the order in source: rename out of the way, run, then retire in the background', () => {
    const sh = readFileSync(script, 'utf8');
    const stop = sh.indexOf('docker stop -t 45 "$CONTAINER"');
    const norestart = sh.indexOf('docker update --restart no "$CONTAINER"', stop);
    const rename = sh.indexOf(
      'docker rename "$CONTAINER" "${OUTGOING_PREFIX}${outgoing_id}"',
      stop
    );
    const run = sh.indexOf('docker start "$CONTAINER"', rename);
    const retire = sh.indexOf('retire_outgoing_in_background "$OUTGOING_CONTAINER"', run);
    expect(stop).toBeGreaterThan(0);
    expect(norestart).toBeGreaterThan(stop);
    expect(rename).toBeGreaterThan(norestart);
    expect(run).toBeGreaterThan(rename);
    expect(retire).toBeGreaterThan(run);
  });

  it('returns from the Docker start receipt even when a subsequent inspection stalls, then keeps the log', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'engine-up-outgoing-'));
    try {
      const bin = join(sandbox, 'bin');
      const state = join(sandbox, 'state');
      const logs = join(sandbox, 'logs');
      const alerts = join(sandbox, 'alerts');
      const horses = join(sandbox, 'horses');
      const control = join(sandbox, 'control');
      for (const dir of [bin, state, control]) mkdirSync(dir);
      mkdirSync(horses, { mode: 0o700 });
      const calls = join(state, 'docker.calls');
      const sha = 'a'.repeat(40);
      const image = `sha256:${'b'.repeat(64)}`;
      const outgoingId = '0123456789ab';
      const leftover = 'club-arena-engine-outgoing-fedcba987654';
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
printf '%s\\n' "$*" >> '${calls}'
running='${state}/running'
case "$1" in
  image) exit 0 ;;
  stop) rm -f "$running"; exit 0 ;;
  update|rm) exit 0 ;;
  rename)
    case "$2" in club-arena-engine-incoming-*) exit 0 ;; esac
    : > '${state}/renamed'; exit 0 ;;
  create) printf '%s\\n' '${'f00dfeed'.repeat(8)}'; exit 0 ;;
  start) : > "$running"; exit 0 ;;
  logs)
    held=0
    while [ ! -e '${state}/release' ] && [ "$held" -lt 300 ]; do sleep 0.1; held=$((held + 1)); done
    printf '%s\\n' "2026-10-19T17:55:13Z [GameServer] the log of $3"
    exit 0
    ;;
  container)
    if [ "$2" = ls ]; then
      case "$*" in *outgoing-*) printf '%s\\n' '${leftover}' ;; esac
      exit 0
    fi
    if [ "$2" = inspect ]; then
      [ -e '${state}/renamed' ] && [ ! -e "$running" ] && exit 1
      exit 0
    fi
    exit 0
    ;;
  inspect)
    case "$3" in
      '{{.Id}}')
        if [ "$4" = club-arena-engine ] && [ -e "$running" ]; then
          held=0
          while [ ! -e '${state}/release' ] && [ "$held" -lt 300 ]; do sleep 0.1; held=$((held + 1)); done
          printf '%s\\n' '${'f00dfeed'.repeat(8)}'
        elif [ "$4" = '${leftover}' ]; then printf '%s\\n' 'fedcba987654beef'
        else printf '%s\\n' '${outgoingId}cafe'; fi ;;
      '{{.State.Status}}') printf '%s\\n' exited ;;
      '{{.Config.Image}}') printf '%s\\n' 'club-arena-engine:deadbeef' ;;
      '{{.State.StartedAt}}') printf '%s\\n' '2026-10-19T16:57:07.000Z' ;;
    esac
    exit 0
    ;;
esac
exit 0
`
      );
      chmodSync(join(bin, 'docker'), 0o755);
      writeFileSync(join(bin, 'logger'), `#!/usr/bin/env bash\ncat >> '${state}/logger.out'\n`);
      chmodSync(join(bin, 'logger'), 0o755);
      // GNU timeout bounds the dump on the host and in CI; its bound is not
      // what this law is about, so a workstation without it gets a pass-through.
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
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          ENGINE_UP_LOCK_HELD: '1',
          ENGINE_CONTROL_DIR: control,
          ENV_FILE: envFile,
          IMAGE: image,
          LOG_DIR: logs,
          ENGINE_ALERT_JOURNAL_HOST_DIR: alerts,
          ENGINE_HORSE_JOURNAL_HOST_DIR: horses,
        },
      });
      const elapsed = Date.now() - started;
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status, output).toBe(0);
      expect(result.stdout).toContain('[engine-up] started f00dfeedf00d');
      expect(result.stdout).toContain(
        `saving the outgoing log of club-arena-engine-outgoing-${outgoingId} in the background`
      );
      const phases = [...result.stderr.matchAll(/phase=([a-z-]+) epoch=([0-9]+)/g)];
      // stop-returned is written by the overlapped stop operation, so its
      // position relative to create-* is not fixed; it always precedes the
      // outgoing inspection, which waits for that operation.
      const names = phases.map((match) => match[1]);
      expect(names.filter((name) => name !== 'stop-returned')).toEqual([
        'stop-start',
        'create-start',
        'create-returned',
        'outgoing-inspect-start',
        'outgoing-inspect-returned',
        'outgoing-rename-start',
        'outgoing-rename-returned',
        'incoming-rename-start',
        'incoming-rename-returned',
        'launch-start',
        'launch-returned',
      ]);
      expect(names.indexOf('stop-returned')).toBeGreaterThan(names.indexOf('stop-start'));
      expect(names.indexOf('stop-returned')).toBeLessThan(names.indexOf('outgoing-inspect-start'));
      expect(
        phases.every(
          (match, index) => index === 0 || Number(match[2]) >= Number(phases[index - 1]![2])
        )
      ).toBe(true);
      const order = readFileSync(calls, 'utf8').trim().split('\n');
      const at = (prefix: string) => order.findIndex((line) => line.startsWith(prefix));
      expect(at('stop -t 45 club-arena-engine')).toBeGreaterThan(-1);
      expect(at('update --restart no club-arena-engine')).toBeGreaterThan(
        at('stop -t 45 club-arena-engine')
      );
      expect(
        at(`rename club-arena-engine club-arena-engine-outgoing-${outgoingId}`)
      ).toBeGreaterThan(at('update --restart no club-arena-engine'));
      expect(at('start club-arena-engine')).toBeGreaterThan(
        at(`rename club-arena-engine club-arena-engine-outgoing-${outgoingId}`)
      );
      expect(order.some((line) => line.startsWith('run '))).toBe(false);
      // The serving name is never removed after the replacement starts.
      expect(
        order.slice(at('start club-arena-engine')).some((line) => line === 'rm club-arena-engine')
      ).toBe(false);
      expect(
        order
          .slice(at('start club-arena-engine'))
          .some((line) => line === 'inspect -f {{.Id}} club-arena-engine')
      ).toBe(false);

      const saved = () =>
        existsSync(logs) ? readdirSync(logs).filter((f) => f.endsWith('.log.gz')) : [];
      // engine-up returned while every dump was still held at the gate. The
      // .log.gz file exists from the moment a dump starts (gzip opens it), so
      // completion is read from the "saved the outgoing log" line, which is
      // written only after a dump succeeds. No dump can succeed before the
      // gate opens; finding one here would mean the gate held nothing.
      const loggerOut = join(state, 'logger.out');
      const completed = () =>
        existsSync(loggerOut)
          ? readFileSync(loggerOut, 'utf8').includes('saved the outgoing log')
          : false;
      expect(completed(), readFileSync(calls, 'utf8')).toBe(false);
      writeFileSync(join(state, 'release'), '');

      const deadline = Date.now() + 12_000;
      const retired = () => {
        const lines = readFileSync(calls, 'utf8').split('\n');
        return (
          lines.includes(`rm club-arena-engine-outgoing-${outgoingId}`) &&
          lines.includes(`rm ${leftover}`)
        );
      };
      while ((saved().length < 2 || !retired()) && Date.now() < deadline) {
        spawnSync('sleep', ['0.2']);
      }
      expect(saved().length, readFileSync(calls, 'utf8')).toBe(2);
      expect(retired(), readFileSync(calls, 'utf8')).toBe(true);
      const contents = saved()
        .map((f) => gunzipSync(readFileSync(join(logs, f))).toString('utf8'))
        .join('');
      expect(contents).toContain(`the log of club-arena-engine-outgoing-${outgoingId}`);
      expect(contents).toContain(`the log of ${leftover}`);
      expect(readFileSync(join(state, 'logger.out'), 'utf8')).toContain(
        'saved the outgoing log to'
      );
      // A gross bound only: a script that waited on a held dump or on the
      // stalled inspection blocks until the 30 s gate ceiling. The real script
      // has measured 3.4 s on a busy runner, so 15 s carries no stopwatch risk.
      expect(elapsed, output).toBeLessThan(15_000);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 30_000);
});
