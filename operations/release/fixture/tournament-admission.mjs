import assert from 'node:assert/strict';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function validateTournamentWitness(w, ids) {
  assert.equal(new Set(ids).size, ids.length);
  const tables = new Map(w.tables.map((t) => [t.id, t]));
  assert.equal(tables.size, w.tables.length);
  for (const t of w.tables) {
    assert.match(t.id, uuid);
    assert.equal(t.tournament_id, w.tournament.id);
    assert.ok(['running', 'waiting'].includes(t.status));
  }
  assert.equal(new Set(w.seats.map((s) => s.user_id)).size, w.seats.length);
  assert.equal(new Set(w.seats.map((s) => s.occupancy_id)).size, w.seats.length);
  for (const s of w.seats) {
    assert.ok(ids.includes(s.user_id) && tables.has(s.table_id));
    assert.match(s.occupancy_id, uuid);
    assert.equal(s.left_at, null);
    assert.ok(Number.isInteger(s.seat_number) && s.seat_number >= 1 && s.seat_number <= 9);
    assert.ok(Number.isFinite(Number(s.stack)) && Number(s.stack) >= 0);
    assert.equal(
      w.players.find((p) => p.user_id === s.user_id).table_id,
      s.table_id,
      'registration/seat table disagreement'
    );
  }
}
export async function readCoherentAdmission({
  tournamentId,
  users,
  session,
  anonKey,
  signal,
  fetchImpl = fetch,
}) {
  assert.match(tournamentId, uuid);
  assert.ok(users.length >= 2 && users.length <= 1000);
  users.forEach((u) => assert.match(u.id, uuid));
  assert.equal(new Set(users.map((u) => u.id)).size, users.length);
  const url = new URL('http://gateway:8000/rest/v1/tournaments');
  url.search = new URLSearchParams({
    id: 'eq.' + tournamentId,
    select:
      'id,status,current_players,ended_at,players:tournament_players(user_id,table_id,status,position,eliminated_at,chip_count),tables:tables(id,tournament_id,status,seats:table_seats!table_seats_table_id_fkey(user_id,table_id,seat_number,occupancy_id,stack,left_at))',
    limit: '2',
    'players.limit': String(users.length + 1),
    'tables.limit': String(users.length + 1),
    'tables.seats.limit': String(users.length + 1),
    'tables.seats.left_at': 'is.null',
  });
  const response = await fetchImpl(url, {
    headers: {
      authorization: 'Bearer ' + session.access_token,
      apikey: anonKey,
      Prefer: 'count=exact',
    },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000),
  });
  assert.ok(response.ok, 'coherent admission HTTP ' + response.status);
  const rows = await response.json();
  assert.equal(rows.length, 1);
  assert.equal(response.headers.get('content-range')?.split('/')[1], '1');
  const r = rows[0];
  assert.ok(
    Array.isArray(r.players) &&
      Array.isArray(r.tables) &&
      r.tables.every((t) => Array.isArray(t.seats)),
    'coherent relationships unreadable'
  );
  const w = {
    observedAt: new Date().toISOString(),
    source: 'one-postgrest-statement',
    tournament: {
      id: r.id,
      status: r.status,
      current_players: r.current_players,
      ended_at: r.ended_at,
    },
    players: r.players,
    tables: r.tables.map(({ seats, ...t }) => t),
    seats: r.tables.flatMap((t) => t.seats),
  };
  assert.equal(w.tournament.id, tournamentId);
  assert.deepEqual(w.players.map((p) => p.user_id).sort(), users.map((u) => u.id).sort());
  if (String(r.status).toUpperCase() !== 'RUNNING') {
    assert.ok(
      ['REGISTERING', 'ANNOUNCED'].includes(String(r.status).toUpperCase()),
      'unexpected admission status'
    );
    return { ready: false, witness: w };
  }
  validateTournamentWitness(
    w,
    users.map((u) => u.id)
  );
  assert.equal(w.seats.length, users.length, 'complete actual seating required');
  assert.ok(
    w.players.every((p) => p.status === 'playing'),
    'full playing cohort required'
  );
  return { ready: true, witness: w };
}
