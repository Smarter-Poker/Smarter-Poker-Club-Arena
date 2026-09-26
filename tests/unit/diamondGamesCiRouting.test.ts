import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

const ROOT = join(__dirname, '..', '..');
const FLAGS = ['src', 'server', 'tests', 'phase4', 'fixture'] as const;
type Flag = (typeof FLAGS)[number];

/**
 * Enumerating a directory is the point, so an EMPTY read must fail loudly.
 * `it.each([])` passes vacuously, which is the exact failure CLAUDE.md 10.86
 * rule 2 is about: an unreadable answer coerced into an empty one reads as
 * good news. Every listing below goes through here first.
 */
function listing(dir: string, keep: (name: string) => boolean): string[] {
  const names = readdirSync(join(ROOT, dir)).filter(keep).sort();
  if (names.length === 0) throw new Error(`${dir} produced no entries to classify - read it again`);
  return names.map((name) => `${dir}/${name}`);
}

function specsUnderE2E(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.spec.ts')) out.push(path);
    }
  };
  walk('tests/e2e');
  return out.sort();
}

/**
 * A spec bundles a fixture by TEXT, and half of these arrive through
 * `await import('../helpers/...')` inside a test body rather than a top-level
 * import - which is why the omission this file now pins was invisible to
 * every static scan of the specs. Match the text, not the import graph.
 */
function consumingSpecs(helperPath: string): string[] {
  const needle = `helpers/${helperPath.split('/').pop()}`;
  return specsUnderE2E().filter((spec) => readFileSync(join(ROOT, spec), 'utf8').includes(needle));
}

// These paths are inputs to the real CI classifier. Keep their behavioral
// assertions separate from tests that read workflow YAML as an artifact.
describe('Diamond Games retain their financial PostgreSQL qualification', () => {
  it.each([
    'tests/sql/diamond-games-funding-identity.sql',
    'tests/sql/diamond-games-bank-fallback.sql',
    'tests/sql/diamond-plinko-denominations.sql',
    'tests/sql/diamond-crash-clicked-multiplier.sql',
    'tests/sql/diamond-spins-claimed-daily-bonus.sql',
    'tests/fixtures/accounting-delivery/diamond-games/functions.sql',
    'src/services/DiamondBonusService.ts',
    'src/services/DiamondGamesService.ts',
    'src/services/DiamondChoiceService.ts',
    'src/services/diamondBonusRecovery.ts',
    'src/utils/crashReceipt.ts',
    'src/pages/DiamondChoicePage.tsx',
    'src/pages/DiamondCrashPage.tsx',
    'src/pages/DiamondPlinkoPage.tsx',
    'tests/sql/diamond-wheel-funded-awards.sql',
    'tests/sql/diamond-wheel-upgrade-eight.sql',
    'tests/sql/diamond-bonus-minimum-wins.sql',
    'tests/sql/diamond-bonus-replays.sql',
    'supabase/migrations/20260919153418_public_bonus_replay_has_an_explicitly_public_reader.sql',
    'tests/fixtures/accounting-delivery/diamond-games/replay-public-guard-dependencies.sql',
    'tests/sql/diamond-daily-custody.sql',
    'tests/sql/diamond-spins-quiet-ledger-before.sql',
    'tests/sql/diamond-spins-quiet-ledger.sql',
    'tests/sql/diamond-spins-daily-profit-burn.sql',
    'tests/sql/diamond-spins-every-movement-has-a-ledger-row.sql',
    'tests/fixtures/accounting-delivery/diamond-games/quiet-ledger-dependencies.sql',
    'tests/fixtures/accounting-delivery/diamond-games/daily-burn-dependencies.sql',
    'tests/fixtures/accounting-delivery/diamond-games/daily-burn-legacy-seed.sql',
    'tests/fixtures/accounting-delivery/diamond-games/daily-burn-legacy-assert.sql',
    'tests/fixtures/accounting-delivery/diamond-games/daily-custody-concurrency-assert.sql',
    'tests/fixtures/accounting-delivery/diamond-games/replay-social-dependencies.sql',
    'tests/fixtures/accounting-delivery/diamond-games/daily-custody-dependencies.sql',
    'src/services/DiamondReplayService.ts',
    'src/services/DiamondStatementService.ts',
    'tests/fixtures/diamond-spins/wheel-v3-postgres-receipts.json',
    'tests/sql/diamond-wheel-v4-model-and-matrix.sql',
    'tests/sql/diamond-wheel-v4-draw-and-cards.sql',
    'tests/fixtures/diamond-spins/wheel-v4-postgres-receipts.json',
    'tests/unit/wheelV4PostgresContract.test.ts',
    'src/utils/wheelV4Model.ts',
    'tests/unit/wheelUpgradePostgresContract.test.ts',
    'tests/unit/wheelUpgradeReceipts.test.ts',
    'tests/fixtures/diamond-wheel-v2-receipts.json',
    'tests/fixtures/diamond-spins/wheel-earned-postgres-receipts.json',
    'tests/unit/wheelServerReceipts.test.ts',
    'tests/unit/wheelEarnedPostgresContract.test.ts',
    'src/services/DiamondWheelService.ts',
    'src/services/WheelBonusEntryService.ts',
    'src/hooks/useEarnedBonus.ts',
    'src/hooks/useBonusBudget.ts',
    'src/components/games/BonusSetup.tsx',
    'src/utils/bonusGameBudget.ts',
    'src/utils/wheelAward.ts',
    'src/utils/wheelPendingSpin.ts',
    'src/utils/wheelFairness.ts',
    'src/pages/DiamondWheelPage.tsx',
  ])('admits the accounting job for %s', (path) => {
    expect(classifyChangedPaths([path]).server).toBe(true);
    expect(classifyChangedPaths([path]).tests).toBe(true);
  });

  it.each([
    'tests/e2e/css/diamond-games-playfield.spec.ts',
    'tests/e2e/helpers/diamond-games-fixture.mjs',
    'tests/e2e/css/diamond-wheel-reveal.spec.ts',
    'tests/e2e/helpers/diamond-wheel-fixture.mjs',
    'src/components/games/gpuFrameRenderer.ts',
    'src/components/games/sceneKit.ts',
    'src/components/games/ChoiceScene.tsx',
    'src/components/plinko/PlinkoBoard.tsx',
    'src/components/crash/CrashCurve.tsx',
  ])('runs the actual browser fixture when %s changes', (path) => {
    expect(classifyChangedPaths([path]).src).toBe(true);
  });

  it('preserves unrelated UI and documentation classification', () => {
    expect(classifyChangedPaths(['src/components/games/ChoiceScene.tsx']).server).toBe(false);
    expect(classifyChangedPaths(['docs/changelog/example.md']).server).toBe(false);
  });
});

