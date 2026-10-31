/**
 * LAW: A MIGRATION THAT NEEDS THE LIVE TABLES WAITS FOR THE DAILY BREAK
 * (2026-10-22).
 *
 * clubs, tables and hand_history are held by some transaction older than
 * 200 ms in 150 of 150 samples during play, so a migration needing ACCESS
 * EXCLUSIVE on them cannot install while tables deal; trying (the Midway
 * rake-cap migration, 02:34 and 02:48 UTC) froze the hand commit path and
 * killed 32 table engines. Such a migration declares
 * "-- @install-window: daily-maintenance". The ordinary applier refuses it as
 * QUEUED; the daily 03:30 America/Chicago run of stage-engine-release.yml
 * installs it inside the 04:00 freeze.
 *
 * What this pins:
 *   1. Window-only: the ordinary applier refuses a declared file, and the
 *      window route is admitted only by the database's own predicate (daily
 *      break counting down, freeze confirmed, start reserve left), asserted
 *      again inside the transaction it sends.
 *   2. Single transaction: one BEGIN/COMMIT per file, the history row inside
 *      it, nothing that manages its own transaction.
 *   3. No retry loop: one attempt per file, the first refusal stops the run,
 *      the wait is one bounded wait for one window, no new schedule.
 *   4. The override reason is supplied by the route and recorded by the
 *      existing DDL guard; the file may not supply its own.
 *   5. It refuses rather than waits: 1 s lock_timeout, 5 s statements, an 8 s
 *      budget asserted before COMMIT, no sleeps, no blocking advisory locks,
 *      all far below the 15 s age at which fn_ca_writer_lock_sentinel cancels.
 * The native proof of all five is scripts/ci/test-maintenance-window-migrations.sh,
 * run by .github/workflows/maintenance-window-migrations.yml.
 */
import {
  validateOwnerMigrationWindow,
  ownerWindowPredicate,
} from '../scripts/ci/owner-window-migration.mjs';
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import {
  WINDOW_ANNOTATION,
  WINDOW_LOCK_TIMEOUT_MS,
  WINDOW_STATEMENT_TIMEOUT_MS,
  TRANSACTION_BUDGET_SECONDS,
  START_RESERVE_SECONDS,
  COMMIT_RESERVE_SECONDS,
  windowDeclaration,
  declaresMaintenanceWindow,
  validateWindowMigration,
  windowOpenPredicate,
  windowTransactionSQL,
  overrideReason,
  dailyWindows,
  windowToServe,
} from '../scripts/ci/maintenance-window-migrations.mjs';

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const applier = read('scripts/ci/apply-recorded-migration.mjs');
const installer = read('scripts/ci/install-window-migrations.mjs');
const FIXTURES = 'scripts/ci/fixtures/maintenance-window-migrations';
const fixture = read(`${FIXTURES}/20991231000001_window_fixture_takes_the_live_tables.sql`);
const FILE = '20991231000001_window_fixture_takes_the_live_tables.sql';
const declared = (body: string) => `-- x\n${WINDOW_ANNOTATION}\nBEGIN;\n${body}\nCOMMIT;\n`;
const refuses = (body: string, opts = {}) =>
  expect(() => validateWindowMigration(FILE, declared(body), opts)).toThrow();

describe('a window migration declares itself exactly', () => {
  it('reads one exact annotation and nothing looser', () => {
    expect(WINDOW_ANNOTATION).toBe('-- @install-window: daily-maintenance');
    expect(windowDeclaration(fixture)).toBe('daily-maintenance');
    expect(windowDeclaration('BEGIN;\nCOMMIT;\n')).toBeNull();
    expect(() => windowDeclaration('-- @install-window: daily\nBEGIN;\nCOMMIT;')).toThrow();
    expect(() =>
      windowDeclaration(`${WINDOW_ANNOTATION}\n${WINDOW_ANNOTATION}\nBEGIN;\nCOMMIT;`)
    ).toThrow();
    expect(declaresMaintenanceWindow('-- @install-window: nightly\n')).toBe(false);
  });
});

