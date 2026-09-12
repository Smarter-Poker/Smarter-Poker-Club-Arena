import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
  // pg_get_* deparsers depend on search_path. Canonicalize it for producer and
  // bridge alike. The caller supplies an exclusive connection. A savepoint
  // preserves both session and SET LOCAL settings without committing the
  // caller's transaction. Standalone callers get an owned read-only transaction.
  const savepoint = `catalogue_${randomUUID().replaceAll('-', '')}`;
  let ownsTransaction = false;
  try {
    await db.query(`SAVEPOINT ${savepoint}`);
  } catch (error) {
    if (error.code !== '25P01') throw error;
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    ownsTransaction = true;
  }
  try {
    await db.query('SET LOCAL search_path = pg_catalog');
    return await canonicalSchemaCatalogue(db);
  } finally {
    if (ownsTransaction) await db.query('ROLLBACK');
    else {
      await db.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await db.query(`RELEASE SAVEPOINT ${savepoint}`);
    }
  }
}
async function canonicalSchemaCatalogue(db) {
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

// Called only by the private fixed-query bridge, never through oracle SQL.
// Lock actual base tables before checking types, closing the schema/view swap
// race until the enclosing read-only transaction finishes.
export async function lockObservationRelations(db) {
  await db.query('LOCK TABLE public.hand_history, public.table_seats IN ACCESS SHARE MODE');
  const { rows } = await db.query(`SELECT n.nspname,c.relname,c.relkind,a.attname,
    tn.nspname AS type_schema,t.typname
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
    JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
    JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace
    WHERE n.nspname='public' AND c.relname IN ('hand_history','table_seats')
      AND a.attnum>0 AND NOT a.attisdropped`);
  const contracts = {
    hand_history: {
      table_id: ['uuid'],
      hand_number: ['int4', 'int8'],
      pot_size: ['numeric'],
      rake_amount: ['numeric'],
      actions: ['jsonb'],
      players: ['jsonb'],
    },
    table_seats: { table_id: ['uuid'], user_id: ['uuid'] },
  };
  for (const [table, columns] of Object.entries(contracts)) {
    for (const [column, types] of Object.entries(columns)) {
      const found = rows.filter((row) => row.relname === table && row.attname === column);
      assert.equal(found.length, 1);
      assert.ok(
        ['r', 'p'].includes(found[0].relkind) &&
          found[0].type_schema === 'pg_catalog' &&
          types.includes(found[0].typname),
        'observation relation contract changed'
      );
    }
  }
}
export async function observeHandPresence(db, tableId, handNumber) {
  await lockObservationRelations(db);
  const { rows } = await db.query(
    'SELECT count(*)::integer AS count FROM public.hand_history WHERE table_id=$1 AND hand_number=$2',
    [tableId, handNumber]
  );
  return { count: rows[0].count };
}
export async function observeHandFacts(db, tableId, handNumber, spectatorId) {
  await lockObservationRelations(db);
  const { rows } = await db.query(
    `SELECT count(*) OVER()::integer AS total, hand_number,
    pot_size::text,rake_amount::text,
    CASE WHEN jsonb_typeof(actions)='array' THEN jsonb_array_length(actions) END AS action_count,
    CASE WHEN jsonb_typeof(players)='array' THEN jsonb_array_length(players) END AS player_count
    FROM public.hand_history WHERE table_id=$1 AND hand_number=$2 LIMIT 2`,
    [tableId, handNumber]
  );
  const seat = await db.query(
    'SELECT count(*)::integer AS count FROM public.table_seats WHERE table_id=$1 AND user_id=$2',
    [tableId, spectatorId]
  );
  return {
    count: rows[0]?.total ?? 0,
    rows: rows.map(({ total, hand_number, ...row }) => ({
      hand_number: Number(hand_number),
      ...row,
    })),
    seat_count: seat.rows[0].count,
  };
}
export async function captureObservationHandFloor(db, tableId) {
  await lockObservationRelations(db);
  const { rows } = await db.query(
    'SELECT coalesce(max(hand_number),0)::text AS hand_floor FROM public.hand_history WHERE table_id=$1',
    [tableId]
  );
  const value = Number(rows[0].hand_floor);
  assert.ok(Number.isSafeInteger(value) && value >= 0);
  return value;
}

/** Fixed, read-only economic facts for the two actors bound by the fixture
 * owner. Never accepts a relation name, SQL, club id or arbitrary player id.
 * The caller owns a repeatable-read transaction with row_security=off.
 */
export async function observeFinancialFacts(db, tableId, actorIds, financial) {
  const { validateFinancial, validateFinancialData, FINANCIAL_SECTIONS } =
    await import('./component-observation-protocol.mjs');
  validateFinancial(financial);
  assert.ok(Array.isArray(actorIds) && actorIds.length === 2 && new Set(actorIds).size === 2);
  for (const id of [tableId, ...actorIds])
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const tables = [
    'tables',
    'club_members',
    'table_seats',
    'table_pending_addons',
    'table_addon_idempotency',
    'entry_purchase_idempotency_receipts',
    'chip_ledger',
    'wallet_transactions',
    'insurance_transactions',
    'insurance_offer_events',
    'hand_atomic_commits',
  ];
  // ACCESS SHARE freezes relation identity for these fixed queries without
  // blocking ordinary game writes. Missing/replaced relation kinds refuse.
  await db.query(
    'LOCK TABLE public.tables, public.club_members, public.table_seats, public.table_pending_addons, public.table_addon_idempotency, public.entry_purchase_idempotency_receipts, public.chip_ledger, public.wallet_transactions, public.insurance_transactions, public.insurance_offer_events, public.hand_atomic_commits IN ACCESS SHARE MODE'
  );
  const identity = await db.query(
    "SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND c.relkind IN ('r','p') ORDER BY c.relname",
    [tables]
  );
  assert.deepEqual(
    identity.rows.map((r) => r.relname),
    [...tables].sort(),
    'FINANCIAL_OBSERVATION_RELATION'
  );
  const actor = actorIds[financial.actor_index];
  const key = `addon:${tableId}:${actor}:${financial.op_id}`;
  const args = [tableId, actorIds, key, financial.hand_number];
  const queries = {
    wallets:
      'SELECT jsonb_build_array(user_id::text,chip_balance::text) AS row FROM public.club_members WHERE club_id=(SELECT club_id FROM public.tables WHERE id=$1) AND user_id=ANY($2::uuid[]) ORDER BY user_id LIMIT 3',
    seats:
      'SELECT jsonb_build_array(occupancy_id::text,user_id::text,stack::text,left_at::text) AS row FROM public.table_seats WHERE table_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY occupancy_id LIMIT 9',
    addons:
      'SELECT jsonb_build_array(id::text,user_id::text,amount::text,kind,resolved_at::text,applied_to_stack::text,refunded::text) AS row FROM public.table_pending_addons WHERE table_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY id LIMIT 9',
    addon_keys:
      'SELECT jsonb_build_array(key,user_id::text,amount::text,applied_to_seat::text,table_id::text) AS row FROM public.table_addon_idempotency WHERE table_id=$1 AND user_id=ANY($2::uuid[]) AND key=$3 ORDER BY key LIMIT 3',
    receipts:
      "SELECT jsonb_build_array(key_domain,idempotency_key,request::text,response::text,claimed_at::text,completed_at::text) AS row FROM public.entry_purchase_idempotency_receipts WHERE key_domain='cash_addon' AND idempotency_key=$3 AND request->>'table_id'=$1::text AND request->>'user_id'=ANY($2::text[]) ORDER BY key_domain,idempotency_key LIMIT 3",
    ledger:
      'SELECT jsonb_build_array(id::text,from_type,from_entity_id::text,to_type,to_entity_id::text,amount::text,category,idempotency_key) AS row FROM public.chip_ledger WHERE table_id=$1 ORDER BY id LIMIT 65',
    wallet_transactions:
      'SELECT jsonb_build_array(id::text,user_id::text,type,category,amount::text,balance_after::text) AS row FROM public.wallet_transactions WHERE table_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY id LIMIT 65',
    insurance:
      'SELECT jsonb_build_array(id::text,player_id::text,premium::text,insured_amount::text,payout::text,net_result::text,player_won::text,bank_type,bank_entity_id::text) AS row FROM public.insurance_transactions WHERE table_id=$1 AND player_id=ANY($2::uuid[]) AND hand_number=$4 ORDER BY id LIMIT 9',
    offers:
      'SELECT jsonb_build_array(id::text,player_id::text,event,premium::text,insured_amount::text,street,hand_number::text) AS row FROM public.insurance_offer_events WHERE table_id=$1 AND player_id=ANY($2::uuid[]) AND hand_number=$4 ORDER BY id LIMIT 25',
    commits:
      'SELECT jsonb_build_array(hand_id::text,payload_hash,committed_at::text,post_commit_completed_at::text,post_commit_payload_hash,post_commit_result::text) AS row FROM public.hand_atomic_commits WHERE table_id=$1 AND hand_number=$4 ORDER BY hand_id LIMIT 3',
  };
  const data = { actor_ids: [...actorIds] };
  for (const [name, sql] of Object.entries(queries)) {
    // Unused bind slots still have explicit types, so PostgreSQL can prepare
    // every fixed query without relying on driver interpolation or casts from
    // client-supplied SQL. The CTE is a value binding, never an authority RPC.
    const bound =
      'WITH observation_binding AS (SELECT $1::uuid,$2::uuid[],$3::text,$4::bigint) ' + sql;
    const result = await db.query(bound, args);
    assert.ok(result.rows.length <= FINANCIAL_SECTIONS[name][0], 'FINANCIAL_OBSERVATION_ROW_CAP');
    data[name] = result.rows.map((r) => r.row);
  }
  assert.equal(data.wallets.length, 2, 'FINANCIAL_OBSERVATION_ACTOR_MEMBERSHIP');
  return validateFinancialData(data);
}
