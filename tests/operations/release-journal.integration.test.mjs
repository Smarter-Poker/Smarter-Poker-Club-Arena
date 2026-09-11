import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, connect, observeSession, observe, configuration, policy } from '../../operations/release/journal.mjs';
import { createCluster } from './postgres-fixture.mjs';

let cluster;
const sockets = new Set();
const actor = 'native-pg17-proof';
const sha = digit => digit.repeat(40);
const deadline = () => new Date(Date.now() + 3600000).toISOString();
const root = fileURLToPath(new URL('../../', import.meta.url));
function intent(head = sha('a'), extra = {}) {
  return { repository: 'Smarter-Poker/Smarter-Poker-Club-Arena', project: 'engine-01', target: 'club-arena-engine',
    head_sha: head, purpose: 'release', manifest: { components: [{ target: 'club-arena-engine', compatibility: 'expand' }] },
    dependencies: [], ...extra };
}
async function db(config) { const client = await connect(config); sockets.add(client); return client; }
async function end(client) { sockets.delete(client); await client.end().catch(() => {}); }
async function enqueue(client, head = sha('a'), extra = {}, key = randomUUID()) {
  return call(client, 'enqueue', [key, intent(head, extra), actor]);
}
async function snapshot(client) { return call(client, 'inspect', [null]); }
async function row(client, id) { return (await snapshot(client)).queue.find(q => q.release_id === id); }
function evidence(s) {
  return { instance_id: s.controller.instance_id, verified: true,
    repository_heads: Object.fromEntries(policy.participants.map(p => [p.repository, sha('a')])),
    components: Object.fromEntries(policy.participants.map(p => [p.target, { receipt_ref: 'native-fixture-only', verified: true }])),
    unresolved_external_ids: s.external.filter(e => ['INTENT', 'UNKNOWN'].includes(e.status)).map(e => e.id),
    receipt_refs: ['native-pg17-fixture:state-snapshot'] };
}
async function reconcile(client) {
  const s = await snapshot(client);
  return call(client, 'reconcile', [s.controller.epoch, s.controller.last_event, evidence(s), actor, 'Native state model reconciliation']);
}
async function owner(client, { activate = true } = {}) {
  const c = await call(client, 'acquire_owner', [randomUUID(), actor]);
  // Test-only administrative fixture exercises future transition guards; this
  // supplies NO provider adapter and executes NO external production operation.
  if (activate) await client.query("UPDATE release_ops.controller SET execution_enabled=true, installed_adapter_receipt='native-fixture-only:not-production'");
  await reconcile(client);
  return c;
}
async function validated(client, c, admission) {
  return receipt(client, c, admission, 'VALIDATION', { accepted_head_sha: admission.intent.head_sha, expected_base_sha: sha('9'), tested_tree_sha: sha('8') });
}
async function transition(client, c, id, state) {
  const current = await row(client, id);
  return call(client, 'transition', [c.owner_id, c.epoch, id, current.state_version, state, actor, 'Native transition proof']);
}
async function receipt(client, c, admission, kind, fields = {}) {
  const event = await call(client, 'record_receipt', [c.owner_id, c.epoch, admission.id, randomUUID(), kind,
    { manifest_digest: admission.manifest_digest, receipt_refs: ['native-fixture:receipt'], success: true, ...fields }, actor]);
  await call(client, 'select_receipt', [c.owner_id, c.epoch, admission.id, (await row(client, admission.id)).state_version, event, actor]);
  return event;
}
async function until(predicate, label) {
  for (let n = 0; n < 100; n++) { const value = await predicate(); if (value) return value; await sleep(10); }
  throw new Error(`Timed out: ${label}`);
}
before(async () => { cluster = await createCluster(); console.log(`Native fixture: ${cluster.version}; data ${cluster.directory}`); });
after(async () => { await Promise.all([...sockets].map(end)); await cluster?.close(); });

test('private migration, role boundaries, immutable history and OBSERVE default', async () => {
  const client = await db(await cluster.database());
  const s = await snapshot(client);
  assert.equal(s.controller.execution_enabled, false);
  assert.equal(s.controller.reconciliation_required, true);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await client.query(`SET ROLE ${role}`);
    await assert.rejects(client.query('SELECT release_ops.inspect(NULL)'), /permission denied/);
    await client.query('RESET ROLE');
  }
  await client.query('SET ROLE release_journal_submitter');
  const a = await enqueue(client);
  await assert.rejects(client.query('UPDATE release_ops.controller SET execution_enabled=true'), /permission denied/);
  await assert.rejects(call(client, 'acquire_owner', [randomUUID(), actor]), /permission denied/);
  await client.query('RESET ROLE');
  await assert.rejects(client.query('UPDATE release_ops.admissions SET actor=$1 WHERE id=$2', ['overwrite', a.id]), /RELEASE_HISTORY_IMMUTABLE/);
  await assert.rejects(client.query('DELETE FROM release_ops.events'), /RELEASE_HISTORY_IMMUTABLE/);
  const c = await owner(client, { activate: false });
  const observed = await snapshot(client);
  await assert.rejects(call(client, 'reconcile', [c.epoch, null, evidence(observed), actor, 'Missing observation version']), /RELEASE_RECONCILIATION_STALE/);
  await assert.rejects(call(client, 'claim_next', [c.owner_id, c.epoch, deadline(), actor]), /RELEASE_EXECUTION_NOT_ACTIVATED/);
  await end(client);
});

