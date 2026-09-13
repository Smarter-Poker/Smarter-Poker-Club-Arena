import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { alignFixtureRoles } from '../../operations/release/fixture/role-alignment.mjs';

const dir = new URL('../../operations/release/fixture/', import.meta.url);
const native = JSON.parse(await readFile(new URL('role-alignment-native.json', dir)));
const aligned = JSON.parse(await readFile(new URL('role-alignment-aligned.json', dir)));
const password = 'f'.repeat(64);

function fixture(mode = 'success') {
  const seen = [],
    clients = [];
  const state = { catalog: native, activeInstaller: false, installs: 0, rollbacks: 0 };
  class Application extends EventEmitter {
    processID = 99;
    connectionParameters = { query_timeout: 5 };
    async query() {
      seen.push('held-identity');
      return {
        rows: [
          {
            pid: 99,
            database: 'club_arena_qualification',
            session_role: 'postgres',
            current_role: 'postgres',
            superuser: false,
            backend_start_micros: '1700000000000000',
          },
        ],
      };
    }
  }
  const applicationClient = new Application();
  class Client extends EventEmitter {
    constructor(config) {
      super();
      this.config = config;
      this.processID = 100 + clients.length;
      this.readOnly = config.options.includes('default_transaction_read_only=on');
      this.closed = false;
      clients.push(this);
      assert.equal(config.host, '/run/postgresql');
      assert.equal(config.user, 'supabase_admin');
      assert.equal(config.database, 'club_arena_qualification');
      if (mode === 'reuse-client' && clients.length > 1) return clients[0];
    }
    async connect() {
      seen.push(['connect', this.processID, this.readOnly]);
    }
    async end() {
      this.closed = true;
      if (!this.readOnly) state.activeInstaller = false;
      seen.push(['end', this.processID]);
      this.emit('end');
    }
    async query(input) {
      const sql = typeof input === 'string' ? input : input.text;
      assert.equal(this.closed, false, 'closed client was queried');
      if (sql.includes('AS backend_start_micros')) {
        return {
          rows: [
            {
              pid: this.processID,
              database: 'club_arena_qualification',
              session_role:
                mode === 'wrong-observer' && this.readOnly ? 'postgres' : 'supabase_admin',
              current_role: 'supabase_admin',
              superuser: true,
              local_socket: true,
              read_only: mode === 'writable-observer' ? 'off' : this.readOnly ? 'on' : 'off',
              backend_start_micros: String(1700000000000000 + this.processID),
            },
          ],
        };
      }
      if (sql.includes('-- REVIEW CANDIDATE ONLY.')) {
        assert.equal(this.readOnly, false);
        state.installs++;
        state.activeInstaller = true;
        assert.equal(sql.includes('@FIXTURE_RANDOM_64_HEX_PASSWORD@'), false);
        assert.equal(sql.includes(password), true);
        seen.push(['install', this.processID]);
        if (mode === 'sql-refusal')
          throw Object.assign(new Error('private SQL ' + password), { code: 'P0001' });
        if (mode === 'install-timeout') return new Promise(() => {});
        state.catalog = aligned;
        if (mode === 'commit-transport-loss') throw new Error('socket lost ' + password);
        if (mode === 'commit-wrong-terminal') return [{ command: 'DO' }];
        if (mode === 'held-disconnect') applicationClient.emit('end');
        if (mode === 'postimage-drift')
          state.catalog = {
            ...aligned,
            roles: aligned.roles.map((r, index) =>
              index === 0 ? { ...r, inherit: !r.inherit } : r
            ),
          };
        if (mode === 'invalid-catalog-identity') state.catalog = { ...aligned, database: 'wrong' };
        return [{ command: 'BEGIN' }, { command: 'COMMIT' }];
      }
      if (sql === 'ROLLBACK') {
        if (!this.readOnly) {
          state.rollbacks++;
          seen.push(['rollback', this.processID]);
        }
        return { command: 'ROLLBACK', rows: [] };
      }
      if (sql.includes('pg_stat_clear_snapshot')) return { rows: [{}], command: 'SELECT' };
      if (sql.includes('AS absent')) return { rows: [{ absent: !state.activeInstaller }] };
      if (sql.includes('AS quiescent')) return { rows: [{ quiescent: !state.activeInstaller }] };
      if (sql.includes('AS preimage;')) {
        assert.equal(this.readOnly, true);
        seen.push(['catalog', this.processID, state.catalog === native ? 'original' : 'committed']);
        return { rows: [{ preimage: { ...state.catalog, observed_at: '2026-09-13T17:00:00Z' } }] };
      }
      if (sql.includes('DO $role_graph$') || sql.includes('DO $membership_matrix$')) {
        assert.equal(this.readOnly, true);
        seen.push([sql.includes('$role_graph$') ? 'graph' : 'membership', this.processID]);
        if (mode === 'graph-failure' && sql.includes('$role_graph$'))
          throw Object.assign(new Error('role graph failed'), { code: 'P0001' });
        return [{ command: 'BEGIN' }, { command: 'DO' }, { command: 'ROLLBACK' }];
      }
      // Exact service-preimage identity/transaction setup is controlled here.
      if (sql.startsWith('BEGIN ISOLATION LEVEL') || sql.includes('DO $owned$'))
        return { command: 'DO', rows: [] };
      throw new Error('Unexpected driver query');
    }
  }
  return { applicationClient, Client, state, seen, clients };
}

