/**
 * THE ENGINE SHIPS ONLY WITH ITS DOORS (2026-09-11).
 *
 * Twice in two days a build went live calling a database function production
 * did not have - fn_move_tournament_player on 2026-09-10 and
 * fn_ca_reprice_unpaid_tournament_place on 2026-09-11 - because a schema
 * manifest fragment declared each one before its migration was applied, and
 * the phantom-reference gate believed the declaration. The deploy now asks
 * production's pg_proc for every function the engine calls, before its release
 * gate, and refuses to hand the build to Hetzner with a door missing.
 *
 * This law pins: the extractor sees both incidents' call sites and nothing in
 * a comment; the real script, run end to end against a "production" that
 * lacks the reprice door, fails and names it; an unreadable database and a
 * rollback never block; and the workflow runs the check before the break gate
 * with production's credentials.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const SCRIPT = resolve(root, 'scripts/ci/check-engine-doors-exist.mjs');
const WF = readFileSync(resolve(root, '.github/workflows/auto-deploy-hetzner.yml'), 'utf8');
const ALLOW = JSON.parse(
  readFileSync(resolve(root, 'scripts/ci/engine-doors.allowlist.json'), 'utf8')
);

type Doors = {
  doorsIn: (src: string) => Set<string>;
  engineDoors: (dir?: string) => Map<string, string[]>;
};
const load = async (): Promise<Doors> => (await import(SCRIPT)) as Doors;

function runScript(env: Record<string, string>) {
  const clean = { ...process.env };
  delete clean.DATABASE_URL;
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    env: { ...clean, ...env },
    encoding: 'utf8',
  });
}

describe('the extractor finds every door the engine calls, and only those', () => {
  it('reads .rpc literals, ignores comments, and takes only the values an rpcName can hold', async () => {
    const { doorsIn } = await load();
    const found = doorsIn(`
      // supabase.rpc('only_in_a_comment')
      /* await supabase.rpc("also_a_comment") */
      const { data } = await supabase.rpc('fn_ca_reprice_unpaid_tournament_place', { p: 1 });
      await db.rpc(\`fn_template_literal\`);
      const rpcName = params.kind === 'mini' ? 'fn_bbj_mini_payout' : 'bbj_atomic_payout_v2';
      const url = 'https://x.test/path // not a comment';
      await supabase.rpc("fn_after_a_url");
    `);
    expect([...found].sort()).toEqual(
      [
        'bbj_atomic_payout_v2',
        'fn_after_a_url',
        'fn_bbj_mini_payout',
        'fn_ca_reprice_unpaid_tournament_place',
        'fn_template_literal',
      ].sort()
    );
  });

  it('sees both call sites that shipped without their function', async () => {
    const { engineDoors } = await load();
    const doors = engineDoors(resolve(root, 'server/src'));
    expect(doors.has('fn_ca_reprice_unpaid_tournament_place')).toBe(true);
    expect(doors.has('fn_move_tournament_player')).toBe(true);
    for (const files of doors.values()) {
      for (const f of files) expect(f).not.toMatch(/\.(test|spec)\.[cm]?[jt]sx?$/);
    }
  });
});

describe('the real script, end to end', () => {
  it('fails, and names the door, when production lacks one the build calls', async () => {
    const { engineDoors } = await load();
    const all = [...engineDoors(resolve(root, 'server/src')).keys()];
    const dir = mkdtempSync(join(tmpdir(), 'engine-doors-'));
    const fixture = join(dir, 'live.json');
    writeFileSync(
      fixture,
      JSON.stringify(all.filter((n) => n !== 'fn_ca_reprice_unpaid_tournament_place'))
    );
    const res = runScript({ ENGINE_DOORS_LIVE_FIXTURE: fixture });
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(
      /::error title=MISSING DATABASE DOOR::fn_ca_reprice_unpaid_tournament_place\(\)/
    );
  });

  it('passes when every door exists', async () => {
    const { engineDoors } = await load();
    const all = [...engineDoors(resolve(root, 'server/src')).keys()];
    const dir = mkdtempSync(join(tmpdir(), 'engine-doors-'));
    const fixture = join(dir, 'live.json');
    writeFileSync(fixture, JSON.stringify(all));
    const res = runScript({ ENGINE_DOORS_LIVE_FIXTURE: fixture });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(
      /^OK - all \d+ database functions this build calls exist in production\./m
    );
  });

  it('a rollback is reported, never blocked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-doors-'));
    const fixture = join(dir, 'live.json');
    writeFileSync(fixture, '[]');
    const res = runScript({ ENGINE_DOORS_LIVE_FIXTURE: fixture, ROLLBACK_REQUESTED: 'true' });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/::warning title=MISSING DATABASE DOOR::/);
  });

  it('an unreadable database is a warning, never the reason a fix cannot ship', () => {
    const res = runScript({});
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/::warning title=DATABASE DOORS UNCHECKED::DATABASE_URL is not set/);
  });
});

