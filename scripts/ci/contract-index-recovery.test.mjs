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
test('old or unknown snapshots, prepared transactions and unknown observer refuse', () => {
  const clear = { observer_authorized: true, clear: true, no_prepared: true };
  validateRecoverySnapshots([clear]);
  for (const key of Object.keys(clear))
    for (const value of [false, null, undefined])
      assert.throws(() => validateRecoverySnapshots([{ ...clear, [key]: value }]));
  for (const rows of [[], [clear, clear], null])
    assert.throws(() => validateRecoverySnapshots(rows));
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
  assert.ok(RECOVERY_SNAPSHOTS.includes('xact_start <= statement_timestamp()'));
  assert.ok(RECOVERY_SNAPSHOTS.includes('xact_start IS NULL'));
  assert.ok(!RECOVERY_SNAPSHOTS.includes('$1'));
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
