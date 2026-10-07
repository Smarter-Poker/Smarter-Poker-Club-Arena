import test from 'node:test';
import assert from 'node:assert/strict';
import { readCoherentAdmission } from './tournament-admission.mjs';
const id = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const users = [{ id: id(1) }, { id: id(2) }];
function field(status = 'RUNNING') {
  return {
    id: id(3),
    status,
    current_players: 2,
    ended_at: null,
    players: users.map((u, i) => ({
      user_id: u.id,
      table_id: id(4),
      seat_number: i + 1,
      status: 'playing',
    })),
    tables: [
      {
        id: id(4),
        tournament_id: id(3),
        status: 'running',
        seats: users.map((u, i) => ({
          user_id: u.id,
          table_id: id(4),
          seat_number: i + 1,
          occupancy_id: id(10 + i),
          stack: 100,
          left_at: null,
        })),
      },
    ],
  };
}
async function read(row) {
  let calls = 0;
  const result = await readCoherentAdmission({
    tournamentId: id(3),
    users,
    session: { access_token: 'fixture' },
    anonKey: 'fixture',
    fetchImpl: async (url) => {
      calls++;
      assert.match(url.searchParams.get('select'), /players:tournament_players/);
      assert.match(url.searchParams.get('select'), /seats:table_seats!table_seats_table_id_fkey/);
      assert.equal(url.searchParams.get('tables.seats.limit'), '3');
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-range': '0-0/1' }),
        json: async () => [row],
      };
    },
  });
  assert.equal(calls, 1);
  return result;
}
test('one statement owns complete live roster and seats', async () =>
  assert.equal((await read(field())).ready, true));
test('incomplete launch is retained as nonacting admission', async () => {
  const r = field('REGISTERING');
  r.players[0].table_id = null;
  r.players[0].seat_number = null;
  r.players[0].status = 'registered';
  r.tables[0].seats.shift();
  assert.equal((await read(r)).ready, false);
});
test('running mismatch remains a refusal', async () => {
  const r = field();
  r.players[0].table_id = null;
  await assert.rejects(read(r), /registration\/seat table disagreement/);
});
test('truncated or duplicate cohort remains refused', async () => {
  const r = field();
  r.tables[0].seats.pop();
  await assert.rejects(read(r), /playing player exact chair required/);
  r.players.pop();
  await assert.rejects(read(r));
});
test('terminal or unknown outcomes never activate cohort', async () => {
  await assert.rejects(read(field('COMPLETED')));
  await assert.rejects(read(field('UNKNOWN')));
});

test('coherent RUNNING subset remains nonacting until full assignments', async () => {
  const r = field();
  r.players[0].status = 'registered';
  r.players[0].table_id = null;
  r.players[0].seat_number = null;
  r.tables[0].seats.shift();
  assert.equal((await read(r)).ready, false);
  assert.equal((await read(field())).ready, true);
});
test('seat number disagreement refuses activation', async () => {
  const r = field();
  r.players[0].seat_number = 9;
  await assert.rejects(read(r), /registration\/seat number disagreement/);
});

test('duplicate chair coordinates refuse admission', async () => {
  const r = field();
  r.players[1].seat_number = 1;
  r.tables[0].seats[1].seat_number = 1;
  await assert.rejects(read(r), /duplicate chair coordinates/);
});
