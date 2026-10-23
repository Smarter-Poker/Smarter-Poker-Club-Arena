// Explicit local PostgreSQL qualification of the exact operator SQL.
// Never accepts a production URL or creates objects in a remote database.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Client } = require('pg');
const connection = {
  host: '127.0.0.1',
  port: Number(process.env.FREE_BUY_QUAL_PORT || 55489),
  database: 'postgres',
};
const admin = new Client(connection);
await admin.connect();
const database = `free_buy_qualification_${process.pid}`;
await admin.query(`CREATE DATABASE ${database}`);
const db = new Client({ ...connection, database });
const peer = new Client({ ...connection, database });
try {
  await db.connect();
  await peer.connect();
  await db.query(`
    CREATE TABLE public.tournament_schedules(id uuid PRIMARY KEY,club_id uuid,name text,active boolean,time_zone text);
    CREATE TABLE public.tournaments(id uuid PRIMARY KEY,schedule_id uuid REFERENCES public.tournament_schedules,
      club_id uuid,name text,start_time timestamptz,status text,guaranteed_prize numeric,prize_pool numeric DEFAULT 0,
      entry_contract_locked boolean DEFAULT false,prize_pool_finalized boolean DEFAULT false,current_players integer DEFAULT 0,
      tournament_type text DEFAULT 'MTT',game_type text DEFAULT 'NLH',buy_in_amount numeric DEFAULT 0,buy_in_fee numeric DEFAULT 0,
      variant text DEFAULT 'freezeout',satellite_target_id uuid,bubble_protection boolean DEFAULT false);
    CREATE TABLE public.tournament_players(tournament_id uuid REFERENCES public.tournaments,player_id uuid);
    CREATE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql AS
      $$SELECT COALESCE(current_setting('test.free_buy_frozen',true),'off')='on'$$;
  `);
  const guardSource = readFileSync(
    new URL(
      '../../supabase/migrations/20260908042400_tournament_places_settle_and_complete_atomically.sql',
      import.meta.url
    ),
    'utf8'
  );
  const guard = guardSource.match(
    /CREATE OR REPLACE FUNCTION public\.trg_freeze_registered_tournament_settlement_contract\(\)[\s\S]*?\$function\$;/
  )?.[0];
  assert.ok(guard);
  await db.query(guard);
  await db.query(`CREATE TRIGGER registered_contract BEFORE UPDATE ON public.tournaments FOR EACH ROW
    EXECUTE FUNCTION public.trg_freeze_registered_tournament_settlement_contract()`);
  const sql = readFileSync(new URL('../ops/free-buy-guarantees.sql', import.meta.url), 'utf8');
  const hosts = ['fade0000-0000-0000-0000-000000000001', '002c2d27-9584-4e52-835a-bb2be148fc81'];
  const slots = [
    ['Morning', 250],
    ['Midday', 500],
    ['Afternoon', 500],
    ['Prime Time', 500],
    ['Midnight', 250],
  ];
  const schedules = [];
  for (const club of hosts)
    for (const [label, expected] of slots) {
      const id = randomUUID(),
        name = `${label} Free Buy (NLH)`;
      await db.query('INSERT INTO public.tournament_schedules VALUES($1,$2,$3,true,$4)', [
        id,
        club,
        name,
        'America/Chicago',
      ]);
      schedules.push({ id, club, name, expected });
    }
  const insert = async (s, patch = {}) => {
    const record = {
      id: randomUUID(),
      schedule_id: s.id,
      club_id: s.club,
      name: s.name,
      start_time: new Date(Date.now() + 7 * 86400000),
      status: 'REGISTERING',
      guaranteed_prize: s.expected === 250 ? 500 : 1000,
      ...patch,
    };
    const keys = Object.keys(record),
      values = Object.values(record);
    await db.query(
      `INSERT INTO public.tournaments(${keys.join(',')}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(',')})`,
      values
    );
    return record.id;
  };
  const eligible = [];
  for (let day = 0; day < 7; day++)
    for (const s of schedules)
      eligible.push([
        await insert(s, { start_time: new Date(Date.now() + (7 + day) * 86400000) }),
        s.expected,
      ]);
  const s = schedules[0],
    protectedIds = [];
  for (const patch of [
    { entry_contract_locked: true },
    { prize_pool_finalized: true },
    { current_players: 1 },
    { prize_pool: 1 },
    { status: 'RUNNING' },
    { status: 'COMPLETED' },
    { start_time: new Date(Date.now() - 86400000) },
    { tournament_type: 'SNG' },
    { game_type: 'PLO4' },
    { buy_in_amount: 1 },
    { buy_in_fee: 1 },
    { club_id: randomUUID() },
  ])
    protectedIds.push(await insert(s, patch));
  const registered = await insert(s);
  protectedIds.push(registered);
  await db.query('INSERT INTO public.tournament_players VALUES($1,$2)', [registered, randomUUID()]);
  const unrelated = await insert(s, { name: 'Unrelated Free Buy' });
  protectedIds.push(unrelated);
  const before = (
    await db.query('SELECT id,to_jsonb(t) AS row FROM public.tournaments t ORDER BY id')
  ).rows;
  await db.query(sql);
  const after = (
    await db.query('SELECT id,to_jsonb(t) AS row FROM public.tournaments t ORDER BY id')
  ).rows;
  for (const [id, expected] of eligible)
    assert.equal(Number(after.find((r) => r.id === id).row.guaranteed_prize), expected);
  for (const id of protectedIds)
    assert.deepEqual(
      after.find((r) => r.id === id),
      before.find((r) => r.id === id)
    );
  await db.query(sql);
  assert.deepEqual(
    (await db.query('SELECT id,to_jsonb(t) AS row FROM public.tournaments t ORDER BY id')).rows,
    after
  );
  await db.query("SELECT set_config('test.free_buy_frozen','on',false)");
  await assert.rejects(db.query(sql), /refused during maintenance/);
  await db.query("SELECT set_config('test.free_buy_frozen','off',false)");
  // A real concurrent registration wins the parent lock before the operator.
  const racing = await insert(s);
  await peer.query('BEGIN');
  await peer.query('SELECT id FROM public.tournaments WHERE id=$1 FOR UPDATE', [racing]);
  await peer.query('INSERT INTO public.tournament_players VALUES($1,$2)', [racing, randomUUID()]);
  const update = db.query(sql);
  await peer.query('SELECT pg_sleep(0.05)');
  await peer.query('COMMIT');
  await update;
  assert.equal(
    Number(
      (await db.query('SELECT guaranteed_prize FROM public.tournaments WHERE id=$1', [racing]))
        .rows[0].guaranteed_prize
    ),
    500
  );
  await assert.rejects(
    db.query('UPDATE public.tournaments SET guaranteed_prize=250 WHERE id=$1', [registered]),
    /frozen after its first entrant/
  );
  console.log(
    JSON.stringify({
      eligible: eligible.length,
      protected: protectedIds.length,
      replay: 'no-op',
      maintenance: 'refused',
      concurrentRegistration: 'preserved',
      installedRegisteredGuard: 'refused direct change',
    })
  );
} finally {
  await peer.end();
  await db.end();
  await admin.query(`DROP DATABASE ${database}`);
  await admin.end();
}
