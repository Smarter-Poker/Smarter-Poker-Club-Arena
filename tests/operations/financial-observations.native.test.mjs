// Native SQL reader boundaries, not a funded or authenticated engine proof.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createCluster } from './postgres-fixture.mjs';
import { connect } from '../../operations/release/journal.mjs';
import { observeFinancialFacts } from '../../operations/release/native/component-semantic-observations.mjs';
let cluster;
before(async () => {
  cluster = await createCluster();
});
after(async () => {
  await cluster.close();
  await rm(cluster.directory, { recursive: true });
});
async function fixture(t) {
  const config = await cluster.database({ migrate: false });
  const db = await connect(config);
  t.after(() => db.end());
  await db.query(`
    CREATE TABLE public.tables(id uuid primary key,club_id uuid);
    CREATE TABLE public.club_members(user_id uuid,club_id uuid,chip_balance numeric);
    CREATE TABLE public.table_seats(occupancy_id uuid,user_id uuid,table_id uuid,stack numeric,left_at timestamptz);
    CREATE TABLE public.table_pending_addons(id uuid,user_id uuid,table_id uuid,amount numeric,kind text,resolved_at timestamptz,applied_to_stack numeric,refunded numeric);
    CREATE TABLE public.table_addon_idempotency(key text,user_id uuid,table_id uuid,amount numeric,applied_to_seat boolean);
    CREATE TABLE public.entry_purchase_idempotency_receipts(key_domain text,idempotency_key text,request jsonb,response jsonb,claimed_at timestamptz,completed_at timestamptz);
    CREATE TABLE public.chip_ledger(id uuid,table_id uuid,from_type text,from_entity_id uuid,to_type text,to_entity_id uuid,amount numeric,category text,idempotency_key text);
    CREATE TABLE public.wallet_transactions(id uuid,table_id uuid,user_id uuid,type text,category text,amount numeric,balance_after numeric);
    CREATE TABLE public.insurance_transactions(id uuid,table_id uuid,player_id uuid,hand_number bigint,premium numeric,insured_amount numeric,payout numeric,net_result numeric,player_won boolean,bank_type text,bank_entity_id uuid);
    CREATE TABLE public.insurance_offer_events(id uuid,table_id uuid,player_id uuid,hand_number bigint,event text,premium numeric,insured_amount numeric,street text);
    CREATE TABLE public.hand_atomic_commits(table_id uuid,hand_number bigint,hand_id uuid,payload_hash text,committed_at timestamptz,post_commit_completed_at timestamptz,post_commit_payload_hash text,post_commit_result jsonb);
  `);
  const table = randomUUID(),
    foreign = randomUUID(),
    club = randomUUID(),
    actors = [randomUUID(), randomUUID()],
    other = randomUUID();
  const financial = { actor_index: 0, op_id: 'owned-reader-0001', hand_number: 1000001 };
  const key = `addon:${table}:${actors[0]}:${financial.op_id}`;
  await db.query('INSERT INTO public.tables VALUES($1,$3),($2,$3)', [table, foreign, club]);
  await db.query('INSERT INTO public.club_members VALUES($1,$4,1900),($2,$4,1800),($3,$4,9999)', [
    ...actors,
    other,
    club,
  ]);
  await db.query('INSERT INTO public.table_seats VALUES($1,$2,$3,200,null),($4,$5,$6,999,null)', [
    randomUUID(),
    actors[0],
    table,
    randomUUID(),
    other,
    foreign,
  ]);
  await db.query(
    "INSERT INTO public.table_pending_addons VALUES($1,$2,$3,10,'addon',null,null,null),($4,$5,$6,999,'addon',null,null,null)",
    [randomUUID(), actors[0], table, randomUUID(), other, foreign]
  );
  await db.query('INSERT INTO public.table_addon_idempotency VALUES($1,$2,$3,10,false)', [
    key,
    actors[0],
    table,
  ]);
  await db.query(
    "INSERT INTO public.entry_purchase_idempotency_receipts VALUES('cash_addon',$1,$2,'{\"balance\":1890}',now(),now())",
    [key, { table_id: table, user_id: actors[0], amount: 10, apply_to_seat: false }]
  );
  await db.query(
    "INSERT INTO public.insurance_offer_events VALUES($1,$2,$3,1000001,'offered',12,200,'turn'),($4,$5,$3,1000001,'offered',999,999,'turn')",
    [randomUUID(), table, actors[0], randomUUID(), foreign]
  );
  async function read(value = financial) {
    await db.query(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL row_security=off; SET LOCAL search_path=pg_catalog; SET LOCAL statement_timeout='5s'"
    );
    try {
      return await observeFinancialFacts(db, table, actors, value);
    } finally {
      await db.query('ROLLBACK');
    }
  }
  return { db, table, foreign, actors, other, key, financial, read };
}
test('fixed native reader scopes actors/table/key/hand and preserves exact numeric strings', async (t) => {
  const f = await fixture(t),
    data = await f.read();
  assert.equal(data.wallets.length, 2);
  assert.equal(data.seats.length, 1);
  assert.equal(data.addons.length, 1);
  assert.equal(data.addon_keys.length, 1);
  assert.equal(data.receipts.length, 1);
  assert.equal(data.offers.length, 1);
  assert.equal(data.addons[0][2], '10');
  assert.equal(data.addon_keys[0][3], 'false');
  assert.ok(!JSON.stringify(data).includes(f.other));
  assert.ok(!JSON.stringify(data).includes(f.foreign));
  assert.deepEqual(await f.read(), data, 'the observation itself must not alter any selected row');
  assert.equal((await f.read({ ...f.financial, op_id: 'other-operation' })).receipts.length, 0);
  assert.equal((await f.read({ ...f.financial, hand_number: 1000002 })).offers.length, 0);
});
test('native reader refuses an over-cap journal instead of returning a truncated proof', async (t) => {
  const f = await fixture(t);
  await f.db.query(
    "INSERT INTO public.chip_ledger SELECT gen_random_uuid(),$1,'player_wallet',$2,'table_stack',$1,1,'addon','one:'||n FROM generate_series(1,65) n",
    [f.table, f.actors[0]]
  );
  await assert.rejects(f.read(), /ROW_CAP/);
  assert.equal(
    (await f.db.query('SELECT count(*)::int AS n FROM public.chip_ledger')).rows[0].n,
    65
  );
});
test('native reader refuses a view masquerading as a fixed base relation', async (t) => {
  const f = await fixture(t);
  await f.db.query(
    'ALTER TABLE public.wallet_transactions RENAME TO old_wallet_transactions; CREATE VIEW public.wallet_transactions AS SELECT * FROM public.old_wallet_transactions'
  );
  await assert.rejects(f.read(), /RELATION/);
});
test('native reader refuses a missing actor wallet instead of treating it as zero', async (t) => {
  const f = await fixture(t);
  await f.db.query('DELETE FROM public.club_members WHERE user_id=$1', [f.actors[1]]);
  await assert.rejects(f.read(), /ACTOR_MEMBERSHIP/);
});
