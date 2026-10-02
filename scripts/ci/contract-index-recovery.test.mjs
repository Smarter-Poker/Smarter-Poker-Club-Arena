import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cleanupStatement,
  validateRecoveryPair,
  RECOVERY_SNAPSHOTS,
  validRecoveryCutoff,
  recoveryRequest,
  recoveryStatement,
  validateRecoveryCatalog,
  validateRecoverySnapshots,
  recoverySnapshotDiagnostic,
  MAX_SNAPSHOT_AGE_SECONDS,
  RECOVERY_FILE,
  RECOVERY_INDEX,
  EXPECTED_DEFINITION,
} from './contract-index-recovery.mjs';
const request = {
  index: RECOVERY_INDEX,
  oid: '83342071',
  before: '2026-10-01T21:22:10Z',
  transientOid: null,
};
const row = {
  observer_authorized: true,
  oid: request.oid,
  owner: 'postgres',
  table_owner: 'postgres',
  replica_identity: false,
  schema: 'public',
  name: 'managed_game_contract_versions_game_id_id_idx',
  relkind: 'i',
  table_schema: 'public',
  table_name: 'managed_game_contract_versions',
  definition: EXPECTED_DEFINITION,
  valid: false,
  ready: true,
  live: true,
  unique_index: false,
  primary_index: false,
  exclusion_index: false,
  key_count: 2,
  attribute_count: 2,
  no_predicate: true,
  no_expression: true,
  no_constraints: true,
  no_transients: true,
  no_builder: true,
};
test('no opt-in emits no recovery request; partial or unbound requests refuse', () => {
  assert.equal(recoveryRequest('irrelevant', '', null, null), null);
  for (const [index, oid] of [
    [RECOVERY_INDEX, null],
    [null, '83342071'],
    ['other', '83342071'],
    [RECOVERY_INDEX, '0'],
    [RECOVERY_INDEX, '4294967296'],
  ])
    assert.throws(() => recoveryRequest(RECOVERY_FILE, '', index, oid));
  assert.throws(() =>
    recoveryRequest(RECOVERY_FILE, 'changed source', RECOVERY_INDEX, request.oid)
  );
  assert.throws(() => recoveryStatement(null));
  assert.equal(recoveryStatement(request), 'REINDEX INDEX CONCURRENTLY ' + RECOVERY_INDEX);
});
test('exact invalid ready live observed index only; replacement must change OID', () => {
  assert.equal(validateRecoveryCatalog([row], request), row);
  for (const [key, value] of Object.entries({
    observer_authorized: false,
    oid: '83342072',
    owner: 'other',
    table_owner: 'other',
    replica_identity: true,
    schema: 'other',
    name: 'other',
    relkind: 'r',
    table_schema: 'other',
    table_name: 'other',
    definition: EXPECTED_DEFINITION + ' WHERE true',
    valid: true,
    ready: false,
    live: false,
    unique_index: true,
    primary_index: true,
    exclusion_index: true,
    key_count: 1,
    attribute_count: 3,
    no_predicate: false,
    no_expression: false,
    no_constraints: false,
    no_transients: false,
    no_builder: false,
  }))
    assert.throws(() => validateRecoveryCatalog([{ ...row, [key]: value }], request), key);
  for (const rows of [[], [row, row], null])
    assert.throws(() => validateRecoveryCatalog(rows, request));
  assert.throws(() => validateRecoveryCatalog([{ ...row, valid: true }], request, true));
  assert.equal(
    validateRecoveryCatalog([{ ...row, valid: true, oid: '83342072' }], request, true).oid,
    '83342072'
  );
});
test('short live snapshots are admitted; old, unknown-age or prepared work refuses', () => {
  assert.equal(MAX_SNAPSHOT_AGE_SECONDS, 60);
  const idle = {
    observed_at: '2026-10-02 17:24:00.000+00',
    observer_authorized: true,
    holders: 0,
    unknown_age: 0,
    oldest_age_seconds: null,
    no_prepared: true,
  };
  // Production as sampled for dry run 37040440084: PostgREST, pg_cron and
  // autovacuum backends always hold short snapshots, the oldest about 34 s.
  const postgrest = { ...idle, holders: 20, oldest_age_seconds: 34.2 };
  for (const rows of [
    [idle],
    [postgrest],
    [{ ...postgrest, holders: 3, oldest_age_seconds: 0.004 }],
    [{ ...postgrest, holders: 1, oldest_age_seconds: 60 }],
  ])
    assert.equal(validateRecoverySnapshots(rows), rows[0]);
  const refusals = {
    'old snapshot': { ...postgrest, oldest_age_seconds: 60.001 },
    'weekly-close reader': { ...postgrest, holders: 2, oldest_age_seconds: 1800 },
    'unknown age beside short holders': { ...postgrest, unknown_age: 1 },
    'unknown age alone': { ...idle, holders: 1, unknown_age: 1, oldest_age_seconds: null },
    'holder without an age': { ...postgrest, oldest_age_seconds: null },
    'age not a number': { ...postgrest, oldest_age_seconds: '12.5' },
    'negative age': { ...postgrest, oldest_age_seconds: -1 },
    'infinite age': { ...postgrest, oldest_age_seconds: Infinity },
    'NaN age': { ...postgrest, oldest_age_seconds: NaN },
    'age without holders': { ...idle, oldest_age_seconds: 1 },
    'missing holder count': { ...postgrest, holders: undefined },
    'string holder count': { ...postgrest, holders: '20' },
    'negative holder count': { ...postgrest, holders: -1 },
    'missing unknown count': { ...postgrest, unknown_age: undefined },
    'prepared transaction': { ...idle, no_prepared: false },
    'prepared transaction beside short holders': { ...postgrest, no_prepared: false },
    'unknown prepared state': { ...postgrest, no_prepared: null },
    'unauthorized observer': { ...postgrest, observer_authorized: false },
    'unknown observer': { ...postgrest, observer_authorized: undefined },
  };
  for (const [label, r] of Object.entries(refusals)) {
    const expected = label.includes('prepared transaction')
      ? /prepared transaction prevents recovery/
      : label.includes('observer') ||
          label.includes('holder count') ||
          label.includes('prepared state')
        ? /recovery admission state is unknown/
        : /older\/unknown snapshot prevents recovery/;
    assert.throws(() => validateRecoverySnapshots([r]), expected, label);
  }
  for (const rows of [[], [idle, idle], null, undefined, [null]])
    assert.throws(() => validateRecoverySnapshots(rows));
});
test('refused admission diagnostic is categorical, aggregate-only and logged before validation', () => {
  const sensitive = {
    observed_at: '2026-10-02 18:21:33.765+00',
    observer_authorized: true,
    holders: 3,
    unknown_age: 0,
    oldest_age_seconds: 90.5,
    no_prepared: true,
    pid: 1234,
    user: 'secret-role',
    query: 'select private_payload',
    gid: 'secret-prepared-name',
  };
  assert.equal(
    recoverySnapshotDiagnostic([sensitive]),
    'category=older-or-unknown-holder; holders=3; unknown_age=0; oldest_age_seconds=90.5; prepared=no'
  );
  assert.equal(
    recoverySnapshotDiagnostic([{ ...sensitive, oldest_age_seconds: 12, no_prepared: false }]),
    'category=prepared-transaction; holders=3; unknown_age=0; oldest_age_seconds=12; prepared=yes'
  );
  assert.equal(
    recoverySnapshotDiagnostic([{ ...sensitive, observer_authorized: false, holders: '3' }]),
    'category=unknown; holders=unknown; unknown_age=0; oldest_age_seconds=90.5; prepared=no'
  );
  for (const secret of [sensitive.user, sensitive.query, sensitive.gid, String(sensitive.pid)])
    assert.ok(!recoverySnapshotDiagnostic([sensitive]).includes(secret));

  const source = readFileSync(new URL('./apply-recorded-migration.mjs', import.meta.url), 'utf8');
  assert.ok(
    source.indexOf('recoverySnapshotDiagnostic(snapshots)') <
      source.indexOf('validateRecoverySnapshots(snapshots)')
  );
});
test('owning applier keeps bounded single recovery before unchanged migration body', () => {
  const source = readFileSync(new URL('./apply-recorded-migration.mjs', import.meta.url), 'utf8');
  assert.equal(source.split('sendOnce(recoveryStatement(recovery))').length - 1, 1);
  assert.ok(
    source.indexOf('validateRecoverySnapshots') <
      source.indexOf('sendOnce(recoveryStatement(recovery))')
  );
  assert.ok(source.includes("SET statement_timeout = '600s'"));
  assert.ok(source.includes('PREAMBLE_MINUTES_NEEDED = 12'));
  assert.ok(
    source.indexOf('recovered exact index OID') <
      source.indexOf('client.query(preamble.length > 0 ? shape.body : sql)')
  );
});

