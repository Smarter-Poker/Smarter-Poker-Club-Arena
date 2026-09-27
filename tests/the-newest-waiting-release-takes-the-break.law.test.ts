/**
 * LAW: when several built releases wait at the same restart certificate, the
 *      NEWEST one takes the break, and a shut certificate is named from the
 *      first read at which a cutover could still be admitted.
 * ═══════════════════════════════════════════════════════════════════════════
 * 2026-09-27, the 15:55Z break, the first hourly cutover since 2026-09-26
 * 14:06Z. Runs 36328195568 (4946473b), 36328946522 (6b6eabb1) and 36329422702
 * (c8cbe6e6) were all built and all admitted at 15:55:03-15:55:06 with about
 * 297000ms of the break left. The OLDEST took the engine lock and sealed at
 * 15:56:44; the two newer releases, which contain it, then read 194653ms and
 * 193966ms under the lock, below the 245000ms floor, and had to wait an hour.
 * The one window an hour shipped the least code it could have.
 *
 * And for the six weeks before that, every in-window refusal of a shut
 * certificate was silent: the first journal line of each break was "below the
 * 260000ms budget" about 40 seconds in, so 630 (later 6) stopped-custody
 * tables that never parked were read as "the certificate arrives too late".
 *
 * Both are executed here against the real shell source. Nothing below lowers
 * a reserve: 285000 strict, 260000 admission, 245000 locked, 135s rollback.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const transaction = readFileSync(
  join(process.cwd(), 'server/scripts/engine-release-transaction.sh'),
  'utf8'
);

const slice = (from: string, to: string) => {
  const start = transaction.indexOf(from);
  expect(start, from).toBeGreaterThanOrEqual(0);
  const end = transaction.indexOf(to, start);
  expect(end, to).toBeGreaterThan(start);
  return transaction.slice(start, end);
};

const reader = () =>
  slice('newer_release_awaiting_certificate() {', '\nrequest_recovery_window() {');
const helpers = () => slice('remaining_seconds() {', 'validate_actor() {');
const queue = () => {
  const start = transaction.indexOf(
    'while :; do',
    transaction.indexOf('NEXT_FRESHNESS_CHECK=$(( $(date +%s) + 60 ))')
  );
  const end = transaction.indexOf(
    '  BREAK_END_EPOCH=$(( $(date +%s) + (BREAK_REMAINING_MS / 1000) ))',
    start
  );
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return transaction.slice(start, end);
};
const certificateHelper = () =>
  slice('maintenance_certificate() {', "\n# Entry to the exact predecessor's checkpoint");

let root = '';
let repo = '';
let requests = '';
let states = '';
const commits: string[] = [];

const git = (...args: string[]) => {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'newest-release-takes-the-break-'));
  repo = join(root, 'repo');
  requests = join(root, 'requests');
  states = join(root, 'states');
  mkdirSync(repo);
  mkdirSync(requests);
  mkdirSync(states);
  git('init', '-q');
  git('config', 'user.email', 'law@example.invalid');
  git('config', 'user.name', 'law');
  for (const name of ['older', 'middle', 'newest']) {
    git('commit', '-q', '--allow-empty', '-m', name);
    commits.push(git('rev-parse', 'HEAD'));
  }
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const reset = () => {
  rmSync(requests, { recursive: true, force: true });
  rmSync(states, { recursive: true, force: true });
  mkdirSync(requests);
  mkdirSync(states);
};

/** A release run as the host holds it: durable request, unit state, and optionally the marker. */
const release = (
  run: string,
  sha: string,
  opts: { state?: string; marker?: string | null; symlink?: boolean } = {}
) => {
  writeFileSync(join(requests, `${run}.request`), `${sha}\nurl\nactor\ngen\ncontrol\n1\n`);
  writeFileSync(join(states, run), opts.state ?? 'activating');
  const marker = opts.marker === undefined ? sha : opts.marker;
  if (marker === null) return;
  const path = join(requests, `${run}.awaiting-certificate`);
  if (opts.symlink) {
    const target = join(root, `${run}.target`);
    writeFileSync(target, `${marker}\n`);
    symlinkSync(target, path);
  } else {
    writeFileSync(path, `${marker}\n`);
  }
};

