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
 * rollback keep their generic policy; continuation targets additionally require
 * their exact two installed migration histories; and the workflow runs the check before the break gate
 * with production's credentials.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Subprocess contract suite: these tests drive REAL child processes, so their
// wall time scales with machine load, not with the code under test. vitest's
// 5000ms default is a UNIT-test budget: the slowest test here measures 288ms
// solo, and the pre-push hook runs this file in a 90-file suite at full width,
// where contention has been measured to stretch these runs by 7.1x and time
// them out. 90s is 312x the measured solo runtime - past anything observed,
// and still a real bound, so a genuinely hung child still fails the suite.
// File-scoped on purpose: no global testTimeout, no --no-file-parallelism.
vi.setConfig({ testTimeout: 90_000 });

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

function runScript(env: Record<string, string>, cwd = root) {
  const clean = { ...process.env };
  delete clean.DATABASE_URL;
  delete clean.ENGINE_DOORS_LIVE_FIXTURE;
  delete clean.ENGINE_DOORS_MIGRATIONS_FIXTURE;
  const dir = mkdtempSync(join(tmpdir(), 'door-history-'));
  try {
    const histories = join(dir, 'histories.json');
    writeFileSync(histories, JSON.stringify(continuationHistory()));
    return spawnSync(process.execPath, [SCRIPT], {
      cwd,
      env: { ...clean, ENGINE_DOORS_MIGRATIONS_FIXTURE: histories, ...env },
      encoding: 'utf8',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

  it('can prepare before the optional downline observation migration installs at the daily break', async () => {
    const { engineDoors } = await load();
    const all = [...engineDoors(resolve(root, 'server/src')).keys()];
    expect(all).toContain('fn_agent_can_watch_table');
    const dir = mkdtempSync(join(tmpdir(), 'engine-doors-'));
    const fixture = join(dir, 'live.json');
    writeFileSync(fixture, JSON.stringify(all.filter((n) => n !== 'fn_agent_can_watch_table')));
    const res = runScript({ ENGINE_DOORS_LIVE_FIXTURE: fixture });
    expect(res.status).toBe(0);
    expect(ALLOW.fn_agent_can_watch_table).toContain('daily-maintenance');
    expect(ALLOW.fn_agent_can_watch_table).toContain('TableViewerAccess.test.ts');
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

  it('an unreadable database remains a warning for a target without continuation prerequisites', () => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-door-target-'));
    try {
      mkdirSync(join(dir, 'server/src'), { recursive: true });
      writeFileSync(join(dir, 'server/src/legacy.ts'), "db.rpc('legacy_door');");
      const res = runScript({}, dir);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(
        /::warning title=DATABASE DOORS UNCHECKED::DATABASE_URL is not set/
      );
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

const continuationFiles = [
  '20261028233353_durable_private_hand_continuation.sql',
  '20261029004521_keep_generation_recovery_at_the_highest_genuinely_played_lev.sql',
];
function continuationHistory() {
  return continuationFiles.map((file) => ({
    version: file.slice(0, 14),
    name: file.slice(15, -4),
    statement_count: 1,
    sql_md5: createHash('md5')
      .update(readFileSync(join(root, 'supabase/migrations', file)))
      .digest('hex'),
  }));
}
function runContinuationFixture(functions: string[], histories: unknown, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'continuation-doors-'));
  try {
    const names = join(dir, 'functions.json');
    const rows = join(dir, 'migrations.json');
    writeFileSync(names, JSON.stringify(functions));
    writeFileSync(rows, JSON.stringify(histories));
    return runScript({
      ENGINE_DOORS_LIVE_FIXTURE: names,
      ENGINE_DOORS_MIGRATIONS_FIXTURE: rows,
      ...extra,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('continuation migration prerequisites in the existing door job', () => {
  it('a continuation target refuses an absent played-level migration', async () => {
    const { engineDoors } = await load();
    const all = [...engineDoors(resolve(root, 'server/src')).keys()];
    expect(all).toContain('fn_f06_claim_legacy_river_continuation');
    const res = runContinuationFixture(all, continuationHistory().slice(0, 1));
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('20261029004521');
  });

  it('refuses an absent private continuation migration even if every RPC name is present', async () => {
    const all = [...(await load()).engineDoors(resolve(root, 'server/src')).keys()];
    const res = runContinuationFixture(all, continuationHistory().slice(1));
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('20261028233353');
  });

  it.each(['sql_md5', 'name', 'statement_count'] as const)(
    'refuses changed installed migration %s rather than trusting its version alone',
    async (field) => {
      const all = [...(await load()).engineDoors(resolve(root, 'server/src')).keys()];
      const history = continuationHistory();
      const row = history[1] as Record<string, unknown>;
      row[field] = field === 'statement_count' ? 2 : 'changed';
      const res = runContinuationFixture(all, history);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('CONTINUATION MIGRATION UNPROVED');
      expect(res.stdout).toContain('20261029004521');
    }
  );

  it('requires exactly one history witness for each immutable target file', async () => {
    const all = [...(await load()).engineDoors(resolve(root, 'server/src')).keys()];
    const history = continuationHistory();
    const res = runContinuationFixture(all, [...history, history[1]]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('CONTINUATION MIGRATION UNPROVED');
  });

  it('passes both exact SQL histories without pinning a later compatible function body', async () => {
    const all = [...(await load()).engineDoors(resolve(root, 'server/src')).keys()];
    const res = runContinuationFixture(all, continuationHistory());
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('both exact continuation migration histories are installed');
  });

  it('fails closed for this continuation target when production is unreadable', () => {
    const res = runScript({});
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('CONTINUATION PREREQUISITES UNCHECKED');
    expect(res.stdout).toContain('DATABASE_URL is not set');
  });

  it('a rollback flag cannot waive the new target migration prerequisite', async () => {
    const all = [...(await load()).engineDoors(resolve(root, 'server/src')).keys()];
    const res = runContinuationFixture(all, [], { ROLLBACK_REQUESTED: 'true' });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('CONTINUATION MIGRATION UNPROVED');
  });

  it('an unreadable history fixture is a failure, including the outer script error path', async () => {
    const all = [...(await load()).engineDoors(resolve(root, 'server/src')).keys()];
    const res = runContinuationFixture(all, null);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('CONTINUATION PREREQUISITES UNCHECKED');
  });
});