test('transactional admission waits through commit and rollback consumes no sequence', async () => {
  const config = await cluster.database(); const first = await db(config); const second = await db(config);
  await first.query('BEGIN');
  const a = (await first.query('SELECT release_ops.enqueue($1,$2,$3) AS v', ['first', intent(sha('a')), actor])).rows[0].v;
  assert.equal(Number(a.admission_seq), 1);
  let finished = false;
  const pending = enqueue(second, sha('b')).finally(() => { finished = true; });
  await until(async () => (await first.query("SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=current_database() AND wait_event_type='Lock'")).rowCount, 'second admission is actually waiting for the row lock');
  assert.equal(finished, false);
  await first.query('ROLLBACK');
  const b = await pending;
  assert.equal(Number(b.admission_seq), 1);
  assert.equal((await snapshot(first)).queue.length, 1);
  await first.query('BEGIN');
  const c = (await first.query('SELECT release_ops.enqueue($1,$2,$3) AS v', ['second-first', intent(sha('c')), actor])).rows[0].v;
  const dPromise = enqueue(second, sha('d'));
  await first.query('COMMIT');
  const d = await dPromise;
  assert.equal(Number(c.admission_seq), 2); assert.equal(Number(d.admission_seq), 3);
  await end(first); await end(second);
});

test('four concurrent agents receive separate durable positions and canonical dedup survives changed caller keys', async () => {
  const config = await cluster.database(); const clients = await Promise.all([1, 2, 3, 4].map(() => db(config)));
  const admitted = await Promise.all(clients.map((client, i) => enqueue(client, sha(String(i + 1)))));
  assert.deepEqual(admitted.map(a => Number(a.admission_seq)).sort(), [1, 2, 3, 4]);
  const duplicates = await Promise.all(clients.map(client => enqueue(client, sha('1'))));
  assert.equal(new Set(duplicates.map(d => d.id)).size, 1);
  assert.ok(duplicates.every(d => d.duplicate));
  const key = 'fixed-client-key'; await enqueue(clients[0], sha('5'), {}, key);
  await assert.rejects(enqueue(clients[0], sha('6'), {}, key), /RELEASE_IDEMPOTENCY_MISMATCH/);
  assert.equal((await snapshot(clients[0])).queue.length, 5);
  await Promise.all(clients.map(end));
});

test('lost COMMIT response reconciles the original admission without replay duplication', async () => {
  const config = await cluster.database(); const writer = await db(config); const reader = await db(config);
  await writer.query('BEGIN');
  await writer.query('SELECT release_ops.enqueue($1,$2,$3)', ['lost-ack', intent(), actor]);
  // COMMIT takes effect before a later statement withholds the multi-statement
  // response; the caller loses its real socket without observing success.
  const response = writer.query('COMMIT; SELECT pg_sleep(0.5)').then(() => 'success', () => 'lost');
  await until(async () => (await reader.query('SELECT count(*)::int AS n FROM release_ops.admissions')).rows[0].n === 1, 'committed admission visible');
  writer.connection.stream.destroy();
  assert.equal(await response, 'lost');
  const recovered = await enqueue(reader, sha('a'), {}, 'lost-ack');
  assert.equal(recovered.duplicate, true); assert.equal(Number(recovered.admission_seq), 1);
  await end(writer); await end(reader);
});

test('dependency admission, withdrawal and emergency ordering preserve prerequisites', async () => {
  const client = await db(await cluster.database());
  await assert.rejects(enqueue(client, sha('a'), { dependencies: [randomUUID()] }), /RELEASE_DEPENDENCY_UNKNOWN_OR_WITHDRAWN/);
  const a = await enqueue(client, sha('a'));
  const b = await enqueue(client, sha('b'), { dependencies: [a.id] });
  const c = await enqueue(client, sha('c'));
  await assert.rejects(call(client, 'withdraw', [a.id, 1, actor, 'Cannot remove prerequisite']), /RELEASE_WITHDRAW_HAS_DEPENDENTS/);
  await assert.rejects(call(client, 'reprioritize', [b.id, a.id, 1, actor, 'Cannot jump prerequisite']), /RELEASE_PRIORITY_DEPENDENCY_ORDER/);
  await call(client, 'reprioritize', [c.id, a.id, 1, actor, 'Emergency independent release']);
  assert.deepEqual((await snapshot(client)).queue.map(q => q.release_id), [c.id, a.id, b.id]);
  assert.equal(Number((await row(client, a.id)).admission.admission_seq), 1);
  await call(client, 'withdraw', [b.id, (await row(client, b.id)).state_version, actor, 'Withdraw dependent first']);
  await call(client, 'withdraw', [a.id, (await row(client, a.id)).state_version, actor, 'Prerequisite now unneeded']);
  await assert.rejects(enqueue(client, sha('d'), { dependencies: [a.id] }), /RELEASE_DEPENDENCY_UNKNOWN_OR_WITHDRAWN/);
  await end(client);
});

test('one native session owns the global row and stale epochs cannot advance it', async () => {
  const config = await cluster.database(); const first = await db(config); const second = await db(config);
  const a = await enqueue(first); const b = await enqueue(first, sha('b'));
  const old = await owner(first);
  await assert.rejects(call(second, 'acquire_owner', [randomUUID(), actor]), /RELEASE_OWNER_BUSY/);
  await call(first, 'claim_next', [old.owner_id, old.epoch, deadline(), actor]);
  assert.equal((await call(first, 'claim_next', [old.owner_id, old.epoch, deadline(), actor])).release_id, a.id);
  await assert.rejects(call(first, 'reprioritize', [b.id, a.id, 1, actor, 'Do not preempt active']), /RELEASE_REPRIORITIZE_QUEUED_ONLY/);
  await end(first);
  const fresh = await call(second, 'acquire_owner', [randomUUID(), actor]);
  assert.notEqual(fresh.epoch, old.epoch); assert.equal(fresh.reconciliation_required, true);
  await assert.rejects(call(second, 'transition', [old.owner_id, old.epoch, a.id, 2, 'MERGING', actor, 'Stale executor']), /RELEASE_STALE_OWNER/);
  await assert.rejects(call(second, 'claim_next', [fresh.owner_id, fresh.epoch, deadline(), actor]), /RELEASE_EXECUTION_NOT_ACTIVATED/);
  await reconcile(second);
  assert.equal((await call(second, 'claim_next', [fresh.owner_id, fresh.epoch, deadline(), actor])).release_id, a.id);
  await end(second);
});

