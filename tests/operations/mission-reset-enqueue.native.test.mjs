import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createCluster } from './postgres-fixture.mjs';
import { connect } from '../../operations/release/journal.mjs';

test('actual global reset enqueue selection, replay and privileges run only in isolated PostgreSQL', async () => {
  const cluster = await createCluster();
  let db;
  try {
    db = await connect(await cluster.database({ migrate: false }));
    await db.query(`CREATE SCHEMA extensions;
      CREATE FUNCTION public.fn_caller_is_engine() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role', true) = 'service_role' $$;
      CREATE TABLE public.user_notification_preferences(user_id uuid PRIMARY KEY, daily_mission_reminders boolean);
      CREATE TABLE public.notifications(id uuid DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid, type text, title text, message text, link text, action_url text, read boolean, is_read boolean, data jsonb);
      GRANT USAGE ON SCHEMA public TO service_role, authenticated, anon;`);
    // Use the actual migration body and grants, not a rewritten enqueue implementation.
    const source = await readFile(
      new URL(
        '../../supabase/migrations/20260906111916_daily_missions_serialized_replay_streak_and_reset_safety.sql',
        import.meta.url
      ),
      'utf8'
    );
    const start = source.indexOf(
      'CREATE OR REPLACE FUNCTION public.enqueue_daily_mission_reset_notifications('
    );
    const end = source.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_drain_daily_mission_reset_notifications(',
      start
    );
    assert.ok(start > 0 && end > start);
    await db.query(source.slice(start, end));
    const indexSource = await readFile(
      new URL(
        '../../supabase/migrations/20260831150000_daily_mission_alerts_and_observability.sql',
        import.meta.url
      ),
      'utf8'
    );
    const index = indexSource.match(
      /CREATE UNIQUE INDEX IF NOT EXISTS notifications_daily_mission_cycle_unique[\s\S]*?;/
    );
    assert.ok(index);
    await db.query(index[0]);
    const optedIn = randomUUID(),
      optedOut = randomUUID();
    await db.query('INSERT INTO public.user_notification_preferences VALUES ($1,true),($2,false)', [
      optedIn,
      optedOut,
    ]);
    await db.query(
      "SET ROLE authenticated; SELECT set_config('request.jwt.claim.role','authenticated',false)"
    );
    await assert.rejects(
      db.query("SELECT public.enqueue_daily_mission_reset_notifications('2026-09-11',5000)"),
      { code: '42501' }
    );
    await db.query('RESET ROLE; SET ROLE service_role');
    await assert.rejects(
      db.query("SELECT public.enqueue_daily_mission_reset_notifications('2026-09-11',5000)"),
      /service role required/
    );
    await db.query("SELECT set_config('request.jwt.claim.role','service_role',false)");
    assert.equal(
      (
        await db.query(
          "SELECT public.enqueue_daily_mission_reset_notifications('2026-09-11',5000) AS n"
        )
      ).rows[0].n,
      1
    );
    assert.equal(
      (
        await db.query(
          "SELECT public.enqueue_daily_mission_reset_notifications('2026-09-11',5000) AS n"
        )
      ).rows[0].n,
      0
    );
    await assert.rejects(
      db.query("SELECT public.enqueue_daily_mission_reset_notifications('2026-09-11',5001)"),
      /p_limit/
    );
    await db.query('RESET ROLE');
    const rows = (await db.query('SELECT user_id,type,message,data FROM public.notifications'))
      .rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, optedIn);
    assert.equal(rows[0].data.cycle_date, '2026-09-11');
    assert.equal(
      rows[0].message,
      'A Fresh Set Of Poker Missions And Rewards Is Ready In Club Arena.'
    );
  } finally {
    await db?.end();
    await cluster.close();
  }
});
