import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { captureFixtureServicePreimage } from './service-preimage.mjs';

export const roleNativePins = Object.freeze({
  'role-alignment-installer.sql': '75de4863de9a9276e701526389a6fbe0a033589d60844b71dd42eb44fbdf31db',
  'role-alignment-native.json': '3427e7aa498973eb09f4a3d3ae04a78bb6795f372b84234f09594ae60ec7ba30',
  'role-alignment-aligned.json': 'd0d858e8dbb70afca05d3e84be6ce109b818ea1ba278813d9d4b6afd062e2083',
});
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function roleNativeInputs() {
  const input = {};
  for (const [name, expected] of Object.entries(roleNativePins)) {
    const raw = await readFile(new URL(name, import.meta.url));
    assert.equal(digest(raw), expected, 'FIXTURE_ROLE_NATIVE_SOURCE');
    input[name] = name.endsWith('.json') ? JSON.parse(raw) : raw.toString('utf8');
  }
  return input;
}
export const identifier = (value) => {
  assert.match(value, /^[a-z][a-z0-9_]{0,62}$/);
  return '"' + value + '"';
};
export function lastCommand(value, expected) {
  assert.equal((Array.isArray(value) ? value : [value]).at(-1)?.command, expected, 'FIXTURE_ROLE_NATIVE_TERMINAL');
}
export class RoleNativeOwner {
  constructor(Client, { password, signal, deadlineMs = 120000 } = {}) {
    assert.equal(typeof Client, 'function');
    assert.match(password, /^[a-f0-9]{64}$/);
    assert.ok(Number.isInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 180000);
    this.Client = Client; this.password = password; this.signal = signal;
    this.deadline = performance.now() + deadlineMs;
    this.workDeadline = performance.now() + Math.floor(deadlineMs * 3 / 4);
    this.records = [];
  }
  async bounded(action, cleanup = false) {
    const until = cleanup ? this.deadline : this.workDeadline;
    assert.ok(performance.now() < until && (cleanup || !this.signal?.aborted), 'FIXTURE_ROLE_NATIVE_DEADLINE');
    let timer, aborted;
    try {
      return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
        const fail = () => reject(new Error('FIXTURE_ROLE_NATIVE_DEADLINE'));
        timer = setTimeout(fail, Math.max(1, until - performance.now()));
        if (!cleanup) { aborted = fail; this.signal?.addEventListener('abort', aborted, { once: true }); }
      })]);
    } finally { clearTimeout(timer); if (aborted) this.signal?.removeEventListener('abort', aborted); }
  }
  make(role = 'supabase_admin', { tcp = false, readOnly = false, database = 'club_arena_qualification', password = this.password } = {}) {
    assert.ok(['club_arena_qualification', 'postgres'].includes(database));
    identifier(role);
    const client = new this.Client({ host: tcp ? '127.0.0.1' : '/run/postgresql', port: 5432,
      database, user: role, ...(tcp ? { password } : {}),
      connectionTimeoutMillis: 3000, query_timeout: 5000,
      // Ordinary role settings are deliberately not overwritten by options.
      ...(role === 'supabase_admin' ? { statement_timeout: 4000, options: '-c search_path=pg_catalog -c lock_timeout=2000' + (readOnly ? ' -c default_transaction_read_only=on' : '') } : {}) });
    assert.ok(this.records.every((r) => r.client !== client));
    const r = { client, role, tcp, readOnly, ended: false, error: false };
    client.on('error', () => { r.error = true; });
    client.once('end', () => { r.ended = true; });
    this.records.push(r);
    return r;
  }
  async connect(role, options, cleanup = false) {
    const r = this.make(role, options);
    await this.bounded(() => r.client.connect(), cleanup);
    const row = (await this.query(r, `SELECT pg_backend_pid() AS pid, session_user AS session_role,
      current_user AS current_role, current_database() AS database,
      current_setting('is_superuser')::boolean AS superuser,
      inet_server_addr() IS NOT NULL AS tcp,
      current_setting('default_transaction_read_only') AS read_only`, undefined, cleanup)).rows[0];
    assert.equal(row.pid, r.client.processID);
    assert.ok(Number.isInteger(row.pid) && row.pid > 0);
    assert.equal(row.session_role, r.role); assert.equal(row.current_role, r.role);
    assert.equal(row.database, options?.database ?? 'club_arena_qualification');
    assert.equal(row.superuser, r.role === 'supabase_admin'); assert.equal(row.tcp, r.tcp);
    if (r.readOnly || r.role === 'supabase_read_only_user') assert.equal(row.read_only, 'on');
    return r;
  }
  async query(r, text, values, cleanup = false) {
    assert.equal(r.ended, false, 'FIXTURE_ROLE_NATIVE_CLOSED_CLIENT');
    assert.equal(r.error, false, 'FIXTURE_ROLE_NATIVE_CLIENT_ERROR');
    return this.bounded(() => r.client.query({ text, values, query_timeout: 5000 }), cleanup);
  }
  async close(r) {
    if (!r || r.ended) return;
    r.endPromise ??= Promise.resolve().then(() => r.client.end());
    // Cleanup may already be out of time before bounded() observes this promise.
    r.endPromise.catch(() => undefined);
    await this.bounded(() => r.endPromise, true);
    assert.equal(r.ended, true, 'FIXTURE_ROLE_NATIVE_END_UNOBSERVED');
  }
  async closeAll() {
    const results = await Promise.allSettled(this.records.map((r) => this.close(r)));
    assert.ok(results.every((r) => r.status === 'fulfilled') && this.records.every((r) => r.ended && !r.error), 'FIXTURE_ROLE_NATIVE_CLIENT_CLEANUP');
  }
  async snapshot(expected, heldPid, cleanup = false) {
    const observer = await this.connect('supabase_admin', { readOnly: true }, cleanup);
    try {
      const captured = await this.bounded(() => captureFixtureServicePreimage(observer.client, heldPid), cleanup);
      const catalog = JSON.parse(captured.serialized); delete catalog.observed_at;
      assert.deepEqual(catalog, expected, 'FIXTURE_ROLE_NATIVE_CATALOG_RESTORATION');
      return captured.proof.catalog_sha256;
    } finally { await this.close(observer); }
  }
  async absent(pids) {
    const observer = await this.connect('supabase_admin', { readOnly: true });
    try {
      await this.query(observer, 'SELECT pg_stat_clear_snapshot()');
      assert.deepEqual((await this.query(observer, 'SELECT NOT EXISTS(SELECT FROM pg_stat_activity WHERE pid=ANY($1::integer[])) AS absent', [pids])).rows, [{ absent: true }]);
    } finally { await this.close(observer); }
  }
}