/**
 * MEASURED 2026-09-20, and the reason this suite stopped reading a list.
 *
 * The classifier recognised e2e fixtures through an alternation of hand-typed
 * basenames, `helpers/(?:diamond-games|diamond-wheel)-fixture\.mjs`, and the
 * it.each list above enumerated the same two names - so the gap was unpinned
 * in both directions and both halves agreed with each other while being wrong:
 *
 *   tests/e2e/css/diamond-games-playfield.spec.ts    -> { src: true }   correct
 *   tests/e2e/helpers/diamond-games-fixture.mjs      -> { src: true }   correct
 *   tests/e2e/helpers/diamond-test-fixture.mjs       -> { src: false }  WRONG
 *   tests/e2e/helpers/diamond-wheel-page-fixture.mjs -> { src: false }  WRONG
 *
 * `diamond-test-fixture.mjs` drives 12 of the 13 tests in the playfield spec
 * and `diamond-wheel-page-fixture.mjs` drives the recovery half of the wheel
 * spec, so editing either answered "no browser job needed" about the one job
 * that runs it (CLAUDE.md 10.86 rule 1). Both are loaded by
 * `await import('../helpers/...')` INSIDE a test body, so the specs' top-level
 * imports named neither.
 *
 * These assertions therefore READ THE DIRECTORY. A list is what rotted; a list
 * of one more name would rot the same way the next time somebody splits a
 * fixture out. A fixture added tomorrow is covered without anybody remembering
 * this file exists.
 */
