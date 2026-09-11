import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLUB_ID = '90000000-0000-4000-8000-000000000001';
const OP_IDS = [
  '90000000-0000-4000-8000-000000000011',
  '90000000-0000-4000-8000-000000000012',
  '90000000-0000-4000-8000-000000000021',
  '90000000-0000-4000-8000-000000000022',
];

function inputIds(actorIds, spectatorId) {
  assert.ok(Array.isArray(actorIds) && actorIds.length === 2, 'FIXTURE_TWO_ACTORS_REQUIRED');
  const ids = [...actorIds, spectatorId];
  assert.ok(
    ids.every((id) => typeof id === 'string' && UUID.test(id)),
    'FIXTURE_UUID_REQUIRED'
  );
  assert.equal(
    new Set(ids.map((id) => id.toLowerCase())).size,
    3,
    'FIXTURE_DISTINCT_USERS_REQUIRED'
  );
  return ids.map((id) => id.toLowerCase());
}

/**
 * Called after real GoTrue migrations, application DDL and three admin-API
 * signups. The input contains identities only. No auth row, session, hand,
 * ledger leg, seat or balance is fabricated by this seed.
 */
export async function seedFixture({ db, actorIds, spectatorId }) {
  const ids = inputIds(actorIds, spectatorId);
  const [actorOne, actorTwo, spectator] = ids;
  const connected = await db.query(`SELECT current_database() AS database,
    inet_server_addr() IS NULL AS local_socket, current_user AS database_user`);
  assert.deepEqual(
    connected.rows[0],
    {
      database: 'club_arena_qualification',
      local_socket: true,
      database_user: 'postgres',
    },
    'FIXTURE_OWNED_LOCAL_DATABASE_REQUIRED'
  );

  let stage = 'begin';
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await db.query("SET LOCAL statement_timeout = '10s'");
    await db.query("SET LOCAL lock_timeout = '2s'");
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('component-fixture-seed-v1', 0))"
    );
    stage = 'auth-preconditions';
    const auth = await db.query(
      `SELECT count(*)::integer AS total,
      count(*) FILTER (WHERE id=ANY($1::uuid[])
        AND email LIKE '%@component-fixture.invalid'
        AND raw_user_meta_data->'component_qualification'='true'::jsonb)::integer AS synthetic
      FROM auth.users`,
      [ids]
    );
    assert.deepEqual(auth.rows[0], { total: 3, synthetic: 3 }, 'FIXTURE_GOTRUE_USERS_REQUIRED');
    const profiles = await db.query(
      `SELECT count(*)::integer AS total,
      count(*) FILTER (WHERE id=ANY($1::uuid[]))::integer AS expected FROM public.profiles`,
      [ids]
    );
    assert.deepEqual(
      profiles.rows[0],
      { total: 3, expected: 3 },
      'FIXTURE_SIGNUP_PROFILES_REQUIRED'
    );
    const empty = await db.query(`SELECT
      NOT EXISTS(SELECT 1 FROM public.clubs) AND
      NOT EXISTS(SELECT 1 FROM public.tables) AND
      NOT EXISTS(SELECT 1 FROM public.table_seats) AND
      NOT EXISTS(SELECT 1 FROM public.hand_history) AND
      NOT EXISTS(SELECT 1 FROM public.chip_ledger) AS empty`);
    assert.equal(empty.rows[0].empty, true, 'FIXTURE_EMPTY_GAME_DATABASE_REQUIRED');
    const policy = await db.query(`SELECT count(*)::integer AS count FROM public.ca_mint_policy
      WHERE id=1 AND per_operation_cap_chips=10000000 AND rolling_24h_cap_chips=25000000
      AND per_operation_cap_diamonds=1000000 AND rolling_24h_cap_diamonds=2000000`);
    assert.equal(policy.rows[0].count, 1, 'FIXTURE_REVIEWED_MINT_POLICY_REQUIRED');

    stage = 'synthetic-club';
    // These are synthetic profile/preferences and zero-balance membership
    // configuration; all existing triggers remain enabled.
    await db.query(
      `UPDATE public.profiles SET onboarding_complete=true,
      age_verified=true, age_verified_at=now(), over_18_attested_at=now(),
      club_arena_tos_accepted_at=now(), jurisdiction_country='US',
      jurisdiction_region='IL', jurisdiction_acknowledged_at=now(),
      arena_avatar_url='/avatars/table/free_samurai@2x.webp'
      WHERE id=ANY($1::uuid[])`,
      [ids]
    );
    await db.query(
      `INSERT INTO public.clubs
      (id,name,club_id,slug,owner_id,is_public,requires_approval,chip_treasury,chip_pool)
      VALUES($1,'Component Fixture Club',99001,'component-fixture-club',$2,true,false,0,0)`,
      [CLUB_ID, spectator]
    );
    await db.query(
      `INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance)
      SELECT $1,id,CASE WHEN id=$3 THEN 'owner' ELSE 'player' END,'active',0
      FROM unnest($2::uuid[]) AS id`,
      [CLUB_ID, ids, spectator]
    );

    // Exercise the real privileged service doors. PostgREST does the same
    // SET ROLE / JWT claims setup after verifying the local service JWT.
    await db.query('SET LOCAL ROLE service_role');
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: 'service_role', sub: spectator }),
    ]);
    stage = 'mint';
    const mint = await db.query(
      `SELECT public.fn_ca_mint('chips','club',$1,4000,
      'Disposable component fixture opening supply','component-fixture-v1:opening','seeded') AS result`,
      [CLUB_ID]
    );
    assert.equal(mint.rows[0].result?.ok, true, 'FIXTURE_MINT_REFUSED');
    stage = 'club-bank-transfer';
    for (const [index, actor] of [actorOne, actorTwo].entries()) {
      const sent = await db.query(
        `SELECT public.fn_club_bank_send($1,$2,2000,'player_wallet',
        'Disposable component fixture actor funding',$3) AS result`,
        [CLUB_ID, actor, OP_IDS[index]]
      );
      assert.equal(sent.rows[0].result?.success, true, 'FIXTURE_BANK_SEND_REFUSED');
    }
    stage = 'cash-game';
    const game = await db.query(
      `SELECT public.fn_cash_game_create($1,'classic','nlh',1,2,6,
      '{}'::jsonb,'Component Fixture Cash',false) AS result`,
      [CLUB_ID]
    );
    const tableId = game.rows[0].result?.table_id;
    assert.ok(typeof tableId === 'string' && UUID.test(tableId), 'FIXTURE_CASH_GAME_REFUSED');
    stage = 'buy-in';
    for (const [index, actor] of [actorOne, actorTwo].entries()) {
      await db.query('SELECT public.atomic_table_buyin($1,$2,$3,200,false,$4,$5)', [
        actor,
        tableId,
        index + 1,
        CLUB_ID,
        OP_IDS[index + 2],
      ]);
    }
    await db.query('RESET ROLE');
    stage = 'verify';
    const result = await db.query(
      `SELECT
      (SELECT count(*)::integer FROM public.table_seats WHERE table_id=$1 AND left_at IS NULL
        AND user_id=ANY($2::uuid[]) AND stack=200) AS actors,
      (SELECT count(*)::integer FROM public.table_seats WHERE user_id=$3 AND left_at IS NULL) AS spectator_seats,
      (SELECT sum(chip_balance) FROM public.club_members WHERE club_id=$4) +
      (SELECT sum(stack) FROM public.table_seats WHERE table_id=$1 AND left_at IS NULL) +
      (SELECT chip_treasury FROM public.clubs WHERE id=$4) AS supply,
      (SELECT count(*)::integer FROM public.hand_history) AS hands,
      (SELECT mfa_required FROM public.profiles WHERE id=$3) AS spectator_mfa_required`,
      [tableId, [actorOne, actorTwo], spectator, CLUB_ID]
    );
    assert.equal(result.rows[0].actors, 2, 'FIXTURE_PAID_SEATS_REQUIRED');
    assert.equal(result.rows[0].spectator_seats, 0, 'FIXTURE_SPECTATOR_MUST_REMAIN_UNSEATED');
    assert.equal(Number(result.rows[0].supply), 4000, 'FIXTURE_SUPPLY_MUST_BALANCE');
    assert.equal(result.rows[0].hands, 0, 'FIXTURE_MUST_NOT_SEED_HANDS');
    assert.equal(result.rows[0].spectator_mfa_required, true, 'FIXTURE_OWNER_MFA_GUARD_REQUIRED');
    // Force all financial constraints before publishing the fixture identity.
    await db.query('SET CONSTRAINTS ALL IMMEDIATE');
    await db.query('COMMIT');
    return {
      club_id: CLUB_ID,
      table_id: tableId,
      actor_user_ids: [actorOne, actorTwo],
      spectator_user_id: spectator,
    };
  } catch (error) {
    await db.query('ROLLBACK');
    // No raw SQL/response/error detail containing auth or account data escapes.
    const code =
      typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : 'REFUSED';
    throw new Error(`FIXTURE_SEED_${stage.toUpperCase().replaceAll('-', '_')}_${code}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let db;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      assert.ok(size <= 4096, 'FIXTURE_INPUT_TOO_LARGE');
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.deepEqual(Object.keys(input).sort(), ['actorIds', 'spectatorId']);
    inputIds(input.actorIds, input.spectatorId);
    const { default: pg } = await import('pg');
    db = new pg.Client({
      host: '/run/postgresql',
      database: 'club_arena_qualification',
      user: 'postgres',
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
    });
    await db.connect();
    process.stdout.write(`${JSON.stringify(await seedFixture({ db, ...input }))}\n`);
  } catch {
    process.stderr.write('FIXTURE_SEED_FAILED\n');
    process.exitCode = 1;
  } finally {
    await db?.end();
  }
}