test('external intent commits before action; uncertain work survives takeover and blocks every successor', async () => {
  const config = await cluster.database(); const first = await db(config); const second = await db(config);
  const a = await enqueue(first); await enqueue(first, sha('b'));
  const old = await owner(first);
  await call(first, 'claim_next', [old.owner_id, old.epoch, deadline(), actor]);
  await validated(first, old, a);
  await transition(first, old, a.id, 'MERGING');
  const body = { target: 'club-arena-engine', manifest_digest: a.manifest_digest, expected_current: { head: sha('9') } };
  const operation = await call(first, 'begin_external', [old.owner_id, old.epoch, a.id, 'merge-attempt-1', 'MERGE', body, actor]);
  assert.equal(operation.may_submit, true);
  assert.equal((await snapshot(second)).external[0].status, 'INTENT');
  const duplicate = await call(first, 'begin_external', [old.owner_id, old.epoch, a.id, 'merge-attempt-1', 'MERGE', body, actor]);
  assert.equal(duplicate.id, operation.id); assert.equal(duplicate.may_submit, false);
  await assert.rejects(transition(first, old, a.id, 'BUILDING'), /RELEASE_EXTERNAL_OUTCOME_UNRESOLVED/);
  await assert.rejects(call(first, 'retry', [a.id, (await row(first, a.id)).state_version, 1, 'TRANSPORT', actor, 'Unknown is not retryable']), /RELEASE_EXTERNAL_OUTCOME_UNRESOLVED/);
  await end(first);
  const fresh = await call(second, 'acquire_owner', [randomUUID(), actor]);
  assert.equal((await row(second, a.id)).state, 'UNKNOWN_EXTERNAL_OUTCOME');
  await reconcile(second);
  assert.equal((await call(second, 'claim_next', [fresh.owner_id, fresh.epoch, deadline(), actor])).release_id, a.id);
  await assert.rejects(call(second, 'resolve_external', [fresh.owner_id, fresh.epoch, operation.id, 'SUCCEEDED', { terminal: false }, actor]), /RELEASE_PROVIDER_TERMINAL_PROOF_REQUIRED/);
  const terminal = { terminal: true, operation_id: operation.id, outcome: 'SUCCEEDED', manifest_digest: a.manifest_digest,
    receipt_refs: ['native-fixture:provider-terminal'] };
  await call(second, 'resolve_external', [fresh.owner_id, fresh.epoch, operation.id, 'SUCCEEDED', terminal, actor]);
  await call(second, 'resolve_external', [fresh.owner_id, fresh.epoch, operation.id, 'SUCCEEDED', terminal, actor]);
  assert.equal((await row(second, a.id)).state, 'MERGING');
  assert.equal((await snapshot(second)).controller.active_release, a.id);
  await assert.rejects(call(second, 'resolve_external', [fresh.owner_id, fresh.epoch, operation.id, 'FAILED', terminal, actor]), /RELEASE_EXTERNAL_TERMINAL_MISMATCH/);
  await end(second);
});

test('bounded retries retain active ownership and counters across executor restart', async () => {
  const config = await cluster.database(); let client = await db(config);
  const a = await enqueue(client); let c = await owner(client);
  await call(client, 'claim_next', [c.owner_id, c.epoch, deadline(), actor]);
  await assert.rejects(call(client, 'retry', [a.id, 2, 1, 'FAILED_TEST', actor, 'Never retry failing test']), /RELEASE_RETRY_NOT_ALLOWED/);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await row(client, a.id);
    const wait = await call(client, 'retry', [a.id, r.state_version, 1, 'TRANSPORT', actor, 'Known transient before acceptance']);
    if (attempt === 3) { assert.equal(wait.state, 'BLOCKED'); break; }
    assert.equal(wait.state, 'RETRY_WAIT'); assert.equal(wait.attempt_count, attempt);
    await assert.rejects(call(client, 'resume_retry', [c.owner_id, c.epoch, a.id, deadline(), actor]), /RELEASE_RETRY_NOT_DUE/);
    await end(client); client = await db(config); c = await owner(client);
    await sleep(1050);
    const resumed = await call(client, 'resume_retry', [c.owner_id, c.epoch, a.id, deadline(), actor]);
    assert.equal(resumed.attempt_count, attempt + 1);
  }
  assert.equal((await snapshot(client)).controller.active_release, a.id);
  await assert.rejects(transition(client, c, a.id, 'VALIDATING'), /RELEASE_RETRY_EXHAUSTED/);
  for (let recovery = 1; recovery <= 3; recovery++) {
    const q = await row(client, a.id);
    const revision = await call(client, 'begin_recovery', [c.owner_id, c.epoch, a.id, q.state_version,
      `repair-${recovery}`, recoveryIntent(q), actor, 'Bounded repair after normal retry exhaustion']);
    assert.equal(revision.may_start, true);
    assert.equal((await row(client, a.id)).attempt_count, 3);
    assert.equal((await row(client, a.id)).recovery_attempt_count, recovery);
    await assert.rejects(call(client, 'retry', [a.id, (await row(client, a.id)).state_version, 1, 'TRANSPORT', actor, 'Cannot reset normal budget']), /RELEASE_RECOVERY_RETRY_REQUIRES_NEW_REVISION/);
    await transition(client, c, a.id, 'RECOVERY_REQUIRED');
  }
  const exhausted = await row(client, a.id);
  await assert.rejects(call(client, 'begin_recovery', [c.owner_id, c.epoch, a.id, exhausted.state_version,
    'repair-4', recoveryIntent(exhausted), actor, 'Fourth repair exceeds budget']), /RELEASE_RECOVERY_BUDGET_EXHAUSTED/);
  assert.equal((await snapshot(client)).controller.active_release, a.id);
  await end(client);
});