async function refused(mode, options = {}) {
  const f = fixture(mode);
  let error;
  try {
    await alignFixtureRoles({ ...f, password, deadlineMs: 1000, ...options });
  } catch (value) {
    error = value;
  }
  assert.ok(error, 'expected refusal');
  assert.equal(error.message, 'FIXTURE_ROLE_ALIGNMENT_FAILED');
  assert.equal(error.proof.status, 'failed');
  assert.equal(JSON.stringify(error).includes(password), false);
  assert.equal(error.cause, undefined);
  return { ...f, error };
}

test('one actual-client binding spans installer and three distinct post-commit observers', async () => {
  const f = fixture();
  const proof = await alignFixtureRoles({ ...f, password, deadlineMs: 1000 });
  assert.equal(proof.status, 'passed');
  assert.equal(proof.commit_acknowledged, true);
  assert.equal(proof.catalog_outcome, 'committed');
  assert.equal(proof.separate_read_only_observers, 4);
  assert.equal(proof.graph_assertion, true);
  assert.equal(proof.membership_assertion, true);
  assert.equal(proof.all_driver_clients_closed, true);
  assert.equal(f.state.installs, 1);
  assert.equal(f.state.rollbacks, 0);
  assert.equal(f.clients.length, 5);
  assert.ok(f.clients.every((c) => c.closed));
  assert.equal(f.applicationClient.listenerCount('end'), 0);
  assert.equal(f.applicationClient.listenerCount('error'), 0);
  assert.equal(proof.actual_login_and_default_acl_tests, false);
  assert.equal(proof.post_alignment_services, false);
  const install = f.seen.find((x) => x[0] === 'install')[1];
  for (const name of ['graph', 'membership'])
    assert.notEqual(f.seen.find((x) => x[0] === name)[1], install);
});
test('SQL refusal explicitly rolls back and observes the full original catalog from a new client', async () => {
  const f = await refused('sql-refusal');
  assert.equal(f.error.proof.rollback_acknowledged, true);
  assert.equal(f.error.proof.catalog_outcome, 'original');
  assert.equal(f.error.proof.installer_backend_absent, true);
  assert.equal(f.state.installs, 1);
  assert.equal(f.state.rollbacks, 1);
  assert.ok(f.clients.every((c) => c.closed));
});
test('lost COMMIT response stays failed even when a fresh observer sees the committed catalog', async () => {
  const f = await refused('commit-transport-loss');
  assert.equal(f.error.proof.commit_acknowledged, false);
  assert.equal(f.error.proof.catalog_outcome, 'committed');
  assert.equal(f.state.installs, 1, 'no retry');
});
test('a response missing the final COMMIT is rejected and classified', async () => {
  const f = await refused('commit-wrong-terminal');
  assert.equal(f.error.proof.commit_acknowledged, false);
  assert.equal(f.error.proof.catalog_outcome, 'committed');
});
test('held client disconnect cannot be accepted after a successful installer response', async () => {
  const f = await refused('held-disconnect');
  assert.equal(f.error.proof.commit_acknowledged, true);
  assert.equal(f.error.proof.catalog_outcome, 'committed');
  assert.equal(f.error.proof.graph_assertion, false);
});
test('postimage drift stays neither rather than being relabelled as rollback', async () => {
  const f = await refused('postimage-drift');
  assert.equal(f.error.proof.catalog_outcome, 'neither');
});
test('invalid catalog identity is unobserved rather than accepted for state classification', async () => {
  const f = await refused('invalid-catalog-identity');
  assert.equal(f.error.proof.catalog_outcome, 'unobserved');
});
test('read-only observer startup is mandatory before any installer query', async () => {
  const f = await refused('writable-observer');
  assert.equal(f.state.installs, 0);
  assert.equal(f.error.proof.catalog_outcome, 'unobserved');
});
test('wrong observer identity is refused before any installer query', async () => {
  const f = await refused('wrong-observer');
  assert.equal(f.state.installs, 0);
});
test('fresh-client requirement rejects a factory that reuses a closed observer', async () => {
  const f = await refused('reuse-client');
  assert.equal(f.state.installs, 0);
});
test('assertion failure remains failed after commit and fresh recovery observation', async () => {
  const f = await refused('graph-failure');
  assert.equal(f.error.proof.catalog_outcome, 'committed');
  assert.equal(f.error.proof.graph_assertion, false);
  assert.equal(f.error.proof.membership_assertion, false);
});
test('primary timeout closes installer and leaves time for independent original-state observation', async () => {
  const f = await refused('install-timeout', { deadlineMs: 180 });
  assert.equal(f.error.proof.catalog_outcome, 'original');
  assert.equal(f.error.proof.all_driver_clients_closed, true);
  assert.equal(f.state.installs, 1);
});
test('unbounded application-client handshake and enlarged total deadline are refused', async () => {
  const f = fixture();
  f.applicationClient.connectionParameters.query_timeout = 0;
  await assert.rejects(
    alignFixtureRoles({ ...f, password }),
    /FIXTURE_ROLE_HELD_CLIENT_TIMEOUT_REQUIRED/
  );
  f.applicationClient.connectionParameters.query_timeout = 5;
  await assert.rejects(alignFixtureRoles({ ...f, password, deadlineMs: 60001 }));
  assert.equal(f.clients.length, 0);
});
