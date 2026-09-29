/**
 * THE DIAMOND SQL ACCEPTANCE RUNS IN CI, AND THE LIST CANNOT ROT (2026-09-19).
 *
 * tests/sql/run-*diamond*.py certify the Diamond Arena's money doors on an
 * isolated PostgreSQL 17. They were written for the owner's Mac and ran only
 * when somebody remembered them. This pins the wiring that makes them a gate:
 * the wrapper names every runner on disk, the accounting job runs the wrapper
 * unguarded, a change to any runner or fixture routes to that job, and the
 * runners still refuse to be pointed anywhere but their fixed local socket -
 * whether that is the wrapper's shared one or a private cluster the runner
 * creates, owns and destroys.
 *
 * THE LIST ROTTED THE DAY AFTER IT WAS WRITTEN. Three runners landed on main
 * from three other pull requests and each moved one place instead of three, so
 * the counts and the explicit names below are deliberately literal. Adding a
 * runner moves the wrapper's RUNNERS, the names here and the counts here, in
 * one commit. Deleting the list or deriving the counts so they can never
 * disagree is the failure mode CLAUDE.md sections 8 and 10.11 forbid.
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
  privateClusterRunnersInWrapper,
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

/* THE TWENTY-THREE RUNNERS, NAMED, AND COUNTED IN WORDS.

   Every other assertion here derives the population from the directory, which
   is right and is not enough on its own: a directory read agrees with itself
   whatever is in it, so a runner deleted together with its wrapper entry would
   leave every derived check green. These literals are what such a deletion has
   to argue with, and they are why a stale list is a red build rather than a
   money door nobody executes. */
const EVERY_DIAMOND_RUNNER = [
  'run-diamond-accepted-hand.py',
  'run-diamond-bomb-pot.py',
  'run-diamond-cash-admission.py',
  'run-diamond-cash-custody.py',
  'run-diamond-club-commerce-admission.py',
  'run-diamond-club-commerce-completion.py',
  'run-diamond-club-commerce-earnings.py',
  'run-diamond-club-commerce-metrics.py',
  'run-diamond-club-commerce-recovery.py',
  'run-diamond-club-commerce-refunds.py',
  'run-diamond-club-commerce.py',
  'run-diamond-controlled-play.py',
  'run-diamond-incident-resolution.py',
  'run-diamond-plain-cash-rule.py',
  'run-diamond-run-it-twice.py',
  'run-diamond-stats-asset-dimension.py',
  'run-diamond-straddle.py',
  'run-diamond-top-up.py',
  'run-diamond-tournament-doors.py',
  'run-diamond-tournament-lifecycle.py',
  'run-diamond-transfer-door-and-dr16.py',
  'run-diamond-wallet-transfer.py',
  'run-poker-diamond-custody.py',
];
/* The ten that stand up a cluster of their own. Declared in the wrapper and
   repeated here, so the split cannot move in one file alone. */
const A_PRIVATE_CLUSTER = [
  'run-diamond-club-commerce-admission.py',
  'run-diamond-club-commerce-completion.py',
  'run-diamond-club-commerce-earnings.py',
  'run-diamond-club-commerce-metrics.py',
  'run-diamond-club-commerce-recovery.py',
  'run-diamond-club-commerce-refunds.py',
  'run-diamond-club-commerce.py',
  'run-diamond-stats-asset-dimension.py',
  'run-diamond-tournament-doors.py',
  'run-diamond-tournament-lifecycle.py',
];
const HOW_MANY_RUNNERS = 23;
const HOW_MANY_ON_A_PRIVATE_CLUSTER = 10;
const HOW_MANY_ON_THE_WRAPPER_CLUSTER = 13;
/* No environment variable but PG_BIN may choose a runner's server. PG17_BINDIR
   is the estate's other name for a bin directory, and two variables naming one
   thing is how the two drift apart: a runner that reads it is refused here. */
const NOT_FROM_THE_ENVIRONMENT = [
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'DATABASE_URL',
  'SUPABASE',
  'PG17_BINDIR',
];

