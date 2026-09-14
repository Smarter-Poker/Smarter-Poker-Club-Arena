import { expect, test } from 'vitest';
import {
  planOnlineGeometry,
  projectedNaturalBB,
  type BalancerTable,
  type OnlineGeometryProfile,
  type MoveInstruction,
} from './TableBalancer.js';

type Geometry = 'ordinary' | 'history' | 'reserved';
type FixtureTable = BalancerTable & { reservedSeats: number[] };
type Fixture = { tables: FixtureTable[]; profile: OnlineGeometryProfile };
type OracleMove = Pick<
  MoveInstruction,
  'playerId' | 'fromTableId' | 'fromSeat' | 'toTableId' | 'toSeat'
>;

function fixture(count: number, geometry: Geometry): Fixture {
  const tables: FixtureTable[] = [9, 1, ...Array(count - 2).fill(5)].map((n, i) => ({
    tableId: `t${String(i).padStart(4, '0')}`,
    maxSeats: 9,
    buttonSeat: geometry === 'ordinary' ? 1 : 3,
    lastBigBlindSeat: 3,
    playerCount: n,
    reservedSeats: [],
    players: Array.from({ length: n }, (_, j) => ({
      userId: `${i}:${j + 1}`,
      seat: j + 1,
      stack: 100 + i + j,
    })),
  }));
  if (geometry !== 'ordinary') {
    tables[1].players[0].seat = 4;
    tables[1].buttonSeat = 2;
    tables[1].lastBigBlindSeat = 5;
    if (geometry === 'reserved') tables[1].reservedSeats = [8, 9];
  }
  return {
    tables,
    profile: {
      policy: 'CLUB_ARENA_ONLINE_MTT_V1',
      sourceRevision: 2,
      format: 'nlh',
      originalPlanId: 'single-destination-regression',
      rosterVersion: 'original',
      activeTableIds: tables.map((t) => t.tableId),
      priorMoveCounts: Object.fromEntries(
        tables.flatMap((t) =>
          t.players.map((p, j) => [p.userId, geometry === 'ordinary' ? 0 : (j * 7) % 5])
        )
      ),
      randomDraws: Array(100002).fill(0),
    },
  };
}
const signature = (moves: readonly OracleMove[]) =>
  JSON.stringify(
    moves.map((m) => [m.playerId, m.fromTableId, m.fromSeat, m.toTableId, m.toSeat]).sort()
  );
const compare = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

// Every table must finish with five players. The nine-player donor must send
// exactly four to the one-player receiver for a minimum-movement plan.
// Enumerate ALL chair subsets and ALL ordered distinct source players. This
// oracle never uses inverse-distance matching or zero-displacement pruning.
function exhaustive({ tables, profile }: Fixture) {
  const [source, destination] = tables;
  const free = Array.from({ length: destination.maxSeats }, (_, i) => i + 1).filter(
    (seat) =>
      !destination.players.some((p) => p.seat === seat) && !destination.reservedSeats.includes(seat)
  );
  const sourceDistances = source.players.map((p) =>
    projectedNaturalBB(
      source.players.map((x) => x.seat),
      source.buttonSeat!,
      p.seat,
      source.lastBigBlindSeat
    )
  );
  const selected: number[] = [];
  let best: number[] | null = null;
  let evaluated = 0;
  const winners = new Set<string>();
  const chairs = (index: number): void => {
    if (selected.length === 4) {
      const finalSeats = [...destination.players.map((p) => p.seat), ...selected];
      const distances = selected.map((seat) =>
        projectedNaturalBB(finalSeats, destination.buttonSeat!, seat, destination.lastBigBlindSeat)
      );
      const moves: OracleMove[] = [];
      const used = new Set<number>();
      const players = (j: number, sum: number, max: number, history: number): void => {
        if (j === 4) {
          evaluated++;
          const objective = [4, sum, max, history];
          const comparison = best ? compare(objective, best) : -1;
          if (comparison < 0) {
            best = objective;
            winners.clear();
          }
          if (comparison <= 0) winners.add(signature(moves));
          return;
        }
        for (let i = 0; i < source.players.length; i++) {
          if (used.has(i)) continue;
          const p = source.players[i];
          used.add(i);
          moves.push({
            playerId: p.userId,
            fromTableId: source.tableId,
            fromSeat: p.seat,
            toTableId: destination.tableId,
            toSeat: selected[j],
          });
          const delta = Math.abs(sourceDistances[i] - distances[j]);
          players(
            j + 1,
            sum + delta,
            Math.max(max, delta),
            history + profile.priorMoveCounts[p.userId]
          );
          moves.pop();
          used.delete(i);
        }
      };
      players(0, 0, 0, 0);
      return;
    }
    for (let i = index; i <= free.length - (4 - selected.length); i++) {
      selected.push(free[i]);
      chairs(i + 1);
      selected.pop();
    }
  };
  chairs(0);
  return { best, winners, evaluated };
}

