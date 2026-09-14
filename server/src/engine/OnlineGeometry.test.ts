import { test, expect } from 'vitest';
import {
  TableBalancer,
  planOnlineGeometry,
  projectedNaturalBB,
  type BalancerTable,
  type OnlineGeometryProfile,
} from './TableBalancer.js';
import { TableBreakEngine } from './TableBreakEngine.js';
const table = (
  id: string,
  seats: number[],
  maxSeats = 9,
  buttonSeat = 1,
  reservedSeats: number[] = []
): BalancerTable => ({
  tableId: id,
  players: seats.map((seat) => ({ userId: id + seat, seat, stack: 100 })),
  playerCount: seats.length,
  maxSeats,
  buttonSeat,
  lastBigBlindSeat: seats.length === 2 ? seats.find((s) => s !== buttonSeat) : undefined,
  reservedSeats,
});
const profile = (tables: BalancerTable[]): OnlineGeometryProfile => ({
  policy: 'CLUB_ARENA_ONLINE_MTT_V1',
  sourceRevision: 2,
  format: 'nlh',
  originalPlanId: 'original:1',
  rosterVersion: 'roster:1',
  activeTableIds: tables.map((t) => t.tableId),
  randomDraws: Array(10000).fill(0),
  priorMoveCounts: Object.fromEntries(tables.flatMap((t) => t.players.map((p) => [p.userId, 0]))),
});
test('natural next BB is zero and heads-up button is SB', () => {
  expect([1, 2, 3].map((s) => projectedNaturalBB([1, 2, 3], 1, s))).toEqual([0, 1, 2]);
  expect([1, 2].map((s) => projectedNaturalBB([1, 2], 1, s, 2))).toEqual([0, 1]);
  expect(projectedNaturalBB([1, 3, 5], 2, 1)).toBe(0);
});
test('8/3 reaches full6/5 with two moves, complete final rosters and no mutation', () => {
  const ts = [table('a', [1, 2, 3, 4, 5, 6, 7, 8]), table('b', [1, 3, 5])];
  const before = JSON.stringify(ts);
  const result = new TableBalancer().planOnlineBalance(ts, profile(ts));
  expect(result.status).toBe('planned');
  if (result.status !== 'planned') return;
  expect(result.moves).toHaveLength(2);
  expect(result.finalRosters.map((t) => t.players.length)).toEqual([6, 5]);
  expect(JSON.stringify(ts)).toBe(before);
  const ds = result.moves.map((m) =>
    Math.abs(
      projectedNaturalBB(
        ts[0].players.map((p) => p.seat),
        1,
        m.fromSeat
      ) -
        projectedNaturalBB(
          result.finalRosters[1].players.map((p) => p.seat),
          1,
          m.toSeat
        )
    )
  );
  expect(result.objective).toEqual([2, ds.reduce((a, b) => a + b, 0), Math.max(...ds), 0]);
  expect(planOnlineGeometry(ts, profile(ts))).toEqual(result);
});
test('capacity and reservations can force remainder onto smaller table', () => {
  const ts = [table('a', [1, 2, 3, 4, 5], 5, 1, []), table('b', [1, 2], 3)];
  const result = planOnlineGeometry(ts, profile(ts));
  expect(result.status).toBe('planned');
  if (result.status === 'planned')
    expect(result.finalRosters.map((t) => t.players.length)).toEqual([4, 3]);
});
test('break assigns all players once and preserves occupied/reserved chairs and stacks', () => {
  const ts = [table('a', [1, 2], 4), table('b', [1, 3], 5, 1, [2])];
  const before = JSON.stringify(ts);
  const result = new TableBreakEngine().planOnlineRedistribution(ts[0], [ts[1]], breakProfile(ts));
  expect(result.status).toBe('planned');
  if (result.status !== 'planned') return;
  expect(result.moves).toHaveLength(2);
  expect(new Set(result.moves.map((m) => m.toSeat))).toEqual(new Set([4, 5]));
  expect(result.finalRosters[0].players.reduce((n, p) => n + p.stack, 0)).toBe(400);
  expect(JSON.stringify(ts)).toBe(before);
  expect(result.equallyRankedPlans).toBe(2);
  expect(result.consumedDraws).toEqual([0]);
});
test('break tie input chooses either complete assignment without player priority', () => {
  const ts = [table('a', [1, 2], 4), table('b', [1, 3], 5, 1, [2])];
  const a = planOnlineGeometry(ts, { ...breakProfile(ts), randomDraws: [0] }, 'a');
  const b = planOnlineGeometry(ts, { ...breakProfile(ts), randomDraws: [1] }, 'a');
  expect(a.status).toBe('planned');
  expect(b.status).toBe('planned');
  if (a.status === 'planned' && b.status === 'planned') expect(a.moves).not.toEqual(b.moves);
});
test('missing random/history, duplicate occupancy, stale active set and capacity refuse', () => {
  const ts = [table('a', [1, 2], 4), table('b', [1, 3], 5, 1, [2])];
  expect(planOnlineGeometry(ts, { ...breakProfile(ts), randomDraws: [] }, 'a').status).toBe(
    'pending'
  );
  expect(planOnlineGeometry(ts, { ...breakProfile(ts), priorMoveCounts: {} }, 'a').status).toBe(
    'pending'
  );
  expect(
    planOnlineGeometry(ts, { ...breakProfile(ts), activeTableIds: ['a', 'b'] }, 'a').status
  ).toBe('pending');
  const full = [ts[0], table('b', [1, 2, 3, 4], 5)];
  expect(planOnlineGeometry(full, breakProfile(full), 'a').status).toBe('pending');
  const duplicate = [ts[0], table('b', [1, 1], 5)];
  expect(planOnlineGeometry(duplicate, breakProfile(duplicate), 'a').status).toBe('pending');
});
test('unbiased rejection consumes a high draw rather than modulo-biasing ties', () => {
  const ts = [table('a', [1], 3), table('b', [1, 2], 5)];
  const r = planOnlineGeometry(ts, { ...breakProfile(ts), randomDraws: [4294967295, 2] }, 'a');
  expect(r.status).toBe('planned');
  if (r.status === 'planned') expect(r.consumedDraws).toEqual([4294967295, 2]);
});

