import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  CHICAGO_FILE,
  CHICAGO_INDEX,
  recoveryCatalog,
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
    'weekly-close reader': {
      ...postgrest,
      holders: 2,
      oldest_age_seconds: 1800,
    },
    'unknown age beside short holders': { ...postgrest, unknown_age: 1 },
    'unknown age alone': {
      ...idle,
      holders: 1,
      unknown_age: 1,
      oldest_age_seconds: null,
    },
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
    'prepared transaction beside short holders': {
      ...postgrest,
      no_prepared: false,
    },
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
function assertAtomicBodyAfterRecovery(source) {
  const recovery = source.indexOf('recovered exact index OID');
  const body = source.indexOf('const transactionBody = preamble.length > 0 ? shape.body : sql');
  const binding = source.indexOf('const atomicSQL = transactionBody.replace(');
  const admission = source.indexOf(
    'admittedSQL = MAINTENANCE_THAW_REPAIR\n    ? thawRepairSQL(atomicSQL)\n    : accountingAdmissionSQL(file, sql, atomicSQL);'
  );
  const identity = source.indexOf(
    'transactionSQL = bindMigrationSession(SETTLEMENT_LANE ? atomicSQL : admittedSQL);'
  );
  const send = source.indexOf('await client.query(transactionSQL)');
  for (const [label, position] of [
    ['recovery', recovery],
    ['body selection', body],
    ['atomic binding', binding],
    ['explicit repair selection', admission],
    ['transaction identity', identity],
    ['transaction send', send],
  ]) {
    assert.ok(position >= 0, `${label} is missing`);
  }
  assert.ok(
    recovery < body &&
      body < binding &&
      binding < admission &&
      admission < identity &&
      identity < send,
    'recovery precedes unchanged body selection, atomic history binding, and send'
  );
}

test('owning applier keeps bounded single recovery before unchanged migration body', () => {
  const source = readFileSync(new URL('./apply-recorded-migration.mjs', import.meta.url), 'utf8');
  assert.equal(source.split('sendOnce(recoveryStatement(recovery))').length - 1, 1);
  assert.ok(
    source.indexOf('validateRecoverySnapshots') <
      source.indexOf('sendOnce(recoveryStatement(recovery))')
  );
  assert.ok(source.includes("SET statement_timeout = '600s'"));
  assert.ok(source.includes('PREAMBLE_MINUTES_NEEDED = 12'));
  assertAtomicBodyAfterRecovery(source);
});

