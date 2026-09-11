import test from 'node:test';
import assert from 'node:assert/strict';
import {
  controllerDatabase,
  verifyControllerPrincipal,
} from '../../operations/release/controller-owner.mjs';

const config = {
  journal: { database_principal: 'fixture_owner', database_ca_path: '/fixture/ca.pem' },
};
const environment = {
  RELEASE_JOURNAL_DATABASE_URL: 'postgresql://fixture_owner:synthetic@localhost/fixture',
  RELEASE_JOURNAL_CONNECTION_MODE: 'direct',
};
test('installed owner configuration requires exact login and root-owned CA without URL TLS overrides', async () => {
  const reads = [];
  const read = async (name) => {
    reads.push(name);
    return Buffer.from('synthetic-ca');
  };
  const result = await controllerDatabase(config, environment, read);
  assert.equal(result.ssl.rejectUnauthorized, true);
  assert.equal(result.ownerPrincipal, 'fixture_owner');
  assert.deepEqual(reads, ['/fixture/ca.pem']);
  const pooled = await controllerDatabase(
    { journal: { ...config.journal, database_username: 'fixture_owner.abcdefghijklmnopqrst' } },
    {
      ...environment,
      RELEASE_JOURNAL_CONNECTION_MODE: 'session',
      RELEASE_JOURNAL_DATABASE_URL:
        'postgresql://fixture_owner.abcdefghijklmnopqrst:synthetic@localhost/fixture',
    },
    read
  );
  assert.equal(pooled.ownerPrincipal, 'fixture_owner');
  await assert.rejects(
    controllerDatabase(
      { journal: { ...config.journal, database_username: 'admin.abcdefghijklmnopqrst' } },
      environment,
      read
    ),
    /RELEASE_CONTROLLER_IDENTITY_REQUIRED/
  );
  for (const suffix of [
    '?sslmode=disable',
    '?sslmode=require',
    '?sslcert=x',
    '?sslrootcert=x',
    '?ssl=true',
  ])
    await assert.rejects(
      controllerDatabase(
        config,
        {
          ...environment,
          RELEASE_JOURNAL_DATABASE_URL: environment.RELEASE_JOURNAL_DATABASE_URL + suffix,
        },
        read
      ),
      /RELEASE_CONTROLLER_IDENTITY_REQUIRED/
    );
  await assert.rejects(
    controllerDatabase({}, environment, read),
    /RELEASE_CONTROLLER_IDENTITY_REQUIRED/
  );
  await assert.rejects(
    controllerDatabase(
      config,
      { ...environment, RELEASE_JOURNAL_DATABASE_URL: 'postgresql://admin@localhost/fixture' },
      read
    ),
    /RELEASE_CONTROLLER_IDENTITY_REQUIRED/
  );
  await assert.rejects(
    controllerDatabase(
      config,
      { ...environment, RELEASE_JOURNAL_CONNECTION_MODE: 'transaction' },
      read
    ),
    /RELEASE_VERIFIED_SESSION_CONNECTION_REQUIRED/
  );
});
test('owner preflight refuses unauthenticated transport and foreign or elevated identity before ownership', async () => {
  let queries = 0;
  const client = {
    connection: { stream: { encrypted: true, authorized: true } },
    query: async (sql) => {
      queries++;
      assert.match(sql, /NOT rolsuper/);
      assert.match(sql, /release_certification_callback/);
      return { rows: [{ rolname: 'fixture_owner', allowed: true }] };
    },
  };
  await verifyControllerPrincipal(client, 'fixture_owner');
  assert.equal(queries, 1);
  for (const flag of ['encrypted', 'authorized']) {
    client.connection.stream[flag] = false;
    await assert.rejects(
      verifyControllerPrincipal(client, 'fixture_owner'),
      /RELEASE_CONTROLLER_IDENTITY_REQUIRED/
    );
    client.connection.stream[flag] = true;
  }
  assert.equal(queries, 1);
  for (const rows of [
    [],
    [{ rolname: 'admin', allowed: true }],
    [{ rolname: 'fixture_owner', allowed: false }],
  ]) {
    client.query = async () => ({ rows });
    await assert.rejects(
      verifyControllerPrincipal(client, 'fixture_owner'),
      /RELEASE_CONTROLLER_IDENTITY_REQUIRED/
    );
  }
});
