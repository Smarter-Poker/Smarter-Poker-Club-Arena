import { test, expect } from 'vitest';
import {
  planOnlineGeometry,
  projectedNaturalBB,
  type BalancerTable,
  type OnlineGeometryProfile,
  type MoveInstruction,
} from './TableBalancer.js';

type Shape = 'donor' | 'receiver' | 'split1' | 'split2';
type FixtureTable = BalancerTable & { reservedSeats: number[] };
type Fixture = { tables: FixtureTable[]; profile: OnlineGeometryProfile };
type OracleMove = Pick<
  MoveInstruction,
  'playerId' | 'fromTableId' | 'fromSeat' | 'toTableId' | 'toSeat'
>;

// Port of accepted0113 oracle: enumerate complete legal plans independently
// of target-quota optimization; reuse the actual accepted natural-BB projector.
function fixture(k: number, shape: Shape): Fixture {
  const counts = shape.startsWith('split')
    ? Array.from({ length: k }, (_, i) => (i < k / 2 ? 5 : 6))
    : Array(k).fill(shape === 'donor' ? 6 : 5);
  if (shape.startsWith('split')) {
    const m = shape === 'split2' ? 2 : 1;
    counts[0] -= m;
    counts[k / 2] += m;
  } else counts[0] = shape === 'donor' ? 4 : 7;
  const tables: FixtureTable[] = counts.map((n, i) => ({
    tableId: 't' + String(i).padStart(4, '0'),
    maxSeats: 9,
    buttonSeat: 1,
    lastBigBlindSeat: 3,
    playerCount: n,
    reservedSeats: [],
    players: Array.from({ length: n }, (_, j) => ({
      userId: `${i}:${j + 1}`,
      seat: j + 1,
      stack: 100 + i + j,
    })),
  }));
  return {
    tables,
    profile: {
      policy: 'CLUB_ARENA_ONLINE_MTT_V1',
      sourceRevision: 2,
      format: 'nlh',
      originalPlanId: 'exact',
      rosterVersion: 'r',
      activeTableIds: tables.map((t) => t.tableId),
      priorMoveCounts: Object.fromEntries(
        tables.flatMap((t, i) => t.players.map((p) => [p.userId, i % 3]))
      ),
      randomDraws: Array(100002).fill(0),
    },
  };
}
const signature = (moves: readonly OracleMove[]) =>
  JSON.stringify(
    [...moves]
      .sort((a, b) => a.playerId.localeCompare(b.playerId))
      .map((x) => [x.playerId, x.fromTableId, x.fromSeat, x.toTableId, x.toSeat])
  );