describe('an e2e fixture is routed by the directory it lives in, not by a list of names', () => {
  const helpers = listing('tests/e2e/helpers', (name) => name.endsWith('.mjs'));

  it.each(helpers)('%s admits the browser job that bundles it', (helper) => {
    expect(
      classifyChangedPaths([helper]).src,
      `${helper} is an e2e fixture and must admit the CSS browser job. If the ` +
        `classifier has been re-narrowed to a list of basenames, widen it back ` +
        `to the directory instead of adding this one name.`
    ).toBe(true);
  });

  /**
   * THE OTHER DIRECTION. A fixture must be admitted at least as widely as
   * every spec that bundles it - never less. Superset rather than equality on
   * purpose: a fixture may legitimately reach further than one of its
   * consumers (a shared helper), but it can never withhold a job the spec
   * itself would have run, because that is the defect measured above.
   */
  it.each(helpers)('%s is classified as the specs that consume it are', (helper) => {
    const consumers = consumingSpecs(helper);
    expect(
      consumers.length,
      `${helper} is bundled by no spec under tests/e2e/. Either it is dead and ` +
        `should be deleted, or this scan missed a dynamic import - check before ` +
        `assuming the fixture is unused.`
    ).toBeGreaterThan(0);
    const fixtureFlags = classifyChangedPaths([helper]);
    for (const spec of consumers) {
      const specFlags = classifyChangedPaths([spec]);
      const withheld = FLAGS.filter((flag: Flag) => specFlags[flag] && !fixtureFlags[flag]);
      expect(
        withheld,
        `${helper} is bundled by ${spec}, but changing the fixture withholds ` +
          `job(s) that changing the spec admits. A fixture-only change must run ` +
          `every check its spec would have run.`
      ).toEqual([]);
    }
  });

  /**
   * tests/e2e/css/ is the CSS browser job's own directory - all three specs in
   * it are named in the css-beats-e2e Playwright invocation - and it carried
   * the identical two-name alternation, which had already dropped
   * club-lobby-sticky-selector.spec.ts.
   */
  it.each(listing('tests/e2e/css', (name) => name.endsWith('.spec.ts')))(
    '%s admits the browser job that runs it',
    (spec) => {
      expect(classifyChangedPaths([spec]).src).toBe(true);
    }
  );

  /**
   * The widening stops at the extension, and that is deliberate: a `.md`
   * companion of a fixture is documentation and must not buy a browser job.
   * tests/unit/fixtureNativeCi.test.ts pins the same rule for support/.
   */
  it('does not let a documentation companion of a fixture admit the browser job', () => {
    expect(classifyChangedPaths(['tests/e2e/helpers/diamond-test-fixture.mjs.md']).src).toBe(false);
    expect(classifyChangedPaths(['tests/e2e/css/diamond-games-playfield.spec.ts.md']).src).toBe(
      false
    );
    expect(classifyChangedPaths(['tests/e2e/helpers/README.md']).src).toBe(false);
  });
});

/**
 * THE SAME DEFECT, SWEPT ACROSS THE REST OF THIS RECALIBRATION'S BLAST RADIUS.
 *
 * `scripts/dev/test-accounting-delivery.sh` is step "Diamond games" of the
 * required accounting_postgres job and executes ELEVEN tests/sql/diamond-*.sql
 * probes; the classifier named ten. Measured before the fix:
 *
 *   tests/sql/diamond-one-setting-super-guarantee.sql -> { server: false }
 *
 * so the probe the job runs could be edited, or broken, with the job skipped.
 * The pin reads the runner script rather than a list, so adding a probe to the
 * script without teaching the classifier about it fails HERE, in the same pull
 * request, instead of silently never running.
 */
describe('every diamond SQL probe the accounting job executes admits that job', () => {
  const runner = 'scripts/dev/test-accounting-delivery.sh';
  const script = readFileSync(join(ROOT, runner), 'utf8');
  const executed = [
    ...script.matchAll(/tests\/sql\/([A-Za-z0-9._-]+)\.sql/g),
    ...script.matchAll(/^\s*run_game_probe\s+([A-Za-z0-9._-]+)/gm),
  ]
    .map((match) => `tests/sql/${match[1]}.sql`)
    .filter((path, index, all) => all.indexOf(path) === index)
    .sort();

  it('found the probes the runner actually executes', () => {
    expect(executed.length, `${runner} named no tests/sql probe - read it again`).toBeGreaterThan(
      5
    );
  });

  it.each(executed)('%s admits the accounting job that runs it', (path) => {
    const flags = classifyChangedPaths([path]);
    expect(
      flags.server,
      `${runner} executes ${path} inside accounting_postgres, which is gated on ` +
        `the server flag. A change to this probe must admit the job that runs it.`
    ).toBe(true);
    expect(flags.tests).toBe(true);
  });

  it.each(listing('tests/sql', (name) => name.startsWith('diamond-') && name.endsWith('.sql')))(
    '%s stays inside the diamond probe lane',
    (path) => {
      expect(classifyChangedPaths([path]).server).toBe(true);
    }
  );

  it('keeps unrelated SQL out, and lets the Diamond Arena lane claim its own', () => {
    /* `poker-diamond-*` is still NOT admitted by this lane's `diamond-` prefix,
       and it must not be: those probes belong to the Diamond ARENA acceptance,
       a different lane in the same file. This read `false` until 2026-09-20,
       when that acceptance started running in the same accounting job:
       scripts/ci/run-diamond-sql-acceptance.py executes
       tests/sql/run-poker-diamond-custody.py, which loads
       tests/sql/poker-diamond-custody.sql. Leaving the absence asserted would
       have meant the one job that executes the probe could skip on a pull
       request that changed the probe, which is the defect this whole file is
       about, one lane over. It is admitted, by the lane that executes it. */
    expect(classifyChangedPaths(['tests/sql/poker-diamond-custody.sql']).server).toBe(true);
    /* An SQL probe no lane owns still admits nothing, and the `.sql` anchor
       still holds: a Markdown companion of a probe is documentation. */
    expect(
      classifyChangedPaths(['tests/sql/union-statement-issuer-rollback-probe.sql']).server
    ).toBe(false);
    expect(classifyChangedPaths(['tests/sql/diamond-daily-custody.sql.md']).server).toBe(false);
  });

  it('keeps the migration and runner classes that already routed correctly', () => {
    // supabase/migrations/** and scripts/dev/** reach the accounting job and
    // the unit suite through the broad rules; re-pinned so a narrowing shows up.
    const migration =
      'supabase/migrations/20260919153418_public_bonus_replay_has_an_explicitly_public_reader.sql';
    expect(classifyChangedPaths([migration])).toMatchObject({ server: true, tests: true });
    expect(classifyChangedPaths([runner])).toMatchObject({ server: true, tests: true });
  });
});

