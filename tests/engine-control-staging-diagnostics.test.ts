import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(
  resolve(import.meta.dirname, '../.github/workflows/auto-deploy-hetzner.yml'),
  'utf8'
);
const stage = workflow.slice(
  workflow.indexOf('name: Stage exact control bytes'),
  workflow.indexOf('name: Dispatch the staged SHA')
);
const payload = stage
  .slice(
    stage.indexOf("<<'REMOTE'\n") + "<<'REMOTE'\n".length,
    stage.lastIndexOf('          REMOTE')
  )
  .split('\n')
  .map((line) => line.replace(/^ {10}/, ''))
  .join('\n');
const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(failure = '', overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'engine-stage-diagnostics-'));
  sandboxes.push(dir);
  const bin = join(dir, 'bin');
  const repo = join(dir, 'repo');
  const archive = join(dir, 'archive');
  for (const path of [bin, join(repo, 'server'), join(archive, 'server/scripts')])
    mkdirSync(path, { recursive: true });
  writeFileSync(join(repo, 'server/.env'), 'SECRET_SENTINEL=must-never-appear\n');
  writeFileSync(
    join(archive, 'server/scripts/entry.sh'),
    failure === 'shell' ? 'if\n' : '#!/bin/bash\ntrue\n'
  );
  for (const file of ['engine-release-seal.py', 'engine-release-database-proof.py'])
    writeFileSync(join(archive, 'server/scripts', file), failure === 'python' ? 'if:\n' : 'pass\n');
  const tar = spawnSync('tar', ['-cf', join(dir, 'archive.tar'), '-C', archive, 'server'], {
    encoding: 'utf8',
  });
  expect(tar.status, tar.stderr).toBe(0);
  const stub = (name: string, body: string) => {
    const p = join(bin, name);
    writeFileSync(p, '#!/bin/bash\n' + body);
    chmodSync(p, 0o755);
  };
  stub('id', `echo ${failure === 'privilege' ? '1000' : '0'}\n`);
  for (const name of ['docker', 'systemctl', 'systemd-analyze']) stub(name, 'exit 0\n');
  stub('flock', '[ "$FAIL_CASE" != lock ]\n');
  stub('timeout', 'shift 3\nexec "$@"\n');
  stub(
    'git',
    `case "$3" in
  remote) if [ "$FAIL_CASE" = repository ]; then echo https://SECRET_SENTINEL@github.invalid/wrong/repo; else echo git@github.com:smarter-poker/smarter-poker-club-arena.git; fi ;;
  fetch) [ "$FAIL_CASE" != fetch ] ;;
  rev-parse) [ "$FAIL_CASE" != main ] || exit 1; printf '%s\\n' "$TARGET_SHA" ;;
  cat-file) [ "$FAIL_CASE" != missing ] ;;
  merge-base) [ "$FAIL_CASE" != ancestry ] ;;
  log) if [ "$FAIL_CASE" = stale ]; then printf '%040d\\n' 1; else printf '%s\\n' "$TARGET_SHA"; fi ;;
  archive) [ "$FAIL_CASE" != archive ] || exit 2; cat "$FIXTURE_ARCHIVE" ;;
  *) exit 99 ;;
esac\n`
  );
  if (failure === 'environment') rmSync(join(repo, 'server/.env'));
  if (failure === 'unexpected') stub('install', 'exit 42\n');
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    TARGET_SHA: 'a'.repeat(40),
    CONTROL_SHA: 'b'.repeat(40),
    RUN_KEY: '34613015733-1',
    REPO_DIR: repo,
    FAIL_CASE: failure,
    FIXTURE_ARCHIVE: join(dir, 'archive.tar'),
    ...overrides,
  };
  const input = payload
    .replaceAll('/var/lib/club-arena', join(dir, 'var/lib/club-arena'))
    .replaceAll('/var/lock/club-arena-source.lock', join(dir, 'source.lock'));
  return spawnSync('bash', ['-se'], { input, env, encoding: 'utf8', timeout: 15000 });
}

describe('exact remote staging emits actionable secret-safe failures', () => {
  it('keeps the full workflow remote payload syntactically valid', () => {
    const result = spawnSync('bash', ['-n'], { input: payload, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });
  it.each([
    ['privilege', 'STAGE_PRIVILEGE_INVALID'],
    ['environment', 'STAGE_ENV_MISSING_OR_EMPTY'],
    ['repository', 'STAGE_REPOSITORY_MISMATCH'],
    ['lock', 'STAGE_SOURCE_LOCK_TIMEOUT'],
    ['fetch', 'STAGE_FETCH_FAILED'],
    ['main', 'STAGE_MAIN_UNRESOLVED'],
    ['missing', 'STAGE_COMMIT_MISSING'],
    ['ancestry', 'STAGE_ANCESTRY_INVALID'],
    ['stale', 'STAGE_TARGET_STALE'],
    ['archive', 'STAGE_ARCHIVE_FAILED'],
    ['shell', 'STAGE_SHELL_SYNTAX_FAILED'],
    ['python', 'STAGE_PYTHON_SYNTAX_FAILED'],
  ])('%s failure is distinct and stops staging', (failure, code) => {
    const result = fixture(failure);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(`code=${code}`);
    expect(result.stdout + result.stderr).not.toContain('SECRET_SENTINEL');
    expect(result.stdout).not.toContain('STAGE_DURABLE');
  });
  it.each([
    [{ TARGET_SHA: 'bad-SHA' }, 'STAGE_TARGET_INVALID'],
    [{ CONTROL_SHA: 'bad-SHA' }, 'STAGE_CONTROL_INVALID'],
    [{ RUN_KEY: '1-01' }, 'STAGE_RUN_KEY_INVALID'],
  ])('invalid input reports only its classified reason', (overrides, code) => {
    const result = fixture('', overrides);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`code=${code}`);
  });
  it('preserves an unexpected command exit and its phase without tracing', () => {
    const result = fixture('unexpected');
    expect(result.status).toBe(42);
    expect(result.stderr).toContain('phase=stage-directory code=STAGE_COMMAND_FAILED');
    expect(result.stderr).toContain('exit=42');
    expect(result.stderr).not.toContain('SECRET_SENTINEL');
  });
  it('finishes first-attempt staging with exact non-secret identities after fsync', () => {
    const result = fixture();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('code=STAGE_DURABLE run=34613015733-1');
    expect(result.stdout).toContain(`target=${'a'.repeat(40)} control=${'b'.repeat(40)}`);
    expect(result.stderr).not.toContain('code=STAGE_COMMAND_FAILED');
  });
});
