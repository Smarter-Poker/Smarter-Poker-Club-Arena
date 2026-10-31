import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  alignCurrentApplicationRoles,
  extendedRolePreimage,
  currentRoleSourcePins,
} from '../current-application-roles.mjs';

const base = JSON.parse(await readFile(new URL('../role-alignment-aligned.json', import.meta.url)));
function harness({ drift = false, occupied = false } = {}) {
  let committed = false,
    pid = 100;
  const clients = [];
  class Client {
    constructor(config) {
      this.config = config;
      this.processID = ++pid;
      clients.push(this);
    }
    async connect() {}
    async query(sql) {
      if (sql.includes('AS quiescent')) return { rows: [{ quiescent: true }] };
      if (sql.includes('AS preimage')) {
        const image = structuredClone(committed ? extendedRolePreimage(base) : base);
        if (occupied && !committed) image.roles.push({ name: 'ca_record_gateway' });
        if (drift && committed)
          image.memberships.find((edge) => edge.role === 'engine_lightning_fold').set = true;
        return { rows: [{ preimage: { ...image, observed_at: '2026-10-31 17:36:17+00' } }] };
      }
      if (sql.includes('CREATE ROLE ca_ledger_refusal_recorder')) {
        assert.equal((sql.match(/PASSWORD NULL/g) || []).length, 5);
        assert.ok(!sql.includes('vault.') && !sql.includes('CREATE OR REPLACE'));
        assert.ok(sql.includes("VALID UNTIL '2026-10-15 15:52:57.04123+00'"));
        assert.ok(sql.includes('NOBYPASSRLS'));
        committed = true;
        return [{ command: 'COMMIT' }];
      }
      return { rows: [] };
    }
  }
  const databaseOwner = {
    own: (client) => client,
    end: async (client) => {
      client.closed = true;
    },
  };
  return {
    args: { Client, databaseOwner, applicationClient: { processID: 99 } },
    clients,
    committed: () => committed,
  };
}

test('literal role extension preserves old facts except three exact current catalogue deltas', () => {
  const next = extendedRolePreimage(base);
  assert.equal(next.roles.length, 38);
  assert.equal(next.memberships.length, base.memberships.length + 5);
  assert.equal(next.default_acl.length, base.default_acl.length);
  const changedDefaults = next.default_acl.filter(
    (row, index) => JSON.stringify(row) !== JSON.stringify(base.default_acl[index])
  );
  assert.deepEqual(
    changedDefaults.map((row) => [row.creator, row.schema, row.type]),
    [
      ['postgres', 'public', 'r'],
      ['supabase_admin', 'realtime', 'r'],
    ]
  );
  assert.equal(
    changedDefaults[0].acl.length,
    base.default_acl.find(
      (row) => row.creator === 'postgres' && row.schema === 'public' && row.type === 'r'
    ).acl.length - 6
  );
  assert.deepEqual(
    changedDefaults[1].acl
      .filter((grant) => grant.grantable)
      .map((grant) => [grant.grantee, grant.privilege]),
    [
      ['postgres', 'INSERT'],
      ['postgres', 'SELECT'],
    ]
  );
  assert.deepEqual(next.schemas, base.schemas);
  assert.deepEqual(next.extensions, base.extensions);
  assert.deepEqual(
    next.roles.filter(
      (role) =>
        role.name !== 'cli_login_postgres' && base.roles.some((old) => old.name === role.name)
    ),
    base.roles.filter((role) => role.name !== 'cli_login_postgres')
  );
  assert.ok(
    next.roles
      .filter((role) => !base.roles.some((old) => old.name === role.name))
      .every(
        (role) =>
          !role.superuser &&
          !role.inherit &&
          !role.bypass_rls &&
          !role.create_db &&
          !role.create_role &&
          !role.replication
      )
  );
  assert.throws(() =>
    extendedRolePreimage({ ...base, roles: [...base.roles, { name: 'unexpected' }] })
  );
});

test('actual installer requires fresh post-commit backend and closes every owned client', async () => {
  const h = harness();
  const proof = await alignCurrentApplicationRoles(h.args);
  assert.equal(proof.roles, 38);
  assert.equal(h.clients.length, 2);
  assert.notEqual(h.clients[0].processID, h.clients[1].processID);
  assert.ok(
    h.clients.every(
      (client) =>
        client.closed &&
        client.config.host === '/run/postgresql' &&
        client.config.user === 'supabase_admin'
    )
  );
});

test('occupied preimage never submits installation and changed postimage never passes', async () => {
  for (const settings of [{ occupied: true }, { drift: true }]) {
    const h = harness(settings);
    await assert.rejects(alignCurrentApplicationRoles(h.args));
    if (settings.occupied) assert.equal(h.committed(), false);
    assert.ok(h.clients.every((client) => client.closed));
  }
});

// The runtime literals are an explicitly reviewed fixture adaptation, not
// permission to execute these production migrations or provider operations.
test('native extension retains the exact protected role-owner source bindings', async () => {
  for (const [path, expected] of Object.entries(currentRoleSourcePins)) {
    const source = await readFile(new URL('../../../../' + path, import.meta.url));
    assert.equal(createHash('sha256').update(source).digest('hex'), expected);
  }
});

test('native extension installer uses actual owning sessions and refuses wrong versions', async () => {
  const { installCurrentApplicationExtensions, currentApplicationExtensions } =
    await import('../current-application-roles.mjs');
  for (const drift of [false, true]) {
    const installed = structuredClone(
      currentApplicationExtensions.filter((item) => ['pg_cron', 'plpgsql'].includes(item.name))
    );
    const statements = [];
    class Client {
      async connect() {}
      async query(sql) {
        if (sql.includes(' AS owned')) return { rows: [{ owned: true }] };
        if (sql.startsWith('SELECT e.extname'))
          return {
            rows: installed
              .map((item) =>
                drift && installed.length === 13 && item.name === 'http'
                  ? { ...item, version: 'wrong' }
                  : item
              )
              .sort((a, b) => (a.name < b.name ? -1 : 1)),
          };
        if (sql.startsWith('CREATE EXTENSION')) {
          const [, name, schema, version] =
            /^CREATE EXTENSION "([^"]+)" WITH SCHEMA "([^"]+)" VERSION '([^']+)'$/.exec(sql);
          installed.push({ name, schema, version, owner: this.owner || 'supabase_admin' });
          statements.push(sql);
        }
        return { rows: [] };
      }
    }
    const applicationClient = new Client();
    applicationClient.owner = 'postgres';
    const clients = [];
    const args = {
      applicationClient,
      Client,
      databaseOwner: {
        own: (c) => {
          clients.push(c);
          return c;
        },
        end: async (c) => {
          c.closed = true;
        },
      },
    };
    if (drift) await assert.rejects(installCurrentApplicationExtensions(args));
    else assert.equal((await installCurrentApplicationExtensions(args)).installed, 13);
    assert.equal(statements.length, 11);
    assert.deepEqual(
      installed.sort((a, b) => (a.name < b.name ? -1 : 1)),
      currentApplicationExtensions
    );
    assert.ok(clients.every((client) => client.closed));
    assert.ok(!statements.some((sql) => sql.includes('pg_net')));
  }
});