describe('it refuses rather than waits, in one transaction', () => {
  it('accepts the fixture that takes all three live tables', () => {
    expect(validateWindowMigration(FILE, fixture, { preamble: [] })).toBe(true);
  });

  it('caps every timeout far below the writer-lock sentinel', () => {
    expect(WINDOW_LOCK_TIMEOUT_MS).toBe(1000);
    expect(WINDOW_STATEMENT_TIMEOUT_MS).toBe(5000);
    expect(TRANSACTION_BUDGET_SECONDS).toBe(8);
    // fn_ca_writer_lock_sentinel cancels a session whose transaction is older
    // than 15 s; the PostgreSQL 17 transaction_timeout backstop is budget + 4.
    expect(TRANSACTION_BUDGET_SECONDS + 4).toBeLessThan(15);
    expect(applier).toContain("SET transaction_timeout = '${TRANSACTION_BUDGET_SECONDS + 4}s'");
    refuses("SET LOCAL lock_timeout = '5s';");
    refuses("SET LOCAL lock_timeout = '1001ms';");
    refuses("SET LOCAL statement_timeout = '6s';");
    refuses("SET lock_timeout = '1s';");
    refuses("SET SESSION statement_timeout = '1s';");
    refuses("SELECT set_config('lock_timeout', '1s', true);");
    refuses("SET LOCAL transaction_timeout = '1s';");
    expect(() =>
      validateWindowMigration(FILE, declared("SET LOCAL lock_timeout = '500ms';"))
    ).not.toThrow();
  });

  it('never sleeps, never blocks on an advisory lock, never loops on LOCK TABLE', () => {
    refuses('SELECT pg_sleep(1);');
    refuses('SELECT pg_advisory_xact_lock(1);');
    refuses('SELECT pg_advisory_lock_shared(1);');
    refuses(
      'DO $$ BEGIN LOOP BEGIN LOCK TABLE public.clubs IN ACCESS EXCLUSIVE MODE; EXIT; EXCEPTION WHEN lock_not_available THEN NULL; END; END LOOP; END $$;'
    );
    expect(() =>
      validateWindowMigration(FILE, declared('SELECT pg_try_advisory_xact_lock(1);'))
    ).not.toThrow();
  });

  it('is exactly one transaction and manages none of its own', () => {
    expect(() =>
      validateWindowMigration(FILE, `${WINDOW_ANNOTATION}\nBEGIN;\nCOMMIT;\nBEGIN;\nCOMMIT;\n`)
    ).toThrow();
    refuses('SAVEPOINT a;');
    refuses('ROLLBACK;');
    refuses('SELECT 1', { preamble: [{ name: 'ix' }] });
    for (const mode of ['recovery', 'batches', 'settlementLane', 'thawRepair', 'rakeHistory'])
      refuses('SELECT 1;', { [mode]: true });
  });

  it('cannot bring its own override or bypass the freeze', () => {
    refuses("SET LOCAL ca.break_window_migration_override = 'mine';");
    refuses("SET LOCAL app.freeze_bypass = 'on';");
  });
});

