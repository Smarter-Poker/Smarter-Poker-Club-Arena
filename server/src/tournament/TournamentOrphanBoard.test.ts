import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentManager } from './TournamentManager.js';
import type { GameServer } from '../GameServer.js';
import { supabase } from '../services/supabase.js';
import * as errors from '../services/errorReporter.js';
class Harness extends TournamentManager {
  constructor() {
    super('event', {} as GameServer, 'generation', performance.now() + 60_000);
    (this as unknown as { lifecycleEpoch: { begin(): void } }).lifecycleEpoch.begin();
    this.running = true;
  }
  withdraw() {
    this.running = false;
  }
  override redrivePendingTournamentSeatMoveOutcomes = vi.fn(async () => true);
  override executePlayerMoves = vi.fn(async () => 1);
}
type Row = Record<string, unknown>;
function fixture(tables: Row[], seats: Row[], failLater = false) {
  vi.spyOn(errors, 'reportError').mockImplementation(() => {});
  vi.spyOn(supabase, 'from').mockImplementation(((relation: string) => {
    let cursor = '';
    let limit = 1000;
    const q: Record<string, unknown> = {};
    for (const name of ['select', 'eq', 'in', 'is', 'order']) q[name] = () => q;
    q.gt = (_key: string, value: string) => {
      cursor = value;
      return q;
    };
    q.limit = (value: number) => {
      limit = Math.min(1000, value);
      return q;
    };
    q.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve(
        failLater && cursor
          ? { data: null, error: { message: 'page failed' } }
          : {
              data: (relation === 'tables' ? tables : seats)
                .filter((r) => String(r.id) > cursor)
                .slice(0, limit),
              error: null,
            }
      ).then(resolve);
    return q;
  }) as never);
  return new Harness();
}
const id = (n: number) => String(n).padStart(8, '0');
const open = { id: 'open', status: 'running', max_players: 9 };
const closed = { id: 'closed', status: 'closed', max_players: 9 };
const occupiedTables = Array.from({ length: 112 }, (_, n) => ({
  ...open,
  id: `occupied-${id(n)}`,
}));
const occupiedSeat = (n: number) => ({
  id: id(n),
  table_id: occupiedTables[Math.floor(n / 9)].id,
  user_id: `p${n}`,
  seat_number: (n % 9) + 1,
  stack: 10,
});
afterEach(() => vi.restoreAllMocks());
describe('orphan planning reads the complete tournament board', () => {
  it('sees a stranded seat after the first 1000 live seats', async () => {
    const seats = Array.from({ length: 1000 }, (_, n) => occupiedSeat(n));
    seats.push({
      id: id(1000),
      table_id: 'closed',
      user_id: 'stranded',
      seat_number: 2,
      stack: 50,
    });
    const manager = fixture([closed, ...occupiedTables, open], seats);
    await expect(manager.absorbOrphanedSeats()).resolves.toBe(1);
    expect(manager.executePlayerMoves).toHaveBeenCalledWith([
      expect.objectContaining({
        playerId: 'stranded',
        fromTableId: 'closed',
        toTableId: 'open',
        toSeat: 1,
      }),
    ]);
  });
  it('does not choose a source when the second closed source is on a later page', async () => {
    const seats: Row[] = [
      { id: id(0), table_id: 'closed', user_id: 'twice', seat_number: 1, stack: 50 },
      ...Array.from({ length: 999 }, (_, n) => ({ ...occupiedSeat(n), id: id(n + 1) })),
      { id: id(1000), table_id: 'closed2', user_id: 'twice', seat_number: 1, stack: 60 },
    ];
    const manager = fixture([closed, { ...closed, id: 'closed2' }, ...occupiedTables, open], seats);
    await expect(manager.absorbOrphanedSeats()).resolves.toBe(0);
    expect(manager.executePlayerMoves).not.toHaveBeenCalled();
  });
  it('does not plan from a partial table inventory', async () => {
    const tables = Array.from({ length: 1001 }, (_, n) => ({
      id: id(n),
      status: n ? 'running' : 'closed',
      max_players: 9,
    }));
    const manager = fixture(
      tables,
      [{ id: 's', table_id: id(0), user_id: 'stranded', seat_number: 1, stack: 50 }],
      true
    );
    await expect(manager.absorbOrphanedSeats()).resolves.toBe(0);
    expect(manager.executePlayerMoves).not.toHaveBeenCalled();
  });
  it('does not act when admission is withdrawn while resolving prior moves', async () => {
    const manager = fixture(
      [closed, open],
      [{ id: 's', table_id: 'closed', user_id: 'p', seat_number: 1, stack: 50 }]
    );
    manager.redrivePendingTournamentSeatMoveOutcomes.mockImplementation(async () => {
      manager.withdraw();
      return true;
    });
    await expect(manager.absorbOrphanedSeats()).resolves.toBe(0);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(manager.executePlayerMoves).not.toHaveBeenCalled();
  });
  it('refuses a partial seat board even when its first page contains an orphan', async () => {
    const seats: Row[] = [
      { id: id(0), table_id: 'closed', user_id: 'stranded', seat_number: 1, stack: 50 },
      ...Array.from({ length: 1000 }, (_, n) => ({ ...occupiedSeat(n), id: id(n + 1) })),
    ];
    const manager = fixture([closed, ...occupiedTables, open], seats, true);
    await expect(manager.absorbOrphanedSeats()).resolves.toBe(0);
    expect(manager.executePlayerMoves).not.toHaveBeenCalled();
  });
});