test('cutoff is explicit real past ISO UTC, never future or malformed', () => {
  assert.equal(validRecoveryCutoff('2026-10-01T21:22:10Z'), true);
  for (const x of [
    null,
    '',
    'NaN',
    '2026-02-30T00:00:00Z',
    '2026-10-01T21:22:10+00:00',
    '2999-01-01T00:00:00Z',
  ])
    assert.equal(validRecoveryCutoff(x), false);
});

test('real exact migration binds a complete explicit request and refuses missing parts', () => {
  const sql = readFileSync(
    new URL('../../supabase/migrations/' + RECOVERY_FILE, import.meta.url),
    'utf8'
  );
  assert.deepEqual(
    recoveryRequest(RECOVERY_FILE, sql, request.index, request.oid, request.before),
    request
  );
  for (const args of [
    [null, request.oid, request.before],
    [request.index, null, request.before],
    [request.index, request.oid, null],
  ])
    assert.throws(() => recoveryRequest(RECOVERY_FILE, sql, ...args));
  assert.throws(() =>
    recoveryRequest(RECOVERY_FILE, sql + ' ', request.index, request.oid, request.before)
  );
});

test('exact interrupted pair alone permits cleanup; original and other indexes never do', () => {
  const r = { ...request, transientOid: '83498459' };
  const names = ['managed_game_contract_versions_game_id_id_idx_ccnew'];
  const original = { ...row, no_transients: false, transient_names: names };
  const transient = {
    ...original,
    oid: r.transientOid,
    name: names[0],
    definition: EXPECTED_DEFINITION.replace('game_id_id_idx ON', 'game_id_id_idx_ccnew ON'),
  };
  assert.equal(validateRecoveryPair([original], [transient], r).transient.oid, r.transientOid);
  assert.equal(
    cleanupStatement(r),
    'DROP INDEX CONCURRENTLY public.managed_game_contract_versions_game_id_id_idx_ccnew'
  );
  for (const bad of [
    null,
    request,
    { ...r, transientOid: request.oid },
    { ...r, transientOid: '0' },
    { ...r, transientOid: '4294967296' },
  ])
    assert.throws(() => cleanupStatement(bad));
  for (const rows of [
    [],
    [transient, transient],
    [{ ...transient, oid: '83498460' }],
    [{ ...transient, valid: true }],
    [{ ...transient, ready: false }],
    [{ ...transient, live: false }],
    [{ ...transient, name: 'other' }],
    [{ ...transient, no_builder: false }],
    [{ ...transient, no_constraints: false }],
    [{ ...transient, definition: EXPECTED_DEFINITION }],
  ])
    assert.throws(() => validateRecoveryPair([original], rows, r));
  for (const names2 of [
    [],
    [...names, 'managed_game_contract_versions_game_id_id_idx_ccold'],
    ['managed_game_contract_versions_game_id_id_idx_ccnew1'],
  ])
    assert.throws(() =>
      validateRecoveryPair([{ ...original, transient_names: names2 }], [transient], r)
    );
  assert.throws(() => validateRecoveryPair([{ ...original, oid: '83342072' }], [transient], r));
  assert.throws(() => validateRecoveryPair([original], [transient], request));
  const sql = readFileSync(
    new URL('../../supabase/migrations/' + RECOVERY_FILE, import.meta.url),
    'utf8'
  );
  assert.deepEqual(
    recoveryRequest(RECOVERY_FILE, sql, r.index, r.oid, r.before, r.transientOid),
    r
  );
});
test('current admission cannot filter readers using the historical failed-operation cutoff', () => {
  // Ages are measured from fresh server time, never from the historical cutoff,
  // and cover snapshot, xid and open-transaction holders other than ourselves.
  assert.ok(!RECOVERY_SNAPSHOTS.includes('$1'));
  assert.ok(!RECOVERY_SNAPSHOTS.includes('statement_timestamp'));
  assert.ok(RECOVERY_SNAPSHOTS.includes('clock_timestamp()-coalesce(xact_start,backend_start)'));
  for (const term of [
    'backend_xmin IS NOT NULL',
    'backend_xid IS NOT NULL',
    'xact_start IS NOT NULL',
    'pid<>pg_backend_pid()',
    'datname=current_database()',
    'pg_prepared_xacts WHERE database=current_database()',
  ])
    assert.ok(RECOVERY_SNAPSHOTS.includes(term), term);
  const source = readFileSync(new URL('./apply-recorded-migration.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('const deadline = performance.now() + 600000'));
  assert.ok(source.includes('deadline - performance.now()'));
  assert.equal(source.split('sendOnce(cleanupStatement(recovery))').length - 1, 1);
  assert.ok(
    source.indexOf('await freshAdmission(false)') <
      source.indexOf('await sendOnce(recoveryStatement(recovery))')
  );
  assert.ok(source.includes('recoverySent ? EXIT_UNKNOWN : EXIT_REFUSED'));
});