describe('the transaction carries the window, the override reason and the budget', () => {
  const atomic =
    "BEGIN;\nALTER TABLE public.clubs ADD COLUMN x int;\nINSERT INTO supabase_migrations.schema_migrations VALUES ('1');\nCOMMIT;";
  const sent = windowTransactionSQL(FILE, atomic);

  it('opens with the reason, the caps and the window assertion before the file body', () => {
    const begin = sent.indexOf('BEGIN;');
    const reason = sent.indexOf(
      `SET LOCAL ca.break_window_migration_override = '${overrideReason(FILE)}';`
    );
    const open = sent.indexOf('DO $ca_install_window_open$');
    const body = sent.indexOf('ALTER TABLE public.clubs');
    expect(begin).toBe(0);
    expect(reason).toBeGreaterThan(begin);
    expect(sent).toContain("SET LOCAL lock_timeout = '1000ms';");
    expect(sent).toContain("SET LOCAL statement_timeout = '5000ms';");
    expect(open).toBeGreaterThan(reason);
    expect(body).toBeGreaterThan(open);
    expect(overrideReason(FILE)).toContain('daily-maintenance window install of ' + FILE);
    expect(overrideReason(FILE)).not.toMatch(/^(on|off|true|false|t|f|yes|no|y|n|1|0)$/i);
  });

  it('asserts the budget and the thaw reserve after the history row, right before COMMIT', () => {
    const history = sent.indexOf('INSERT INTO supabase_migrations.schema_migrations');
    const close = sent.indexOf('DO $ca_install_window_close$');
    expect(close).toBeGreaterThan(history);
    expect(sent.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sent.match(/COMMIT;/g)).toHaveLength(1);
    expect(sent).toContain(
      `IF clock_timestamp() - transaction_timestamp() > make_interval(secs => ${TRANSACTION_BUDGET_SECONDS})`
    );
    expect(sent).toContain(windowOpenPredicate(COMMIT_RESERVE_SECONDS));
    expect(sent).toContain(windowOpenPredicate(START_RESERVE_SECONDS));
  });

  it('defines "open" as the daily break counting down inside a confirmed freeze', () => {
    const p = windowOpenPredicate(START_RESERVE_SECONDS);
    expect(p).toContain('public.fn_platform_frozen()');
    expect(p).toContain("b.phase = 'counting_down'");
    expect(p).toContain('b.enforce_freeze');
    expect(p).toContain('b.break_ends_at - clock_timestamp() >= make_interval(secs => 150)');
    expect(p).toContain("AT TIME ZONE 'America/Chicago')::time >= time '03:55'");
    // The engine starts its thaw 90 s before break_ends_at; a commit never
    // lands inside it.
    expect(COMMIT_RESERVE_SECONDS).toBeGreaterThan(90 + TRANSACTION_BUDGET_SECONDS);
    expect(START_RESERVE_SECONDS).toBeGreaterThan(COMMIT_RESERVE_SECONDS);
  });

  it('finds 04:00 America/Chicago on both sides of DST', () => {
    const summer = dailyWindows(Date.parse('2026-07-01T12:00:00Z')).map((w) =>
      new Date(w.startsAt).toISOString()
    );
    expect(summer).toContain('2026-07-01T09:00:00.000Z');
    const winter = dailyWindows(Date.parse('2026-12-01T12:00:00Z')).map((w) =>
      new Date(w.startsAt).toISOString()
    );
    expect(winter).toContain('2026-12-01T10:00:00.000Z');
    // A 03:30 run serves the 04:00 window; a run after 04:02:30 serves none
    // that day (nothing can be admitted with the start reserve left).
    expect(windowToServe(Date.parse('2026-10-22T08:30:00Z'))?.startsAt).toBe(
      Date.parse('2026-10-22T09:00:00Z')
    );
    expect(windowToServe(Date.parse('2026-10-22T09:02:31Z'))).toBeNull();
  });
});

