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
  // Full definitions plus normalized ownership/effective ACLs. PUBLIC grants
  // remain visible; NOINHERIT is not evidence of observer isolation. Role names
  // replace OIDs and ACL entries sort independently of GRANT statement order.
  // This query is fixture-only; the result never contains role passwords.
  const { rows } = await db.query(`WITH user_schemas AS (
      SELECT * FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
    ), acl_objects AS (
      SELECT 'routine:'||p.prokind::text AS kind,n.nspname AS schema_name,
        p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS object_name,
        p.proowner AS owner_id,coalesce(p.proacl,acldefault('f',p.proowner)) AS acl
      FROM pg_proc p JOIN user_schemas n ON n.oid=p.pronamespace
      UNION ALL SELECT 'schema',n.nspname,n.nspname,n.nspowner,
        coalesce(n.nspacl,acldefault('n',n.nspowner)) FROM user_schemas n
      UNION ALL SELECT 'relation:'||c.relkind::text,n.nspname,c.relname,c.relowner,
        coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))
      FROM pg_class c JOIN user_schemas n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p','v','m','f','S')
      UNION ALL SELECT 'column',n.nspname,c.relname||'.'||a.attname,c.relowner,
        coalesce(a.attacl,'{}'::aclitem[])
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN user_schemas n ON n.oid=c.relnamespace
      WHERE a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m','f')
      UNION ALL SELECT 'type',n.nspname,t.typname,t.typowner,
        coalesce(t.typacl,acldefault('T',t.typowner))
      FROM pg_type t JOIN user_schemas n ON n.oid=t.typnamespace
      UNION ALL SELECT 'default:'||d.defaclobjtype::text||CASE WHEN d.defaclnamespace=0 THEN ':global' ELSE ':schema' END,coalesce(n.nspname,'*'),
        pg_get_userbyid(d.defaclrole)::text,d.defaclrole,d.defaclacl
      FROM pg_default_acl d LEFT JOIN user_schemas n ON n.oid=d.defaclnamespace
      WHERE d.defaclnamespace=0 OR n.oid IS NOT NULL
    ), normalized_acl AS (
      SELECT o.kind,o.schema_name,o.object_name,pg_get_userbyid(o.owner_id)::text AS owner_name,
        coalesce((SELECT jsonb_agg(jsonb_build_array(
          pg_get_userbyid(a.grantor)::text,
          CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,
          a.privilege_type,a.is_grantable)
          ORDER BY pg_get_userbyid(a.grantor)::text,
          CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END,
          a.privilege_type,a.is_grantable) FROM aclexplode(CASE WHEN cardinality(o.acl)>0 THEN o.acl ELSE NULL::aclitem[] END) a),'[]'::jsonb) AS grants
      FROM acl_objects o
    ) SELECT jsonb_build_object('access',
      (SELECT coalesce(jsonb_agg(jsonb_build_array(kind,schema_name,object_name,owner_name,grants)
        ORDER BY kind,schema_name,object_name),'[]'::jsonb) FROM normalized_acl),
    'roles',(SELECT coalesce(jsonb_agg(jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,
      rolcreatedb,rolcanlogin,rolreplication,rolbypassrls) ORDER BY rolname),'[]'::jsonb) FROM pg_roles),
    'memberships',(SELECT coalesce(jsonb_agg(jsonb_build_array(pg_get_userbyid(roleid),
      pg_get_userbyid(member),pg_get_userbyid(grantor),admin_option,inherit_option,set_option)
      ORDER BY pg_get_userbyid(roleid),pg_get_userbyid(member),pg_get_userbyid(grantor)),'[]'::jsonb)
      FROM pg_auth_members),
    'functions',(SELECT coalesce(jsonb_agg(jsonb_build_array(n.nspname,p.proname,
      pg_get_function_identity_arguments(p.oid),pg_get_functiondef(p.oid))
      ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)),'[]'::jsonb)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('public','auth') AND p.prokind IN ('f','p')),
    'columns',(SELECT coalesce(jsonb_agg(jsonb_build_array(n.nspname,c.relname,a.attname,
      format_type(a.atttypid,a.atttypmod),tn.nspname,t.typname,
      NOT (a.attnotnull OR (t.typtype='d' AND t.typnotnull)),pg_get_expr(d.adbin,d.adrelid),
      a.attnum,a.atttypmod,t.typtype,
      CASE WHEN t.typtype='d' THEN format_type(t.typbasetype,t.typtypmod) ELSE NULL END)
      ORDER BY n.nspname,c.relname,a.attnum),'[]'::jsonb)
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_type t ON t.oid=a.atttypid
      JOIN pg_namespace tn ON tn.oid=t.typnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE n.nspname IN ('public','auth') AND c.relkind IN ('r','p','v','m','f')
        AND a.attnum>0 AND NOT a.attisdropped),
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
    'rls',(SELECT coalesce(jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity)
      ORDER BY n.nspname,c.relname),'[]'::jsonb) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','auth') AND c.relkind IN ('r','p'))
    )::text AS catalogue`);
  return digest(rows[0].catalogue);
}
