/**
 * THE DIAMOND SQL ACCEPTANCE RUNS IN CI, AND THE LIST CANNOT ROT (2026-09-19).
 *
 * tests/sql/run-*diamond*.py certify the Diamond Arena's money doors on an
 * isolated PostgreSQL 17. They were written for the owner's Mac and ran only
 * when somebody remembered them. This pins the wiring that makes them a gate:
 * the wrapper names every runner on disk, the accounting job runs the wrapper
 * unguarded, a change to any runner or fixture routes to that job, and the
 * runners still refuse to be pointed anywhere but their fixed local socket.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';
import {
  accountingJobText,
  findDiamondRunnerProblems,
  jobSteps,
  runnerProofsInWrapper,
  runnersListedInWrapper,
  runnersOnDisk,
  sqlScriptsListedInWrapper,
  WRAPPER,
} from '../../scripts/ci/check-diamond-runners-listed.mjs';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const ci = parse(read('.github/workflows/ci.yml'));
const wrapper = read(WRAPPER);

describe('every Diamond SQL runner is run by the accounting job', () => {
  it('finds no drift between tests/sql, the wrapper and ci.yml', () => {
    expect(findDiamondRunnerProblems(root)).toEqual([]);
  });

  it('names the eleven runners and the arena access script explicitly', () => {
    const listed = runnersListedInWrapper(wrapper);
    expect(listed).toEqual(expect.arrayContaining(runnersOnDisk(root)));
    expect(listed).toHaveLength(runnersOnDisk(root).length);
    expect(listed).toContain('run-diamond-controlled-play.py');
    expect(listed).toContain('run-diamond-wallet-transfer.py');
    expect(listed).toContain('run-poker-diamond-custody.py');
    expect(sqlScriptsListedInWrapper(wrapper)).toEqual(['poker-arena-access.sql']);
  });

  it('reports a runner the wrapper does not name', () => {
    /* The check reads the wrapper's RUNNERS block. Prove the parser sees an
       addition by feeding it a block with one entry removed. */
    const entry = /^ {4}\('run-diamond-top-up\.py',[\s\S]*?\),\n/m.exec(wrapper);
    expect(entry, 'the top-up entry is no longer shaped as expected').not.toBeNull();
    const fewer = wrapper.replace(entry![0], '');
    expect(runnersListedInWrapper(fewer)).not.toContain('run-diamond-top-up.py');
    expect(runnersListedInWrapper(fewer)).toHaveLength(runnersOnDisk(root).length - 1);
  });

  it('gives every runner a proof line the wrapper requires in its output', () => {
    /* Exit 0 is not proof: a runner whose fixture loaded nothing exits 0 too.
       Each entry names the runner's own terminal print, and the wrapper fails
       the step when that line is absent. */
    const proofs = runnerProofsInWrapper(wrapper);
    expect(proofs).toHaveLength(runnersOnDisk(root).length);
    /* A proof has to be text the fixture suite really emits, so an invented
       string cannot sit here looking like evidence. Some runners print their
       own closing line and some reach it through an included .sql file, so the
       haystack is the runner plus every fixture script it can include. Two
       runners print a counted total: the count is pinned here and the wording
       is what must exist in the source. */
    const fixtureText = readdirSync(join(root, 'tests/sql'))
      .filter((name) => name.endsWith('.sql'))
      .map((name) => read(`tests/sql/${name}`))
      .join('\n');
    for (const [name, proof] of proofs!) {
      expect(proof.trim(), `${name} has no proof line`).not.toBe('');
      const printed = proof.replace(/^\d+/, '');
      expect(
        read(`tests/sql/${name}`).includes(printed) || fixtureText.includes(printed),
        `${name} never prints "${printed}"`
      ).toBe(true);
    }
    expect(wrapper).toContain('proved = proof in result.stdout or proof in result.stderr');
    expect(wrapper).toContain('if result.returncode or not proved:');
  });

  it('runs the wrapper in the accounting job, once, without a bypass, on PostgreSQL 17', () => {
    const job = ci.jobs.accounting_postgres;
    const steps = job.steps.filter((s: { id?: string }) => s.id === 'diamond_sql_acceptance');
    expect(steps).toHaveLength(1);
    const step = steps[0];
    expect(step.if).toBeUndefined();
    expect(step['continue-on-error']).toBeUndefined();
    expect(step.env.PG_BIN).toBe('/usr/lib/postgresql/17/bin');
    expect(step['timeout-minutes']).toBeGreaterThanOrEqual(10);
    expect(step.run.trim()).toBe(
      'python3 scripts/ci/run-diamond-sql-acceptance.py --evidence artifacts/diamond-sql-acceptance'
    );
    /* The static list check runs in the same job before the runners do, so a
       new runner that is not listed fails the job the runners belong to. */
    const check = job.steps.find(
      (s: { run?: string }) => s.run?.trim() === 'node scripts/ci/check-diamond-runners-listed.mjs'
    );
    expect(check).toBeDefined();
    expect(job.steps.indexOf(check)).toBeLessThan(job.steps.indexOf(step));
    /* The server install precedes it: the controlled-play runner drives the
       real HandController through server/node_modules/.bin/vitest. */
    const install = job.steps.find(
      (s: { name?: string }) => s.name === 'Install server test dependencies'
    );
    expect(job.steps.indexOf(install)).toBeLessThan(job.steps.indexOf(step));
    /* And its evidence is kept whether it passed or failed. */
    const retain = job.steps.find(
      (s: { name?: string }) => s.name === 'Retain Diamond SQL acceptance evidence'
    );
    expect(retain.if).toContain('steps.diamond_sql_acceptance.outcome');
    expect(retain.with.path).toBe('artifacts/diamond-sql-acceptance/');
    expect(retain.with['if-no-files-found']).toBe('error');
  });

  it('the raw-text step reader agrees with the parsed workflow', () => {
    const steps = jobSteps(accountingJobText(read('.github/workflows/ci.yml')));
    expect(steps.filter((s) => s.includes(WRAPPER))).toHaveLength(1);
    expect(steps.length).toBe(ci.jobs.accounting_postgres.steps.length);
  });
});

