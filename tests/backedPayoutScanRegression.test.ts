import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrationCorpus } from './helpers/migrationCorpus';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const name = 'fn_tournament_conservation_delta';
const migrationPath =
  'supabase/migrations/20260927050956_batch_backed_payout_shortfall_discovery_without_changing_set.sql';
const migration = read(migrationPath);
const successorPath =
  'supabase/migrations/20260927163648_backed_payout_discovery_follows_reviewed_overlay_returns.sql';
const successor = read(successorPath);
const successorScalar = read('scripts/ci/fixtures/backed-payout-scan/reviewed-return-scalar.sql');
const successorPins = JSON.parse(
  read('scripts/ci/fixtures/backed-payout-scan/reviewed-return-expectations.json')
);
const fixture = JSON.parse(read('scripts/ci/fixtures/backed-payout-scan/baseline.json'));
let declaredFunctions: (sql: string) => { name: string; header: string; body: string }[];
let stripComments: (sql: string) => string;
beforeAll(async () => {
  const href = pathToFileURL(
    resolve(process.cwd(), 'scripts/ci/check-definer-authorization.mjs')
  ).href;
  const mod = await import(/* @vite-ignore */ href);
  declaredFunctions = mod.declaredFunctions;
  stripComments = mod.stripComments;
});

