import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const digest = (value) => createHash('sha256').update(value).digest('hex');

// The function is separately testable against native PostgreSQL. The caller
// must supply the browser-observed hand, not a count manufactured by a fixture.
export async function verifyPersistedHand(db, tableId, cycle, userId) {
  // In the disposable fixture, filtering an observer's read through player
  // RLS could hide a duplicated hand or an accidentally acquired seat. This
  // setting makes PostgreSQL error instead of silently returning filtered rows
  // when the fixture reader lacks complete read authority; it grants no bypass.
  await db.query('SET row_security = off');
  assert.ok(Number.isSafeInteger(cycle.handNumber) && cycle.handNumber > 0);
  assert.ok(cycle.nextHandNumber > cycle.handNumber);
  const result = await db.query(
    `SELECT hand_number, pot_size::text, rake_amount::text,
    actions, players FROM public.hand_history WHERE table_id=$1 AND hand_number=$2`,
    [tableId, cycle.handNumber]
  );
  assert.equal(result.rowCount, 1, 'the browser-observed completed hand must persist once');
  const hand = result.rows[0];
  assert.ok(
    Array.isArray(hand.actions) && hand.actions.length > 0,
    'persisted hand requires actual actions'
  );
  assert.ok(
    Array.isArray(hand.players) && hand.players.length >= 2,
    'persisted hand requires two players'
  );
  assert.ok(Number.isFinite(Number(hand.pot_size)) && Number(hand.pot_size) > 0);
  assert.ok(Number(hand.rake_amount) >= 0 && Number(hand.rake_amount) <= Number(hand.pot_size));
  const seat = await db.query(
    'SELECT count(*)::integer AS count FROM public.table_seats WHERE table_id=$1 AND user_id=$2',
    [tableId, userId]
  );
  assert.equal(seat.rows[0].count, 0, 'spectating the exact web bundle must not acquire a seat');
  return {
    hand_number: cycle.handNumber,
    next_hand_number: cycle.nextHandNumber,
    actions: hand.actions.length,
    players: hand.players.length,
    seat_count: 0,
  };
}

export async function schemaCatalogue(db) {
  // Full definitions, result/argument contracts, RLS and columns. Object names
  // alone do not establish schema compatibility. This query is fixture-only.
  const { rows } = await db.query(`SELECT jsonb_build_object(
    'functions',(SELECT coalesce(jsonb_agg(jsonb_build_array(n.nspname,p.proname,
      pg_get_function_identity_arguments(p.oid),pg_get_functiondef(p.oid))
      ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)),'[]'::jsonb)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('public','auth') AND p.prokind IN ('f','p')),
    'columns',(SELECT coalesce(jsonb_agg(jsonb_build_array(table_schema,table_name,column_name,
      data_type,udt_name,is_nullable,column_default) ORDER BY table_schema,table_name,ordinal_position),'[]'::jsonb)
      FROM information_schema.columns WHERE table_schema IN ('public','auth')),
    'policies',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY schemaname,tablename,policyname),'[]'::jsonb)
      FROM pg_policies p WHERE schemaname IN ('public','auth')),
    'constraints',(SELECT coalesce(jsonb_agg(jsonb_build_array(n.nspname,c.relname,k.conname,
      pg_get_constraintdef(k.oid),k.convalidated) ORDER BY n.nspname,c.relname,k.conname),'[]'::jsonb)
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','auth')),
    'triggers',(SELECT coalesce(jsonb_agg(jsonb_build_array(n.nspname,c.relname,t.tgname,
      pg_get_triggerdef(t.oid),t.tgenabled) ORDER BY n.nspname,c.relname,t.tgname),'[]'::jsonb)
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','auth') AND NOT t.tgisinternal),
    'indexes',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY schemaname,tablename,indexname),'[]'::jsonb)
      FROM pg_indexes i WHERE schemaname IN ('public','auth')),
    'grants',(SELECT coalesce(jsonb_agg(jsonb_build_array(n.nspname,c.relname,
      pg_get_userbyid(c.relowner),c.relacl) ORDER BY n.nspname,c.relname),'[]'::jsonb)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','auth')),
    'rls',(SELECT coalesce(jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity)
      ORDER BY n.nspname,c.relname),'[]'::jsonb) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','auth') AND c.relkind IN ('r','p'))
    )::text AS catalogue`);
  return digest(rows[0].catalogue);
}