describe('a Diamond acceptance input routes to the accounting job', () => {
  it.each([
    ...runnersOnDisk(root).map((name) => `tests/sql/${name}`),
    ...readdirSync(join(root, 'tests/sql'))
      .filter((name) => /^poker-diamond-.*\.sql$/.test(name))
      .map((name) => `tests/sql/${name}`),
    'tests/sql/poker-arena-access.sql',
    'tests/sql/diamond-controlled-play-driver.ts',
    'tests/sql/diamond-session-fixture.sql',
    'tests/sql/diamond-transfer-cap-fixture.sql',
    'scripts/ci/run-diamond-sql-acceptance.py',
    'scripts/ci/check-diamond-runners-listed.mjs',
  ])('%s selects the PostgreSQL accounting job', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });

  it('does not select it for a lookalike note', () => {
    expect(classifyChangedPaths(['tests/sql/run-diamond-top-up.py.md']).server).toBe(false);
    expect(classifyChangedPaths(['docs/tests/sql/run-diamond-top-up.py']).server).toBe(false);
  });
});

/* The socket and port every runner is wired to, read OUT of the wrapper rather
   than repeated here. One source of truth, and it keeps a machine-local
   absolute path out of a test file, which tests/tests-are-portable.test.ts
   refuses on sight and is right to. */
const socketDir = /^SOCKET_DIR = '([^']+)'$/m.exec(wrapper)?.[1];
const socketPort = /^PORT = '([0-9]+)'$/m.exec(wrapper)?.[1];

describe('the runners stay on their fixed local socket', () => {
  it('the wrapper states one socket and one port, and both are readable here', () => {
    expect(socketDir, 'the wrapper no longer states SOCKET_DIR').toBeTruthy();
    expect(socketPort, 'the wrapper no longer states PORT').toBe('55472');
    /* A relative or empty socket directory would be a different cluster per
       working directory, which is how two runners end up on two databases. */
    expect(socketDir!.startsWith('/')).toBe(true);
    expect(socketDir).toContain('codex-diamond-phase2-pg');
  });

  it.each(runnersOnDisk(root))(
    '%s honours PG_BIN and nothing else from the environment',
    (name) => {
      const source = read(`tests/sql/${name}`);
      expect(source).toContain("os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')");
      expect(source, `${name} is not on the wrapper's socket`).toContain(socketDir!);
      expect(source, `${name} is not on the wrapper's port`).toContain(socketPort!);
      /* No other environment read may choose the server: the socket path and
       port are the property that keeps a runner off production. */
      for (const key of ['PGHOST', 'PGPORT', 'PGDATABASE', 'DATABASE_URL', 'SUPABASE'])
        expect(source, `${name} reads ${key}`).not.toContain(key);
      expect(source).not.toContain('/opt/homebrew/opt/postgresql@17/bin/psql');
    }
  );

  it('the wrapper builds a socket-only cluster and never a TCP listener', () => {
    expect(wrapper).toContain('listen_addresses=');
    expect(wrapper).not.toMatch(/listen_addresses=['"]?[a-z0-9*]/);
    /* Nothing may reach this cluster over the network, so no runner and no
       environment variable can be pointed at a real database by mistake. */
    expect(wrapper).toContain("'-h', SOCKET_DIR");
  });
});