describe('backed payout discovery is the same accounting question in a batch', () => {
  it.each([
    migrationPath,
    successorPath,
    'scripts/ci/fixtures/backed-payout-scan/reviewed-return-native.py',
    'scripts/ci/fixtures/backed-payout-scan/reviewed-return-cases.sql',
    'scripts/ci/fixtures/backed-payout-scan/reviewed-return-scalar.sql',
    'scripts/ci/fixtures/backed-payout-scan/reviewed-return-batch-selection.sql',
    'scripts/ci/fixtures/backed-payout-scan/reviewed-return-expectations.json',
    'scripts/ci/fixtures/backed-payout-scan/reviewed-return-index-native.py',
    'scripts/ci/fixtures/backed-payout-scan/reviewed-return-index-build-online.sql',
    'scripts/ci/fixtures/backed-payout-scan/reviewed-return-index-recover-online.sql',
    'scripts/ci/fixtures/backed-payout-scan/reviewed-return-index-expectations.json',
    'supabase/migrations/20260927164203_reviewed_overlay_returns_use_their_exact_partial_ledger_inde.sql',
    'scripts/ci/test-backed-payout-scan-postgres.py',
    'scripts/ci/fixtures/backed-payout-scan/baseline.json',
    'scripts/ci/fixtures/backed-payout-scan/batch-selection.sql',
    'scripts/ci/fixtures/backed-payout-scan/setup.sql',
    'scripts/ci/fixtures/backed-payout-scan/cases.sql',
    'tests/backedPayoutScanRegression.test.ts',
  ])('enforces native and source checks for %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });

  it('runs the default real PG17 acceptance through required accounting', () => {
    const accounting = read('.github/workflows/ci.yml')
      .split('\n  accounting_postgres:')[1]
      .split('\n  server:')[0];
    expect(accounting).toContain('run: python3 scripts/ci/test-backed-payout-scan-postgres.py');
    expect(accounting).not.toContain('test-backed-payout-scan-postgres.py --baseline');
  });

  it('pins the live scalar and exact caller preimages without changing grants or schedules', () => {
    for (const fn of fixture.functions) {
      expect(createHash('md5').update(fn.definition).digest('hex')).toBe(fn.md5);
      expect(migration).toContain(fn.md5);
    }
    expect(migration).not.toMatch(/\b(?:GRANT|REVOKE|cron\.(?:schedule|alter_job|unschedule))\b/i);
    for (const property of [
      'indisunique',
      'indisvalid',
      'indisready',
      'indislive',
      'indimmediate',
    ]) {
      expect(migration).toContain('i.' + property);
    }
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    const scan = read('scripts/ci/fixtures/backed-payout-scan/batch-selection.sql').trimEnd();
    expect(migration).toContain('$scan$' + scan + '$scan$');
    expect(scan).toContain('wallet_receipts AS MATERIALIZED');
    expect(scan).toContain('rr.rake_amount <> 0');
    expect(migration).toContain('BACKED_PAYOUT_SCAN_COVER_CHANGED');
    expect(migration).not.toMatch(/SET(?: LOCAL)? enable_/i);
    expect(scan).not.toContain('is_horse');
    expect(scan).not.toContain('fn_tournament_conservation_delta(');
    expect(scan).toContain('LIMIT GREATEST(p_limit, 1)');
    expect(scan).toContain('ORDER BY t.ended_at ASC NULLS LAST');
  });

  it('binds the reviewed return successor to native parity and exact installed prerequisites', () => {
    expect(createHash('md5').update(successorScalar).digest('hex')).toBe(
      successorPins.scalarDefinitionMD5
    );
    for (const key of ['scalarDefinitionMD5', 'batchDefinitionMD5', 'previousBatchDefinitionMD5'])
      expect(successor).toContain(successorPins[key]);
    const scan = read(
      'scripts/ci/fixtures/backed-payout-scan/reviewed-return-batch-selection.sql'
    ).trimEnd();
    expect(successor).toContain('$scan$' + scan + '$scan$');
    expect(scan).toContain(
      'GREATEST(COALESCE(l.overlay, 0), COALESCE(o.amount, 0)) - COALESCE(ro.returned, 0)'
    );
    expect(scan).toContain('l.from_entity_id = l.tournament_id');
    expect(scan).toContain("l.metadata->>'kind' = 'reviewed_void_overlay_return'");
    expect(scan).not.toContain('is_horse');
    expect(successor).not.toMatch(/\b(?:GRANT|REVOKE|cron\.(?:schedule|alter_job|unschedule))\b/i);
    expect(read('scripts/ci/test-backed-payout-scan-postgres.py')).toContain(
      "runpy.run_path(str(FIXTURE/'reviewed-return-native.py'))['qualify'](globals())"
    );
    const native = read('scripts/ci/fixtures/backed-payout-scan/reviewed-return-native.py');
    for (const proof of [
      'original-formula-red-reproduced',
      'whole successor caller differs',
      'successor transaction rollback',
      'fresh statement missed committed return',
    ])
      expect(native).toContain(proof);
  });

  it('enforces the exact online return cover without changing financial functions', () => {
    const build = read(
      'scripts/ci/fixtures/backed-payout-scan/reviewed-return-index-build-online.sql'
    );
    const verifier = read(
      'supabase/migrations/20260927164203_reviewed_overlay_returns_use_their_exact_partial_ledger_inde.sql'
    );
    const pins = JSON.parse(
      read('scripts/ci/fixtures/backed-payout-scan/reviewed-return-index-expectations.json')
    );
    expect(createHash('md5').update(pins.definition).digest('hex')).toBe(pins.definitionMD5);
    expect(verifier).toContain(pins.definitionMD5);
    expect(stripComments(build).match(/;/g)).toHaveLength(1);
    expect(stripComments(build)).toMatch(
      /^\s*CREATE INDEX CONCURRENTLY idx_chip_ledger_reviewed_overlay_returns/
    );
    expect(build).toContain('INCLUDE (amount)');
    expect(verifier).toContain('numeric(15,2)');
    expect(verifier).not.toMatch(
      /\b(?:CREATE|ALTER|DROP|GRANT|REVOKE|EXECUTE)\s+(?:INDEX|FUNCTION|TABLE|ALL)/i
    );
    expect(read('scripts/ci/test-backed-payout-scan-postgres.py')).toContain(
      "runpy.run_path(str(FIXTURE/'reviewed-return-index-native.py'))['qualify'](globals())"
    );
    for (const guard of [
      'SOURCE_CHANGED',
      'AUTHORITY_CHANGED',
      'COLUMNS_CHANGED',
      'MISSING_BUILD_ONLINE',
      'ACTIVE_BUILD',
      'DEFINITION_CHANGED',
    ])
      expect(verifier).toContain('REVIEWED_RETURN_INDEX_' + guard);
    const native = read('scripts/ci/fixtures/backed-payout-scan/reviewed-return-index-native.py');
    for (const proof of [
      'waiting for old snapshots',
      'real interrupted build leaves invalid durable state',
      'index changes financial output',
      'financial data changed',
    ])
      expect(native).toContain(proof);
  });

  it('requires renewed batch qualification when the maintained scalar formula changes', () => {
    const declarations = migrationCorpus().flatMap(({ name: file, sql }) =>
      declaredFunctions(sql)
        .filter((fn) => fn.name === name)
        .map((fn) => ({ file, ...fn }))
    );
    const latest = declarations.at(-1)!;
    const baseline = declaredFunctions(successorScalar)[0];
    const normalize = (body: string) => stripComments(body).replace(/\s+/g, ' ').trim();
    expect(normalize(latest.body), latest.file).toBe(normalize(baseline.body));
    // A dynamic patch is also a formula change: future pg_get_functiondef
    // writers must be reviewed together, rather than evading CREATE detection.
    const laterDynamic = migrationCorpus().filter(
      ({ name: file, sql }) =>
        file > latest.file &&
        ![migrationPath, successorPath].some((path) => file === path.split('/').at(-1)) &&
        /pg_get_functiondef[\s\S]{0,180}fn_tournament_conservation_delta/.test(sql) &&
        /\bEXECUTE\b/i.test(stripComments(sql))
    );
    expect(laterDynamic.map(({ name: file }) => file)).toEqual([]);
  });
});