test('complete state chain requires integration and terminal certification receipts before next claim', async () => {
  const client = await db(await cluster.database()); const a = await enqueue(client); const b = await enqueue(client, sha('b'), { dependencies: [a.id] });
  const c = await owner(client);
  await assert.rejects(call(client, 'claim_next', [c.owner_id, c.epoch, 'infinity', actor]), /RELEASE_DEADLINE_INVALID/);
  await call(client, 'claim_next', [c.owner_id, c.epoch, deadline(), actor]);
  await assert.rejects(transition(client, c, a.id, 'MERGING'), /RELEASE_VALIDATION_RECEIPT_REQUIRED/);
  const validation = await validated(client, c, a);
  await transition(client, c, a.id, 'MERGING');
  await assert.rejects(call(client, 'begin_external', [c.owner_id, c.epoch, a.id, 'cross-target', 'MERGE',
    { target: 'world-hub-web', manifest_digest: a.manifest_digest, expected_current: {} }, actor]), /RELEASE_EXTERNAL_INTENT_INVALID/);
  await assert.rejects(transition(client, c, a.id, 'BUILDING'), /RELEASE_INTEGRATION_RECEIPT_REQUIRED/);
  const integration = await receipt(client, c, a, 'INTEGRATION', { merged_sha: sha('1'), validation_receipt: validation,
    accepted_head_sha: a.intent.head_sha, expected_base_sha: sha('9'), merged_tree_sha: sha('8') });
  await transition(client, c, a.id, 'BUILDING');
  await assert.rejects(transition(client, c, a.id, 'STAGED'), /RELEASE_BUILD_RECEIPT_REQUIRED/);
  const build = await receipt(client, c, a, 'BUILD', { integration_receipt: integration, source_sha: sha('1'),
    artifact: { components: { 'club-arena-engine': { identity: 'native-fixture-artifact' } } } });
  const otherBuild = await call(client, 'record_receipt', [c.owner_id, c.epoch, a.id, 'unrelated-build', 'BUILD',
    { manifest_digest: a.manifest_digest, receipt_refs: ['fixture:unrelated'], success: true,
      artifact: { components: { 'club-arena-engine': { identity: 'unrelated-artifact' } } } }, actor]);
  await transition(client, c, a.id, 'STAGED');
  await assert.rejects(transition(client, c, a.id, 'READY'), /RELEASE_STAGE_RECEIPT_REQUIRED/);
  const stage = await receipt(client, c, a, 'STAGED', { build_receipt: build, compatibility_verified: true });
  await transition(client, c, a.id, 'READY');
  await assert.rejects(transition(client, c, a.id, 'APPLYING'), /RELEASE_READINESS_RECEIPT_REQUIRED/);
  await receipt(client, c, a, 'READINESS', { stage_receipt: stage, technical_gates_passed: true, expected_current: { identity: 'prior-fixture' } });
  await transition(client, c, a.id, 'APPLYING'); await transition(client, c, a.id, 'VERIFYING');
  await assert.rejects(transition(client, c, a.id, 'VERIFIED'), /RELEASE_CERTIFICATION_REQUIRED/);
  const alternateCertification = await call(client, 'record_receipt', [c.owner_id, c.epoch, a.id, 'unrelated-cert', 'CERTIFICATION',
    { manifest_digest: a.manifest_digest, receipt_refs: ['fixture:unrelated-cert'], success: true,
      cleanup_complete: true, unchanged_release: true, build_receipt: otherBuild, served_components: {}, certification_run_id: 'fixture-other-run' }, actor]);
  await assert.rejects(call(client, 'select_receipt', [c.owner_id, c.epoch, a.id,
    (await row(client, a.id)).state_version, alternateCertification, actor]), /RELEASE_RECEIPT_SELECTED_CHAIN_MISMATCH/);
  await receipt(client, c, a, 'CERTIFICATION', { cleanup_complete: true, unchanged_release: true, build_receipt: build,
    served_components: {}, certification_run_id: 'fixture-missing-component' });
  await assert.rejects(transition(client, c, a.id, 'VERIFIED'), /RELEASE_CERTIFICATION_REQUIRED/);
  await receipt(client, c, a, 'CERTIFICATION', { cleanup_complete: false, unchanged_release: true, build_receipt: build, served_components: { 'club-arena-engine': { identity: 'native-fixture-artifact' } }, certification_run_id: 'fixture-run' });
  await assert.rejects(transition(client, c, a.id, 'VERIFIED'), /RELEASE_CERTIFICATION_REQUIRED/);
  await receipt(client, c, a, 'CERTIFICATION', { cleanup_complete: true, unchanged_release: true, build_receipt: build, served_components: { 'club-arena-engine': { identity: 'native-fixture-artifact' } }, certification_run_id: 'fixture-run' });
  await transition(client, c, a.id, 'VERIFIED');
  assert.equal((await call(client, 'claim_next', [c.owner_id, c.epoch, deadline(), actor])).release_id, b.id);
  await end(client);
});

test('LISTEN registration plus startup scan observes admissions despite a lost wakeup and publishes nothing', async () => {
  const config = await cluster.database(); const writer = await db(config); const early = await enqueue(writer);
  const observations = [];
  await observeSession(config, { once: true, emit: value => observations.push(value), afterListen: async () => {
    // Admission in the LISTEN/read overlap must appear once in the snapshot.
    await enqueue(writer, sha('b'));
  } });
  assert.equal(observations.length, 1); assert.equal(observations[0].unresolved_count, 2);
  assert.equal(observations[0].head.release_id, early.id);
  assert.equal((await snapshot(writer)).queue.every(q => q.state === 'QUEUED'), true);
  assert.equal((await snapshot(writer)).external.length, 0);
  const abort = new AbortController(); const stream = [];
  const consumer = observeSession(config, { signal: abort.signal, emit: value => stream.push(value) });
  await until(() => stream.length, 'consumer initial snapshot');
  const later = await enqueue(writer, sha('c'));
  await until(() => stream.some(value => value.unresolved_count === 3), 'notification wakes consumer');
  assert.equal((await row(writer, later.id)).state, 'QUEUED');
  abort.abort(); await consumer;
  await end(writer);
});

