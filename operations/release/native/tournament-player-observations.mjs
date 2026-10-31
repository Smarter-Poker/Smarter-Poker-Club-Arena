import assert from 'node:assert/strict';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Only fixture startup can supply this binding; the observer never chooses a
// relation, user, club or tournament ID on the wire.
export function tournamentObservationBinding(cohorts) {
  assert.ok(Array.isArray(cohorts) && cohorts.length === 3);
  assert.deepEqual(cohorts.map((c) => c.format).sort(), ['MTT', 'SNG', 'SPIN']);
  const ids = new Set();
  const result = cohorts.map((c) => {
    assert.match(c.tournament_id, uuid);
    assert.match(c.club_id, uuid);
    assert.ok(!ids.has(c.tournament_id));
    ids.add(c.tournament_id);
    assert.ok(Array.isArray(c.actor_ids) && c.actor_ids.length >= 3 && c.actor_ids.length <= 9);
    assert.equal(new Set(c.actor_ids).size, c.actor_ids.length);
    c.actor_ids.forEach((id) => assert.match(id, uuid));
    return Object.freeze({
      format: c.format,
      tournament_id: c.tournament_id,
      club_id: c.club_id,
      actor_ids: Object.freeze([...c.actor_ids]),
    });
  });
  return Object.freeze(result);
}

export function validateTournamentRead(value) {
  assert.ok(value && Object.keys(value).sort().join(',') === 'actor_index,cohort_index,token');
  assert.ok(
    Number.isSafeInteger(value.cohort_index) && value.cohort_index >= 0 && value.cohort_index < 3
  );
  assert.ok(
    Number.isSafeInteger(value.actor_index) && value.actor_index >= 0 && value.actor_index < 9
  );
  assert.ok(
    value.token === null ||
      (typeof value.token === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(value.token))
  );
  return value;
}

/** Called only inside the existing bridge's repeatable-read READ ONLY
 * transaction. All SQL and limits are maintained control source. JSON field
 * projection does not expose arbitrary rows, auth sessions or private cards.
 */