const stubs = () => `
# macOS workstations have no coreutils timeout; the host and CI runners do.
# The shim runs the bounded command unbounded and only where timeout is absent.
command -v timeout >/dev/null 2>&1 || timeout() { shift 3; "$@"; }
systemctl() {
  # systemctl show club-arena-engine-release-v1@RUN.service -p ActiveState --value
  local unit="$2" run
  run="\${unit#club-arena-engine-release-v1@}"; run="\${run%.service}"
  cat "$STATES/$run" 2>/dev/null || echo inactive
}
`;

/** Execute the REAL reader for a release of SHA under RUN_ID. */
const whoIsNewer = (runId: string, sha: string) =>
  spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
REQUEST_ROOT="$ROOT_REQUESTS"; REPO_DIR="$ROOT_REPO"; RUN_ID="$MY_RUN"; SHA="$MY_SHA"
${stubs()}
${reader()}
newer_release_awaiting_certificate`,
    ],
    {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        ROOT_REQUESTS: requests,
        ROOT_REPO: repo,
        STATES: states,
        MY_RUN: runId,
        MY_SHA: sha,
      },
    }
  );

describe('an older release stands aside only for a newer one really waiting at the certificate', () => {
  it('names the newer waiting release that contains this target', () => {
    reset();
    const [older, , newest] = commits;
    release('100-1', older);
    release('300-1', newest);
    const result = whoIsNewer('100-1', older);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`300-1 ${newest}`);
  });

  it('never stands aside for itself, an older target, or nobody', () => {
    reset();
    const [older, middle] = commits;
    expect(whoIsNewer('200-1', middle).status).toBe(1);
    release('200-1', middle);
    expect(whoIsNewer('200-1', middle).status).toBe(1);
    release('100-1', older);
    // the waiting release is OLDER than this one: it is not contained, so no deferral
    expect(whoIsNewer('200-1', middle).status).toBe(1);
  });

  it('ignores a release that has left: failed, inactive, or no marker any more', () => {
    const [older, , newest] = commits;
    for (const opts of [{ state: 'failed' }, { state: 'inactive' }, { marker: null }]) {
      reset();
      release('100-1', older);
      release('300-1', newest, opts);
      expect(whoIsNewer('100-1', older).status, JSON.stringify(opts)).toBe(1);
    }
  });

  it('accepts a marker only for the run it names, byte for byte its durable request', () => {
    const [older, middle, newest] = commits;
    reset();
    release('100-1', older);
    release('300-1', newest, { marker: middle });
    expect(whoIsNewer('100-1', older).status).toBe(1);
    reset();
    release('100-1', older);
    release('300-1', newest, { marker: 'not-a-sha' });
    expect(whoIsNewer('100-1', older).status).toBe(1);
    reset();
    release('100-1', older);
    release('300-1', newest, { symlink: true });
    expect(whoIsNewer('100-1', older).status).toBe(1);
  });
});

/**
 * The real certificate queue, with the clock, lock and certificate stubbed the
 * way tests/operations/engine-release-window-queue.py stubs them. The newer
 * release's marker is removed after DEFER_SLEEPS sleeps, as its EXIT trap does
 * when it seals, fails or rolls back.
 */
const runQueue = (deferSleeps: number, newerWaiting = true) => {
  reset();
  const [older, , newest] = commits;
  release('100-1', older, { marker: null });
  if (newerWaiting) release('300-1', newest);
  const events = join(root, 'events');
  rmSync(events, { force: true });
  const result = spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
NOW=100; DEADLINE=10000; CERTIFICATE_DEADLINE=9000; NEXT_FRESHNESS_CHECK=99999
BREAK_END_EPOCH=0; LOCK_HELD=0; LEGACY_CHECKPOINT_REQUIRED=0; LEGACY_CHECKPOINT_ATTEMPTED=0
MIN_BREAK_REMAINING_MS=285000; BREAK_ADMISSION_MIN_BREAK_MS=260000; BREAK_LOCKED_MIN_BREAK_MS=245000
LEGACY_MIN_BREAK_REMAINING_MS=245000; BREAK_ENTRY_BUDGET_MS=0; BREAK_DEFERRED_TO=''
REQUEST_ROOT="$ROOT_REQUESTS"; REPO_DIR="$ROOT_REPO"; RUN_ID=100-1; SHA=${older}
SLEEPS=0
event() { printf '%s\\n' "$*" >> "$EVENTS"; }
date() { printf '%s\\n' "$NOW"; }
die() { event "DIE:$*"; exit 1; }
break_proof_seconds() { event UNEXPECTED_BREAK_DEADLINE; exit 98; }
sleep() {
  [ "$LOCK_HELD" = 0 ] || { event SLEEP_WITH_LOCK; exit 96; }
  SLEEPS=$((SLEEPS + 1)); event "SLEEP:$1"; NOW=$((NOW + $1))
  if [ "$SLEEPS" -ge ${deferSleeps} ]; then rm -f "$REQUEST_ROOT/300-1.awaiting-certificate"; fi
}
source_target_is_current() { event FRESH; }
acquire_engine_lock() { [ "$LOCK_HELD" = 0 ]; LOCK_HELD=1; event LOCK; }
release_engine_lock() { [ "$LOCK_HELD" = 1 ]; LOCK_HELD=0; event UNLOCK; }
exact_runtime_instance() { return 1; }
note_missed_admission() { :; }
request_recovery_window() { :; }
maintenance_certificate() { event "CERTIFICATE:$LOCK_HELD:$1"; printf '297000\\n'; return 0; }
${stubs()}
${helpers()}
${reader()}
${queue()}
  event "PREPARE_ALLOWED:$BREAK_REMAINING_MS"
  break
done
`,
    ],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        ROOT_REQUESTS: requests,
        ROOT_REPO: repo,
        STATES: states,
        EVENTS: events,
      },
    }
  );
  let lines: string[] = [];
  try {
    lines = readFileSync(events, 'utf8').trim().split('\n');
  } catch {
    lines = [];
  }
  return { result, events: lines };
};