test('database restart preserves admissions and mandates a fresh epoch reconciliation', async () => {
  const config = await cluster.database(); const client = await db(config);
  const a = await enqueue(client); const old = await owner(client, { activate: false });
  await end(client);
  cluster.stop(); cluster.start();
  const restarted = await db(config); const fresh = await call(restarted, 'acquire_owner', [randomUUID(), actor]);
  assert.equal((await row(restarted, a.id)).admission.canonical_digest, a.canonical_digest);
  assert.notEqual(fresh.epoch, old.epoch); assert.equal(fresh.reconciliation_required, true);
  const s = await snapshot(restarted);
  await assert.rejects(call(restarted, 'reconcile', [old.epoch, s.controller.last_event, evidence(s), actor, 'Stale pre-restore snapshot']), /RELEASE_RECONCILIATION_STALE/);
  await end(restarted);
});

test('CLI uses durable command path, requires explicit session configuration and rejects execution mode', async () => {
  assert.throws(() => configuration({}), /RELEASE_DATABASE_REFERENCE_REQUIRED/);
  assert.throws(() => configuration({ RELEASE_JOURNAL_DATABASE_URL: 'redacted', RELEASE_JOURNAL_CONNECTION_MODE: 'transaction' }), /RELEASE_VERIFIED_SESSION_CONNECTION_REQUIRED/);
  assert.throws(() => configuration({ RELEASE_JOURNAL_DATABASE_URL: 'redacted', RELEASE_JOURNAL_CONNECTION_MODE: 'session', RELEASE_JOURNAL_MODE: 'EXECUTE' }), /RELEASE_EXECUTION_NOT_IMPLEMENTED_OR_ACTIVATED/);
  const config = await cluster.database(); const filename = path.join(cluster.directory, 'cli-intent.json');
  await writeFile(filename, JSON.stringify(intent()));
  const uri = `postgresql://${config.user}@localhost:${config.port}/${config.database}?host=${encodeURIComponent(config.host)}`;
  async function cli(args) {
    const child = spawn(process.execPath, [path.join(root, 'operations/release/cli.mjs'), ...args], {
      env: { PATH: process.env.PATH, RELEASE_JOURNAL_DATABASE_URL: uri, RELEASE_JOURNAL_CONNECTION_MODE: 'direct' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    const code = await new Promise(resolve => child.on('close', resolve));
    return { code, out, err };
  }
  const submitted = await cli(['enqueue', '--file', filename, '--key', 'cli-1', '--actor', actor]);
  assert.equal(submitted.code, 0, submitted.err); const admitted = JSON.parse(submitted.out);
  const inspected = await cli(['inspect', '--id', admitted.id]); assert.equal(inspected.code, 0, inspected.err);
  assert.equal(JSON.parse(inspected.out).queue[0].release_id, admitted.id);
  const observed = await cli(['observe', '--once']); assert.equal(observed.code, 0, observed.err);
  assert.equal(JSON.parse(observed.out).mode, 'OBSERVE');
  const withdrawn = await cli(['withdraw', '--id', admitted.id, '--version', '1', '--actor', actor, '--reason', 'Native CLI withdrawal']);
  assert.equal(withdrawn.code, 0, withdrawn.err); assert.equal(JSON.parse(withdrawn.out).state, 'CANCELLED');
});

test('canonical intent dedup crosses authenticated caller identities and repository targets stay scoped', async () => {
  const config = await cluster.database(); const admin = await db(config);
  await admin.query('CREATE ROLE release_submitter_fixture LOGIN; GRANT release_journal_submitter TO release_submitter_fixture');
  const submitter = await db({ ...config, user: 'release_submitter_fixture' });
  const original = await enqueue(admin, sha('a'), {}, 'same-key');
  const duplicate = await enqueue(submitter, sha('a'), {}, 'same-key');
  assert.equal(duplicate.id, original.id); assert.equal(duplicate.duplicate, true);
  const alias = await admin.query('SELECT principal FROM release_ops.submissions WHERE release_id=$1 ORDER BY principal', [original.id]);
  assert.equal(new Set(alias.rows.map(row => row.principal)).size, 2);
  await assert.rejects(enqueue(submitter, sha('b'), { repository: 'attacker/unregistered' }), /RELEASE_TARGET_NOT_ALLOWED/);
  await assert.rejects(call(submitter, 'reconcile', [randomUUID(), 1, {}, actor, 'Caller cannot self certify']), /permission denied/);
  await end(submitter); await end(admin);
});

test('documentation completion still requires exact source integration and no-runtime evidence', async () => {
  const client = await db(await cluster.database()); const a = await enqueue(client, sha('a'), { purpose: 'documentation' });
  const c = await owner(client); await call(client, 'claim_next', [c.owner_id, c.epoch, deadline(), actor]);
  await assert.rejects(transition(client, c, a.id, 'DOCUMENTATION_ONLY'), /RELEASE_TRANSITION_INVALID/);
  const validation = await validated(client, c, a);
  await transition(client, c, a.id, 'MERGING');
  await assert.rejects(transition(client, c, a.id, 'DOCUMENTATION_ONLY'), /RELEASE_INTEGRATION_RECEIPT_REQUIRED/);
  const integration = await receipt(client, c, a, 'INTEGRATION', { validation_receipt: validation, accepted_head_sha: a.intent.head_sha,
    expected_base_sha: sha('9'), merged_tree_sha: sha('8'), merged_sha: sha('1') });
  await assert.rejects(transition(client, c, a.id, 'DOCUMENTATION_ONLY'), /RELEASE_DOCUMENTATION_PROOF_REQUIRED/);
  await call(client, 'record_receipt', [c.owner_id, c.epoch, a.id, 'not-selected-documentation', 'DOCUMENTATION',
    { manifest_digest: a.manifest_digest, receipt_refs: ['fixture:docs'], success: true,
      no_runtime_change: true, integration_receipt: integration }, actor]);
  await assert.rejects(transition(client, c, a.id, 'DOCUMENTATION_ONLY'), /RELEASE_DOCUMENTATION_PROOF_REQUIRED/);
  await receipt(client, c, a, 'DOCUMENTATION', { no_runtime_change: true, integration_receipt: integration });
  const result = await transition(client, c, a.id, 'DOCUMENTATION_ONLY');
  assert.equal(result.integrated, true); assert.equal((await snapshot(client)).controller.active_release, null);
  await end(client);
});

test('known retry deadlines wake observation without polling or executing the retry', async () => {
  const config = await cluster.database(); const writer = await db(config); const a = await enqueue(writer); const c = await owner(writer);
  await call(writer, 'claim_next', [c.owner_id, c.epoch, deadline(), actor]);
  await call(writer, 'retry', [a.id, 2, 1, 'TRANSPORT', actor, 'Persisted retry wakeup test']);
  await end(writer);
  const abort = new AbortController(); const observations = [];
  const running = observeSession(config, { signal: abort.signal, emit: value => observations.push(value) });
  for (let i = 0; i < 150 && !observations.some(value => value.retry_due_count === 1); i++) await sleep(10);
  assert.ok(observations.some(value => value.retry_due_count === 1));
  abort.abort(); await running;
  const reader = await db(config); assert.equal((await row(reader, a.id)).state, 'RETRY_WAIT');
  assert.equal((await row(reader, a.id)).attempt_count, 1); await end(reader);
});

test('native session loss reconnects, rescans admitted work and requires fresh reconciliation', async () => {
  const config = { ...await cluster.database(), application_name: 'release-consumer-reconnect-fixture' };
  const admin = await db({ ...config, application_name: 'release-reconnect-observer' });
  const abort = new AbortController(); const observations = []; const reconnects = [];
  const running = observe(config, { signal: abort.signal, emit: value => observations.push(value), onReconnect: e => reconnects.push(e) });
  await until(() => observations.length > 0, 'initial connected observation');
  const epoch = observations[0].epoch;
  await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='release-consumer-reconnect-fixture'");
  await enqueue(admin);
  await until(() => observations.some(value => value.epoch !== epoch && value.unresolved_count === 1), 'reconnection startup scan');
  assert.ok(reconnects.length >= 1);
  assert.equal(observations.at(-1).reconciliation_required, true);
  abort.abort(); await running; await end(admin);
});

test('native pg_dump/pg_restore cannot revive the old ownership epoch or bypass reconciliation', async () => {
  const original = await cluster.database(); const before = await db(original);
  const a = await enqueue(before); const old = await owner(before, { activate: false });
  const backup = path.join(cluster.directory, 'journal-before-restore.dump');
  cluster.backup(original, backup);
  await enqueue(before, sha('b')); // This newer journal history is absent from the restored snapshot.
  await end(before);
  const restoredConfig = await cluster.database({ migrate: false });
  cluster.restore(restoredConfig, backup);
  const restored = await db(restoredConfig);
  assert.equal((await snapshot(restored)).queue.length, 1);
  const fresh = await call(restored, 'acquire_owner', [randomUUID(), actor]);
  assert.notEqual(fresh.epoch, old.epoch); assert.equal(fresh.reconciliation_required, true);
  assert.equal((await row(restored, a.id)).admission.id, a.id);
  await assert.rejects(call(restored, 'claim_next', [fresh.owner_id, fresh.epoch, deadline(), actor]), /RELEASE_EXECUTION_NOT_ACTIVATED/);
  await end(restored);
});

test('priority changes behind an active release cannot invalidate its state version', async () => {
  const client = await db(await cluster.database()); const a = await enqueue(client); const b = await enqueue(client, sha('b')); const c = await enqueue(client, sha('c'));
  const own = await owner(client); await call(client, 'claim_next', [own.owner_id, own.epoch, deadline(), actor]);
  const active = await row(client, a.id);
  await call(client, 'reprioritize', [c.id, b.id, 1, actor, 'Emergency order behind active release']);
  assert.deepEqual((await snapshot(client)).queue.map(q => q.release_id), [a.id, c.id, b.id]);
  assert.equal((await row(client, a.id)).state_version, active.state_version);
  assert.equal((await snapshot(client)).controller.active_release, a.id);
  await end(client);
});

function recoveryIntent(q, extra = {}) {
  return { purpose: 'forward-repair', source_revision: sha('c'), expected_base_sha: sha('9'),
    failed_release_id: q.release_id, prior_attempt_id: q.attempt_id, parent_recovery_id: q.recovery_id,
    scope: ['server/engine'], manifest: { components: [{ target: 'club-arena-engine', compatibility: 'expand', revision: 2 }] },
    expected_current: { identity: 'native-fixture-current' }, compatibility_evidence: ['native-fixture:compatibility'],
    receipt_refs: ['native-fixture:recovery-authority'], budget_seconds: 3600, deadline: deadline(), ...extra };
}
async function recovery(client, c, a, extra = {}, key = randomUUID()) {
  const q = await row(client, a.id);
  return call(client, 'begin_recovery', [c.owner_id, c.epoch, a.id, q.state_version, key,
    recoveryIntent(q, extra), actor, 'Exact bounded recovery revision']);
}

test('canonical identity ignores observed base metadata but preserves client content and immutable prerequisites', async () => {
  const client = await db(await cluster.database());
  const prerequisite = await enqueue(client, sha('1'));
  const original = await enqueue(client, sha('a'), { pull_request: 42, base_sha: sha('9') }, 'base-observation');
  const same = await enqueue(client, sha('a'), { pull_request: 42, base_sha: sha('8') });
  const sourceOnly = await enqueue(client, sha('a'));
  assert.equal(same.id, original.id); assert.equal(sourceOnly.id, original.id);
  assert.equal(same.intent.base_sha, sha('9'));
  await assert.rejects(enqueue(client, sha('a'), { pull_request: 42, base_sha: sha('8') }, 'base-observation'), /RELEASE_IDEMPOTENCY_MISMATCH/);
  await assert.rejects(enqueue(client, sha('a'), { dependencies: [prerequisite.id] }), /RELEASE_CANONICAL_PREREQUISITE_CONFLICT/);
  assert.equal((await snapshot(client)).queue.length, 2);
  await end(client);
});

test('expired active attempt starts an immutable bounded recovery without another queue admission or stale receipt reuse', async () => {
  const client = await db(await cluster.database()); const a = await enqueue(client); await enqueue(client, sha('b'));
  const c = await owner(client);
  await call(client, 'claim_next', [c.owner_id, c.epoch, new Date(Date.now() + 160).toISOString(), actor]);
  const oldValidation = await validated(client, c, a);
  const prior = await row(client, a.id);
  await sleep(180);
  await assert.rejects(transition(client, c, a.id, 'MERGING'), /RELEASE_ATTEMPT_EXPIRED/);
  await transition(client, c, a.id, 'RECOVERY_REQUIRED');
  await assert.rejects(recovery(client, c, a, { purpose: undefined }), /RELEASE_RECOVERY_INTENT_INVALID/);
  await assert.rejects(recovery(client, c, a, { manifest: { components: [{ target: 'world-hub-web' }] } }), /RELEASE_RECOVERY_TARGET_SCOPE_MISMATCH/);
  await assert.rejects(recovery(client, c, a, { budget_seconds: 10, deadline: deadline() }), /RELEASE_RECOVERY_DEADLINE_INVALID/);
  const request = recoveryIntent(await row(client, a.id), { source_revision: a.intent.head_sha, manifest: a.intent.manifest });
  const version = (await row(client, a.id)).state_version;
  const revision = await call(client, 'begin_recovery', [c.owner_id, c.epoch, a.id, version, 'recover-expired', request, actor, 'Expired delivery recovery']);
  assert.equal(revision.may_start, true); assert.equal(revision.prior_attempt_id, prior.attempt_id);
  const q = await row(client, a.id);
  assert.equal(q.state, 'VALIDATING'); assert.equal(q.attempt_count, prior.attempt_count);
  assert.equal(q.recovery_attempt_count, 1); assert.notEqual(q.attempt_id, prior.attempt_id);
  assert.equal((await snapshot(client)).queue.length, 2);
  assert.equal((await snapshot(client)).controller.active_release, a.id);
  assert.deepEqual(q.admission.intent, a.intent);
  await assert.rejects(call(client, 'select_receipt', [c.owner_id, c.epoch, a.id, q.state_version, oldValidation, actor]), /RELEASE_RECEIPT_SELECTION_INVALID/);
  const duplicate = await call(client, 'begin_recovery', [c.owner_id, c.epoch, a.id, version, 'recover-expired', request, actor, 'Lost response reattachment']);
  assert.equal(duplicate.id, revision.id); assert.equal(duplicate.may_start, false);
  assert.equal((await row(client, a.id)).state_version, q.state_version);
  await assert.rejects(call(client, 'begin_recovery', [c.owner_id, c.epoch, a.id, version, 'recover-expired',
    { ...request, source_revision: sha('d') }, actor, 'Changed recovery replay']), /RELEASE_RECOVERY_IDEMPOTENCY_MISMATCH/);
  await assert.rejects(client.query('DELETE FROM release_ops.recovery_revisions WHERE id=$1', [revision.id]), /RELEASE_HISTORY_IMMUTABLE/);
  const current = { ...a, intent: { ...a.intent, head_sha: request.source_revision }, manifest_digest: q.resolution_manifest_digest };
  await receipt(client, c, current, 'VALIDATION', { accepted_head_sha: request.source_revision, expected_base_sha: sha('7'), tested_tree_sha: sha('8') });
  await assert.rejects(transition(client, c, a.id, 'MERGING'), /RELEASE_VALIDATION_RECEIPT_REQUIRED/);
  await validated(client, c, current);
  await transition(client, c, a.id, 'MERGING');
  await end(client);
});

test('UNKNOWN blocks recovery across expiration and takeover; terminal proof permits the same owned recovery', async () => {
  const config = await cluster.database(); let client = await db(config); const a = await enqueue(client); const old = await owner(client);
  await call(client, 'claim_next', [old.owner_id, old.epoch, new Date(Date.now() + 200).toISOString(), actor]);
  await validated(client, old, a); await transition(client, old, a.id, 'MERGING');
  const operation = await call(client, 'begin_external', [old.owner_id, old.epoch, a.id, 'uncertain-original', 'MERGE',
    { target: 'club-arena-engine', manifest_digest: a.manifest_digest, expected_current: { head: sha('9') } }, actor]);
  await sleep(220); await end(client); client = await db(config);
  let fresh = await call(client, 'acquire_owner', [randomUUID(), actor]);
  await reconcile(client);
  const q = await row(client, a.id);
  assert.equal(q.state, 'UNKNOWN_EXTERNAL_OUTCOME');
  await assert.rejects(recovery(client, old, a), /RELEASE_STALE_OWNER/);
  await assert.rejects(recovery(client, fresh, a), /RELEASE_EXTERNAL_OUTCOME_UNRESOLVED/);
  await call(client, 'resolve_external', [fresh.owner_id, fresh.epoch, operation.id, 'FAILED',
    { terminal: true, operation_id: operation.id, outcome: 'FAILED', manifest_digest: a.manifest_digest, receipt_refs: ['fixture:terminal-failed'] }, actor]);
  const request = recoveryIntent(await row(client, a.id));
  const version = (await row(client, a.id)).state_version;
  const revision = await call(client, 'begin_recovery', [fresh.owner_id, fresh.epoch, a.id, version, 'takeover-recovery', request, actor, 'Terminal prior operation reconciled']);
  const recoveryOwner = fresh;
  await end(client); client = await db(config); fresh = await call(client, 'acquire_owner', [randomUUID(), actor]);
  await assert.rejects(recovery(client, fresh, a), /RELEASE_EXECUTION_NOT_ACTIVATED/);
  await reconcile(client);
  await assert.rejects(recovery(client, recoveryOwner, a), /RELEASE_STALE_OWNER/);
  const reattached = await call(client, 'begin_recovery', [fresh.owner_id, fresh.epoch, a.id, version, 'takeover-recovery', request, actor, 'Attach after owner restart']);
  assert.equal(reattached.id, revision.id); assert.equal(reattached.deadline, revision.deadline); assert.equal(reattached.may_start, false);
  assert.equal((await row(client, a.id)).recovery_attempt_count, 1);
  assert.equal((await snapshot(client)).controller.active_release, a.id);
  await end(client);
});

test('forward revert requires rebuilt exact recovery source and certification; reverted prerequisites do not satisfy dependents', async () => {
  const client = await db(await cluster.database()); const a = await enqueue(client);
  const dependent = await enqueue(client, sha('b'), { dependencies: [a.id] });
  const c = await owner(client); await call(client, 'claim_next', [c.owner_id, c.epoch, deadline(), actor]);
  await transition(client, c, a.id, 'RECOVERY_REQUIRED');
  const revision = await recovery(client, c, a, { purpose: 'forward-revert' });
  const q = await row(client, a.id);
  const current = { ...a, manifest_digest: q.resolution_manifest_digest, intent: { ...a.intent, head_sha: q.resolution_head_sha } };
  assert.notEqual(current.manifest_digest, a.manifest_digest);
  const validation = await validated(client, c, current); await transition(client, c, a.id, 'MERGING');
  const integration = await receipt(client, c, current, 'INTEGRATION', { validation_receipt: validation,
    accepted_head_sha: current.intent.head_sha, expected_base_sha: sha('9'), merged_tree_sha: sha('8'), merged_sha: sha('2') });
  await transition(client, c, a.id, 'BUILDING');
  const artifact = { 'club-arena-engine': { identity: 'fixture-forward-revert-artifact' } };
  const build = await receipt(client, c, current, 'BUILD', { integration_receipt: integration, source_sha: sha('2'), artifact: { components: artifact } });
  await transition(client, c, a.id, 'STAGED');
  const stage = await receipt(client, c, current, 'STAGED', { build_receipt: build, compatibility_verified: true });
  await transition(client, c, a.id, 'READY');
  await receipt(client, c, current, 'READINESS', { stage_receipt: stage, technical_gates_passed: true, expected_current: { identity: 'fixture-failed-artifact' } });
  await transition(client, c, a.id, 'ROLLING_BACK');
  await transition(client, c, a.id, 'VERIFYING');
  const cert = { build_receipt: build, served_components: artifact, cleanup_complete: true, unchanged_release: true, certification_run_id: 'fixture-recovery-cert' };
  await receipt(client, c, current, 'CERTIFICATION', cert);
  await assert.rejects(transition(client, c, a.id, 'RECOVERED'), /RELEASE_RECOVERY_SOURCE_PROOF_REQUIRED/);
  await receipt(client, c, current, 'CERTIFICATION', { ...cert, recovery_revision_id: revision.id, source_reconciled: true, source_revision: current.intent.head_sha });
  await assert.rejects(transition(client, c, a.id, 'VERIFIED'), /RELEASE_RECOVERY_DISPOSITION_MISMATCH/);
  const terminal = await transition(client, c, a.id, 'RECOVERED');
  assert.equal(terminal.terminal_disposition.recovery_revision_id, revision.id);
  assert.equal((await snapshot(client)).controller.active_release, null);
  await assert.rejects(call(client, 'claim_next', [c.owner_id, c.epoch, deadline(), actor]), /RELEASE_DEPENDENCIES_UNVERIFIED/);
  assert.equal((await row(client, dependent.id)).state, 'QUEUED');
  await end(client);
});

test('history inspection is paginated and observer snapshot stays compact as immutable history grows', async () => {
  const client = await db(await cluster.database());
  for (const digit of ['1', '2', '3', '4', '5']) await enqueue(client, sha(digit));
  const page = await call(client, 'inspect', [null, 0, 2, 0]);
  assert.equal(page.queue.length, 2); assert.equal(page.events.length, 2);
  const next = await call(client, 'inspect', [null, page.page.next_admission, 2, page.page.next_event]);
  assert.equal(next.queue.length, 2); assert.ok(next.queue.every(q => Number(q.admission_seq) > 2));
  const observed = await call(client, 'observe_snapshot');
  assert.equal(Number(observed.unresolved_count), 5); assert.equal('queue' in observed, false); assert.equal('events' in observed, false);
  assert.equal('intent' in observed.head, false);
  await client.query('CREATE OR REPLACE FUNCTION release_ops.schema_version() RETURNS integer LANGUAGE sql AS $$ SELECT 99 $$');
  await assert.rejects(snapshot(client), /RELEASE_SCHEMA_VERSION_UNSUPPORTED/);
  await end(client);
});