/**
 * `tests/law-registry.law.test.ts` readdirSync's docs/laws.d/ and enforces the
 * registry both ways, and it runs in exactly one place: `npx vitest run tests/`
 * under unit_shards, gated on `src || tests`. Measured before the fix,
 * docs/laws.d/** classified as { src: false, server: false, tests: false } - so
 * a pull request that only retired a law's registry file, or broke its first
 * line, skipped the single reader of the directory it had just edited. That is
 * CLAUDE.md 10.83 exactly: a check nobody can see is not a check.
 */
describe('the law registry admits the suite that reads it', () => {
  it.each(listing('docs/laws.d', (name) => name.endsWith('.md')).slice(0, 3))(
    '%s runs the law registry suite',
    (path) => {
      expect(classifyChangedPaths([path]).tests).toBe(true);
    }
  );

  it('admits the suite for every registry file, and for a new one', () => {
    const registry = listing('docs/laws.d', (name) => name.endsWith('.md'));
    for (const path of registry) expect(classifyChangedPaths([path]).tests).toBe(true);
    // A law retired tomorrow deletes a file this listing cannot contain.
    expect(classifyChangedPaths(['docs/laws.d/a-law-retired-tomorrow.md']).tests).toBe(true);
    expect(classifyChangedPaths(['tests/law-registry.law.test.ts']).tests).toBe(true);
  });

  it('leaves the rest of docs outside the application suites', () => {
    // The registry is test INPUT. Ordinary documentation is not, and widening
    // this to docs/ would run the whole unit suite on every changelog entry.
    expect(classifyChangedPaths(['docs/example.md'])).toMatchObject({
      src: false,
      server: false,
      tests: false,
    });
    expect(classifyChangedPaths(['docs/LAWS.md']).tests).toBe(false);
  });
});

/**
 * MEASURED 2026-09-26. PR #5260 changed a client scene and
 * scripts/dev/diamond-scene-perf.mjs, a headless-Chromium frame-time tool for
 * the Diamond fixture page. `scripts/dev/` admits the PostgreSQL accounting
 * job (it is where that job's test-*.sh and probe-* files live), so the tool
 * alone bought 29.5 minutes of accounting and four server shards. The two
 * screenshot/perf harnesses are named out of that lane exactly; nothing else
 * in scripts/dev/ moves, and a harness changed beside anything server-bound
 * still runs the job.
 */
describe('the Diamond screenshot harnesses do not buy the accounting job', () => {
  it.each(['scripts/dev/diamond-test-shots.mjs', 'scripts/dev/diamond-scene-perf.mjs'])(
    '%s alone does not admit the server lane',
    (path) => {
      expect(classifyChangedPaths([path]).server).toBe(false);
    }
  );

  it.each([
    'scripts/dev/test-accounting-delivery.sh',
    'scripts/dev/probe-atomic-tournament-blinds-pg17.py',
    'scripts/dev/diamond-wheel-render.mjs',
    'scripts/dev/diamond-test-shots.mjs.bak',
    'scripts/dev/nested/diamond-test-shots.mjs',
  ])('every other scripts/dev path still admits it: %s', (path) => {
    expect(classifyChangedPaths([path]).server).toBe(true);
  });

  it('a harness changed beside a migration or server source still runs accounting', () => {
    expect(
      classifyChangedPaths([
        'scripts/dev/diamond-test-shots.mjs',
        'supabase/migrations/20260926000000_example.sql',
      ]).server
    ).toBe(true);
    expect(
      classifyChangedPaths(['scripts/dev/diamond-scene-perf.mjs', 'server/src/index.ts']).server
    ).toBe(true);
  });
});
