import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { createProviderProbePeer } from './provider-probe-peer.mjs';
import { providerSql as sql, providerVersions } from './provider-semantic-sql.mjs';

const keyFile = '/run/club-arena-qualification/private/provider-key';
const keyScript = '/usr/local/bin/fixture-provider-getkey';
// Docker mounts /run with noexec. Only this immutable image launcher executes;
// its key remains private data in disposable tmpfs, never executable content.
export const providerKeyLauncher = '#!/bin/sh\nexec /bin/cat ' + keyFile + '\n';
const exec = promisify(execFile);
const database = 'club_arena_qualification';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const providerPostgresArguments = Object.freeze([
  '-c', 'shared_preload_libraries=pg_stat_statements,pg_cron,pg_net,supabase_vault',
  '-c', 'pg_net.database_name=' + database,
  '-c', 'pg_net.username=supabase_admin',
  '-c', 'vault.getkey_script=' + keyScript,
]);
export async function createProviderKeyFile(file) {
  // Fresh synthetic key lives only in private disposable tmpfs. It never enters
  // logs, SQL, image layers, caller environment or the qualification receipt.
  const key = randomBytes(32).toString('hex');
  await writeFile(file, key + '\n', { flag: 'wx', mode: 0o400 });
  return key + '\n';
}
export async function prepareProviderKey() {
  assert.equal(await readFile(keyScript, 'utf8'), providerKeyLauncher,
    'FIXTURE_PROVIDER_KEY_LAUNCHER_REQUIRED');
  const expected = await createProviderKeyFile(keyFile);
  // Exercise the actual immutable executable before starting PostgreSQL. Raw
  // output is compared in memory and never included in a public diagnostic.
  const { stdout, stderr } = await exec(keyScript, [], { timeout: 5000, maxBuffer: 1024 });
  assert.equal(stdout, expected, 'FIXTURE_PROVIDER_KEY_READ_REQUIRED');
  assert.equal(stderr, '', 'FIXTURE_PROVIDER_KEY_STDERR_REFUSED');
}
export function assertProviderPostgresVersion(version) {
  // The pinned Debian package adds its exact packaging suffix to pg_config.
  assert.ok(version === 'PostgreSQL 17.11' ||
    version === 'PostgreSQL 17.11 (Debian 17.11-0+deb13u1)',
    'FIXTURE_PROVIDER_POSTGRES_VERSION');
}
export async function providerBuildEvidence() {
  const bytes = await readFile('/opt/qualification/provenance/genuine-providers.json');
  assert.ok(bytes.length > 0 && bytes.length <= 128 * 1024);
  const built = JSON.parse(bytes);
  assert.equal(built.scope, 'genuine-provider-build');
  assertProviderPostgresVersion(built.postgres);
  const libraries = { postgis: 'postgis-3.so', pg_net: 'pg_net.so', http: 'http.so', supabase_vault: 'supabase_vault.so', plpgsql_check: 'plpgsql_check-2.7.so' };
  for (const [name, version] of Object.entries(providerVersions)) {
    const item = built.providers[name];
    assert.equal(item.version, version);
    assert.equal(item.library, libraries[name]);
    assert.equal(hash(await readFile('/usr/lib/postgresql/17/lib/' + item.library)), item.library_sha256);
    assert.equal(hash(await readFile('/usr/share/postgresql/17/extension/' + name + '.control')), item.control_sha256);
    const expected = name === 'supabase_vault' ? ['supabase_vault--0.3.0.sql', 'supabase_vault--0.3.0--0.3.1.sql'] : [name + '--' + version + '.sql'];
    assert.deepEqual(item.sql_install_path.map((row) => row.file), expected);
    for (const file of item.sql_install_path)
      assert.equal(hash(await readFile('/usr/share/postgresql/17/extension/' + file.file)), file.sha256);
  }
  return hash(bytes);
}

function finalCommand(result, command) {
  assert.equal((Array.isArray(result) ? result : [result]).at(-1)?.command, command, 'FIXTURE_PROVIDER_FINAL_COMMAND');
}
export function assertProviderCatalog(rows) {
  assert.ok(Array.isArray(rows) && rows.length > 100 && rows.length < 10000);
  for (const row of rows) assert.equal(row.owner, 'supabase_admin');
  const symbols = [
    ['http', 'http', '$libdir/http'],
    ['pg_net', 'wake', 'pg_net'],
    ['supabase_vault', '_crypto_aead_det_encrypt', '$libdir/supabase_vault'],
    ['supabase_vault', '_crypto_aead_det_decrypt', '$libdir/supabase_vault'],
    ['plpgsql_check', 'plpgsql_check_function_tb', '$libdir/plpgsql_check-2.7'],
    ['postgis', 'st_makepoint', '$libdir/postgis-3'],
  ];
  for (const [extension, name, library] of symbols)
    assert.ok(rows.some((row) => row.extension === extension && row.name === name && row.library === library && row.language === 'c'), 'FIXTURE_PROVIDER_NATIVE_SYMBOL');
  for (const name of ['create_secret', 'update_secret']) {
    const row = rows.find((row) => row.extension === 'supabase_vault' && row.name === name);
    assert.equal(row?.security_definer, true);
    assert.deepEqual(row.settings, ['search_path=""']);
  }
  return hash(JSON.stringify(rows));
}

