import { expect, test } from 'vitest';
import {
  planOnlineGeometry,
  type BalancerTable,
  type OnlineGeometryProfile,
} from './TableBalancer.js';

type Shape = 'donor' | 'receiver' | 'split1' | 'split2';

function fixture(count: number, shape: Shape) {
  const counts = shape.startsWith('split')
    ? Array.from({ length: count }, (_, i) => (i < count / 2 ? 5 : 6))
    : Array(count).fill(shape === 'donor' ? 6 : 5);
  if (shape.startsWith('split')) {
    const moves = shape === 'split2' ? 2 : 1;
    counts[0] -= moves;
    counts[count / 2] += moves;
  } else {
    counts[0] = shape === 'donor' ? 4 : 7;
  }
  const tables: BalancerTable[] = counts.map((players, i) => ({
    tableId: 't' + String(i).padStart(4, '0'),
    maxSeats: 9,
    buttonSeat: 1,
    lastBigBlindSeat: 3,
    playerCount: players,
    reservedSeats: [],
    players: Array.from({ length: players }, (_, j) => ({
      userId: `${i}:${j + 1}`,
      seat: j + 1,
      stack: 100 + i + j,
    })),
  }));
  const profile: OnlineGeometryProfile = {
    policy: 'CLUB_ARENA_ONLINE_MTT_V1',
    sourceRevision: 2,
    format: 'nlh',
    originalPlanId: 'large-field-original',
    rosterVersion: 'roster-original',
    activeTableIds: tables.map((t) => t.tableId),
    priorMoveCounts: Object.fromEntries(
      tables.flatMap((t, i) => t.players.map((p) => [p.userId, i % 3]))
    ),
    randomDraws: Array(100_002).fill(0),
  };
  return { tables, profile };
}

// Expected objectives and complete winning-plan counts come from the
// independent exhaustive one/two-move oracle accepted in ProgramReview0131.
// They do not call the planner under test to calculate their expectations.
const cases: Array<[number, Shape, number[], number]> = [
  [364, 'donor', [1, 0, 0, 0], 605],
  [364, 'receiver', [1, 0, 0, 0], 1452],
  [1000, 'split1', [1, 0, 0, 2], 5],
  [1000, 'split2', [2, 0, 0, 4], 15],
  [2000, 'donor', [1, 0, 0, 0], 3330],
  [2000, 'receiver', [1, 0, 0, 0], 7996],
  [2000, 'split1', [1, 0, 0, 1], 5],
  [2000, 'split2', [2, 0, 0, 2], 15],
];

test.each(cases)(
  '%i-table %s field reaches the complete exact optimum',
  (count, shape, objective, ties) => {
    const { tables, profile } = fixture(count, shape);
    const before = JSON.stringify({ tables, profile });
    const result = planOnlineGeometry(tables, profile);
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') throw Error(result.reason);
    expect(result.objective).toEqual(objective);
    expect(result.equallyRankedPlans).toBe(ties);
    expect(result.moves).toHaveLength(objective[0]);
    expect(result.originalPlanId).toBe(profile.originalPlanId);
    expect(result.rosterVersion).toBe(profile.rosterVersion);
    expect(result.finalRosters).toHaveLength(count);
    const players = (rosters: Array<{ players: BalancerTable['players'] }>) =>
      rosters.flatMap((t) => t.players.map((p) => `${p.userId}=${p.stack}`)).sort();
    expect(players(result.finalRosters)).toEqual(players(tables));
    const total = tables.reduce((sum, t) => sum + t.playerCount, 0);
    const low = Math.floor(total / count);
    const high = Math.ceil(total / count);
    for (const roster of result.finalRosters) {
      expect(roster.players.length).toBeGreaterThanOrEqual(low);
      expect(roster.players.length).toBeLessThanOrEqual(high);
      expect(new Set(roster.players.map((p) => p.seat)).size).toBe(roster.players.length);
    }
    expect(JSON.stringify({ tables, profile })).toBe(before);
  }
);

test('reserved chairs restrict neutral high targets without losing exact ties', () => {
  const { tables, profile } = fixture(364, 'receiver');
  tables[0].players.push({ userId: '0:8', seat: 8, stack: 108 });
  tables[0].playerCount = 8;
  for (let i = 1; i < tables.length; i++) {
    if (i <= 3) tables[i].reservedSeats = [7, 8, 9];
    else tables[i].maxSeats = 5;
  }
  profile.priorMoveCounts = Object.fromEntries(
    tables.flatMap((t) => t.players.map((p) => [p.userId, p.seat % 3]))
  );
  const result = planOnlineGeometry(tables, profile);
  expect(result.status).toBe('planned');
  if (result.status !== 'planned') throw Error(result.reason);
  expect(result.objective).toEqual([2, 1, 1, 1]);
  expect(result.equallyRankedPlans).toBe(6);
  expect(result.moves.every((move) => move.toSeat === 6)).toBe(true);
  expect(result.finalRosters.filter((t) => t.players.length === 6)).toHaveLength(3);
  expect(result.finalRosters).toHaveLength(364);
});

test('a table unable to reach the floor cannot produce a partial plan', () => {
  const { tables, profile } = fixture(364, 'split1');
  tables[0].maxSeats = 4;
  expect(planOnlineGeometry(tables, profile)).toEqual({
    status: 'pending',
    reason: 'capacity_unavailable',
  });
});

test('an exhausted proof budget never releases its best plan so far', () => {
  const { tables, profile } = fixture(364, 'split2');
  tables.forEach((table, i) => {
    table.playerCount = i < 182 ? 9 : 3;
    table.players = Array.from({ length: table.playerCount }, (_, j) => ({
      userId: `${i}:${j + 1}`,
      seat: j + 1,
      stack: 100,
    }));
  });
  profile.priorMoveCounts = Object.fromEntries(
    tables.flatMap((table) => table.players.map((player) => [player.userId, 0]))
  );
  expect(planOnlineGeometry(tables, profile)).toEqual({
    status: 'pending',
    reason: 'search_budget_exhausted',
  });
});

test('missing captured randomness cannot select a partial or preferred assignment', () => {
  const { tables, profile } = fixture(364, 'donor');
  profile.randomDraws = [];
  expect(planOnlineGeometry(tables, profile)).toEqual({
    status: 'pending',
    reason: 'random_input_exhausted_or_invalid',
  });
});
