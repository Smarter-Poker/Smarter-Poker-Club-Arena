import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const policy = JSON.parse(await readFile(new URL('./policy.json', import.meta.url), 'utf8'));
const functions = new Set(['enqueue', 'inspect', 'observe_snapshot', 'retry', 'withdraw', 'reconcile', 'reprioritize',
  'acquire_owner', 'claim_next', 'record_receipt', 'select_receipt', 'transition', 'begin_external', 'mark_unknown',
  'resolve_external', 'begin_recovery', 'resume_retry']);

export function configuration(env = process.env) {
  if (!env.RELEASE_JOURNAL_DATABASE_URL) throw new Error('RELEASE_DATABASE_REFERENCE_REQUIRED');
  if (!policy.connectionModes.includes(env.RELEASE_JOURNAL_CONNECTION_MODE)) {
    throw new Error('RELEASE_VERIFIED_SESSION_CONNECTION_REQUIRED');
  }
  if (env.RELEASE_JOURNAL_MODE && env.RELEASE_JOURNAL_MODE !== 'OBSERVE') {
    throw new Error('RELEASE_EXECUTION_NOT_IMPLEMENTED_OR_ACTIVATED');
  }
  return { connectionString: env.RELEASE_JOURNAL_DATABASE_URL, connectionTimeoutMillis: 5000,
    application_name: 'club-arena-release-journal-observe', keepAlive: true };
}

export async function connect(config) {
  const client = new pg.Client(config);
  // Query promises expose sanitized failures; the listener prevents an unhandled
  // idle socket error from bypassing the consumer's reconnection boundary.
  client.on('error', () => {});
  await client.connect();
  await client.query("SET statement_timeout = '10s'; SET lock_timeout = '3s'; SET idle_in_transaction_session_timeout = '15s'");
  return client;
}

export async function call(client, name, args = []) {
  if (!functions.has(name)) throw new Error('RELEASE_COMMAND_NOT_ALLOWED');
  const placeholders = args.map((_, i) => `$${i + 1}`).join(',');
  // The response is deliberately withheld until COMMIT succeeds. Never put
  // provider calls, builds, sleeps or approval waits in this transaction.
  const version = (await client.query('SELECT release_ops.schema_version() AS version')).rows[0]?.version;
  if (version !== policy.version) throw new Error('RELEASE_SCHEMA_VERSION_UNSUPPORTED');
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL synchronous_commit = on');
    const result = await client.query(`SELECT release_ops.${name}(${placeholders}) AS value`, args);
    await client.query('COMMIT');
    return result.rows[0].value;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Original uncertain outcome is retained. */ }
    throw error;
  }
}

export function sanitizedError(error) {
  const message = /^RELEASE_[A-Z_]+$/.test(error?.message ?? '')
    ? error.message : 'RELEASE_CONNECTION_OR_QUERY_FAILED';
  return { error: message, code: error?.code ?? null };
}

export function observation(snapshot) {
  return { mode: 'OBSERVE', productionExecutionSupported: false,
    instance_id: snapshot.controller.instance_id, epoch: snapshot.controller.epoch,
    event_no: snapshot.controller.last_event, reconciliation_required: snapshot.controller.reconciliation_required,
    active_release: snapshot.controller.active_release, unresolved_count: snapshot.unresolved_count,
    retry_due_count: snapshot.retry_due_count, head: snapshot.head,
    unresolved_external_count: snapshot.unresolved_external_count };
}

// This is an actual LISTEN consumer. It never calls a provider or advances a
// release phase. Activation requires a later installed, reviewed adapter upgrade.
export async function observeSession(config, { once = false, signal, emit = console.log,
  actor = 'release-journal-observer', afterListen } = {}) {
  const client = await connect(config);
  let dirty = false;
  let waking;
  let timer;
  let connectionError;
  let lastObservation = null;
  let stopped = signal?.aborted ?? false;
  const wake = () => { dirty = true; waking?.(); };
  const abort = () => { stopped = true; wake(); };
  const onError = error => { connectionError = error; wake(); };
  client.on('notification', wake);
  client.on('error', onError);
  client.on('end', () => { if (!stopped) onError(new Error('RELEASE_CONNECTION_LOST')); });
  signal?.addEventListener('abort', abort, { once: true });
  try {
    // Autocommit LISTEN first, then a NEW transaction snapshot. Registration
    // overlaps safely with durable event numbers; notifications are wakeups only.
    await client.query(`LISTEN ${policy.notificationChannel}`);
    await afterListen?.(client);
    const ownership = await call(client, 'acquire_owner', [randomUUID(), actor]);
    for (;;) {
      if (connectionError) throw connectionError;
      if (stopped) break;
      dirty = false;
      const snapshot = await call(client, 'observe_snapshot');
      if (snapshot.controller.epoch !== ownership.epoch) throw new Error('RELEASE_STALE_OWNER');
      const observed = observation(snapshot);
      const signature = `${observed.event_no}/${observed.retry_due_count}`;
      if (signature !== lastObservation) {
        emit(observed);
        lastObservation = signature;
      }
      if (once) break;
      clearTimeout(timer);
      // Timers belong exclusively to already journaled retries, never discovery
      // or publication. A past deadline produces one observation without spinning.
      const retryDates = [Date.parse(snapshot.next_retry_at)].filter(date => date > Date.now());
      if (retryDates.length) timer = setTimeout(wake, Math.min(...retryDates) - Date.now() + 1);
      if (!dirty && !stopped && !connectionError) await new Promise(resolve => { waking = resolve; });
      waking = undefined;
    }
  } finally {
    stopped = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    client.off('error', onError);
    await client.end().catch(() => {});
  }
}

export async function observe(config, options = {}) {
  let failures = 0;
  while (!options.signal?.aborted) {
    try { await observeSession(config, options); return; }
    catch (error) {
      if (options.signal?.aborted) return;
      if (error.message === 'RELEASE_OWNER_BUSY' || failures >= policy.reconnectDelayMilliseconds.length) throw error;
      options.onReconnect?.(sanitizedError(error));
      const delay = policy.reconnectDelayMilliseconds[failures++];
      await new Promise(resolve => {
        const timer = setTimeout(done, delay);
        function done() { clearTimeout(timer); options.signal?.removeEventListener('abort', done); resolve(); }
        options.signal?.addEventListener('abort', done, { once: true });
      });
      // A reconnect registers LISTEN before reading again and starts a fresh
      // reconciliation-required epoch. It never replays a provider request.
    }
  }
}
