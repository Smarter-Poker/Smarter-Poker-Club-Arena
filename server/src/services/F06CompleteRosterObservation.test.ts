import { test, expect } from 'vitest';
import { completeOriginalRosterObservation } from './F06CompleteRosterObservation.js';
import { captureMTTRosterBeforeReserve } from '../engine/MTTPreReserveRoster.js';
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
function fixture() {
  const identity = {
    admission_id: id(1),
    tournament_id: id(2),
    table_id: id(3),
    lifecycle: '1',
    lease_generation: id(4),
    custody_id: id(5),
  };
  const local = [1, 2].map((n) => ({
    user_id: id(10 + n),
    seat_id: id(20 + n),
    occupancy_id: id(30 + n),
    seat_joined_at: '2026-09-14T12:00:00.123456Z',
    seat_number: n,
    stack: 100,
    username: 'local-label',
    is_horse: false,
  }));
  const db: any = {
    tables: {
      id: id(3),
      tournament_id: id(2),
      f06_lifecycle: 1,
      max_players: 9,
      game_variant: 'nlh',
      pineapple_holdem: false,
      bomb_pot_enabled: false,
    },
    tournaments: { id: id(2), tournament_type: 'MTT' },
    table_seats: local.map((s) => ({
      id: s.seat_id,
      user_id: s.user_id,
      table_id: id(3),
      seat_number: s.seat_number,
      occupancy_id: s.occupancy_id,
      joined_at: s.seat_joined_at,
      stack: s.stack,
      left_at: null,
      entry_hold: null,
    })),
    tournament_players: local.map((s, n) => ({
      id: id(40 + n),
      user_id: s.user_id,
      tournament_id: id(2),
      table_id: id(3),
      seat_number: s.seat_number,
      registered_at: s.seat_joined_at,
      rebuys: 0,
      status: 'playing',
    })),
  };
  let owner = true,
    ordinal = 0;
  let hook: (name: string, result: any, step: number) => void = () => {};
  let chairRows = local;
  const calls: any[] = [];
  const client: any = {
    from(name: string) {
      const ops: any[] = [];
      const q: any = {};
      for (const op of ['select', 'eq', 'is', 'order', 'limit', 'single'])
        q[op] = (...args: any[]) => {
          ops.push([op, ...args]);
          return q;
        };
      q.then = (resolve: any, reject: any) => {
        const result = {
          data: structuredClone(db[name]),
          error: null,
          count: Array.isArray(db[name]) ? db[name].length : null,
        };
        ordinal++;
        calls.push({ name, ops });
        hook(name, result, ordinal);
        return Promise.resolve(result).then(resolve, reject);
      };
      return q;
    },
  };
  const observe = completeOriginalRosterObservation(
    client,
    identity,
    () => owner,
    () => chairRows
  );
  return {
    identity,
    local,
    db,
    observe,
    calls,
    setOwner: (v: boolean) => (owner = v),
    setHook: (h: typeof hook) => (hook = h),
    setChairs: (v: typeof local) => (chairRows = v),
  };
}
test('existing scoped client reads all records twice with explicit completeness and makes Lease proposal', async () => {
  const f = fixture(),
    result = await f.observe(f.local, f.local);
  expect(f.calls).toHaveLength(8);
  expect(result.participants).toHaveLength(2);
  expect(result.seats).toHaveLength(2);
  for (const c of f.calls) {
    expect(
      c.ops.some((o: any) => o[0] === 'eq' && o[2] === (c.name === 'tournaments' ? id(2) : id(3)))
    ).toBe(true);
    if (c.name === 'table_seats' || c.name === 'tournament_players') {
      expect(c.ops.find((o: any) => o[0] === 'select')[2]).toEqual({ count: 'exact' });
      expect(c.ops.find((o: any) => o[0] === 'limit')[1]).toBe(11);
    }
  }
  const snapshot = captureMTTRosterBeforeReserve(result).forOriginalIntent({
    ...f.identity,
    admission_revision: '1',
    permit_id: id(90),
    hand_number: '1000001',
  });
  expect(snapshot.complete_roster).toHaveLength(2);
  f.db.table_seats[0].stack = 500;
  expect(result.seats[0].stack).toBe(100);
});
for (let step = 1; step <= 8; step++)
  test('owner replacement after read ' + step, async () => {
    const f = fixture();
    f.setHook((_, __, n) => {
      if (n === step) f.setOwner(false);
    });
    await expect(f.observe(f.local, f.local)).rejects.toThrow('owner_changed');
    expect(f.calls).toHaveLength(step);
  });
