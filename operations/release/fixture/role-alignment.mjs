import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';
import { captureFixtureServicePreimage } from './service-preimage.mjs';
import {
  withHeldFixtureRoleAlignmentClient,
  assertHeldFixtureRoleAlignmentClient,
  renderFixtureRoleAlignmentSql,
} from './role-alignment-render.mjs';

// These immutable image files are source authority, never a runtime manifest.
const pins = Object.freeze({
  'role-alignment-installer.sql':
    '75de4863de9a9276e701526389a6fbe0a033589d60844b71dd42eb44fbdf31db',
  'role-alignment-native.json': '3427e7aa498973eb09f4a3d3ae04a78bb6795f372b84234f09594ae60ec7ba30',
  'role-alignment-aligned.json': 'd0d858e8dbb70afca05d3e84be6ce109b818ea1ba278813d9d4b6afd062e2083',
  'role-alignment-graph.sql': '3582de41dcf8af409d2c485b18465e7b3ec22e4c6c42db9b029dbf60b6cbb29d',
  'role-alignment-membership.sql':
    '54e090026febbb5eaa32c1a5ce5aff171249144fa727058a5bc9ed4fa704136f',
});
const identitySql = `SELECT pg_backend_pid() AS pid, current_database() AS database,
  session_user AS session_role, current_user AS current_role,
  current_setting('is_superuser')::boolean AS superuser,
  current_setting('default_transaction_read_only') AS read_only,
  inet_server_addr() IS NULL AS local_socket,
  (SELECT (extract(epoch FROM backend_start)*1000000)::bigint::text
     FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS backend_start_micros`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const failure = (code) => Object.assign(new Error(code), { code });
const now = () => performance.now();

async function loadInputs() {
  const files = {};
  for (const [name, expected] of Object.entries(pins)) {
    const bytes = await readFile(new URL('./' + name, import.meta.url));
    assert.ok(bytes.length > 0 && bytes.length <= 256 * 1024);
    assert.equal(hash(bytes), expected, 'FIXTURE_ROLE_SOURCE_PIN_REQUIRED');
    files[name] = bytes.toString('utf8');
  }
  return {
    template: files['role-alignment-installer.sql'],
    native: JSON.parse(files['role-alignment-native.json']),
    aligned: JSON.parse(files['role-alignment-aligned.json']),
    graph: files['role-alignment-graph.sql'],
    membership: files['role-alignment-membership.sql'],
  };
}

// A race timeout does not claim cancellation or rollback. The caller closes the
// actual installer and observes backend absence before classifying its catalog.
async function bounded(action, deadline, signals = []) {
  if (now() >= deadline) throw failure('FIXTURE_ROLE_DEADLINE');
  if (signals.some((signal) => signal?.aborted)) throw failure('FIXTURE_ROLE_ABORTED');
  let timer;
  const removals = [];
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(failure('FIXTURE_ROLE_DEADLINE')), deadline - now());
        for (const signal of signals.filter(Boolean)) {
          const aborted = () => reject(failure('FIXTURE_ROLE_ABORTED'));
          signal.addEventListener('abort', aborted, { once: true });
          removals.push(() => signal.removeEventListener('abort', aborted));
        }
      }),
    ]);
  } finally {
    clearTimeout(timer);
    for (const remove of removals) remove();
  }
}

function finalCommand(result, expected) {
  const rows = Array.isArray(result) ? result : [result];
  assert.equal(rows.at(-1)?.command, expected, 'FIXTURE_ROLE_FINAL_COMMAND_REQUIRED');
}

function catalogOnly(captured) {
  const catalog = JSON.parse(captured.serialized);
  delete catalog.observed_at;
  return catalog;
}

