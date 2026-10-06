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
const inlinePins = JSON.parse(
  read('scripts/ci/fixtures/backed-payout-scan/wallet-inline-expectations.json')
);
const inlinePath = inlinePins.migration;
const inlineMigration = read(inlinePath);
const incomePins = JSON.parse(
  read('scripts/ci/fixtures/backed-payout-scan/seat-income-expectations.json')
);
const incomePath = incomePins.migration;
const incomeMigration = read(incomePath);
const coverPins = JSON.parse(
  read('scripts/ci/fixtures/backed-payout-scan/wallet-cover-expectations.json')
);
const coverPath = coverPins.migration;
const coverMigration = read(coverPath);
const successorScalar = read('scripts/ci/fixtures/backed-payout-scan/reviewed-return-scalar.sql');
const successorPins = JSON.parse(
  read('scripts/ci/fixtures/backed-payout-scan/reviewed-return-expectations.json')
);
const fixture = JSON.parse(read('scripts/ci/fixtures/backed-payout-scan/baseline.json'));
const ticketPins = JSON.parse(
  read('scripts/ci/fixtures/backed-payout-scan/ticket-funding-expectations.json')
);
const ticketPath = ticketPins.migration;
const ticketMigration = read(ticketPath);
const ticketScalar = read('scripts/ci/fixtures/backed-payout-scan/ticket-funding-scalar.sql');
// The conservation scan's one-pass read (2026-10-03) reads the scalar's md5
// as a preimage and rewrites fn_tournament_money_conservation, not the scalar;
// tests/the-conservation-scan-reads-every-event-in-one-pass.law.test.ts pins it.
const conservationPath = JSON.parse(
  read('scripts/ci/fixtures/backed-payout-scan/conservation-set-expectations.json')
).migration;
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
    inlinePath,
    incomePath,
    coverPath,
    'scripts/ci/fixtures/backed-payout-scan/wallet-cover-native.py',
    'scripts/ci/fixtures/backed-payout-scan/wallet-cover-build-online.sql',
    'scripts/ci/fixtures/backed-payout-scan/wallet-cover-recover-online.sql',
    'scripts/ci/fixtures/backed-payout-scan/wallet-cover-expectations.json',
    'scripts/ci/fixtures/backed-payout-scan/seat-income-native.py',
    'scripts/ci/fixtures/backed-payout-scan/seat-income-expectations.json',
    'scripts/ci/fixtures/backed-payout-scan/seat-income-cases.sql',
    'scripts/ci/fixtures/backed-payout-scan/wallet-inline-native.py',
    'scripts/ci/fixtures/backed-payout-scan/wallet-inline-expectations.json',
    'scripts/ci/fixtures/backed-payout-scan/reviewed-return-native.py',
    'scripts/ci/fixtures/backed-payout-scan/reviewed-return-cases.sql',
    'scripts/ci/fixtures/backed-payout-scan/reviewed-return-scalar.sql',
    'scripts/ci/fixtures/backed-payout-scan/reviewed-return-batch-selection.sql',
    'scripts/ci/fixtures/backed-payout-scan/reviewed-return-expectations.json',
    'scripts/ci/fixtures/backed-payout-scan/reviewed-return-index-native.py',
    'scripts/ci/fixtures/backed-payout-scan/reviewed-return-index-build-online.sql',
    'scripts/ci/fixtures/backed-payout-scan/reviewed-return-index-recover-online.sql',
    'scripts/ci/fixtures/backed-payout-scan/reviewed-return-index-expectations.json',
    'supabase/migrations/20260927170830_reviewed_overlay_returns_use_their_exact_partial_ledger_index.sql',
    'scripts/ci/test-backed-payout-scan-postgres.py',
    'scripts/ci/fixtures/backed-payout-scan/baseline.json',
    'scripts/ci/fixtures/backed-payout-scan/batch-selection.sql',
    'scripts/ci/fixtures/backed-payout-scan/setup.sql',
    'scripts/ci/fixtures/backed-payout-scan/cases.sql',
    'tests/backedPayoutScanRegression.test.ts',
    ticketPath,
    'scripts/ci/fixtures/backed-payout-scan/ticket-funding-scalar.sql',
    'scripts/ci/fixtures/backed-payout-scan/ticket-funding-cases.sql',
    'scripts/ci/fixtures/backed-payout-scan/ticket-funding-native.py',
    'scripts/ci/fixtures/backed-payout-scan/ticket-funding-expectations.json',
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
      'supabase/migrations/20260927170830_reviewed_overlay_returns_use_their_exact_partial_ledger_index.sql'
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

  it('inlines only the single-use wallet receipt read and retains every financial byte', () => {
    const original = fixture.functions.find((fn: { signature: string }) =>
      fn.signature.startsWith('fn_pay_backed')
    ).definition;
    const scan = read(
      'scripts/ci/fixtures/backed-payout-scan/reviewed-return-batch-selection.sql'
    ).trimEnd();
    const start = original.indexOf('    SELECT t.id, t.name, t.club_id, t.prize_pool,');
    const end = original.indexOf('\n  LOOP', start);
    const before = original.slice(0, start) + scan + original.slice(end);
    const after = before.replace(inlinePins.oldToken, inlinePins.newToken);
    expect(before.split(inlinePins.oldToken)).toHaveLength(2);
    expect(createHash('md5').update(before).digest('hex')).toBe(inlinePins.beforeDefinitionMD5);
    expect(createHash('md5').update(after).digest('hex')).toBe(inlinePins.afterDefinitionMD5);
    for (const digest of [
      inlinePins.beforeDefinitionMD5,
      inlinePins.afterDefinitionMD5,
      inlinePins.scalarDefinitionMD5,
    ])
      expect(inlineMigration).toContain(digest);
    expect(inlineMigration).toContain(
      "replace(v_old,'wallet_receipts AS MATERIALIZED (','wallet_receipts AS NOT MATERIALIZED (')"
    );
    expect(inlineMigration).not.toMatch(
      /\b(?:GRANT|REVOKE|cron\.(?:schedule|alter_job|unschedule))\b/i
    );
    expect(read('scripts/ci/test-backed-payout-scan-postgres.py')).toContain(
      "runpy.run_path(str(FIXTURE/'wallet-inline-native.py'))['qualify'](globals())"
    );
    const native = read('scripts/ci/fixtures/backed-payout-scan/wallet-inline-native.py');
    for (const proof of [
      'original-spool-red-reproduced',
      'whole inline caller differs',
      'inline transaction rollback',
      'inline fresh statement misses wallet or return receipt',
    ])
      expect(native).toContain(proof);
  });

  it('bounds only incoming satellite keys using the existing expression index', () => {
    const original = fixture.functions.find((fn: { signature: string }) =>
      fn.signature.startsWith('fn_pay_backed')
    ).definition;
    const scan = read(
      'scripts/ci/fixtures/backed-payout-scan/reviewed-return-batch-selection.sql'
    ).trimEnd();
    const start = original.indexOf('    SELECT t.id, t.name, t.club_id, t.prize_pool,');
    const end = original.indexOf('\n  LOOP', start);
    const before = (original.slice(0, start) + scan + original.slice(end)).replace(
      inlinePins.oldToken,
      inlinePins.newToken
    );
    const a = before.indexOf('    ), seat_income AS MATERIALIZED (');
    const b = before.indexOf('    ), seat_outgoing AS MATERIALIZED (', a);
    const income = before.slice(a, b);
    expect(createHash('md5').update(income).digest('hex')).toBe(incomePins.incomeBeforeMD5);
    expect(income.split(incomePins.oldPredicate)).toHaveLength(2);
    const after =
      before.slice(0, a) +
      income.replace(incomePins.oldPredicate, incomePins.newPredicate) +
      before.slice(b);
    expect(createHash('md5').update(before).digest('hex')).toBe(incomePins.beforeDefinitionMD5);
    expect(createHash('md5').update(after).digest('hex')).toBe(incomePins.afterDefinitionMD5);
    for (const digest of [
      incomePins.beforeDefinitionMD5,
      incomePins.afterDefinitionMD5,
      incomePins.scalarDefinitionMD5,
      incomePins.indexDefinitionMD5,
    ])
      expect(incomeMigration).toContain(digest);
    expect(createHash('md5').update(incomePins.indexDefinition).digest('hex')).toBe(
      incomePins.indexDefinitionMD5
    );
    expect(stripComments(incomeMigration)).not.toMatch(
      /\b(?:GRANT|REVOKE|CREATE INDEX|ALTER INDEX|DROP INDEX|cron\.(?:schedule|alter_job|unschedule))\b/i
    );
    expect(incomeMigration).toContain('substring(v_old FROM v_end)');
    expect(incomePins.newPredicate).not.toContain('::uuid');
    expect(read('scripts/ci/test-backed-payout-scan-postgres.py')).toContain(
      "runpy.run_path(str(FIXTURE/'seat-income-native.py'))['qualify'](globals())"
    );
    const native = read('scripts/ci/fixtures/backed-payout-scan/seat-income-native.py');
    for (const proof of [
      'original-heap-read-red-reproduced',
      'whole incoming caller differs',
      'incoming rows changed',
      'outgoing bytes changed',
      'income fresh statement misses payout or ticket state',
      'income transaction rollback',
    ])
      expect(native).toContain(proof);
  });

  it('covers the existing six wallet receipt categories with unchanged financial authority', () => {
    const build = read('scripts/ci/fixtures/backed-payout-scan/wallet-cover-build-online.sql');
    expect(createHash('md5').update(coverPins.definition).digest('hex')).toBe(
      coverPins.definitionMD5
    );
    expect(coverMigration).toContain(coverPins.definitionMD5);
    expect(coverMigration).toContain(incomePins.afterDefinitionMD5);
    expect(stripComments(build).match(/;/g)).toHaveLength(1);
    expect(stripComments(build)).toMatch(
      /^\s*CREATE INDEX CONCURRENTLY idx_wallet_tx_tournament_receipts_cover/
    );
    expect(build).toContain('INCLUDE (type, category, amount)');
    for (const kind of ['tournament_buyin', 'rebuy', 'addon', 'refund', 'prize', 'bounty'])
      expect(coverPins.predicate).toContain("'" + kind + "'");
    expect(coverMigration).toContain('numeric(15,2)');
    expect(stripComments(coverMigration)).not.toMatch(
      /\b(?:CREATE|ALTER|DROP|GRANT|REVOKE|EXECUTE)\s+(?:INDEX|FUNCTION|TABLE|ALL)/i
    );
    expect(read('scripts/ci/test-backed-payout-scan-postgres.py')).toContain(
      "runpy.run_path(str(FIXTURE/'wallet-cover-native.py'))['qualify'](globals())"
    );
    const native = read('scripts/ci/fixtures/backed-payout-scan/wallet-cover-native.py');
    for (const proof of [
      'waiting for old snapshots',
      'real interrupted build leaves invalid durable state',
      'index changes financial output',
      'financial data changed',
      'oversized-excluded-label',
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
    // The ticket and house-funding successor (2026-10-03) is the maintained
    // scalar; its native qualification is ticket-funding-native.py.
    const baseline = declaredFunctions(ticketScalar)[0];
    const normalize = (body: string) => stripComments(body).replace(/\s+/g, ' ').trim();
    expect(normalize(latest.body), latest.file).toBe(normalize(baseline.body));
    // A dynamic patch is also a formula change: future pg_get_functiondef
    // writers must be reviewed together, rather than evading CREATE detection.
    const laterDynamic = migrationCorpus().filter(
      ({ name: file, sql }) =>
        file > latest.file &&
        ![migrationPath, successorPath, inlinePath, incomePath, ticketPath, conservationPath].some(
          (path) => file === path.split('/').at(-1)
        ) &&
        /pg_get_functiondef[\s\S]{0,180}fn_tournament_conservation_delta/.test(sql) &&
        /\bEXECUTE\b/i.test(stripComments(sql))
    );
    expect(laterDynamic.map(({ name: file }) => file)).toEqual([]);
  });

  it('reads a ticket from its payout row and a house correction as funding, on both paths', () => {
    expect(createHash('md5').update(ticketScalar).digest('hex')).toBe(
      ticketPins.scalarDefinitionMD5
    );
    expect(ticketMigration).toContain(ticketScalar.trimEnd() + ';');
    for (const key of ['scalarBeforeMD5', 'scalarDefinitionMD5', 'batchBeforeMD5', 'batchAfterMD5'])
      expect(ticketMigration).toContain(ticketPins[key]);
    // The predecessors are the qualified ones, nothing else.
    expect(ticketPins.scalarBeforeMD5).toBe(successorPins.scalarDefinitionMD5);
    expect(ticketPins.batchBeforeMD5).toBe(incomePins.afterDefinitionMD5);
    // The ticket resolves from the award row, else from a well-formed payout
    // ticket id; a malformed one is never cast.
    expect(
      ticketScalar.match(/COALESCE\(a\.ticket_id, CASE WHEN sp\.metadata->>'ticket_id' ~\* /g)
    ).toHaveLength(2);
    expect(ticketScalar).toMatch(
      /c\.category = 'correction'\s+AND c\.to_type = 'prize_liability'\s+AND c\.from_type IN \('union_bank','club_treasury'\)\), 0\) AS house_correction/
    );
    expect(ticketScalar).toMatch(/\+ m\.funded_overlay\n\s+\+ m\.house_correction\n/);
    expect(ticketScalar).not.toMatch(/settlement_suspense|from_type IN \([^)]*player_wallet/);
    const replacements = ticketPins.replacements as { old: string; new: string; count: number }[];
    expect(replacements.map((r) => r.count)).toEqual([2, 1, 1, 1]);
    expect(replacements[1].new).toContain('house_corrections AS MATERIALIZED (');
    expect(replacements[3].new).toContain('LEFT JOIN house_corrections hc ON hc.id = e.id');
    for (const code of ['PREIMAGE_CHANGED', 'AUTHORITY_CHANGED', 'BATCH_CHANGED', 'RESULT_CHANGED'])
      expect(ticketMigration).toContain('TICKET_FUNDING_' + code);
    expect(stripComments(ticketMigration)).not.toMatch(
      /\b(?:CREATE INDEX|DROP|cron\.(?:schedule|alter_job|unschedule))\b/i
    );
    // Authority is only ever restated, never widened: the scalar is closed to
    // every browser role and open to the service role, and nothing else is
    // granted or revoked.
    expect(stripComments(ticketMigration).match(/\b(?:GRANT|REVOKE)\b[^;]*;/g)).toEqual([
      'REVOKE ALL ON FUNCTION public.fn_tournament_conservation_delta(uuid) FROM PUBLIC, anon, authenticated;',
      'GRANT EXECUTE ON FUNCTION public.fn_tournament_conservation_delta(uuid) TO service_role;',
    ]);
    expect(ticketMigration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(ticketMigration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(read('scripts/ci/test-backed-payout-scan-postgres.py')).toContain(
      "runpy.run_path(str(FIXTURE/'ticket-funding-native.py'))['qualify'](globals())"
    );
    const native = read('scripts/ci/fixtures/backed-payout-scan/ticket-funding-native.py');
    for (const proof of [
      'original formula',
      'predecessor batch must pay the phantom backing',
      'successor oracle must not pay the phantom backing',
      'ticket transaction rollback',
      'whole successor caller differs',
      'ticket whole-population scalar parity',
      'ticket successor changed authority or function identity',
    ])
      expect(native).toContain(proof);
  });
});