for (const name of ['tables', 'tournaments', 'table_seats', 'tournament_players'])
  test('read error ' + name, async () => {
    const f = fixture();
    f.setHook((n, r) => {
      if (n === name) r.error = { message: 'unknown' };
    });
    await expect(f.observe(f.local, f.local)).rejects.toThrow();
  });
for (const count of [null, undefined, 3, 1000])
  test('never accepts incomplete exact count ' + count, async () => {
    const f = fixture();
    f.setHook((n, r) => {
      if (n === 'table_seats') r.count = count;
    });
    await expect(f.observe(f.local, f.local)).rejects.toThrow('incomplete');
  });
for (const field of [
  'tournament_type',
  'game_variant',
  'pineapple_holdem',
  'bomb_pot_enabled',
  'f06_lifecycle',
  'tournament_id',
  'max_players',
])
  test('refuses missing profile ' + field, async () => {
    const f = fixture();
    delete (field === 'tournament_type' ? f.db.tournaments : f.db.tables)[field];
    await expect(f.observe(f.local, f.local)).rejects.toThrow();
  });
for (const mode of [
  'positive-hold',
  'duplicate-seat',
  'orphan-participant',
  'missing-participant',
  'wrong-table',
  'wrong-tournament',
  'infinite-stack',
])
  test('refuses ' + mode, async () => {
    const f = fixture();
    if (mode === 'positive-hold') f.db.table_seats[0].entry_hold = 'waiting';
    if (mode === 'duplicate-seat') f.db.table_seats[1] = f.db.table_seats[0];
    if (mode === 'orphan-participant') f.db.tournament_players[0].user_id = id(99);
    if (mode === 'missing-participant') f.db.tournament_players.pop();
    if (mode === 'wrong-table') f.db.table_seats[0].table_id = id(99);
    if (mode === 'wrong-tournament') f.db.tournament_players[0].tournament_id = id(99);
    if (mode === 'infinite-stack') f.db.table_seats[0].stack = Infinity;
    await expect(f.observe(f.local, f.local)).rejects.toThrow();
  });
test('database change between complete reads refuses', async () => {
  const f = fixture();
  f.setHook((_, __, n) => {
    if (n === 4) f.db.table_seats[0].stack = 200;
  });
  await expect(f.observe(f.local, f.local)).rejects.toThrow('database_changed');
});
test('local mutation during async read refuses', async () => {
  const f = fixture();
  f.setHook((_, __, n) => {
    if (n === 5) f.local[0].occupancy_id = id(99);
  });
  await expect(f.observe(f.local, f.local)).rejects.toThrow('local_changed');
});
test('replacement chair membership during async read refuses', async () => {
  const f = fixture();
  f.setHook((_, __, n) => {
    if (n === 5) f.setChairs([{ ...f.local[0], user_id: id(99) }, f.local[1]]);
  });
  await expect(f.observe(f.local, f.local)).rejects.toThrow('local_changed');
});
test('extra canonical live seat is not omitted to match cached local members', async () => {
  const f = fixture();
  f.db.table_seats.push({
    ...f.db.table_seats[0],
    id: id(70),
    user_id: id(71),
    occupancy_id: id(72),
    seat_number: 3,
    stack: 0,
  });
  await expect(f.observe(f.local, f.local)).rejects.toThrow('local_incomplete');
});
test('unsafe bigint lifecycle is not rounded to original', async () => {
  const f = fixture();
  f.db.tables.f06_lifecycle = 9007199254740992;
  await expect(f.observe(f.local, f.local)).rejects.toThrow('lifecycle');
});