describe('every Diamond SQL runner is run by the accounting job', () => {
  it('finds no drift between tests/sql, the wrapper and ci.yml', () => {
    expect(findDiamondRunnerProblems(root)).toEqual([]);
  });

  it('is the seventeen runners this file names, counted the same two ways', () => {
    expect(runnersOnDisk(root)).toEqual(EVERY_DIAMOND_RUNNER);
    expect(EVERY_DIAMOND_RUNNER).toHaveLength(HOW_MANY_RUNNERS);
    expect(runnersOnDisk(root)).toHaveLength(HOW_MANY_RUNNERS);
    expect(HOW_MANY_ON_A_PRIVATE_CLUSTER + HOW_MANY_ON_THE_WRAPPER_CLUSTER).toBe(HOW_MANY_RUNNERS);
  });

  it('names the seventeen runners and the arena access script explicitly', () => {
    const listed = runnersListedInWrapper(wrapper);
    expect(listed).toEqual(expect.arrayContaining(runnersOnDisk(root)));
    expect(listed).toHaveLength(runnersOnDisk(root).length);
    expect(listed).toHaveLength(HOW_MANY_RUNNERS);
    expect(listed!.slice().sort()).toEqual(EVERY_DIAMOND_RUNNER);
    expect(listed).toContain('run-diamond-controlled-play.py');
    expect(listed).toContain('run-diamond-wallet-transfer.py');
    expect(listed).toContain('run-poker-diamond-custody.py');
    expect(listed).toContain('run-diamond-tournament-doors.py');
    expect(listed).toContain('run-diamond-tournament-lifecycle.py');
    expect(listed).toContain('run-diamond-stats-asset-dimension.py');
    expect(listed).toContain('run-diamond-incident-resolution.py');
    expect(listed).toContain('run-diamond-transfer-door-and-dr16.py');
    expect(sqlScriptsListedInWrapper(wrapper)).toEqual(['poker-arena-access.sql']);
  });

  it('declares, in the wrapper, which runners build a cluster of their own', () => {
    /* A declaration rather than a guess: it decides which of the two full
       contracts below a runner is held to, and the wrapper uses it to skip
       starting a shared cluster no selected run needs. */
    expect(privateClusterRunnersInWrapper(wrapper)).toEqual(A_PRIVATE_CLUSTER);
    expect(A_PRIVATE_CLUSTER).toHaveLength(HOW_MANY_ON_A_PRIVATE_CLUSTER);
    for (const name of A_PRIVATE_CLUSTER) expect(runnersListedInWrapper(wrapper)).toContain(name);
    expect(wrapper).toContain('name not in PRIVATE_CLUSTER_RUNNERS for name, _ in selected');
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
       haystack is the runner plus every fixture script it can include. Four
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
    expect(step.if).toMatch(/^matrix\.shard == [1-4]$/); // its accounting shard, nothing else
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
    /* The fixtures the incident-resolution and transfer-door runners load.
       The `diamond-` probe-lane prefix admits them today; naming them here is
       what fails if that prefix is ever narrowed underneath them. */
    'tests/sql/diamond-incident-resolution-fixture.sql',
    'tests/sql/diamond-transfer-door-fixture.sql',
    /* Every file the two tournament runners load out of tests/sql. The runner is
       what the accounting job executes, so a change to what it loads has to
       reach the same job or the acceptance certifies bytes nobody reviewed. */
    'tests/sql/diamond-tournament-fixture-schema.sql',
    'tests/sql/diamond-tournament-doors-captured.sql',
    'tests/sql/diamond-tournament-doors-captured.manifest.json',
    'tests/sql/diamond-tournament-lifecycle-schema.sql',
    'tests/sql/diamond-tournament-lifecycle-doors.sql',
    'tests/sql/diamond-tournament-lifecycle-doors.manifest.json',
    'tests/sql/diamond-tournament-lifecycle-seed.sql',
    'tests/sql/diamond-tournament-lifecycle-cases.sql',
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

/* The socket and port the wrapper's own cluster answers on, read OUT of the
   wrapper rather than repeated here. One source of truth, and it keeps a
   machine-local absolute path out of a test file, which
   tests/tests-are-portable.test.ts refuses on sight and is right to. */
const socketDir = /^SOCKET_DIR = '([^']+)'$/m.exec(wrapper)?.[1];
const socketPort = /^PORT = '([0-9]+)'$/m.exec(wrapper)?.[1];

/* TWO SHAPES OF RUNNER, AND EVERY RUNNER IS EXACTLY ONE OF THEM.
 *
 * Thirteen are hard-wired to the wrapper's socket and port. Four stand up a
 * private cluster of their own, because they load the estate's historical
 * schema base and pin the installed doors against it: they need a cluster
 * nothing else has written to, and two postmasters cannot own one socket and
 * one port, so they cannot be moved onto the shared one.
 *
 * NEITHER CONTRACT BELOW IS A RELAXATION OF THE OTHER. Each is stated in full;
 * a private-cluster runner is FORBIDDEN from naming the shared socket or port,
 * and the two lists are required to partition the directory. So a runner can
 * neither escape a check nor be relabelled into a weaker one, and the property
 * both contracts exist for - that no environment variable can point a runner at
 * a real database - is held either way. */
const onAPrivateCluster = privateClusterRunnersInWrapper(wrapper) ?? [];
const onTheWrapperCluster = runnersOnDisk(root).filter((n) => !onAPrivateCluster.includes(n));

describe('the runners stay on their fixed local socket', () => {
  it('the wrapper states one socket and one port, and both are readable here', () => {
    expect(socketDir, 'the wrapper no longer states SOCKET_DIR').toBeTruthy();
    expect(socketPort, 'the wrapper no longer states PORT').toBe('55472');
    /* A relative or empty socket directory would be a different cluster per
       working directory, which is how two runners end up on two databases. */
    expect(socketDir!.startsWith('/')).toBe(true);
    expect(socketDir).toContain('codex-diamond-phase2-pg');
  });

  it('the two contracts partition the runners on disk, with nothing left over', () => {
    expect(onAPrivateCluster).toEqual(A_PRIVATE_CLUSTER);
    expect(onAPrivateCluster).toHaveLength(HOW_MANY_ON_A_PRIVATE_CLUSTER);
    expect(onTheWrapperCluster).toHaveLength(HOW_MANY_ON_THE_WRAPPER_CLUSTER);
    expect([...onTheWrapperCluster, ...onAPrivateCluster].sort()).toEqual(runnersOnDisk(root));
    for (const name of onAPrivateCluster) expect(onTheWrapperCluster).not.toContain(name);
  });

  it.each(onTheWrapperCluster)(
    '%s honours PG_BIN and nothing else from the environment',
    (name) => {
      const source = read(`tests/sql/${name}`);
      expect(source).toContain("os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')");
      expect(source, `${name} is not on the wrapper's socket`).toContain(socketDir!);
      expect(source, `${name} is not on the wrapper's port`).toContain(socketPort!);
      /* No other environment read may choose the server: the socket path and
       port are the property that keeps a runner off production. */
      for (const key of NOT_FROM_THE_ENVIRONMENT)
        expect(source, `${name} reads ${key}`).not.toContain(key);
      expect(source).not.toContain('/opt/homebrew/opt/postgresql@17/bin/psql');
    }
  );

  it.each(onAPrivateCluster)(
    '%s honours PG_BIN and nothing else from the environment, on a cluster it owns',
    (name) => {
      const source = read(`tests/sql/${name}`);
      expect(source).toContain("os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')");
      /* Same forbidden list as the shared contract: PG_BIN names the binaries,
         and nothing in the environment names a server. */
      for (const key of NOT_FROM_THE_ENVIRONMENT)
        expect(source, `${name} reads ${key}`).not.toContain(key);
      expect(source).not.toContain('/opt/homebrew/opt/postgresql@17/bin/psql');
      /* The cluster is one this runner creates and destroys, in a directory it
         makes for itself. Naming the wrapper's socket or port would put it on a
         cluster thirteen other runners have written to, and would also be the way
         a runner slipped from this contract into the other one. */
      expect(source, `${name} must not name the wrapper's socket`).not.toContain(socketDir!);
      expect(source, `${name} must not name the wrapper's port`).not.toContain(socketPort!);
      expect(source, `${name} does not create its own socket directory`).toContain(
        'tempfile.mkdtemp'
      );
      /* Socket only. Nothing may reach this cluster over the network either. */
      expect(source).toContain('listen_addresses=');
      expect(source).not.toMatch(/listen_addresses=['"]?[a-z0-9*]/);
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