describe('the control policy scans a separate exact target', () => {
  it('executes the control checker and allowlist while reading only target server/src', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-door-control-'));
    try {
      const control = join(dir, 'control');
      const target = join(control, 'engine-target');
      for (const base of [control, target]) {
        mkdirSync(join(base, 'scripts/ci'), { recursive: true });
        mkdirSync(join(base, 'server/src'), { recursive: true });
      }
      const checker = join(control, 'scripts/ci/check-engine-doors-exist.mjs');
      writeFileSync(checker, readFileSync(SCRIPT, 'utf8'));
      writeFileSync(
        join(control, 'scripts/ci/engine-doors.allowlist.json'),
        JSON.stringify({ fn_allowed: 'approved by control' })
      );
      writeFileSync(join(control, 'server/src/control.ts'), "db.rpc('fn_control_only');");
      writeFileSync(
        join(target, 'scripts/ci/check-engine-doors-exist.mjs'),
        "throw new Error('OLD_CONTROL_EXECUTED');"
      );
      writeFileSync(
        join(target, 'scripts/ci/engine-doors.allowlist.json'),
        JSON.stringify({ fn_missing: 'stale target policy' })
      );
      writeFileSync(
        join(target, 'server/src/runtime.ts'),
        "db.rpc('fn_allowed'); db.rpc('fn_missing');"
      );
      const fixture = join(dir, 'live.json');
      writeFileSync(fixture, '[]');
      const git = (cwd: string, ...args: string[]) =>
        execFileSync('git', args, {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        }).trim();
      for (const repository of [target, control]) {
        git(repository, 'init', '-q');
        git(repository, 'config', 'user.name', 'Control source fixture');
        git(repository, 'config', 'user.email', 'fixture@example.invalid');
        git(repository, 'add', '--', 'scripts', 'server');
        git(repository, 'commit', '-qm', 'exact source snapshot');
      }
      const controlSha = git(control, 'rev-parse', 'HEAD');
      const targetSha = git(target, 'rev-parse', 'HEAD');
      expect(controlSha).not.toBe(targetSha);
      const start = WF.indexOf('      - name: Prove the control and source identities');
      const end = WF.indexOf('\n      - name:', start + 1);
      const step = WF.slice(start, end);
      const identityCode = step
        .slice(step.indexOf('run: |\n') + 'run: |\n'.length)
        .replace(/^ {10}/gm, '');
      for (const [CONTROL_SHA, TARGET_SHA, expected] of [
        [controlSha, targetSha, 0],
        [targetSha, targetSha, 1],
        [controlSha, controlSha, 1],
      ] as const) {
        const identity = spawnSync('bash', ['-c', identityCode], {
          cwd: control,
          encoding: 'utf8',
          env: { ...process.env, CONTROL_SHA, TARGET_SHA },
        });
        expect(identity.status, identity.stderr).toBe(expected);
      }
      const controlAlias = join(dir, 'control-link');
      symlinkSync(control, controlAlias, 'dir');
      const result = spawnSync(
        process.execPath,
        [join(controlAlias, 'scripts/ci/check-engine-doors-exist.mjs')],
        {
          cwd: target,
          encoding: 'utf8',
          env: {
            ...process.env,
            ENGINE_DOORS_TARGET_ROOT: target,
            ENGINE_DOORS_LIVE_FIXTURE: fixture,
          },
        }
      );
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout).toContain('MISSING DATABASE DOOR::fn_missing()');
      expect(result.stdout).not.toMatch(/fn_allowed\(\)|fn_control_only|OLD_CONTROL_EXECUTED/);
      expect(result.stderr).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unreadable target source cannot pass as an unreadable database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-door-no-source-'));
    try {
      const result = runScript({ ENGINE_DOORS_TARGET_ROOT: dir });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ENGINE DOOR SOURCE INVALID');
      expect(result.stdout).not.toContain('DATABASE DOORS UNCHECKED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the workflow asks before it hands the build to Hetzner', () => {
  it('runs the check with production credentials, before the durable intake', () => {
    const doors = WF.indexOf(
      '- name: Every database function this build calls exists in production'
    );
    const handoff = WF.indexOf(
      '- name: Dispatch the staged SHA through the durable Hetzner intake'
    );
    const build = WF.indexOf('- name: Compile and test the exact server tree');
    expect(doors).toBeGreaterThan(build);
    expect(doors).toBeLessThan(handoff);
    const step = WF.slice(doors, handoff);
    expect(step).toMatch(/DATABASE_URL: \$\{\{ secrets\.DATABASE_URL \}\}/);
    expect(step).toMatch(/ROLLBACK_REQUESTED:/);
    expect(step).toMatch(/node scripts\/ci\/check-engine-doors-exist\.mjs/);
  });

  it('every allowlisted door says why', () => {
    for (const [name, reason] of Object.entries(ALLOW)) {
      expect(typeof reason, name).toBe('string');
      expect(String(reason).length, name).toBeGreaterThan(20);
    }
  });
});
