import assert from 'node:assert/strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Read only the owned disposable database. Auth success can conceal trigger exceptions. */
export async function assertCanonicalSignup(db, userIds) {
  assert.ok(
    Array.isArray(userIds) && [1, 3].includes(userIds.length),
    'FIXTURE_SIGNUP_USERS_REQUIRED'
  );
  assert.ok(
    userIds.every((id) => typeof id === 'string' && UUID.test(id)),
    'FIXTURE_SIGNUP_IDS_REQUIRED'
  );
  assert.equal(new Set(userIds).size, userIds.length, 'FIXTURE_SIGNUP_IDS_DISTINCT');
  const ownership = await db.query(`SELECT current_database() AS database,
    inet_server_addr() IS NULL AS local_socket, current_user AS database_user`);
  assert.deepEqual(
    ownership.rows,
    [{ database: 'club_arena_qualification', local_socket: true, database_user: 'postgres' }],
    'FIXTURE_SIGNUP_OWNED_DATABASE_REQUIRED'
  );
  const result = await db.query(
    `WITH expected AS (SELECT unnest($1::uuid[]) AS id)
    SELECT e.id,
      (SELECT count(*)::int FROM auth.users a WHERE a.id=e.id
        AND a.email LIKE '%@smarter-poker.invalid'
        AND a.raw_user_meta_data->'component_qualification'='true'::jsonb) AS synthetic_auth,
      (SELECT count(*)::int FROM public.profiles p WHERE p.id=e.id
        AND p.diamonds=500 AND p.diamond_balance=500) AS canonical_profile,
      (SELECT count(*)::int FROM public.users u JOIN public.profiles p ON p.id=u.id
        WHERE u.id=e.id AND u.username=p.username AND u.email=p.email) AS legacy_profile,
      (SELECT count(*)::int FROM public.wallets w WHERE w.user_id=e.id) AS wallets,
      (SELECT count(*)::int FROM public.wallets w WHERE w.user_id=e.id
        AND w.wallet_type='PLAYER' AND w.balance=0 AND w.locked_balance=0) AS zero_player_wallet,
      (SELECT count(*)::int FROM (
        SELECT balance,lifetime_earned,lifetime_spent FROM public.user_diamonds WHERE user_id=e.id
        UNION ALL SELECT balance,lifetime_earned,lifetime_spent FROM public.user_diamond_balance WHERE user_id=e.id
        UNION ALL SELECT balance,lifetime_earned,lifetime_spent FROM public.diamond_wallets WHERE user_id=e.id
      ) mirrors WHERE balance=500 AND lifetime_earned=500 AND lifetime_spent=0) AS diamond_mirrors,
      (SELECT count(*)::int FROM public.user_daily_streaks s WHERE s.user_id=e.id
        AND s.current_streak=0 AND s.longest_streak=0 AND s.total_days_played=0
        AND s.last_completed_date IS NULL) AS empty_streak,
      (SELECT count(*)::int FROM public.ca_mint_ledger m WHERE m.holder_id=e.id) AS mint_rows,
      (SELECT count(*)::int FROM public.diamond_transactions t WHERE t.user_id=e.id) AS diamond_journal_rows,
      (SELECT count(*)::int FROM public.ca_mint_ledger m
        JOIN public.diamond_transactions t ON t.id=m.diamond_tx_id
        WHERE m.holder_id=e.id AND m.holder_type='player' AND m.asset='diamonds' AND m.action='mint'
          AND m.op_id='signup:'||e.id::text AND m.amount=500 AND m.balance_before=0 AND m.balance_after=500
          AND m.chip_ledger_id IS NULL AND t.user_id=e.id AND t.reference_id=m.op_id
          AND t.type='earn' AND t.transaction_type='mint' AND t.source='the_mint'
          AND t.amount=500 AND t.balance_after=500 AND t.issuance_class='promotional') AS linked_signup_mint,
      (SELECT count(*)::int FROM public.ca_op_claims c WHERE c.op_id='signup:'||e.id::text
        AND c.fn_name='fn_ca_mint' AND c.finalized_at IS NOT NULL
        AND c.result->'ok'='true'::jsonb AND c.result->>'asset'='diamonds'
        AND c.result->>'target_id'=e.id::text AND c.result->'amount'='500'::jsonb) AS finalized_mint,
      (SELECT count(*)::int FROM public.signup_errors) AS signup_errors,
      (SELECT count(*)::int FROM public.ca_diamond_incidents) AS diamond_incidents
    FROM expected e ORDER BY e.id`,
    [userIds]
  );
  const expected = [...userIds]
    .sort()
    .map((id) => ({
      id,
      synthetic_auth: 1,
      canonical_profile: 1,
      legacy_profile: 1,
      wallets: 1,
      zero_player_wallet: 1,
      diamond_mirrors: 3,
      empty_streak: 1,
      mint_rows: 1,
      diamond_journal_rows: 1,
      linked_signup_mint: 1,
      finalized_mint: 1,
      signup_errors: 0,
      diamond_incidents: 0,
    }));
  // The caller's diagnostics are fixed labels; never export accounts or incident text.
  assert.deepEqual(result.rows, expected, 'FIXTURE_CANONICAL_SIGNUP_INCOMPLETE');
  return {
    users: userIds.length,
    zero_player_wallets: userIds.length,
    diamonds_per_user: 500,
    linked_signup_mints: userIds.length,
    signup_errors: 0,
    diamond_incidents: 0,
  };
}

/** Chip supply is separate from the canonical diamond grants made by real Auth. */
export async function assertAttributionChipSeed(db, attributionId) {
  assert.match(attributionId, UUID);
  const result = await db.query(
    `SELECT
    (SELECT count(*)::integer FROM public.profiles) AS profiles,
    (SELECT count(*)::integer FROM public.club_members) AS members,
    (SELECT count(*)::integer FROM public.table_seats) AS seats,
    (SELECT count(*)::integer FROM public.ca_mint_ledger WHERE asset='chips') AS chip_mints,
    (SELECT count(*)::integer FROM public.club_members WHERE user_id=$1) AS attribution_memberships,
    (SELECT count(*)::integer FROM public.table_seats WHERE user_id=$1) AS attribution_seats,
    (SELECT sum(chip_treasury)::text FROM public.clubs) AS treasury,
    (SELECT sum(chip_balance)::text FROM public.club_members) AS wallets,
    (SELECT sum(stack)::text FROM public.table_seats) AS stacks`,
    [attributionId]
  );
  assert.equal(result.rows.length, 1, 'FIXTURE_ATTRIBUTION_CHIP_ROW_REQUIRED');
  const balances = { ...result.rows[0] };
  for (const field of ['treasury', 'wallets', 'stacks']) {
    assert.ok(
      typeof balances[field] === 'string' && /^[0-9]+(?:\.[0-9]{1,2})?$/.test(balances[field]),
      'FIXTURE_ATTRIBUTION_CHIP_VALUE_REQUIRED'
    );
    balances[field] = Number(balances[field]);
  }
  assert.deepEqual(
    balances,
    {
      profiles: 4,
      members: 3,
      seats: 2,
      chip_mints: 1,
      attribution_memberships: 0,
      attribution_seats: 0,
      treasury: 96000,
      wallets: 3600,
      stacks: 400,
    },
    'FIXTURE_ATTRIBUTION_MUST_NOT_CHANGE_CHIP_SEED'
  );
}
