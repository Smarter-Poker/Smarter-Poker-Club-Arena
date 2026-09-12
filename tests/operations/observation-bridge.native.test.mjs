import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createCluster } from './postgres-fixture.mjs';
import { connect } from '../../operations/release/journal.mjs';
import { startObservationBridge } from '../../operations/release/fixture/observation-bridge.mjs';
import { createObservationClient } from '../../operations/release/native/component-observation-client.mjs';
import * as protocol from '../../operations/release/native/component-observation-protocol.mjs';
import * as observations from '../../operations/release/native/component-semantic-observations.mjs';
let cluster;
before(async () => {
  cluster = await createCluster();
});
after(async () => {
  await cluster.close();
});
async function fixture(t, overrides = {}) {
  const config = await cluster.database({ migrate: false }),
    admin = await connect(config);
  await admin.query(
    'CREATE EXTENSION "uuid-ossp"; CREATE SCHEMA auth; CREATE TABLE public.tables(id uuid primary key); CREATE TABLE auth.users(id uuid primary key); CREATE TABLE public.club_members(id uuid primary key)'
  );
  const base = await readFile(
    new URL('../../supabase/migrations/001_club_arena_schema.sql', import.meta.url),
    'utf8'
  );
  const history = await readFile(
    new URL(
      '../../supabase/migrations/20260307_hand_rake_history_missing_rpcs.sql',
      import.meta.url
    ),
    'utf8'
  );
  await admin.query(base.match(/CREATE TABLE IF NOT EXISTS table_seats \([\s\S]+?\n\);/)[0]);
  await admin.query(history.match(/CREATE TABLE IF NOT EXISTS hand_history \([\s\S]+?\n\);/)[0]);
  const table = randomUUID(),
    spectator = randomUUID(),
    foreignTable = randomUUID();
  await admin.query('INSERT INTO public.tables VALUES($1),($2)', [table, foreignTable]);
  await admin.query('INSERT INTO auth.users VALUES($1)', [spectator]);
  const directory = await mkdtemp(path.join(tmpdir(), 'obs-pg-'));
  await chmod(directory, 0o2750);
  const socketPath = path.join(directory, 'observation.sock');
  const binding = {
    version: 1,
    instance_id: randomUUID(),
    control_sha: 'c'.repeat(40),
    table_id: table,
    spectator_user_id: spectator,
  };
  const db = await connect(config),
    failures = [];
  const options = {
    socketPath,
    fixtureUid: process.getuid(),
    observerUid: process.getuid(),
    observerGid: process.getgid(),
    allowSharedTestIdentity: true,
    protocol,
    observations: { ...observations, ...overrides },
  };
  const bridge = await startObservationBridge(
    { db, binding, onFailure: (value) => failures.push(value) },
    options
  );
  const client = createObservationClient(
    { ...binding, socket: socketPath },
    { version: 1, control_sha: binding.control_sha },
    options
  );
  t.after(async () => {
    client.close();
    await bridge.close();
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  });
  const insert = async (id = table) =>
    admin.query(
      `INSERT INTO public.hand_history(table_id,hand_number,pot_size,rake_amount,actions,players) VALUES($1,17,25,1,'[{"type":"call"},{"type":"pot_win"}]','[{"seat":1},{"seat":2}]')`,
      [id]
    );
  return { admin, db, client, bridge, failures, table, spectator, foreignTable, insert };
}
const hand = { hand_number: 17, next_hand_number: 18 };

test('catalogue reads preserve caller-local settings through commit', async (t) => {
  const f = await fixture(t);
  const settings = async () =>
    (
      await f.admin.query(
        "SELECT current_setting('search_path') AS path, current_setting('transaction_read_only') AS read_only"
      )
    ).rows[0];
  const initial = await settings();
  const schema = await observations.schemaCatalogue(f.admin);
  assert.deepEqual(await settings(), initial, 'standalone read must preserve session settings');
  await f.admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await f.admin.query('SET LOCAL search_path = pg_catalog');
  assert.equal(await observations.schemaCatalogue(f.admin), schema);
  assert.deepEqual(await settings(), { path: 'pg_catalog', read_only: 'on' });
  await f.admin.query('SET LOCAL search_path = public, pg_catalog');
  assert.equal(await observations.schemaCatalogue(f.admin), schema);
  assert.deepEqual(await settings(), { path: 'public, pg_catalog', read_only: 'on' });
  await f.admin.query('COMMIT');
  assert.deepEqual(
    await settings(),
    initial,
    'committing the caller must not leak its local path into the session'
  );
});

test('private fixed-query bridge returns actual scoped PG facts and preserves application ACLs', async (t) => {
  const f = await fixture(t);
  const schema = await observations.schemaCatalogue(f.admin);
  assert.equal((await f.client.catalogue()).catalogue_digest, schema);
  assert.deepEqual(await f.client.handPresence(hand), { count: 0 });
  await f.insert();
  await f.insert(f.foreignTable);
  await f.admin.query(
    'INSERT INTO public.table_seats(table_id,user_id,seat_number,stack) VALUES($1,$2,1,100)',
    [f.foreignTable, f.spectator]
  );
  assert.deepEqual(await f.client.handPresence(hand), { count: 1 });
  const facts = await f.client.handFacts(hand);
  assert.equal(facts.rows.length, 1);
  assert.equal(facts.rows[0].pot_size, '25.00');
  assert.equal(facts.seat_count, 0);
  assert.deepEqual(protocol.verifyObservedHandFacts(facts, hand), {
    hand_number: 17,
    next_hand_number: 18,
    actions: 2,
    players: 2,
    seat_count: 0,
  });
  assert.equal(
    await observations.schemaCatalogue(f.admin),
    schema,
    'bridge must not modify app ACLs or schema'
  );
  await f.admin.query(
    'INSERT INTO public.table_seats(table_id,user_id,seat_number,stack) VALUES($1,$2,1,100)',
    [f.table, f.spectator]
  );
  const seated = await f.client.handFacts(hand);
  assert.equal(seated.seat_count, 1);
  assert.throws(() => protocol.verifyObservedHandFacts(seated, hand), /spectator acquired/);
});

test('a substituted view cannot be executed as a hand observation relation', async (t) => {
  const f = await fixture(t);
  await f.admin.query(
    'ALTER TABLE public.hand_history RENAME TO old_hand_history; CREATE VIEW public.hand_history AS SELECT * FROM public.old_hand_history'
  );
  await assert.rejects(f.client.handPresence(hand));
  assert.equal(f.failures.length, 1);
  assert.equal(
    (await f.admin.query('SELECT count(*)::integer AS n FROM public.old_hand_history')).rows[0].n,
    0
  );
});

test('private PG connection enforces read-only transactions even against an injected test query', async (t) => {
  const f = await fixture(t, {
    observeHandPresence: async (db) => {
      await db.query('DELETE FROM public.hand_history');
      return { count: 0 };
    },
  });
  await f.insert();
  await assert.rejects(f.client.handPresence(hand));
  assert.equal(f.failures.length, 1);
  assert.equal(
    (await f.admin.query('SELECT count(*)::integer AS n FROM public.hand_history')).rows[0].n,
    1
  );
});

test('actual private PG backend termination closes bridge without an alternate query path', async (t) => {
  const f = await fixture(t);
  const pid = f.db.processID;
  await f.admin.query('SELECT pg_terminate_backend($1)', [pid]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(f.client.catalogue());
  assert.equal(f.failures.length, 1);
  assert.equal(
    (await f.admin.query('SELECT 1 AS n')).rows[0].n,
    1,
    'runtime admin connection is independently owned'
  );
});
