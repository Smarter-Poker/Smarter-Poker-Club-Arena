import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { supabase } from '../services/supabase/client.js';
import { deadlineScheduler } from './DeadlineScheduler.js';

const table = '11111111-1111-4111-8111-111111111111';
const player = '22222222-2222-4222-8222-222222222222';
const occupancy = '33333333-3333-4333-8333-333333333333';
const seat = '44444444-4444-4444-8444-444444444444';
const pool = '55555555-5555-4555-8555-555555555555';
const stamp = '2026-10-20T19:30:00.000Z';
let engine: any;
let writes: boolean[];
let release: (() => void) | null;
let blocked: Promise<void>;
let seatRow: Record<string, unknown> | null;
let poolRow: Record<string, unknown> | null;
let failWrite: boolean;
let filters: Array<[string, string, unknown]>;

beforeEach(() => {
  writes = [];
  filters = [];
  release = null;
  blocked = new Promise<void>((r) => {
    release = r;
  });
  seatRow = { id: seat, table_id: table, user_id: player, occupancy_id: occupancy, left_at: null };
  poolRow = { id: pool, player_id: player, anchor_seat_id: seat, exited_at: null };
  failWrite = false;
  vi.spyOn(supabase, 'from').mockImplementation(((name: string) => {
    let wanted = false;
    const builder: any = {
      update(patch: { is_sitting_out: boolean }) {
        wanted = patch.is_sitting_out;
        writes.push(wanted);
        return builder;
      },
      select: () => builder,
      eq(column: string, value: unknown) {
        filters.push([name, column, value]);
        return builder;
      },
      is(column: string, value: unknown) {
        filters.push([name, column, value]);
        return builder;
      },
      async maybeSingle() {
        if (name === 'lightning_pool_session') return { data: poolRow, error: null };
        await blocked;
        if (failWrite) return { data: null, error: { message: 'refused' } };
        return {
          data: seatRow && {
            ...seatRow,
            is_sitting_out: wanted,
            sit_out_at: wanted ? stamp : null,
          },
          error: null,
        };
      },
      then(resolve: any, reject: any) {
        return builder.maybeSingle().then(resolve, reject);
      },
    };
    return builder;
  }) as any);
  engine = new ServerTableEngine(table) as any;
  engine.tableInfo = {
    id: table,
    game_type: 'cash',
    club_id: 'club',
    big_blind: 2,
    max_players: 6,
  };
  engine.handController = null;
  engine.seatedPlayers = [{ user_id: player, occupancy_id: occupancy, stack: 2, seat_number: 1 }];
  engine.dealtInUserIds.add(player);
  engine.hub = { emitEvent: vi.fn(), publish: vi.fn() };
  vi.spyOn(engine.chipContinuity, 'evaluate').mockResolvedValue([]);
  engine.broadcastCurrentState = vi.fn();
});
afterEach(() => {
  release?.();
  deadlineScheduler.cancelAll(table);
  vi.restoreAllMocks();
});
const events = () =>
  engine.hub.emitEvent.mock.calls.filter(([, e]: any) => e.type === 'lightning_sitout_changed');

describe('the original engine sit-out persistence publishes its own Lightning transition', () => {
  it('emits the database stamp only after its exact seat write completes', async () => {
    expect(engine.sitOut(player, true).success).toBe(true);
    await vi.waitFor(() => expect(writes).toEqual([true]));
    expect(events()).toEqual([]);
    release?.();
    await vi.waitFor(() =>
      expect(events()).toEqual([
        [
          pool,
          {
            type: 'lightning_sitout_changed',
            pool_session_id: pool,
            player_id: player,
            occupancy_id: occupancy,
            sitting_out: true,
            sit_out_at: stamp,
          },
        ],
      ])
    );
    expect(filters).toEqual([
      ['table_seats', 'table_id', table],
      ['table_seats', 'user_id', player],
      ['table_seats', 'occupancy_id', occupancy],
      ['table_seats', 'left_at', null],
      ['lightning_pool_session', 'anchor_seat_id', seat],
      ['lightning_pool_session', 'player_id', player],
      ['lightning_pool_session', 'exited_at', null],
    ]);
  });
  it('keeps concurrent out/back persistence and events in original transition order', async () => {
    engine.sitOut(player, true);
    engine.sitOut(player, false);
    await vi.waitFor(() => expect(writes).toEqual([true]));
    release?.();
    await vi.waitFor(() =>
      expect(events().map(([, e]: any) => [e.sitting_out, e.sit_out_at])).toEqual([
        [true, stamp],
        [false, null],
      ])
    );
    expect(writes).toEqual([true, false]);
  });
  it('does not let an earlier refused write block a later explicit return', async () => {
    failWrite = true;
    engine.sitOut(player, true);
    release?.();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(events()).toEqual([]);
    failWrite = false;
    engine.sitOut(player, false);
    await vi.waitFor(() =>
      expect(events().map(([, e]: any) => [e.sitting_out, e.sit_out_at])).toEqual([[false, null]])
    );
    expect(writes).toEqual([true, false]);
  });
  it.each([
    'no_row',
    'replaced_occupancy',
    'foreign_owner',
    'closed_pool',
    'ordinary_cash',
    'write_refused',
  ])('does not publish an unproven transition: %s', async (why) => {
    if (why === 'no_row') seatRow = null;
    if (why === 'replaced_occupancy') seatRow!.occupancy_id = pool;
    if (why === 'foreign_owner') poolRow!.player_id = pool;
    if (why === 'closed_pool') poolRow!.exited_at = stamp;
    if (why === 'ordinary_cash') poolRow = null;
    if (why === 'write_refused') failWrite = true;
    engine.sitOut(player, true);
    await vi.waitFor(() => expect(writes).toEqual([true]));
    release?.();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(events()).toEqual([]);
  });
});