export async function observeTournamentPlayerFacts(db, cohorts, read) {
  validateTournamentRead(read);
  const c = cohorts[read.cohort_index],
    actor = c?.actor_ids[read.actor_index];
  assert.ok(actor, 'TOURNAMENT_OBSERVATION_ACTOR_NOT_BOUND');
  const scope = await db.query(
    `SELECT t.id::text, t.club_id::text,
    t.status::text, t.ended_at::text,
    COALESCE(to_jsonb(t)->>'tournament_type',to_jsonb(t)->>'variant') AS format
    FROM public.tournaments t WHERE t.id=$1 AND t.club_id=$2`,
    [c.tournament_id, c.club_id]
  );
  assert.equal(scope.rows.length, 1, 'TOURNAMENT_OBSERVATION_SCOPE_ABSENT');
  assert.equal(
    String(scope.rows[0].format).toUpperCase(),
    c.format,
    'TOURNAMENT_OBSERVATION_FORMAT_DISAGREES'
  );
  const players = await db.query(
    `SELECT p.user_id::text, p.username::text,
    p.position::integer, p.prize::text, p.bounty_winnings::text,
    p.status::text, p.table_id::text, p.seat_number::integer,
    p.chip_count::text FROM public.tournament_players p
    WHERE p.tournament_id=$1 ORDER BY p.user_id LIMIT 10`,
    [c.tournament_id]
  );
  assert.equal(players.rows.length, c.actor_ids.length, 'TOURNAMENT_OBSERVATION_ROSTER_CHANGED');
  assert.deepEqual(players.rows.map((p) => p.user_id).sort(), [...c.actor_ids].sort());
  const seats = await db.query(
    `SELECT s.id::text,s.table_id::text,s.seat_number::integer,
    s.stack::text,s.occupancy_id::text FROM public.table_seats s
    JOIN public.tables t ON t.id=s.table_id
    WHERE t.tournament_id=$1 AND s.user_id=$2 AND s.left_at IS NULL LIMIT 3`,
    [c.tournament_id, actor]
  );
  const wallet = await db.query(
    `SELECT chip_balance::text FROM public.club_members
    WHERE club_id=$1 AND user_id=$2 LIMIT 2`,
    [c.club_id, actor]
  );
  assert.equal(wallet.rows.length, 1, 'TOURNAMENT_OBSERVATION_WALLET_ABSENT');
  // Accepted purchase identities and completion are owned by the canonical
  // entry receipt, never inferred from a modal closing or a positive stack.
  const prefix = `tourney:${c.tournament_id}:`;
  const receipts = await db.query(
    `SELECT r.idempotency_key,r.completed_at::text,
    response->>'table_id' AS table_id,response->>'seat_number' AS seat_number,
    response->>'seat_id' AS seat_id,response->>'seated' AS seated,
    response->>'success' AS success,response->>'atomic_tournament_chip_purchase' AS atomic_version,
    request->>'version' AS request_version,request->>'tournament_id' AS tournament_id,
    request->>'idempotency_key' AS request_key,
    EXISTS(SELECT 1 FROM public.tournament_knockout_candidates kc
      WHERE kc.id=(r.response->>'candidate_id')::uuid
        AND kc.id::text=r.request->>'candidate_id'
        AND kc.tournament_id=$3 AND kc.eliminated_user_id=$2::uuid
        AND kc.state='rebought' AND r.response->>'candidate_state'='rebought') AS candidate_committed
    FROM public.entry_purchase_idempotency_receipts r
    WHERE key_domain='tournament_chip_purchase'
      AND left(idempotency_key,length($1))=$1
      AND request->>'user_id'=$2
      AND request->>'rebuy_type' IN ('rebuy','reentry')
    ORDER BY claimed_at,idempotency_key LIMIT 33`,
    [prefix, actor, c.tournament_id]
  );
  assert.ok(receipts.rows.length <= 32, 'TOURNAMENT_OBSERVATION_RECEIPT_CAP');
  const exact =
    read.token === null
      ? []
      : receipts.rows.filter((r) => r.idempotency_key.endsWith(`:${actor}:tok:${read.token}`));
  assert.ok(exact.length <= 1, 'TOURNAMENT_OBSERVATION_DUPLICATE_TOKEN');
  const player = players.rows.find((p) => p.user_id === actor),
    seat = seats.rows[0];
  return {
    tournamentId: c.tournament_id,
    userId: actor,
    tournamentStatus: scope.rows[0].status,
    endedAt: scope.rows[0].ended_at,
    activeSeatCount: seats.rows.length,
    tableId: seat?.table_id ?? null,
    seatNumber: seat?.seat_number ?? null,
    stack: Number(seat?.stack ?? 0),
    playerStatus: player.status,
    playerChipCount: Number(player.chip_count),
    wallet: Number(wallet.rows[0].chip_balance),
    purchaseCount: receipts.rows.filter((r) => r.completed_at !== null).length,
    purchaseToken: exact.length ? read.token : null,
    purchaseCommitted:
      exact.length === 1 &&
      exact[0].completed_at !== null &&
      exact[0].request_version === 'v1' &&
      exact[0].tournament_id === c.tournament_id &&
      exact[0].request_key === exact[0].idempotency_key &&
      exact[0].success === 'true' &&
      exact[0].atomic_version === 'v1' &&
      exact[0].candidate_committed === true &&
      exact[0].seated === 'true' &&
      exact[0].seat_id === seat?.id &&
      exact[0].table_id === seat?.table_id &&
      Number(exact[0].seat_number) === seat?.seat_number,
    standings: players.rows.map((p) => ({
      user_id: p.user_id,
      username: p.username,
      position: p.position,
      prize: Number(p.prize),
      bounty_winnings: Number(p.bounty_winnings),
    })),
  };
}

export function validateTournamentPlayerData(data) {
  const expected = [
    'tournamentId',
    'userId',
    'tournamentStatus',
    'endedAt',
    'activeSeatCount',
    'tableId',
    'seatNumber',
    'stack',
    'playerStatus',
    'playerChipCount',
    'wallet',
    'purchaseCount',
    'purchaseToken',
    'purchaseCommitted',
    'standings',
  ];
  assert.deepEqual(Object.keys(data).sort(), expected.sort());
  assert.match(data.tournamentId, uuid);
  assert.match(data.userId, uuid);
  for (const key of ['stack', 'wallet', 'playerChipCount'])
    assert.ok(Number.isFinite(data[key]) && data[key] >= 0);
  assert.ok(
    Number.isInteger(data.activeSeatCount) && data.activeSeatCount >= 0 && data.activeSeatCount <= 2
  );
  assert.ok(
    Number.isInteger(data.purchaseCount) && data.purchaseCount >= 0 && data.purchaseCount <= 32
  );
  assert.equal(typeof data.purchaseCommitted, 'boolean');
  assert.ok(
    Array.isArray(data.standings) && data.standings.length >= 3 && data.standings.length <= 9
  );
  for (const row of data.standings) {
    assert.deepEqual(Object.keys(row).sort(), [
      'bounty_winnings',
      'position',
      'prize',
      'user_id',
      'username',
    ]);
    assert.match(row.user_id, uuid);
    assert.ok(typeof row.username === 'string' && row.username.length <= 256);
    assert.ok(row.position === null || (Number.isSafeInteger(row.position) && row.position > 0));
    for (const field of ['prize', 'bounty_winnings'])
      assert.ok(Number.isFinite(row[field]) && row[field] >= 0);
  }
  return data;
}