describe('the break goes to the newest waiting release', () => {
  it('an admitted older release does not take the lock while a newer one waits', () => {
    const { result, events } = runQueue(3);
    expect(result.status, result.stderr).toBe(0);
    const firstLock = events.indexOf('LOCK');
    // three admissions, three five-second waits, and no lock among them
    expect(events.slice(0, firstLock)).toEqual([
      'CERTIFICATE:0:260000',
      'SLEEP:5',
      'CERTIFICATE:0:260000',
      'SLEEP:5',
      'CERTIFICATE:0:260000',
      'SLEEP:5',
      'CERTIFICATE:0:260000',
    ]);
    // said once, by name, not at every poll
    expect(result.stdout.match(/standing aside so the break ships the newest code/g)).toHaveLength(
      1
    );
    expect(result.stdout).toContain(
      `newer release ${commits[2]} (run 300-1) contains ${commits[0]}`
    );
    // once the newer release has left, the ordinary ladder applies unchanged
    expect(events.slice(firstLock)).toEqual([
      'LOCK',
      'FRESH',
      'CERTIFICATE:1:245000',
      'PREPARE_ALLOWED:297000',
    ]);
    expect(events).not.toContain('SLEEP_WITH_LOCK');
  });

  it('without a newer waiting release the queue is exactly what it was', () => {
    const { result, events } = runQueue(0, false);
    expect(result.status, result.stderr).toBe(0);
    expect(events).toEqual([
      'CERTIFICATE:0:260000',
      'LOCK',
      'FRESH',
      'CERTIFICATE:1:245000',
      'PREPARE_ALLOWED:297000',
    ]);
    expect(result.stdout).not.toContain('standing aside');
  });
});