describe('the ordinary applier refuses it; only the window route installs it', () => {
  it('refuses a declared file as QUEUED unless the window route sends it', () => {
    const at = applier.indexOf('if (windowMigration && !MAINTENANCE_WINDOW) {');
    expect(at).toBeGreaterThan(applier.indexOf('if (already.length > 0) {'));
    expect(at).toBeLessThan(applier.indexOf('async function refusalNow'));
    // The refusal block ends where the send begins: the "[apply] <file>" line.
    const block = applier.slice(at, applier.indexOf('console.log(`[apply] ${file}`);', at));
    expect(block).toContain('refused(');
    expect(block).toContain('It is QUEUED, not lost');
  });

  it('skips the :50-:03 refusal only on the window route, which asks the database instead', () => {
    expect(applier).toContain('if (!MAINTENANCE_WINDOW && (minute >= 50 || minute <= 3)) {');
    expect(applier).toMatch(
      /state = \(\s*await client.query\(ownerWindow \? ownerWindowState\(ownerWindow, 150\) : WINDOW_STATE_QUERY\)\s*\).rows\[0\];/
    );
    expect(applier).toContain('refused(\n        `the daily maintenance window is not open');
    expect(applier).toContain(
      'if (MAINTENANCE_WINDOW) admittedSQL = windowTransactionSQL(file, atomicSQL, ownerWindow);'
    );
    expect(applier).toContain('the window route installs only declared files');
  });

  it('the installer sends each queued file once and stops at the first refusal', () => {
    const loop = installer.slice(installer.indexOf('for (const f of queued) {\n  const started'));
    expect(loop.match(/spawnSync\(/g)).toHaveLength(1);
    expect(loop).toContain("'--maintenance-window'");
    expect(loop).toContain('if (run.status === 1)');
    expect(loop).toContain('Not retried.');
    expect(installer).not.toMatch(/\bretry\s*\(/i);
    // One bounded wait for one window, ending at the last admissible start.
    expect(installer).toContain('while (Date.now() < lastAdmit) {');
    expect(installer).toContain('const lastAdmit = window.endsAt - START_RESERVE_SECONDS * 1000;');
    expect(installer).toContain('BREAK NEVER OPENED');
    expect(installer).toContain('REFUSED before waiting');
  });
});

describe('the route runs on the daily schedule that already exists', () => {
  const stageText = read('.github/workflows/stage-engine-release.yml');
  const stage = parse(stageText);
  const job = stage.jobs['window-migrations'];

  it('runs on daily preparation or an explicit expiring owner migration window', () => {
    expect(job.needs).toBe('detect');
    expect(job.if).toContain("needs.detect.result == 'success'");
    expect(job.if).toContain("needs.detect.outputs.admission_allowed == 'true'");
    expect(job.if).toContain(
      "github.event_name == 'schedule' || needs.detect.outputs.owner_window_id != ''"
    );
    expect(stage.on.schedule).toEqual([{ cron: '30 8 * * *' }, { cron: '30 9 * * *' }]);
    expect(job.permissions).toEqual({ contents: 'read' });
    expect(job.concurrency['cancel-in-progress']).toBe(false);
    const run = job.steps.map((s: { run?: string }) => s.run ?? '').join('\n');
    expect(run).toContain('node scripts/ci/install-window-migrations.mjs');
    expect(run).toContain('--ssl-root-cert scripts/ci/certificates/supabase-prod-ca-2021.crt');
    expect(run).not.toMatch(/dispatches|event_type|ssh|systemctl/);
    // It is declared before the signal job, outside the slice that
    // tests/the-deploy-can-always-ship.law.test.ts keeps credential-free.
    expect(stageText.indexOf('\n  window-migrations:')).toBeLessThan(
      stageText.indexOf('\n  signal:')
    );
  });

  it('is qualified natively on every pull request that touches it', () => {
    const wf = parse(read('.github/workflows/maintenance-window-migrations.yml'));
    expect(wf.on.pull_request.paths).toContain('scripts/ci/maintenance-window-migrations.mjs');
    expect(wf.on.pull_request.paths).toContain('scripts/ci/apply-recorded-migration.mjs');
    const run = wf.jobs.qualify.steps.map((s: { run?: string }) => s.run ?? '').join('\n');
    expect(run).toContain('bash scripts/ci/test-maintenance-window-migrations.sh');
    expect(run).toContain('postgresql-17');
  });

  it('a queued window migration is reported as queued, not as missing, for a week', () => {
    const live = read('scripts/ci/check-migrations-are-live.mjs');
    expect(live).toContain('declaresMaintenanceWindow(m.sql)');
    expect(live).toContain('const WINDOW_QUEUE_GRACE_HOURS = 7 * 24;');
  });

  it('every declared migration on main passes the window rules', () => {
    const dir = resolve(root, 'supabase/migrations');
    for (const f of readdirSync(dir).filter((n) => /^\d{14}_[a-z0-9_]+\.sql$/.test(n))) {
      const sql = readFileSync(resolve(dir, f), 'utf8');
      if (!/@install-window/.test(sql)) continue;
      expect(() => validateWindowMigration(f, sql, { preamble: [] }), f).not.toThrow();
    }
  });
});

describe('a later explicit owner exception preserves freeze and transaction safeguards', () => {
  const at = Date.now();
  const w = {
    id: 'horse-test',
    contains: 'a'.repeat(40),
    ownerOrder: "Dan: publish this upgrade now, don't wait",
    notBefore: new Date(at - 60_000).toISOString(),
    notAfter: new Date(at + 3600000).toISOString(),
    migrations: [FILE],
  };
  it('admits only named files in a bounded currently valid owner window', () => {
    expect(validateOwnerMigrationWindow(w, FILE, at)).toEqual(w);
    expect(() => validateOwnerMigrationWindow(w, '20991231000002_other.sql', at)).toThrow();
    expect(() => validateOwnerMigrationWindow(w, FILE, at + 3600000)).toThrow();
    expect(() =>
      validateOwnerMigrationWindow(
        { ...w, notAfter: new Date(at + 7 * 3600000).toISOString() },
        FILE,
        at
      )
    ).toThrow();
    expect(() => validateOwnerMigrationWindow({ ...w, ownerOrder: '' }, FILE, at)).toThrow();
  });
  it('requires owned recovery, actual freeze and unchanged opening/closing reserves', () => {
    const sql = windowTransactionSQL(FILE, 'BEGIN; SELECT 1; COMMIT;', w);
    expect(sql).toContain(ownerWindowPredicate(150, w));
    expect(sql).toContain(ownerWindowPredicate(100, w));
    expect(sql).toContain("b.reason = 'Deployment Recovery'");
    expect(sql).toContain('b.ownership_token IS NOT NULL');
    expect(sql).toContain('public.fn_platform_frozen()');
    expect(sql).toContain('make_interval(secs => 8)');
    expect(sql).toContain("don''t wait");
  });
});

describe('a superseded window migration is never queued', () => {
  // Without DATABASE_URL the installer stops right after building its queue:
  // exit 0 "NOTHING QUEUED" when every declared file is superseded, exit 3
  // "DATABASE_URL is not set" when something is still queued.
  const runInstaller = (cwd: string) => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    delete env.GITHUB_STEP_SUMMARY;
    return spawnSync(
      process.execPath,
      [resolve(root, 'scripts/ci/install-window-migrations.mjs')],
      { cwd, env, encoding: 'utf8' }
    );
  };
  const tree = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'window-superseded-'));
    mkdirSync(join(dir, 'supabase', 'migrations'), { recursive: true });
    for (const [name, sql] of Object.entries(files))
      writeFileSync(join(dir, 'supabase', 'migrations', name), sql);
    return dir;
  };
  const SUCCESSOR = '20991231000010_window_fixture_successor.sql';

  it('skips a declared file whose SUPERSEDED BY names a file in this tree', () => {
    const run = runInstaller(
      tree({
        [FILE]: `-- SUPERSEDED BY 20991231000010\n${fixture}`,
        [SUCCESSOR]: 'BEGIN;\nSELECT 1;\nCOMMIT;\n',
      })
    );
    expect(run.stdout).toContain(`skipped \`${FILE}\`: SUPERSEDED BY 20991231000010`);
    expect(run.stdout).toContain('NOTHING QUEUED');
    expect(run.status).toBe(0);
  });

  it('still queues a file whose SUPERSEDED BY names no file in this tree', () => {
    const run = runInstaller(tree({ [FILE]: `-- SUPERSEDED BY 20991231000010\n${fixture}` }));
    expect(run.stdout).not.toContain('skipped');
    expect(run.stdout).toContain('DATABASE_URL is not set');
    expect(run.status).toBe(3);
  });

  it('does not queue 20261024020328, superseded by 20261024193818', () => {
    const name = '20261024020328_agents_can_watch_every_live_downline_table.sql';
    const sql = read(`supabase/migrations/${name}`);
    expect(sql.split('\n')[0]).toBe('-- SUPERSEDED BY 20261024193818');
    expect(
      readdirSync(resolve(root, 'supabase/migrations')).some((f) => f.startsWith('20261024193818_'))
    ).toBe(true);
    const run = runInstaller(root);
    expect(run.stdout).toContain(`skipped \`${name}\`: SUPERSEDED BY 20261024193818`);
  });
});