test('history tie uses sum of accepted moves after displacement and movement count', () => {
  const ts = [table('a', [1, 2, 3, 4], 4), table('b', [1, 2, 3, 4], 4), table('c', [1, 2], 4)];
  const config = profile(ts);
  config.priorMoveCounts = { ...config.priorMoveCounts, a2: 9, b2: 1 };
  const result = planOnlineGeometry(ts, config);
  expect(result.status).toBe('planned');
  if (result.status === 'planned') {
    expect(result.moves.map((m) => m.playerId)).toEqual(['b2']);
    expect(result.objective).toEqual([1, 0, 0, 1]);
  }
});
test('random rejection exhaustion defers without returning partial assignments', () => {
  const ts = [
    table('a', [1, 2, 3, 4, 5, 6, 7, 8], 9),
    table('b', [1, 2], 9),
    table('c', [1, 2], 9),
  ];
  const result = planOnlineGeometry(
    ts,
    { ...breakProfile(ts), randomDraws: Array(100001).fill(4294967295) },
    'a'
  );
  expect(result).toEqual({ status: 'pending', reason: 'search_budget_exhausted' });
});

test('three-to-two transition follows actual previous BB and missing history refuses', () => {
  expect(projectedNaturalBB([2, 3], 1, 2, 3)).toBe(0);
  expect(projectedNaturalBB([2, 3], 1, 3, 3)).toBe(1);
  expect(() => projectedNaturalBB([2, 3], 1, 2)).toThrow('heads_up_history_unknown');
});

function breakProfile(tables: BalancerTable[]): OnlineGeometryProfile {
  return { ...profile(tables), activeTableIds: tables.slice(1).map((t) => t.tableId) };
}

test('0111 precision counterexample defers outside documented aggregate-safe domain', () => {
  const ts = [
    table('a', [1, 2, 3, 4, 5], 5),
    table('b', [1, 2, 3, 4, 5], 5),
    table('c', [1, 2], 4),
  ];
  const cfg = profile(ts);
  cfg.priorMoveCounts = {
    ...cfg.priorMoveCounts,
    a2: 9007199254740991,
    a4: 9007199254740990,
    b2: 2,
    b4: 2,
  };
  expect(planOnlineGeometry(ts, cfg)).toEqual({
    status: 'pending',
    reason: 'aggregate_history_out_of_domain',
  });
  cfg.priorMoveCounts = { ...profile(ts).priorMoveCounts, a2: Number.MAX_SAFE_INTEGER };
  expect(planOnlineGeometry(ts, cfg).status).toBe('planned');
});
test('0111 prior BB must belong to configured domain, vacant seat remains valid', () => {
  const ts = [table('a', [1, 2, 3, 4], 4), table('b', [1, 2, 3], 3), table('c', [1], 2)];
  ts[2].lastBigBlindSeat = 100;
  expect(planOnlineGeometry(ts, profile(ts))).toEqual({
    status: 'pending',
    reason: 'prior_bb_out_of_domain',
  });
  ts[2].lastBigBlindSeat = 2;
  expect(planOnlineGeometry(ts, profile(ts)).status).toBe('planned');
});
test('partial shuffle has six distinct equally likely two-player three-chair mappings', () => {
  const ts = [table('a', [1, 2], 4), table('b', [1, 2], 5)];
  const outcomes = new Set<string>();
  for (let first = 0; first < 3; first++)
    for (let second = 0; second < 2; second++) {
      const r = planOnlineGeometry(ts, { ...breakProfile(ts), randomDraws: [first, second] }, 'a');
      expect(r.status).toBe('planned');
      if (r.status === 'planned') {
        outcomes.add(r.moves.map((m) => m.toSeat).join(','));
        expect(r.completeAssignmentCount).toBe('6');
      }
    }
  expect(outcomes.size).toBe(6);
});
test('break supports complete hundred-table field and preserves all roster identities', () => {
  const ts = [
    table('a', [1, 2, 3, 4], 9),
    ...Array.from({ length: 99 }, (_, i) => table('b' + i, [1, 2, 3, 4, 5, 6], 9)),
  ];
  const result = planOnlineGeometry(ts, breakProfile(ts), 'a');
  expect(result.status).toBe('planned');
  if (result.status === 'planned') {
    expect(result.moves).toHaveLength(4);
    expect(result.finalRosters).toHaveLength(99);
    expect(new Set(result.finalRosters.flatMap((t) => t.players.map((p) => p.userId))).size).toBe(
      598
    );
  }
  expect(planOnlineGeometry(ts, profile(ts))).toEqual({
    status: 'pending',
    reason: 'balance_field_budget_exhausted',
  });
});