describe('the release still proves everything it proved before', () => {
  it('keeps every reserve and the ladder exactly where they were', () => {
    expect(transaction).toMatch(/^BREAK_CUTOVER_PROOF_SECONDS=150$/m);
    expect(transaction).toMatch(/^BREAK_ROLLBACK_RESERVE_SECONDS=135$/m);
    expect(transaction).toMatch(/^BREAK_CERTIFICATE_LAG_SECONDS=25$/m);
    expect(transaction).toMatch(/^BREAK_LOCKED_ENTRY_SECONDS=15$/m);
    expect(transaction).toMatch(/^BREAK_WINDOW_MS=300000$/m);
  });

  it('stands aside BEFORE the lock and AFTER every certificate verdict, never instead of one', () => {
    const q = queue();
    const defer = q.indexOf('newer_release_awaiting_certificate');
    expect(defer).toBeGreaterThan(q.indexOf('request_recovery_window'));
    expect(defer).toBeLessThan(q.indexOf("acquire_engine_lock 'maintenance cutover'"));
    expect(
      q.indexOf('BREAK_REMAINING_MS="$(maintenance_certificate "$BREAK_LOCKED_MIN_BREAK_MS")"')
    ).toBeGreaterThan(q.indexOf("acquire_engine_lock 'maintenance cutover'"));
  });

  it('writes the marker only once the image is built and clears it on entry and on every exit', () => {
    const cleared = transaction.indexOf('rm -f -- "$AWAITING_CERTIFICATE_FILE"\n');
    const built = transaction.indexOf('"$IMAGE_BUILDER" "$REPO_DIR" "$SHA" "$IMAGE_REF"');
    const written = transaction.indexOf(
      'mv -f -- "$AWAITING_CERTIFICATE_FILE.$$" "$AWAITING_CERTIFICATE_FILE"'
    );
    const loop = transaction.indexOf(
      'while :; do',
      transaction.indexOf('NEXT_FRESHNESS_CHECK=$(( $(date +%s) + 60 ))')
    );
    expect(cleared).toBeGreaterThan(0);
    expect(cleared).toBeLessThan(built);
    expect(built).toBeLessThan(written);
    expect(written).toBeLessThan(loop);
    const onExit = slice('recover_on_exit() {', '\ntrap recover_on_exit EXIT');
    expect(onExit).toContain('rm -f -- "$AWAITING_CERTIFICATE_FILE"');
  });
});

/** Drive the REAL maintenance_certificate with a stubbed /health body. */
const certificate = (maintenance: Record<string, unknown>, hands = 0) => {
  const body = JSON.stringify({
    running: true,
    handsInFlightTotal: hands,
    maintenance: {
      active: true,
      phase: 'counting_down',
      durableConfirmed: true,
      ...maintenance,
    },
  });
  return spawnSync(
    'bash',
    [
      '-c',
      `set -u
MIN_BREAK_REMAINING_MS=285000
ENV_FILE=/dev/null
INFLIGHT_HANDS=true
curl() { printf '%s\\n%s' "$PROBE_BODY" "200"; }
${certificateHelper()}
maintenance_certificate 260000`,
    ],
    { encoding: 'utf8', timeout: 10_000, env: { ...process.env, PROBE_BODY: body } }
  );
};

describe('a shut certificate is named while a cutover could still be admitted', () => {
  it('names the stopped-custody refusal at the first in-window read, with the time left', () => {
    const result = certificate({
      remainingMs: 297000,
      readyForRestart: false,
      unparkedTables: 6,
      unparkedReasons: { f06_preparation_stuck: 94, stopped_bank_custody_stuck: 6 },
    });
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe('');
    expect(result.stderr).toContain(
      'the restart certificate is shut with 297000ms of the break left: unparkedTables=6'
    );
    expect(result.stderr).toContain("'stopped_bank_custody_stuck': 6");
  });

  it('names a real hand in the air the same way, and still refuses it', () => {
    const result = certificate(
      {
        remainingMs: 296000,
        readyForRestart: false,
        unparkedTables: 1,
        unparkedReasons: { f06_preparation_unresolved: 1 },
      },
      1
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('handsInFlightTotal=1');
  });

  it('says nothing extra when the certificate is open or the database admits', () => {
    const open = certificate({ remainingMs: 297000, readyForRestart: true, unparkedTables: 0 });
    expect(open.status).toBe(0);
    expect(open.stdout.trim()).toBe('297000');
    expect(open.stderr).not.toContain('is shut with');
    const bounded = certificate({
      remainingMs: 297000,
      readyForRestart: false,
      unparkedTables: 4,
      unparkedReasons: { f06_preparation_stuck: 94, f06_preparation_unresolved: 4 },
    });
    expect(bounded.status, bounded.stderr).toBe(0);
    expect(bounded.stdout.trim()).toBe('297000');
    expect(bounded.stderr).not.toContain('is shut with');
  });

  it('leaves the short-break verdict exactly as it was', () => {
    const short = certificate({
      remainingMs: 200000,
      readyForRestart: false,
      unparkedTables: 6,
      unparkedReasons: { stopped_bank_custody_stuck: 6 },
    });
    expect(short.status).toBe(2);
    expect(short.stdout.trim()).toBe('200000');
    expect(short.stderr).toContain('the restart certificate is also shut');
    expect(short.stderr).not.toContain('is shut with');
  });
});