for (const geometry of ['ordinary', 'history', 'reserved'] as const) {
  test.each([12, 90, 364, 2000])(
    `%i-table ${geometry} four-move plan matches exhaustive assignments`,
    (count) => {
      const f = fixture(count, geometry);
      const before = JSON.stringify(f);
      const truth = exhaustive(f);
      expect(truth.evaluated).toBe(geometry === 'reserved' ? 45360 : 211680);
      expect(truth.winners.size).toBe(
        geometry === 'ordinary' ? 70 : geometry === 'history' ? 35 : 5
      );
      const result = planOnlineGeometry(f.tables, f.profile);
      expect(result.status).toBe('planned');
      if (result.status !== 'planned') throw new Error(result.reason);
      expect(result.objective).toEqual(truth.best);
      expect(result.equallyRankedPlans).toBe(truth.winners.size);
      expect(truth.winners.has(signature(result.moves))).toBe(true);
      expect(result.moves).toHaveLength(4);
      expect(JSON.stringify(f)).toBe(before);
      // Independently apply selected moves and compare the returned complete roster.
      const final = new Map(f.tables.map((t) => [t.tableId, t.players.map((p) => ({ ...p }))]));
      for (const move of result.moves) {
        const source = final.get(move.fromTableId)!;
        const index = source.findIndex((p) => p.userId === move.playerId);
        expect(index).toBeGreaterThanOrEqual(0);
        const [player] = source.splice(index, 1);
        expect(player.seat).toBe(move.fromSeat);
        const destination = final.get(move.toTableId)!;
        expect(destination.some((p) => p.seat === move.toSeat)).toBe(false);
        expect(f.tables.find((t) => t.tableId === move.toTableId)!.reservedSeats).not.toContain(
          move.toSeat
        );
        destination.push({ ...player, seat: move.toSeat });
      }
      expect(result.finalRosters).toHaveLength(count);
      expect(new Set(result.finalRosters.map((t) => t.tableId)).size).toBe(count);
      const rosterSignature = (players: BalancerTable['players']) =>
        players.map((p) => [p.userId, p.seat, p.stack]).sort();
      for (const table of result.finalRosters) {
        expect(table.players).toHaveLength(5);
        expect(rosterSignature(table.players)).toEqual(rosterSignature(final.get(table.tableId)!));
        expect(new Set(table.players.map((p) => p.seat)).size).toBe(5);
        expect(table.players.every((p) => p.seat >= 1 && p.seat <= 9)).toBe(true);
      }
      expect(
        result.finalRosters.flatMap((t) => t.players.map((p) => [p.userId, p.stack])).sort()
      ).toEqual(f.tables.flatMap((t) => t.players.map((p) => [p.userId, p.stack])).sort());
    }
  );
}

test('all 70 exhaustive four-move best ties are reachable', () => {
  const f = fixture(12, 'ordinary');
  const truth = exhaustive(f);
  const reached = new Set<string>();
  for (let winner = 0; winner < 70; winner++) {
    const randomDraws = Array(69).fill(1);
    if (winner > 0) randomDraws[winner - 1] = 0;
    const result = planOnlineGeometry(f.tables, { ...f.profile, randomDraws });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') throw new Error(result.reason);
    expect(result.objective).toEqual(truth.best);
    expect(result.equallyRankedPlans).toBe(70);
    expect(result.consumedDraws).toEqual(randomDraws);
    reached.add(signature(result.moves));
  }
  expect(reached).toEqual(truth.winners);
});

test('four-move ties reject an out-of-range sampling residue and consume the next draw', () => {
  const f = fixture(12, 'ordinary');
  const truth = exhaustive(f);
  // Draw 0 selects among two ties; uint32 max is rejected for three ties.
  const randomDraws = [0, 4294967295, ...Array(70).fill(0)];
  const result = planOnlineGeometry(f.tables, { ...f.profile, randomDraws });
  expect(result.status).toBe('planned');
  if (result.status !== 'planned') throw new Error(result.reason);
  expect(result.objective).toEqual(truth.best);
  expect(result.equallyRankedPlans).toBe(70);
  expect(truth.winners.has(signature(result.moves))).toBe(true);
  expect(result.consumedDraws).toEqual(randomDraws.slice(0, 70));
});

test('four-move ties with missing randomness return no partial plan', () => {
  const f = fixture(12, 'ordinary');
  f.profile.randomDraws = [];
  const before = JSON.stringify(f);
  const result = planOnlineGeometry(f.tables, f.profile);
  expect(result).toEqual({ status: 'pending', reason: 'random_input_exhausted_or_invalid' });
  expect(result).not.toHaveProperty('moves');
  expect(result).not.toHaveProperty('objective');
  expect(JSON.stringify(f)).toBe(before);
});