test('body-order assertion refuses missing or reordered owning steps', () => {
  const source = readFileSync(new URL('./apply-recorded-migration.mjs', import.meta.url), 'utf8');
  for (const part of [
    'recovered exact index OID',
    'const transactionBody = preamble.length > 0 ? shape.body : sql',
    'const atomicSQL = transactionBody.replace(',
    'admittedSQL = MAINTENANCE_THAW_REPAIR\n    ? thawRepairSQL(atomicSQL)\n    : accountingAdmissionSQL(file, sql, atomicSQL);',
    'transactionSQL = bindMigrationSession(SETTLEMENT_LANE ? atomicSQL : admittedSQL);',
    'await client.query(transactionSQL)',
  ]) {
    assert.throws(() => assertAtomicBodyAfterRecovery(source.replace(part, 'removed step')), part);
  }
  const identity =
    'transactionSQL = bindMigrationSession(SETTLEMENT_LANE ? atomicSQL : admittedSQL);';
  assert.throws(
    () =>
      assertAtomicBodyAfterRecovery(identity + '\n' + source.replace(identity, 'removed identity')),
    /recovery precedes/
  );
  const send = 'await client.query(transactionSQL)';
  assert.throws(
    () => assertAtomicBodyAfterRecovery(send + '\n' + source.replace(send, 'removed send')),
    /recovery precedes/
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

// The same required installer regression job covers the source-bound serial option.
import {
  SERIAL_JOURNAL_FILE, validateSerialJournalIndex, validateSerialJournalConnection,
  bindSerialJournalIndex, serialJournalConnection,
} from './serial-journal-index.mjs';
const serialSql = readFileSync(new URL('../../supabase/migrations/' + SERIAL_JOURNAL_FILE, import.meta.url), 'utf8');
const serialRequest = { enabled: true, file: SERIAL_JOURNAL_FILE, sql: serialSql,
  preamble: [{ schema: 'public', name: 'horse_adaptive_journal_metadata_cover' }], otherModes: false };
test('serial option binds only the exact merged single-index migration', () => {
  assert.equal(validateSerialJournalIndex(serialRequest), true);
  assert.equal(validateSerialJournalIndex({ enabled: false }), false);
  for (const bad of [{ file: '20261020170644_other.sql' }, { sql: serialSql + '\n' },
    { otherModes: true }, { preamble: [] }, { preamble: [...serialRequest.preamble, ...serialRequest.preamble] },
    { preamble: [{ schema: 'public', name: 'other' }] }])
    assert.throws(() => validateSerialJournalIndex({ ...serialRequest, ...bad }));
});
test('serial option refuses transaction pool and unverified session hosts', () => {
  validateSerialJournalConnection(new URL('postgres://postgres.kuklfnapbkmacvwxktbh@aws-0-us-west-2.pooler.supabase.com:5432/postgres'));
  for (const u of ['postgres://postgres@aws-0-us-west-2.pooler.supabase.com:6543/postgres',
    'postgres://postgres@localhost:5432/postgres',
    'postgres://postgres.otherproject@aws-0-us-west-2.pooler.supabase.com:5432/postgres',
    'postgres://postgres.kuklfnapbkmacvwxktbh@aws-1-us-west-2.pooler.supabase.com:5432/postgres',
    'postgres://postgres.kuklfnapbkmacvwxktbh@aws-0-us-west-2.pooler.supabase.com:5432/other']) assert.throws(() => validateSerialJournalConnection(new URL(u)));
});
test('explicit serial mode selects only the configured provider session port', () => {
  for (const port of ['5432', '6543']) {
    const configured = new URL(`postgres://postgres.kuklfnapbkmacvwxktbh:fixture%40password@aws-0-us-west-2.pooler.supabase.com:${port}/postgres?sslmode=require`);
    const session = serialJournalConnection(configured);
    assert.equal(configured.port, port);
    assert.equal(session.port, '5432');
    for (const key of ['hostname', 'username', 'password', 'pathname', 'search'])
      assert.equal(session[key], configured[key]);
  }
  for (const raw of [
    'postgres://postgres.kuklfnapbkmacvwxktbh@unverified.example:6543/postgres',
    'postgres://postgres.other@aws-0-us-west-2.pooler.supabase.com:6543/postgres',
    'postgres://postgres.kuklfnapbkmacvwxktbh@aws-0-us-west-2.pooler.supabase.com:6432/postgres',
    'postgres://postgres.kuklfnapbkmacvwxktbh@aws-0-us-west-2.pooler.supabase.com:6543/other',
  ]) assert.throws(() => serialJournalConnection(new URL(raw)));
});
test('existing hosted installer exposes the serial option through explicit dispatch only', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/apply-merged-migration.yml', import.meta.url), 'utf8');
  assert.match(workflow, /serial_journal_index:\s*\n\s*description:/);
  assert.match(workflow, /SERIAL_JOURNAL_INDEX: \$\{\{ inputs\.serial_journal_index \}\}/);
  assert.match(workflow, /if \[\[ "\$\{SERIAL_JOURNAL_INDEX:-false\}" == "true" \]\]; then\s*recovery_args\+=\(--serial-journal-index\)/);
  assert.doesNotMatch(workflow, /client_payload\.serial_journal_index/);
  assert.match(workflow, /recovery_args\+=\(--recover-index/);
  assert.match(workflow, /group: apply-merged-migration-\$\{\{ inputs\.migration \|\| github\.event\.client_payload\.migration \}\}\s*cancel-in-progress: false/);
  const start = workflow.indexOf('          recovery_args=()');
  const end = workflow.indexOf('          node scripts/ci/apply-recorded-migration.mjs', start);
  assert.ok(start > 0 && end > start);
  const env = { PATH: process.env.PATH, RECOVER_INDEX: '', RECOVER_OID: '',
    RECOVER_BEFORE: '', RECOVER_TRANSIENT_OID: '', FINAL_TABLE_PAGES: '',
    FINAL_TABLE_OPERATION: '', QUALIFY_RAKE_REPORT_HISTORY: 'false',
    MAINTENANCE_THAW_REPAIR: 'false' };
  for (const value of [undefined, 'false', 'true', 'true; arbitrary command']) {
    const input = { ...env, ...(value === undefined ? {} : { SERIAL_JOURNAL_INDEX: value }) };
    const result = spawnSync('bash', ['-eu', '-c', workflow.slice(start, end) + '\ndeclare -p recovery_args'], { env: input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes('--serial-journal-index'), value === 'true');
  }
  const mixed = spawnSync('bash', ['-eu', '-c', workflow.slice(start, end) + '\ndeclare -p recovery_args'], { env: { ...env, SERIAL_JOURNAL_INDEX: 'true', RECOVER_INDEX: 'fixture' }, encoding: 'utf8' });
  assert.equal(mixed.status, 0, mixed.stderr);
  assert.ok(mixed.stdout.includes('--serial-journal-index') && mixed.stdout.includes('--recover-index'));
});
test('serial setting is applied and read back before the index, never assumed from startup', async () => {
  for (const scenario of ['good', 'wrong-setting', 'different-backend', 'missing-row', 'set-error', 'wrong-user', 'replica', 'wrong-db']) {
    const calls = [];
    const client = { async query(sql) {
      calls.push(sql);
      if (sql.startsWith('SET ')) { if (scenario === 'set-error') throw new Error('refused'); return {}; }
      if (!sql.includes('current_setting')) return { rows: [{ pid: 42, session_user: scenario === 'wrong-user' ? 'other' : 'postgres', current_user: 'postgres', recovery: scenario === 'replica', database: scenario === 'wrong-db' ? 'other' : 'postgres' }] };
      return { rows: scenario === 'missing-row' ? [] : [{ pid: scenario === 'different-backend' ? 43 : 42,
        workers: scenario === 'wrong-setting' ? '8' : '0' }] };
    } };
    const send = async () => { await bindSerialJournalIndex(client); calls.push('CREATE INDEX'); };
    if (scenario === 'good') { await send(); assert.equal(calls.at(-1), 'CREATE INDEX'); }
    else { await assert.rejects(send); assert.ok(!calls.includes('CREATE INDEX')); }
    if (!['wrong-user', 'replica', 'wrong-db'].includes(scenario)) assert.ok(calls.includes('SET max_parallel_maintenance_workers = 0'));
  }
});
test('maintained applier invokes the serial guard immediately before concurrent index send', () => {
  const source = readFileSync(new URL('./apply-recorded-migration.mjs', import.meta.url), 'utf8');
  assert.match(source, /validateSerialJournalIndex\(\{/);
  assert.match(source, /connectionURL = serialJournalConnection\(connectionURL\)/);
  assert.match(source, /if \(serialJournalIndex\) \{\s*try \{\s*await bindSerialJournalIndex\(client\);/);
  const bound = source.indexOf('await bindSerialJournalIndex(client);');
  const refusal = source.indexOf("refused('serial journal session identity or worker bound unproven. No index was sent.');", bound);
  const send = source.indexOf('await client.query(ix.statement);', bound);
  assert.ok(bound > 0 && refusal > bound && send > refusal);
});

test('Chicago cash recovery binds exact source, predicate, OID and sole index', () => {
  const sql = readFileSync(
    new URL('../../supabase/migrations/' + CHICAGO_FILE, import.meta.url),
    'utf8'
  );
  const r = recoveryRequest(CHICAGO_FILE, sql, CHICAGO_INDEX, '232930889', '2026-10-23T22:25:14Z');
  assert.equal(recoveryStatement(r), 'REINDEX INDEX CONCURRENTLY ' + CHICAGO_INDEX);
  assert.match(recoveryCatalog(r), /ca_hand_facts_cash_member_time_idx/);
  const cash = {
    ...row,
    oid: r.oid,
    name: 'ca_hand_facts_cash_member_time_idx',
    table_name: 'ca_hand_facts',
    definition:
      'CREATE INDEX ca_hand_facts_cash_member_time_idx ON public.ca_hand_facts USING btree (user_id, played_at) WHERE (tournament_id IS NULL)',
    no_predicate: false,
  };
  assert.equal(validateRecoveryCatalog([cash], r), cash);
  for (const patch of [
    { no_predicate: true },
    { definition: cash.definition.replace('NULL', 'NOT NULL') },
    { valid: true },
    { oid: '232930890' },
    { no_builder: false },
    { no_transients: false },
    { no_constraints: false },
  ])
    assert.throws(() => validateRecoveryCatalog([{ ...cash, ...patch }], r));
  assert.throws(() => validateRecoveryCatalog([{ ...cash, valid: true }], r, true));
  assert.doesNotThrow(() =>
    validateRecoveryCatalog([{ ...cash, oid: '232930890', valid: true }], r, true)
  );
  assert.throws(() => recoveryRequest(CHICAGO_FILE, sql + ' ', CHICAGO_INDEX, r.oid, r.before));
  assert.throws(() =>
    recoveryRequest(CHICAGO_FILE, sql, CHICAGO_INDEX, r.oid, r.before, '232930890')
  );
  assert.throws(() => cleanupStatement(r));
});
test('installer binds and verifies backend identity after pool startup replacement', () => {
  const s = readFileSync(new URL('./apply-recorded-migration.mjs', import.meta.url), 'utf8');
  const connected = s.indexOf('await client.connect()');
  const bound = s.indexOf(`SET application_name = 'apply-recorded-migration'`, connected);
  const checked = s.indexOf(`identity.rows[0]?.name !== 'apply-recorded-migration'`, bound);
  assert.ok(connected < bound && bound < checked && checked < s.indexOf('let already;'));
});