// Client is the actual pg.Client imported by fixture-server. applicationClient
// is its already-connected, supervisor-owned postgres session. Controlled unit
// doubles exercise this lifecycle; they are not native SQL or socket evidence.
export async function alignFixtureRoles({
  applicationClient,
  Client,
  password,
  signal,
  deadlineMs = 60000,
}) {
  assert.ok(Number.isInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 60000);
  assert.equal(typeof Client, 'function');
  // The accepted binding helper queries the actual client directly. Pin the
  // public pg connection configuration that bounds that handshake query too.
  assert.ok(
    Number.isInteger(applicationClient?.connectionParameters?.query_timeout) &&
      applicationClient.connectionParameters.query_timeout > 0 &&
      applicationClient.connectionParameters.query_timeout <=
        Math.min(5000, Math.floor(deadlineMs / 3)),
    'FIXTURE_ROLE_HELD_CLIENT_TIMEOUT_REQUIRED'
  );
  const deadline = now() + deadlineMs;
  const workDeadline = now() + Math.floor((deadlineMs * 2) / 3);
  const records = [];
  let installer,
    inputs,
    recovered = false;
  const proof = {
    scope: 'native-full-role-installer',
    status: 'failed',
    stage: 'source',
    template_sha256: pins['role-alignment-installer.sql'],
    install_submitted: false,
    commit_acknowledged: false,
    catalog_outcome: 'unobserved',
    rollback_acknowledged: false,
    separate_read_only_observers: 0,
    graph_assertion: false,
    membership_assertion: false,
    actual_login_and_default_acl_tests: false,
    post_alignment_services: false,
    full_schema_ready: false,
    funded_or_production_complete: false,
  };

  const make = (readOnly) => {
    const client = new Client({
      host: '/run/postgresql',
      user: 'supabase_admin',
      database: 'club_arena_qualification',
      connectionTimeoutMillis: 5000,
      query_timeout: 8000,
      statement_timeout: 8000,
      options:
        '-c search_path=pg_catalog -c lock_timeout=2000' +
        (readOnly ? ' -c default_transaction_read_only=on' : ''),
    });
    assert.notEqual(client, applicationClient, 'FIXTURE_ROLE_DISTINCT_CLIENT_REQUIRED');
    assert.ok(
      !records.some((record) => record.client === client),
      'FIXTURE_ROLE_FRESH_CLIENT_REQUIRED'
    );
    const record = {
      client,
      readOnly,
      ended: false,
      endPromise: null,
      identity: null,
      abort: new AbortController(),
    };
    record.onError = () => record.abort.abort();
    record.onEnd = () => {
      record.ended = true;
    };
    client.on('error', record.onError);
    client.on('end', record.onEnd);
    records.push(record);
    return record;
  };
  const close = async (record, until) => {
    if (!record) return;
    record.endPromise ??= Promise.resolve().then(() => record.client.end());
    await bounded(() => record.endPromise, until);
    assert.equal(record.ended, true, 'FIXTURE_ROLE_CLIENT_END_UNOBSERVED');
  };
  const query = (record, text, until, primary = false, values) =>
    bounded(
      () =>
        record.client.query({
          text,
          values,
          query_timeout: Math.max(1, Math.floor(until - now())),
        }),
      until,
      [record.abort.signal, ...(primary ? [signal] : [])]
    );
  const connect = async (record, until, primary) => {
    await bounded(() => record.client.connect(), until, [
      record.abort.signal,
      ...(primary ? [signal] : []),
    ]);
    const response = await query(record, identitySql, until, primary);
    assert.equal(response.rows?.length, 1, 'FIXTURE_ROLE_OBSERVER_IDENTITY_REQUIRED');
    const row = response.rows[0];
    assert.ok(Number.isInteger(row.pid) && row.pid > 0 && row.pid === record.client.processID);
    assert.notEqual(row.pid, applicationClient.processID);
    assert.equal(row.database, 'club_arena_qualification');
    assert.equal(row.session_role, 'supabase_admin');
    assert.equal(row.current_role, 'supabase_admin');
    assert.equal(row.superuser, true);
    assert.equal(row.local_socket, true);
    assert.ok(
      typeof row.backend_start_micros === 'string' &&
        /^[1-9][0-9]{12,18}$/.test(row.backend_start_micros)
    );
    if (record.readOnly)
      assert.equal(row.read_only, 'on', 'FIXTURE_ROLE_READ_ONLY_OBSERVER_REQUIRED');
    record.identity = row;
  };
  const observer = async (operation, until, primary = false) => {
    const record = make(true);
    try {
      await connect(record, until, primary);
      proof.separate_read_only_observers++;
      return await operation(record);
    } finally {
      await close(record, Math.min(deadline, now() + 3000));
    }
  };
  const snapshot = (record, until) =>
    bounded(
      () => captureFixtureServicePreimage(record.client, applicationClient.processID),
      until,
      [record.abort.signal]
    );
  const waitInstallerAbsent = async (record, until) => {
    if (!installer?.client.processID) return;
    for (;;) {
      await query(record, 'SELECT pg_stat_clear_snapshot()', until);
      const result = await query(
        record,
        `SELECT NOT EXISTS (
        SELECT FROM pg_catalog.pg_stat_activity WHERE pid=$1
        AND ($2::bigint IS NULL OR (extract(epoch FROM backend_start)*1000000)::bigint=$2::bigint)
      ) AS absent`,
        until,
        false,
        [installer.client.processID, installer.identity?.backend_start_micros ?? null]
      );
      if (result.rows?.length === 1 && result.rows[0].absent === true) return;
      await bounded(() => new Promise((resolve) => setTimeout(resolve, 100)), until);
    }
  };
  const recover = async () => {
    if (recovered) return;
    recovered = true;
    proof.stage = 'recovery';
    if (installer && !installer.ended) {
      if (proof.install_submitted) {
        try {
          finalCommand(
            await query(installer, 'ROLLBACK', Math.min(deadline, now() + 2000)),
            'ROLLBACK'
          );
          proof.rollback_acknowledged = true;
        } catch {
          proof.rollback_acknowledged = false;
        }
      }
      try {
        await close(installer, Math.min(deadline, now() + 3000));
      } catch {
        proof.installer_close_unobserved = true;
      }
    }
    try {
      await observer(async (record) => {
        await waitInstallerAbsent(record, Math.min(deadline, now() + 5000));
        proof.installer_backend_absent = true;
        const captured = await snapshot(record, deadline);
        const actual = catalogOnly(captured);
        proof.catalog_outcome = isDeepStrictEqual(actual, inputs?.native)
          ? 'original'
          : isDeepStrictEqual(actual, inputs?.aligned)
            ? 'committed'
            : 'neither';
        proof.recovery_catalog_sha256 = captured.proof.catalog_sha256;
      }, deadline);
    } catch {
      proof.catalog_outcome = 'unobserved';
    }
  };

  let accepted = false;
  try {
    inputs = await bounded(loadInputs, workDeadline, [signal]);
    await withHeldFixtureRoleAlignmentClient(applicationClient, async (binding) => {
      try {
        proof.stage = 'original-catalog';
        await observer(
          async (record) => {
            const captured = await snapshot(record, workDeadline);
            assert.ok(
              isDeepStrictEqual(catalogOnly(captured), inputs.native),
              'FIXTURE_ROLE_ORIGINAL_CATALOG_REQUIRED'
            );
            proof.original_catalog_sha256 = captured.proof.catalog_sha256;
          },
          workDeadline,
          true
        );
        assertHeldFixtureRoleAlignmentClient(binding);
        const sql = renderFixtureRoleAlignmentSql(inputs.template, {
          password,
          clientBinding: binding,
        });
        installer = make(false);
        await connect(installer, workDeadline, true);
        assertHeldFixtureRoleAlignmentClient(binding);
        proof.stage = 'installer';
        proof.install_submitted = true;
        finalCommand(await query(installer, sql, workDeadline, true), 'COMMIT');
        proof.commit_acknowledged = true;
        await close(installer, Math.min(deadline, now() + 3000));
        assertHeldFixtureRoleAlignmentClient(binding);
        proof.stage = 'new-postimage-observer';
        await observer(
          async (record) => {
            await waitInstallerAbsent(record, Math.min(deadline, now() + 5000));
            proof.installer_backend_absent = true;
            const captured = await snapshot(record, deadline);
            assert.ok(
              isDeepStrictEqual(catalogOnly(captured), inputs.aligned),
              'FIXTURE_ROLE_ALIGNED_CATALOG_REQUIRED'
            );
            proof.catalog_outcome = 'committed';
            proof.aligned_catalog_sha256 = captured.proof.catalog_sha256;
          },
          deadline,
          true
        );
        for (const [name, sql] of [
          ['graph', inputs.graph],
          ['membership', inputs.membership],
        ]) {
          assertHeldFixtureRoleAlignmentClient(binding);
          proof.stage = 'new-' + name + '-observer';
          await observer(
            async (record) => finalCommand(await query(record, sql, deadline, true), 'ROLLBACK'),
            deadline,
            true
          );
          proof[name + '_assertion'] = true;
        }
        assertHeldFixtureRoleAlignmentClient(binding);
      } catch (error) {
        proof.failed_stage = proof.stage;
        await recover();
        throw error;
      }
    });
    accepted = true;
  } catch (error) {
    proof.failed_stage ??= proof.stage;
    if (typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code))
      proof.sqlstate = error.code;
    if (
      [
        'FIXTURE_ORIGINAL_BOOTSTRAP_REQUIRED',
        'FIXTURE_QUIESCENT_INSTALLATION_REQUIRED',
        'FIXTURE_FULL_ROLE_PREIMAGE_REQUIRED',
        'FIXTURE_FULL_ROLE_POSTIMAGE_REQUIRED',
      ].includes(error?.message)
    )
      proof.refusal = error.message;
    await recover();
  } finally {
    const closes = await Promise.allSettled(records.map((record) => close(record, deadline)));
    proof.all_driver_clients_closed =
      closes.every((value) => value.status === 'fulfilled') &&
      records.every((record) => record.ended);
    for (const record of records) {
      if (record.ended) {
        record.client.off('error', record.onError);
        record.client.off('end', record.onEnd);
      }
    }
  }
  if (accepted && proof.all_driver_clients_closed && !signal?.aborted) {
    proof.status = 'passed';
    proof.stage = 'complete';
    return Object.freeze(proof);
  }
  // A committed catalog after transport loss stays a failed, classified run.
  // No raw SQL, passwords, driver messages, cause or automatic retry is exposed.
  throw Object.assign(new Error('FIXTURE_ROLE_ALIGNMENT_FAILED'), {
    proof: Object.freeze(proof),
    ...(proof.sqlstate ? { code: proof.sqlstate } : {}),
  });
}
