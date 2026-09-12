import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { assertCanonicalSignup } from './auth-bootstrap-proof.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLUB_REQUEST = '90000000-0000-4000-8000-000000000001';
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
 * Seed through the canonical authenticated doors using real GoTrue session IDs.
 * Each RPC commits separately, so transaction-local money authority cannot leak
 * into the following operation. Failure retires the entire disposable fixture;
 * no fixture identity is returned until every committed postcondition passes.
 */
export async function seedFixture({
  db,
  actorIds,
  spectatorId,
  sessionIds,
  financialScenario = false,
}) {
  assert.equal(typeof financialScenario, 'boolean', 'FIXTURE_FINANCIAL_MODE_REQUIRED');
  const ids = inputIds(actorIds, spectatorId);
  assert.ok(
    Array.isArray(sessionIds) &&
      sessionIds.length === 3 &&
      sessionIds.every((id) => typeof id === 'string' && UUID.test(id)),
    'FIXTURE_REAL_SESSION_IDS_REQUIRED'
  );
  assert.equal(
    new Set(sessionIds.map((id) => id.toLowerCase())).size,
    3,
    'FIXTURE_DISTINCT_SESSIONS_REQUIRED'
  );
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
  let locked = false;
  let claims;
  let signupProof;
  const transaction = async (action, actorIndex = null) => {
    await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      await db.query("SET LOCAL statement_timeout = '10s'");
      await db.query("SET LOCAL lock_timeout = '2s'");
      if (actorIndex !== null) {
        await db.query('SET LOCAL ROLE authenticated');
        await db.query("SELECT set_config('request.jwt.claims',$1,true)", [
          JSON.stringify(claims[actorIndex]),
        ]);
      }
      const result = await action();
      await db.query('SET CONSTRAINTS ALL IMMEDIATE');
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  };
  try {
    const ownership = await db.query(
      "SELECT pg_try_advisory_lock(hashtextextended('component-fixture-seed-v1',0)) AS locked"
    );
    assert.equal(ownership.rows[0].locked, true, 'FIXTURE_SEED_ALREADY_OWNED');
    locked = true;
    stage = 'auth-preconditions';
    await transaction(async () => {
      const auth = await db.query(
        `SELECT count(*)::integer AS total,
        count(*) FILTER (WHERE id=ANY($1::uuid[]) AND email LIKE '%@smarter-poker.invalid'
          AND raw_user_meta_data->'component_qualification'='true'::jsonb)::integer AS synthetic
        FROM auth.users`,
        [ids]
      );
      assert.deepEqual(auth.rows[0], { total: 3, synthetic: 3 }, 'FIXTURE_GOTRUE_USERS_REQUIRED');
      stage = 'signup-profiles';
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
      stage = 'live-sessions';
      const sessions = await db.query(
        `SELECT s.id, s.user_id, s.aal::text AS aal
        FROM auth.sessions s JOIN unnest($1::uuid[],$2::uuid[]) AS expected(user_id,id)
          ON s.id=expected.id AND s.user_id=expected.user_id
        WHERE s.not_after IS NULL OR s.not_after>now()`,
        [ids, sessionIds]
      );
      assert.equal(sessions.rows.length, 3, 'FIXTURE_LIVE_SESSIONS_REQUIRED');
      claims = ids.map((id, index) => {
        const session = sessions.rows.find((row) => row.user_id === id);
        assert.equal(
          session?.id,
          sessionIds[index].toLowerCase(),
          'FIXTURE_SESSION_OWNER_REQUIRED'
        );
        assert.equal(session.aal, index === 2 ? 'aal2' : 'aal1', 'FIXTURE_SESSION_AAL_REQUIRED');
        return { sub: id, role: 'authenticated', session_id: session.id, aal: session.aal };
      });
      stage = 'canonical-signup-outcomes';
      signupProof = await assertCanonicalSignup(db, ids);
      stage = 'empty-database';
      const empty = await db.query(`SELECT
        NOT EXISTS(SELECT 1 FROM public.clubs) AND NOT EXISTS(SELECT 1 FROM public.tables) AND
        NOT EXISTS(SELECT 1 FROM public.table_seats) AND NOT EXISTS(SELECT 1 FROM public.hand_history) AND
        NOT EXISTS(SELECT 1 FROM public.chip_ledger) AS empty`);
      assert.equal(empty.rows[0].empty, true, 'FIXTURE_EMPTY_GAME_DATABASE_REQUIRED');
      stage = 'synthetic-preferences';
      // Synthetic display/legal preferences only; no money or authority flags.
      await db.query(
        `UPDATE public.profiles SET onboarding_complete=true,
        age_verified=true, age_verified_at=now(), over_18_attested_at=now(),
        club_arena_tos_accepted_at=now(), jurisdiction_country='US',
        jurisdiction_region='IL', jurisdiction_acknowledged_at=now(),
        arena_avatar_url='/avatars/table/free_samurai@2x.webp' WHERE id=ANY($1::uuid[])`,
        [ids]
      );
    });
    stage = 'canonical-club';
    const club = await transaction(
      () =>
        db.query(
          `SELECT public.fn_create_club_atomic(
      $1,'Component Fixture Club',NULL,'royal-blue',true,false,NULL) AS result`,
          [CLUB_REQUEST]
        ),
      2
    );
    const clubId = club.rows[0].result?.id;
    assert.ok(typeof clubId === 'string' && UUID.test(clubId), 'FIXTURE_CANONICAL_CLUB_REQUIRED');
    stage = 'opening-grant';
    await transaction(async () => {
      const grant = await db.query(
        `SELECT
        (SELECT chip_treasury FROM public.clubs WHERE id=$1) AS treasury,
        (SELECT count(*)::integer FROM public.chip_ledger WHERE idempotency_key='club-opening-grant:'||$1::text
          AND category='mint' AND from_type='issuance_reserve' AND to_type='club_treasury'
          AND to_entity_id=$1 AND amount=100000) AS ledger,
        (SELECT count(*)::integer FROM public.ca_mint_ledger WHERE op_id='club-opening-grant:'||$1::text
          AND action='mint' AND asset='chips' AND holder_id=$1 AND amount=100000
          AND chip_ledger_id IS NOT NULL) AS mint,
        (SELECT count(*)::integer FROM public.chip_transactions WHERE club_id=$1
          AND transaction_type='club_opening_grant' AND amount=100000) AS transaction`,
        [clubId]
      );
      assert.equal(Number(grant.rows[0].treasury), 100000, 'FIXTURE_OPENING_SUPPLY_REQUIRED');
      for (const field of ['ledger', 'mint', 'transaction'])
        assert.equal(grant.rows[0][field], 1, 'FIXTURE_OPENING_ACCOUNTING_REQUIRED');
    });
    stage = 'canonical-memberships';
    for (let index = 0; index < 2; index++)
      await transaction(() => db.query('SELECT public.fn_join_club($1)', [clubId]), index);
    stage = 'club-bank-transfer';
    for (const [index, actor] of [actorOne, actorTwo].entries()) {
      const sent = await transaction(
        () =>
          db.query(
            `SELECT public.fn_club_bank_send($1,$2,2000,
        'player_wallet','Disposable component fixture actor funding',$3) AS result`,
            [clubId, actor, OP_IDS[index]]
          ),
        2
      );
      assert.equal(sent.rows[0].result?.success, true, 'FIXTURE_BANK_SEND_REFUSED');
    }
    stage = 'cash-game';
    const game = await transaction(
      () =>
        db.query(
          `SELECT public.fn_cash_game_create($1,'classic','nlh',1,2,6,
      $2::jsonb,'Component Fixture Cash',false) AS result`,
          [clubId, financialScenario ? { options: { insurance_enabled: true } } : {}]
        ),
      2
    );
    const tableId = game.rows[0].result?.table_id;
    assert.ok(typeof tableId === 'string' && UUID.test(tableId), 'FIXTURE_CASH_GAME_REFUSED');
    stage = 'buy-in';
    for (const [index, actor] of [actorOne, actorTwo].entries())
      await transaction(
        () =>
          db.query('SELECT public.atomic_table_buyin($1,$2,$3,200,false,$4,$5)', [
            actor,
            tableId,
            index + 1,
            clubId,
            OP_IDS[index + 2],
          ]),
        index
      );
    stage = 'verify';
    await transaction(async () => {
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
        [tableId, [actorOne, actorTwo], spectator, clubId]
      );
      assert.equal(result.rows[0].actors, 2, 'FIXTURE_PAID_SEATS_REQUIRED');
      assert.equal(result.rows[0].spectator_seats, 0, 'FIXTURE_SPECTATOR_MUST_REMAIN_UNSEATED');
      assert.equal(Number(result.rows[0].supply), 100000, 'FIXTURE_SUPPLY_MUST_BALANCE');
      assert.equal(result.rows[0].hands, 0, 'FIXTURE_MUST_NOT_SEED_HANDS');
      assert.equal(result.rows[0].spectator_mfa_required, true, 'FIXTURE_OWNER_MFA_GUARD_REQUIRED');
      if (financialScenario) {
        const financial = await db.query(
          `SELECT insurance_enabled, tournament_id, max_buy_in::text AS max_buy_in
           FROM public.tables WHERE id=$1`,
          [tableId]
        );
        assert.equal(financial.rows.length, 1);
        assert.equal(
          financial.rows[0].insurance_enabled,
          true,
          'FIXTURE_CANONICAL_INSURANCE_REQUIRED'
        );
        assert.equal(financial.rows[0].tournament_id, null, 'FIXTURE_CASH_TABLE_REQUIRED');
        assert.ok(Number(financial.rows[0].max_buy_in) >= 210, 'FIXTURE_TOPUP_HEADROOM_REQUIRED');
      }
    });
    return {
      club_id: clubId,
      table_id: tableId,
      actor_user_ids: [actorOne, actorTwo],
      spectator_user_id: spectator,
      signup_proof: signupProof,
    };
  } catch (error) {
    const code =
      typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : 'REFUSED';
    throw new Error(`FIXTURE_SEED_${stage.toUpperCase().replaceAll('-', '_')}_${code}`);
  } finally {
    if (locked) {
      const unlocked = await db.query(
        "SELECT pg_advisory_unlock(hashtextextended('component-fixture-seed-v1',0)) AS unlocked"
      );
      assert.equal(unlocked.rows[0].unlocked, true, 'FIXTURE_SEED_OWNERSHIP_NOT_RELEASED');
    }
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
    assert.deepEqual(Object.keys(input).sort(), ['actorIds', 'sessionIds', 'spectatorId']);
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
