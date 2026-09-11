/**
 * The seat claim is the last thing that stands between a snapshot taken five
 * minutes ago and a player being dealt two hands at once. These pin the two
 * answers that matter: "somebody else already seated them" and "I could not
 * tell" must BOTH refuse.
 */
import { describe, it, expect } from 'vitest';
import { findLiveSeatsInTournament, mayTakeSeat } from './seatClaim.js';

interface FakeResult {
  data?: unknown;
  error?: { message: string } | null;
  throws?: Error;
}

function fakeClient(result: FakeResult) {
  const calls: { table: string; select: string; filters: [string, string, unknown][] } = {
    table: '',
    select: '',
    filters: [],
  };
  const builder: Record<string, unknown> = {
    select: (s: string) => {
      calls.select = s;
      return builder;
    },
    is: (c: string, v: unknown) => {
      calls.filters.push(['is', c, v]);
      return builder;
    },
    eq: (c: string, v: unknown) => {
      calls.filters.push(['eq', c, v]);
      return builder;
    },
    then: (onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) => {
      if (result.throws) return Promise.reject(result.throws).then(onOk, onErr);
      return Promise.resolve({
        data: 'data' in result ? result.data : null,
        error: result.error ?? null,
      }).then(onOk, onErr);
    },
  };
  return {
    client: {
      from: (t: string) => {
        calls.table = t;
        return builder;
      },
    },
    calls,
  };
}

const TOURNEY = 'bae46dbf-7cf6-42c0-a709-c38a97306a08';
const PLAYER = '00000000-0000-0000-0000-000000000011';
const TABLE_A = '3d4b5105-2011-4211-8d19-d2a8da9eb511';
const TABLE_B = '7faa8cd9-7765-415d-b317-cbd723fb083c';

describe('findLiveSeatsInTournament', () => {
  it('asks only for LIVE seats at tables of THIS tournament, for THIS player', async () => {
    const { client, calls } = fakeClient({ data: [] });
    await findLiveSeatsInTournament(client, TOURNEY, PLAYER);

    expect(calls.table).toBe('table_seats');
    // The tournament is reached through the join - table_seats has no
    // tournament_id column, which is the whole reason a partial unique index
    // cannot express this rule.
    // The parent is named so a new foreign key on table_seats cannot make this
    // embed ambiguous (PGRST201); see the 2026-09-09 rotator outage.
    expect(calls.select).toContain('tables!table_seats_table_id_fkey!inner(tournament_id)');
    expect(calls.filters).toContainEqual(['is', 'left_at', null]);
    expect(calls.filters).toContainEqual(['eq', 'tables.tournament_id', TOURNEY]);
    expect(calls.filters).toContainEqual(['eq', 'user_id', PLAYER]);
  });

  it('returns the seats the player holds', async () => {
    const { client } = fakeClient({
      data: [{ id: 'seat-a', table_id: TABLE_A, seat_number: 9 }],
    });
    const found = await findLiveSeatsInTournament(client, TOURNEY, PLAYER);
    expect(found).toEqual({
      ok: true,
      seats: [{ id: 'seat-a', table_id: TABLE_A, seat_number: 9 }],
    });
  });

  it('ignores the one table the caller named, and nothing else', async () => {
    const { client } = fakeClient({
      data: [
        { id: 'seat-a', table_id: TABLE_A, seat_number: 9 },
        { id: 'seat-b', table_id: TABLE_B, seat_number: 8 },
      ],
    });
    const found = await findLiveSeatsInTournament(client, TOURNEY, PLAYER, TABLE_A);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.seats.map((s) => s.table_id)).toEqual([TABLE_B]);
  });

  it('a read error is UNKNOWN, never an empty seat list', async () => {
    const { client } = fakeClient({ error: { message: 'statement timeout' } });
    const found = await findLiveSeatsInTournament(client, TOURNEY, PLAYER);
    expect(found.ok).toBe(false);
  });

  it('null data with no error is UNKNOWN too', async () => {
    const { client } = fakeClient({ data: null });
    const found = await findLiveSeatsInTournament(client, TOURNEY, PLAYER);
    expect(found.ok).toBe(false);
  });

  it('a thrown client is UNKNOWN, not a crash', async () => {
    const { client } = fakeClient({ throws: new Error('socket hang up') });
    const found = await findLiveSeatsInTournament(client, TOURNEY, PLAYER);
    expect(found).toEqual({ ok: false, reason: 'socket hang up' });
  });
});

describe('mayTakeSeat', () => {
  it('allows a player who holds no seat in the tournament', async () => {
    const { client } = fakeClient({ data: [] });
    expect(await mayTakeSeat(client, TOURNEY, PLAYER)).toEqual({ allowed: true });
  });

  it('REFUSES a player who is already sitting at another table of the event', async () => {
    const { client } = fakeClient({
      data: [{ id: 'seat-a', table_id: TABLE_A, seat_number: 9 }],
    });
    const claim = await mayTakeSeat(client, TOURNEY, PLAYER);
    expect(claim.allowed).toBe(false);
    if (claim.allowed) return;
    expect(claim.unknown).toBe(false);
    // The report has to name where they are sitting, or nobody can act on it.
    expect(claim.reason).toContain(TABLE_A.slice(0, 8));
    expect(claim.reason).toContain('9');
  });

  it('REFUSES when the answer could not be read, and says so', async () => {
    const { client } = fakeClient({ error: { message: 'statement timeout' } });
    const claim = await mayTakeSeat(client, TOURNEY, PLAYER);
    expect(claim.allowed).toBe(false);
    if (claim.allowed) return;
    expect(claim.unknown).toBe(true);
    expect(claim.reason).toContain('statement timeout');
  });

  it('a move ignores the source seat it is about to vacate', async () => {
    const { client } = fakeClient({
      data: [{ id: 'seat-a', table_id: TABLE_A, seat_number: 9 }],
    });
    expect(await mayTakeSeat(client, TOURNEY, PLAYER, TABLE_A)).toEqual({ allowed: true });
  });

  it('a move still refuses when a THIRD seat exists beyond the source', async () => {
    const { client } = fakeClient({
      data: [
        { id: 'seat-a', table_id: TABLE_A, seat_number: 9 },
        { id: 'seat-b', table_id: TABLE_B, seat_number: 8 },
      ],
    });
    const claim = await mayTakeSeat(client, TOURNEY, PLAYER, TABLE_A);
    expect(claim.allowed).toBe(false);
  });
});