// A consumed engine anchor must not strand a separately owed database file.
describe('explicit database-only owner-window continuation', () => {
  it('uses the same serialized installer while skipping every engine admission', () => {
    const workflow = parse(read('.github/workflows/stage-engine-release.yml'));
    expect(workflow.on.workflow_dispatch.inputs.owner_window_id.required).toBe(true);
    expect(workflow.jobs.detect.if).toBe("github.event_name != 'workflow_dispatch'");
    expect(workflow.jobs.signal.needs).toBe('detect');
    const job = workflow.jobs['window-migrations'];
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(job.if).toContain('always()');
    expect(job.concurrency.group).toBe('daily-maintenance-window-migrations');
    const install = job.steps.find(
      (step: { env?: { OWNER_WINDOW_ID?: string } }) => step.env?.OWNER_WINDOW_ID
    );
    expect(install.env.OWNER_WINDOW_ID).toBe(
      '${{ inputs.owner_window_id || needs.detect.outputs.owner_window_id }}'
    );
    expect(install.run).toContain('node scripts/ci/install-window-migrations.mjs');
    expect(install.run).toContain('--owner-window');
    expect(install.run).not.toMatch(/deploy-club-arena-engine|ssh |request_recovery/);
  });
});

describe('database-only windows cannot displace engine admission', () => {
  it('keeps the one-off continuation clear of the daily announcement and installed files', () => {
    const doc = JSON.parse(read('server/release/owner-maintenance-windows.json'));
    const id = '2026-10-27-lightning-dwell-database-continuation';
    const windows = doc.databaseWindows.filter((w: { id: string }) => w.id === id);
    expect(windows).toHaveLength(1);
    expect(doc.windows.some((w: { id: string }) => w.id === id)).toBe(false);
    const window = windows[0];
    expect(window.migrations).toEqual([
      '20261026110858_a_lightning_game_stays_in_its_mode_long_enough_to_play_it.sql',
    ]);
    const end = Date.parse(window.notAfter);
    expect(end - Date.parse(window.notBefore)).toBe(3 * 60 * 60 * 1000);
    expect(Date.parse('2026-10-27T08:58:00Z') - (end - 420000)).toBeGreaterThan(3600000);
  });
  it('keeps its reviewed entry outside both engine consumers', () => {
    const doc = JSON.parse(read('server/release/owner-maintenance-windows.json'));
    const id = '2026-10-26-lightning-dwell-database-only';
    expect(doc.windows.some((w: { id: string }) => w.id === id)).toBe(false);
    expect(doc.databaseWindows.filter((w: { id: string }) => w.id === id)).toHaveLength(1);
    expect(read('scripts/ci/owner-window-migration.mjs')).toContain(
      '...(doc.databaseWindows ?? [])'
    );
    expect(read('.github/workflows/stage-engine-release.yml')).not.toContain('databaseWindows');
    expect(read('server/scripts/engine-release-transaction.sh')).not.toContain('databaseWindows');
  });
});

describe('one explicit database-only certified maintenance operation', () => {
  it('runs real Git and seal-journal refusal/replay qualification', () => {
    const r = spawnSync(
      'python3',
      ['-B', 'tests/operations/database-maintenance-reservation.test.py'],
      { encoding: 'utf8', timeout: 60000 }
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }, 65000);
  it('retains the original lock, loopback request and thaw instead of replacing the engine', () => {
    const code = read('scripts/ci/database-maintenance-window.py');
    expect(code).toContain('/var/lock/club-arena-engine-up.lock');
    expect(code).toContain('fcntl.LOCK_EX | fcntl.LOCK_NB');
    expect(code).toContain('*.awaiting-certificate');
    expect(code).toContain("body:JSON.stringify({announcedAt,cause:'urgent'})");
    expect(code).toContain('>= 285000');
    expect(code).toContain("m.get('durableConfirmed') is True");
    expect(code).toContain("waves.get('finishedAt', 0) >= end");
    expect(code).not.toMatch(
      /docker.*(?:restart|stop|start|run)|systemctl|fn_thaw_platform|force-desired/
    );
  });
});