const compare = (a: readonly number[], b: readonly number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};
function oracle(f: Fixture, moves: readonly OracleMove[]) {
  const ds = moves.map((m) => {
    const source = f.tables.find((t) => t.tableId === m.fromTableId)!,
      dest = f.tables.find((t) => t.tableId === m.toTableId)!;
    const finalSeats = [
      ...dest.players.map((p) => p.seat),
      ...moves.filter((x) => x.toTableId === dest.tableId).map((x) => x.toSeat),
    ];
    return Math.abs(
      projectedNaturalBB(
        source.players.map((p) => p.seat),
        source.buttonSeat!,
        m.fromSeat,
        source.lastBigBlindSeat
      ) - projectedNaturalBB(finalSeats, dest.buttonSeat!, m.toSeat, dest.lastBigBlindSeat)
    );
  });
  return [
    moves.length,
    ds.reduce((a, b) => a + b, 0),
    Math.max(...ds),
    moves.reduce((a, m) => a + f.profile.priorMoveCounts[m.playerId], 0),
  ];
}
function exhaustive(f: Fixture, two = false) {
  let best: number[] | null = null;
  const winning = new Set<string>();
  const total = f.tables.reduce((a, t) => a + t.players.length, 0),
    low = Math.floor(total / f.tables.length),
    high = Math.ceil(total / f.tables.length);
  const outside = f.tables.filter((t) => t.players.length < low || t.players.length > high);
  const record = (m: OracleMove[]) => {
    const objective = oracle(f, m),
      c = best ? compare(objective, best) : -1;
    if (c < 0) {
      best = objective;
      winning.clear();
    }
    if (c <= 0) winning.add(signature(m));
  };
  if (two) {
    const source = f.tables.find((t) => t.players.length === 8),
      dest = f.tables.find((t) => t.players.length === 3);
    if (!source || !dest) throw new Error('invalid two-move fixture');
    const free = Array.from({ length: dest.maxSeats }, (_, i) => i + 1).filter(
      (s) => !dest.players.some((p) => p.seat === s) && !dest.reservedSeats.includes(s)
    );
    for (let i = 0; i < source.players.length; i++)
      for (let j = i + 1; j < source.players.length; j++)
        for (const a of free)
          for (const b of free)
            if (a !== b)
              record(
                [source.players[i], source.players[j]].map((p, k) => ({
                  playerId: p.userId,
                  fromTableId: source.tableId,
                  fromSeat: p.seat,
                  toTableId: dest.tableId,
                  toSeat: k === 0 ? a : b,
                }))
              );
  } else
    for (const source of f.tables) {
      if (source.players.length - 1 < low || source.players.length - 1 > high) continue;
      for (const dest of f.tables) {
        if (
          source === dest ||
          dest.players.length + 1 < low ||
          dest.players.length + 1 > high ||
          outside.some((t) => t !== source && t !== dest)
        )
          continue;
        for (const p of source.players)
          for (let seat = 1; seat <= dest.maxSeats; seat++)
            if (!dest.players.some((x) => x.seat === seat) && !dest.reservedSeats.includes(seat))
              record([
                {
                  playerId: p.userId,
                  fromTableId: source.tableId,
                  fromSeat: p.seat,
                  toTableId: dest.tableId,
                  toSeat: seat,
                },
              ]);
      }
    }
  return { best, winning };
}
test.each([
  [364, 'donor'],
  [364, 'receiver'],
  [1000, 'split1'],
  [1000, 'split2'],
  [2000, 'donor'],
  [2000, 'receiver'],
  [2000, 'split1'],
  [2000, 'split2'],
] as const)('%i-table %s matches exhaustive objective and complete ties', (k, shape) => {
  const f = fixture(k, shape),
    before = JSON.stringify(f.tables),
    truth = exhaustive(f, shape === 'split2'),
    r = planOnlineGeometry(f.tables, f.profile);
  expect(r.status).toBe('planned');
  if (r.status !== 'planned') throw new Error(`Expected planned: ${r.reason}`);
  expect(r.objective).toEqual(truth.best);
  expect(r.equallyRankedPlans).toBe(truth.winning.size);
  expect(truth.winning.has(signature(r.moves))).toBe(true);
  expect(JSON.stringify(f.tables)).toBe(before);
  expect(r.finalRosters.length).toBe(k);
  expect(r.finalRosters.flatMap((t) => t.players.map((p) => [p.userId, p.stack])).sort()).toEqual(
    f.tables.flatMap((t) => t.players.map((p) => [p.userId, p.stack])).sort()
  );
});
test('364-table reserved destinations retain all neutral target alternatives', () => {
  const f = fixture(364, 'receiver');
  const source = f.tables[0];
  source.players.push({ userId: '0:8', seat: 8, stack: 108 });
  source.playerCount = 8;
  for (let i = 1; i < f.tables.length; i++) {
    if (i <= 3) f.tables[i].reservedSeats = [7, 8, 9];
    else f.tables[i].maxSeats = 5;
  }
  f.profile.priorMoveCounts = Object.fromEntries(
    f.tables.flatMap((t) => t.players.map((p) => [p.userId, p.seat % 3]))
  );
  let best: number[] | null = null;
  const winners = new Set<string>();
  for (let i = 0; i < 8; i++)
    for (let j = i + 1; j < 8; j++)
      for (let a = 1; a <= 3; a++)
        for (let b = 1; b <= 3; b++)
          if (a !== b) {
            const moves = [source.players[i], source.players[j]].map((p, k) => ({
              playerId: p.userId,
              fromTableId: source.tableId,
              fromSeat: p.seat,
              toTableId: f.tables[k === 0 ? a : b].tableId,
              toSeat: 6,
            }));
            const objective = oracle(f, moves),
              c = best ? compare(objective, best) : -1;
            if (c < 0) {
              best = objective;
              winners.clear();
            }
            if (c <= 0) winners.add(signature(moves));
          }
  const r = planOnlineGeometry(f.tables, f.profile);
  expect(r.status).toBe('planned');
  if (r.status !== 'planned') throw new Error(`Expected planned: ${r.reason}`);
  expect(r.objective).toEqual(best);
  expect(r.equallyRankedPlans).toBe(winners.size);
  expect(winners.has(signature(r.moves))).toBe(true);
  expect(r.finalRosters.filter((t) => t.players.length === 6).length).toBe(3);
  expect(r.finalRosters.length).toBe(364);
});
test('impossible floor capacity remains pending', () => {
  const f = fixture(364, 'split1');
  f.tables[0].maxSeats = 4;
  const r = planOnlineGeometry(f.tables, f.profile);
  expect(r.status).toBe('pending');
  if (r.status !== 'pending') throw new Error('Expected pending');
  expect(r.reason).toBe('capacity_unavailable');
});
test.each(['large_move_budget', 'missing_random'] as const)(
  '%s returns no partial plan',
  (kind) => {
    const f = fixture(364, kind === 'missing_random' ? 'donor' : 'split2');
    if (kind === 'missing_random') f.profile.randomDraws = [];
    else {
      f.tables.forEach((t, i) => {
        const n = i < 182 ? 9 : 3;
        t.players = Array.from({ length: n }, (_, j) => ({
          userId: `${i}:${j + 1}`,
          seat: j + 1,
          stack: 100,
        }));
        t.playerCount = n;
      });
      f.profile.priorMoveCounts = Object.fromEntries(
        f.tables.flatMap((t) => t.players.map((p) => [p.userId, 0]))
      );
    }
    const r = planOnlineGeometry(f.tables, f.profile);
    expect(r.status).toBe('pending');
    if (r.status !== 'pending') throw new Error('Expected pending');
    expect(r).not.toHaveProperty('moves');
    expect(r).not.toHaveProperty('objective');
    expect(r.reason).toBe(
      kind === 'missing_random' ? 'random_input_exhausted_or_invalid' : 'search_budget_exhausted'
    );
  }
);
