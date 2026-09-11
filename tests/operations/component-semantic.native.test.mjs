// Native observation/oracle tests, not a claim that the real candidate images,
// authenticated browser or complete product fixture ran on this workstation.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createCluster } from './postgres-fixture.mjs';
import { connect } from '../../operations/release/journal.mjs';
import {
  verifyPersistedHand,
  schemaCatalogue,
} from '../../operations/release/native/component-semantic-observations.mjs';

let cluster;
before(async () => {
  cluster = await createCluster();
});
after(async () => {
  await cluster.close();
});
async function fixture() {
  const db = await connect(await cluster.database({ migrate: false }));
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
  // Execute actual application's table definitions, with only their unrelated
  // parent rows reduced to id-only scaffolding. These are real PostgreSQL
  // constraints and data queries, not mocked query results or receipt JSON.
  await db.query(`CREATE EXTENSION "uuid-ossp"; CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid primary key);CREATE TABLE public.tables(id uuid primary key);
    CREATE TABLE public.club_members(id uuid primary key);`);
  await db.query(base.match(/CREATE TABLE IF NOT EXISTS table_seats \([\s\S]+?\n\);/)[0]);
  await db.query(history.match(/CREATE TABLE IF NOT EXISTS hand_history \([\s\S]+?\n\);/)[0]);
  const tableId = randomUUID(),
    userId = randomUUID();
  await db.query('INSERT INTO public.tables VALUES($1);', [tableId]);
  await db.query('INSERT INTO auth.users VALUES($1);', [userId]);
  const write = () =>
    db.query(
      `INSERT INTO public.hand_history(table_id,hand_number,pot_size,rake_amount,actions,players)
    VALUES($1,17,25,1,'[{"type":"call"},{"type":"pot_win"}]','[{"seat":1},{"seat":2}]')`,
      [tableId]
    );
  return { db, tableId, userId, write, cycle: { handNumber: 17, nextHandNumber: 18 } };
}

test('product observation requires exactly the browser-observed persisted hand and no spectator seat', async () => {
  const f = await fixture();
  try {
    await assert.rejects(verifyPersistedHand(f.db, f.tableId, f.cycle, f.userId), /persist once/);
    await f.write();
    assert.deepEqual(await verifyPersistedHand(f.db, f.tableId, f.cycle, f.userId), {
      hand_number: 17,
      next_hand_number: 18,
      actions: 2,
      players: 2,
      seat_count: 0,
    });
    await f.write();
    await assert.rejects(verifyPersistedHand(f.db, f.tableId, f.cycle, f.userId), /persist once/);
  } finally {
    await f.db.end();
  }
});

test('real PostgreSQL source schema rejects a receipt for empty actions, impossible rake or acquired seat', async () => {
  const f = await fixture();
  try {
    await f.write();
    await f.db.query("UPDATE public.hand_history SET actions='[]'");
    await assert.rejects(verifyPersistedHand(f.db, f.tableId, f.cycle, f.userId), /actual actions/);
    await f.db.query("UPDATE public.hand_history SET actions='[{}]',rake_amount=26");
    await assert.rejects(verifyPersistedHand(f.db, f.tableId, f.cycle, f.userId));
    await f.db.query('UPDATE public.hand_history SET rake_amount=1');
    await f.db.query(
      'INSERT INTO public.table_seats(table_id,seat_number,user_id,stack) VALUES($1,1,$2,10)',
      [f.tableId, f.userId]
    );
    await assert.rejects(
      verifyPersistedHand(f.db, f.tableId, f.cycle, f.userId),
      /must not acquire a seat/
    );
  } finally {
    await f.db.end();
  }
});

test('exact catalogue detects changed function behavior, same-name columns and RLS policy changes', async () => {
  const f = await fixture();
  try {
    await f.db.query(
      'CREATE FUNCTION public.semantic_fixture_contract() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$'
    );
    const before = await schemaCatalogue(f.db);
    await f.db.query(
      'CREATE OR REPLACE FUNCTION public.semantic_fixture_contract() RETURNS integer LANGUAGE sql AS $$ SELECT 2 $$'
    );
    const intermediate = await schemaCatalogue(f.db);
    assert.notEqual(intermediate, before);
    await f.db.query('ALTER TABLE public.table_seats ALTER COLUMN stack SET DEFAULT 9');
    const after = await schemaCatalogue(f.db);
    assert.notEqual(after, intermediate);
    await f.db.query(
      'ALTER TABLE public.table_seats ENABLE ROW LEVEL SECURITY;CREATE POLICY semantic_read ON public.table_seats FOR SELECT TO anon USING(false)'
    );
    assert.notEqual(await schemaCatalogue(f.db), after);
  } finally {
    await f.db.end();
  }
});

test('old/intermediate/new exact schema combinations execute the SQL oracle and fail the incompatible middle', async () => {
  const results = [];
  for (const mode of ['before', 'intermediate', 'after']) {
    const f = await fixture();
    try {
      await f.write();
      // A real incompatible schema loses the hand's action contract while
      // retaining the endpoint/table names. Final state alone would miss it.
      if (mode === 'intermediate')
        await f.db.query('ALTER TABLE public.hand_history RENAME COLUMN actions TO old_actions');
      try {
        await verifyPersistedHand(f.db, f.tableId, f.cycle, f.userId);
        results.push(true);
      } catch {
        results.push(false);
      }
    } finally {
      await f.db.end();
    }
  }
  assert.deepEqual(results, [true, false, true]);
});

test('an RLS-filtered fixture observer cannot hide a seat or fabricate an empty history', async () => {
  const f = await fixture();
  try {
    await f.write();
    await f.db.query(`GRANT USAGE ON SCHEMA public TO anon;
      GRANT SELECT ON public.hand_history,public.table_seats TO anon;
      ALTER TABLE public.hand_history ENABLE ROW LEVEL SECURITY;
      CREATE POLICY hide_fixture ON public.hand_history FOR SELECT TO anon USING(false);
      SET ROLE anon;`);
    await assert.rejects(
      verifyPersistedHand(f.db, f.tableId, f.cycle, f.userId),
      (error) => error.code === '42501'
    );
  } finally {
    await f.db.query('RESET ROLE');
    await f.db.end();
  }
});
