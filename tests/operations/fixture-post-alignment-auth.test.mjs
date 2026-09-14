import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { qualifyPostAlignmentAuth } from '../../operations/release/fixture/post-alignment-auth.mjs';
import { fixtureSecrets } from '../../operations/release/fixture/auth-fixture.mjs';
const { fixtureAuth } = await import(
  process.env.AUTH_FIXTURE_SUBJECT
    ? pathToFileURL(process.env.AUTH_FIXTURE_SUBJECT).href
    : new URL('../../operations/release/fixture/auth-fixture.mjs', import.meta.url).href
);

const input = () => ({
  db: {
    processID: 102,
    query: async () => {
      throw new Error('DATABASE_TOUCHED');
    },
  },
  heldBackendPid: 101,
  roleProof: {
    scope: 'native-full-role-installer',
    status: 'passed',
    commit_acknowledged: true,
    installer_backend_absent: true,
    all_driver_clients_closed: true,
    graph_assertion: true,
    membership_assertion: true,
    aligned_catalog_sha256: 'a'.repeat(64),
  },
  providerProof: {
    scope: 'native-five-provider-semantics',
    status: 'passed',
    dummy_objects_removed: true,
    all_probe_clients_closed: true,
    private_http_closed: true,
    build_sha256: 'b'.repeat(64),
    catalog_sha256: 'c'.repeat(64),
  },
  authEnvironment: {
    GOTRUE_DB_DATABASE_URL:
      'postgres://supabase_auth_admin:dummy@127.0.0.1:5432/club_arena_qualification',
  },
  supervisor: { abort: new AbortController(), assertHealthy() {}, fail() {} },
  secrets: fixtureSecrets(),
});

for (const [name, change] of [
  [
    'held pre-alignment connection',
    (v) => {
      v.db.processID = v.heldBackendPid;
    },
  ],
  [
    'unacknowledged role commit',
    (v) => {
      v.roleProof.commit_acknowledged = false;
    },
  ],
  [
    'installer still present',
    (v) => {
      v.roleProof.installer_backend_absent = false;
    },
  ],
  [
    'open role client',
    (v) => {
      v.roleProof.all_driver_clients_closed = false;
    },
  ],
  [
    'failed provider',
    (v) => {
      v.providerProof.status = 'failed';
    },
  ],
  [
    'provider cleanup incomplete',
    (v) => {
      v.providerProof.private_http_closed = false;
    },
  ],
  [
    'unbounded budget',
    (v) => {
      v.deadlineMs = 30001;
    },
  ],
  [
    'superuser Auth service',
    (v) => {
      v.authEnvironment.GOTRUE_DB_DATABASE_URL =
        'postgres://supabase_admin:dummy@127.0.0.1:5432/club_arena_qualification';
    },
  ],
  [
    'remote Auth database',
    (v) => {
      v.authEnvironment.GOTRUE_DB_DATABASE_URL =
        'postgres://supabase_auth_admin:dummy@example.invalid:5432/club_arena_qualification';
    },
  ],
]) {
  test(`attached Auth refuses ${name} before touching its estate`, async () => {
    const value = input();
    change(value);
    await assert.rejects(qualifyPostAlignmentAuth(value), (error) => {
      assert.notEqual(error.message, 'DATABASE_TOUCHED');
      return true;
    });
  });
}

test('an already aborted supervisor prevents the first database observation', async () => {
  const value = input();
  value.supervisor.abort.abort();
  await assert.rejects(qualifyPostAlignmentAuth(value), /FIXTURE_AUTH_DEADLINE/);
});

test('Auth request is physically aborted by its parent budget while the peer withholds a response', async () => {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const abort = new AbortController();
  const requestObserved = once(server, 'request');
  const started = performance.now();
  try {
    const api = fixtureAuth({
      ...fixtureSecrets(),
      signal: abort.signal,
      endpoint: `http://127.0.0.1:${server.address().port}`,
    });
    const pending = api.createUsers();
    const failed = assert.rejects(pending, (error) => error.name === 'AbortError');
    const [request] = await requestObserved;
    const closed = once(request.socket, 'close');
    abort.abort();
    await failed;
    await closed;
    assert.ok(performance.now() - started < 2000);
  } finally {
    abort.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