// Real pg.Client is supplied by fixture-server. No DSN/URL/table/function name
// can be supplied by a caller. The accepted full-role proof is a prerequisite.
export async function qualifyFixtureProviders({ Client, signal, buildSha256, roleProof, deadlineMs = 60000, peerFactory = createProviderProbePeer }) {
  assert.equal(roleProof?.scope, 'native-full-role-installer');
  assert.equal(roleProof?.status, 'passed');
  assert.equal(roleProof?.catalog_outcome, 'committed');
  assert.equal(roleProof?.graph_assertion, true);
  assert.equal(roleProof?.membership_assertion, true);
  assert.equal(roleProof?.all_driver_clients_closed, true);
  assert.match(buildSha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 60000);
  const deadline = performance.now() + deadlineMs;
  const workDeadline = performance.now() + Math.floor(deadlineMs * 3 / 4);
  const records = [];
  let peer, peerTask, peerClosePromise, installer, observer;
  let retiringPeer = false;
  const ids = [];
  let secretId = null;
  const proof = {
    scope: 'native-five-provider-semantics', status: 'failed', stage: 'identity',
    build_sha256: buildSha256, versions: providerVersions, catalog_sha256: null,
    genuine_symbols: false, role_acl_catalog: false, actual_anon_vault_denial: false,
    postgis_geometry_geography_gist: false, http_private_response: false,
    pg_net_worker_identity: false, pg_net_commit_only: false, pg_net_rollback_absent: false,
    vault_encrypt_update_rollback: false, plpgsql_valid_invalid: false,
    dummy_objects_removed: false, all_probe_clients_closed: false, private_http_closed: false,
    production_binary_parity: false, complete_catalog_parity: false,
    actual_login_and_default_acl_tests: false, post_alignment_services: false,
    full_schema_ready: false, funded_or_production_complete: false,
  };
  async function bounded(action, cleanup = false) {
    const until = cleanup ? deadline : workDeadline;
    assert.ok((cleanup || !signal?.aborted) && performance.now() < until, 'FIXTURE_PROVIDER_DEADLINE');
    let timer, abort;
    try {
      return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
        const fail = () => reject(new Error('FIXTURE_PROVIDER_DEADLINE'));
        timer = setTimeout(fail, Math.max(1, until - performance.now()));
        abort = cleanup ? undefined : fail;
        if (abort) signal?.addEventListener('abort', abort, { once: true });
      })]);
    } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
  }
  async function closePeer() {
    if (!peer) return;
    // Start disposal even when a late acquisition outlives the cleanup budget.
    // The receipt still fails if physical closure cannot be observed in time.
    peerClosePromise ??= Promise.resolve().then(() => peer.close());
    // Retain rejection ownership even if bounded() rejects before attaching.
    peerClosePromise.catch(() => undefined);
    await bounded(() => peerClosePromise, true);
    proof.private_http_closed = true;
  }
  async function close(record) {
    if (record.ended) return;
    record.endPromise ??= Promise.resolve().then(() => record.client.end());
    record.endPromise.catch(() => undefined);
    await bounded(() => record.endPromise, true);
    assert.equal(record.ended, true, 'FIXTURE_PROVIDER_CLIENT_END');
  }
  async function query(record, text, values) {
    assert.equal(record.failed, false, 'FIXTURE_PROVIDER_CLIENT_FAILED');
    return bounded(() => record.client.query({ text, values, query_timeout: Math.min(5000, Math.max(1, Math.floor(deadline - performance.now()))) }));
  }
  async function connect(readOnly = false) {
    const client = new Client({ host: '/run/postgresql', user: 'supabase_admin', database,
      connectionTimeoutMillis: 3000, query_timeout: 5000, statement_timeout: 4000,
      options: '-c search_path=pg_catalog -c lock_timeout=2000' + (readOnly ? ' -c default_transaction_read_only=on' : '') });
    assert.ok(records.every((r) => r.client !== client));
    const record = { client, ended: false, failed: false };
    client.on('error', () => { record.failed = true; });
    client.once('end', () => { record.ended = true; });
    records.push(record);
    await bounded(() => client.connect());
    const row = (await query(record, sql.identity)).rows[0];
    assert.deepEqual(row, { pid: client.processID, database, role: 'supabase_admin', session_role: 'supabase_admin', local: true, superuser: true, read_only: readOnly ? 'on' : 'off', version_num: '170011' });
    assert.ok(Number.isInteger(row.pid) && row.pid > 0);
    assert.ok(records.filter((r) => r.client.processID === row.pid).length === 1);
    return record;
  }
  const pause = (ms) => bounded(() => new Promise((resolve) => setTimeout(resolve, ms)));
  async function waitFor(action) {
    for (let n = 0; n < 50; n++) { if (await action()) return; await pause(100); }
    throw new Error('FIXTURE_PROVIDER_OBSERVATION_TIMEOUT');
  }
  async function response(id) {
    await waitFor(async () => {
      const result = await query(observer, sql.response, [id]);
      if (result.rows.length === 0) return false;
      assert.deepEqual(result.rows, [{ status_code: 200, content: peer.body, timed_out: false, error_msg: null }]);
      return true;
    });
  }
  async function enqueue(name) {
    const id = (await query(installer, sql.enqueue, [peer.url(name)])).rows[0]?.id;
    assert.match(String(id), /^[1-9][0-9]{0,18}$/);
    ids.push(String(id));
    return String(id);
  }
  try {
    installer = await connect();
    const empty = await query(installer, sql.empty, [Object.keys(providerVersions)]);
    assert.deepEqual(empty.rows, [{ empty: true }]);
    proof.stage = 'install';
    finalCommand(await query(installer, sql.install), 'COMMIT');
    observer = await connect(true);
    assert.deepEqual((await query(observer, sql.inventory, [Object.keys(providerVersions)])).rows,
      Object.entries(providerVersions).map(([name, version]) => ({ name, version, schema: name === 'supabase_vault' ? 'vault' : 'extensions', owner: 'supabase_admin' })));
    proof.catalog_sha256 = assertProviderCatalog((await query(observer, sql.catalog, [Object.keys(providerVersions)])).rows);
    proof.genuine_symbols = true;
    const acl = (await query(observer, sql.acl)).rows;
    assert.deepEqual(acl, [Object.fromEntries(['vault_schema_denied','vault_create_denied','vault_table_denied','net_schema_public','net_get_public','net_queue_public','http_public','extensions_usage','extensions_create_denied'].map((key) => [key, true]))]);
    proof.role_acl_catalog = true;
    await query(installer, 'BEGIN');
    await query(installer, 'SET LOCAL ROLE anon');
    let denied = false;
    try { await query(installer, sql.vaultDenied); } catch (error) { assert.equal(error.code, '42501'); denied = true; }
    assert.equal(denied, true);
    finalCommand(await query(installer, 'ROLLBACK'), 'ROLLBACK');
    proof.actual_anon_vault_denial = true;
    proof.stage = 'postgis';
    const spatial = await query(installer, sql.postgis);
    finalCommand(spatial, 'ROLLBACK');
    const plan = spatial.find((r) => r.command === 'EXPLAIN')?.rows[0]?.['QUERY PLAN'];
    assert.ok(JSON.stringify(plan).includes('provider_points_gist'), 'FIXTURE_PROVIDER_GIST_PLAN');
    proof.postgis_geometry_geography_gist = true;
    proof.stage = 'plpgsql-check';
    finalCommand(await query(installer, sql.plpgsql), 'ROLLBACK');
    proof.plpgsql_valid_invalid = true;
    proof.stage = 'vault';
    secretId = (await query(installer, sql.vaultCreate, ['fixture-dummy-alpha'])).rows[0]?.id;
    assert.match(secretId, /^[a-f0-9-]{36}$/);
    const vault = async (value) => assert.deepEqual((await query(observer, sql.vaultRead, [secretId, value])).rows, [{ encrypted: true, decrypted: true, authenticated_ciphertext: true }]);
    await vault('fixture-dummy-alpha');
    await query(installer, sql.vaultUpdate, [secretId, 'fixture-dummy-beta']);
    await vault('fixture-dummy-beta');
    await query(installer, 'BEGIN');
    await query(installer, sql.vaultUpdate, [secretId, 'fixture-dummy-rolled-back']);
    finalCommand(await query(installer, 'ROLLBACK'), 'ROLLBACK');
    await vault('fixture-dummy-beta');
    proof.vault_encrypt_update_rollback = true;
    proof.stage = 'private-http';
    // Keep ownership of acquisition after the work deadline or cancellation.
    // A listener that arrives late must still be disposed, never abandoned.
    peerTask = Promise.resolve().then(peerFactory).then(async (acquired) => {
      peer = acquired;
      if (retiringPeer) await closePeer();
      return acquired;
    });
    // Acquisition can reject after a stall leaves no time for bounded() to attach.
    peerTask.catch(() => undefined);
    peer = await bounded(() => peerTask);
    // The pinned extension rejects FOLLOWLOCATION as a runtime option. Its
    // genuine GET behavior remains unchanged. The destination and response
    // belong to our fixed loopback peer, which never supplies a redirect.
    assert.deepEqual((await query(installer, sql.httpOptions)).rows, [{ timeout: true, connect_timeout: true, proxy_disabled: true }]);
    assert.deepEqual((await query(installer, sql.http, [peer.url('http')])).rows, [{ status: 200, content_type: 'application/json', content: peer.body }]);
    peer.assertHits({ http: 1, commit: 0, rollback: 0, sentinel: 0 });
    proof.http_private_response = true;
    proof.stage = 'pg-net';
    assert.deepEqual((await query(observer, sql.preload)).rows, [{ libraries: 'pg_stat_statements,pg_cron,pg_net,supabase_vault', database, username: 'supabase_admin', key_script: keyScript }]);
    await query(installer, 'SELECT net.wait_until_running()');
    assert.deepEqual((await query(observer, sql.worker)).rows, [{ workers: 1 }]);
    proof.pg_net_worker_identity = true;
    await query(installer, 'BEGIN');
    const committed = await enqueue('commit');
    await pause(300);
    assert.deepEqual((await query(observer, sql.queueInvisible, [committed])).rows, [{ absent: true }]);
    peer.assertHits({ http: 1, commit: 0, rollback: 0, sentinel: 0 });
    finalCommand(await query(installer, 'COMMIT'), 'COMMIT');
    await response(committed);
    peer.assertHits({ http: 1, commit: 1, rollback: 0, sentinel: 0 });
    proof.pg_net_commit_only = true;
    await query(installer, 'BEGIN');
    const rolledBack = await enqueue('rollback');
    finalCommand(await query(installer, 'ROLLBACK'), 'ROLLBACK');
    const sentinel = await enqueue('sentinel');
    await response(sentinel);
    await pause(300);
    assert.deepEqual((await query(observer, sql.queueInvisible, [rolledBack])).rows, [{ absent: true }]);
    peer.assertHits({ http: 1, commit: 1, rollback: 0, sentinel: 1 });
    proof.pg_net_rollback_absent = true;
    proof.stage = 'cleanup';
    await close(installer);
    await close(observer);
    const cleaner = await connect();
    await query(cleaner, 'BEGIN');
    await query(cleaner, 'DELETE FROM net._http_response WHERE id=ANY($1::bigint[])', [ids]);
    await query(cleaner, 'DELETE FROM net.http_request_queue WHERE id=ANY($1::bigint[])', [ids]);
    await query(cleaner, 'DELETE FROM vault.secrets WHERE id=$1::uuid', [secretId]);
    await query(cleaner, 'DROP SCHEMA fixture_provider_probe CASCADE');
    finalCommand(await query(cleaner, 'COMMIT'), 'COMMIT');
    await close(cleaner);
    const fresh = await connect(true);
    assert.deepEqual((await query(fresh, sql.cleaned, [ids, secretId])).rows, [{ cleaned: true }]);
    await close(fresh);
    proof.dummy_objects_removed = true;
  } catch (error) {
    // Native diagnostics disclose stage and safe proof only, never SQL/errors.
    proof.failure_type = ['Error', 'AssertionError', 'TypeError', 'RangeError', 'error'].includes(error?.name)
      ? error.name : 'Error';
    proof.sqlstate = typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)
      ? error.code : null;
    throw Object.assign(new Error('FIXTURE_PROVIDER_SEMANTICS_FAILED'), { proof });
  } finally {
    let failed = false;
    retiringPeer = true;
    for (const record of records) {
      try { await close(record); } catch { failed = true; }
    }
    proof.all_probe_clients_closed = records.length > 0 && records.every((r) => r.ended);
    if (peerTask) {
      try { await bounded(() => peerTask, true); } catch { failed = true; }
    }
    try { await closePeer(); } catch { failed = true; }
    if (failed || signal?.aborted || records.some((record) => record.failed)) {
      // Cleanup failure cannot replace the first semantic failure's location.
      proof.failure_type ??= 'Error';
      proof.sqlstate ??= null;
      throw Object.assign(new Error('FIXTURE_PROVIDER_CLEANUP_FAILED'), { proof });
    }
  }
  proof.status = 'passed';
  proof.stage = 'complete';
  return proof;
}
