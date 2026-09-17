import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { supabase } from '../services/supabase.js';
import * as moves from '../services/supabase/seatMoves.js';

const TABLE = 'aaaaaaaa-1111-4111-8111-111111111111';
const SEAT = '99999999-8888-4888-8888-888888888888';
const USER = 'bbbbbbbb-2222-4222-8222-222222222222';
const ORIGINAL = 'cccccccc-3333-4333-8333-333333333333';
const REPLACEMENT = 'dddddddd-4444-4444-8444-444444444444';
const pending = () => ({
  move_id: 'eeeeeeee-5555-4555-8555-555555555555',
  player_id: USER,
  to_table_id: 'ffffffff-6666-4666-8666-666666666666',
  to_table_name: 'Main 2',
  to_role: 'main',
  to_main_index: 2,
  reason: 'seat_change' as const,
  announced_at: '2026-09-14T09:00:00Z',
  ready_at: '2026-09-14T09:01:00Z',
  swap_move_id: '11111111-7777-4777-8777-777777777777',
  source_occupancy_id: ORIGINAL,
});
function setup() {
  const engine = Object.create(ServerTableEngine.prototype) as any;
  engine.tableId = TABLE;
  engine.tableInfo = { cluster_id: 'game' };
  engine.seatedPlayers = [
    { seat_id: SEAT, user_id: USER, occupancy_id: ORIGINAL, seat_number: 1, stack: 10 },
  ];
  engine.lifecycleCanMutate = vi.fn(() => true);
  engine.isTournamentTable = vi.fn(() => false);
  engine.heldForSwap = new Set();
  engine.announcedSeatMoves = new Set();
  engine.entryHoldWriteChains = new Map();
  engine.depositPresenceForMove = vi.fn();
  engine.hub = { emitEvent: vi.fn() };
  return engine;
}
afterEach(() => vi.restoreAllMocks());

describe('Must-Move restart and occupancy boundaries', () => {
  it('a queued entry write cannot clear the hold on a replacement occupancy', async () => {
    const engine = setup();
    let release!: () => void;
    engine.entryHoldWriteChains.set(
      USER,
      new Promise<void>((r) => {
        release = r;
      })
    );
    const rows = [
      {
        id: SEAT,
        table_id: TABLE,
        user_id: USER,
        occupancy_id: REPLACEMENT,
        left_at: null,
        entry_hold: 'waiting',
      },
    ];
    const writes: Array<Record<string, unknown>> = [];
    vi.spyOn(supabase, 'from').mockImplementation((() => {
      const filters: Record<string, unknown> = {};
      let patch: Record<string, unknown>;
      const builder = {
        update: (value: Record<string, unknown>) => {
          patch = value;
          return builder;
        },
        eq: (key: string, value: unknown) => {
          filters[key] = value;
          return builder;
        },
        is: (key: string, value: unknown) => {
          filters[key] = value;
          return builder;
        },
        then: (resolve: (value: unknown) => void) => {
          writes.push(filters);
          for (const row of rows)
            if (Object.entries(filters).every(([k, v]) => (row as any)[k] === v))
              Object.assign(row, patch);
          return Promise.resolve({ error: null }).then(resolve);
        },
      };
      return builder;
    }) as any);
    engine.persistEntryHold(USER, { hold: null, agreed: false });
    const tail = engine.entryHoldWriteChains.get(USER);
    engine.seatedPlayers[0].occupancy_id = REPLACEMENT;
    release();
    await tail;
    expect(writes).toHaveLength(1);
    expect(rows[0].entry_hold).toBe('waiting');
    expect(writes[0].id).toBe(SEAT);
    expect(writes[0].occupancy_id).toBe(ORIGINAL);
  });

  it('rehydrates a ready swap side after restart before it can be dealt', async () => {
    const engine = setup();
    vi.spyOn(moves, 'pendingSeatMoves').mockResolvedValue([pending()]);
    await engine.announcePendingSeatMoves();
    expect(engine.isHeldForSwap(USER)).toBe(true);
  });

  it('rechecks a restored swap hold against an already selected deal roster', async () => {
    const engine = setup();
    engine.seatedPlayers.push({
      user_id: 'second',
      occupancy_id: REPLACEMENT,
      seat_number: 2,
      stack: 10,
    });
    const selectedBeforeRead = [...engine.seatedPlayers];
    engine.seatBoundaryTail = Promise.resolve();
    engine.waitingForBB = new Set();
    engine.disconnectEngine = { isSittingOut: () => false };
    engine.takePreparedHandNumber = vi.fn(() => {
      throw new Error('new hand started');
    });
    vi.spyOn(moves, 'pendingSeatMoves').mockResolvedValue([pending()]);
    await engine.announcePendingSeatMoves();
    await expect(engine.dealHand(selectedBeforeRead)).resolves.toBeUndefined();
    expect(engine.takePreparedHandNumber).not.toHaveBeenCalled();
    engine.heldForSwap.clear();
    await expect(engine.dealHand(selectedBeforeRead)).rejects.toThrow('new hand started');
  });

  it('an unreadable swap state defers the deal without discarding a known hold', async () => {
    const engine = setup();
    engine.heldForSwap.add(USER);
    vi.spyOn(moves, 'pendingSeatMoves').mockRejectedValue(new Error('read failed'));
    await expect(engine.announcePendingSeatMoves()).resolves.toBe(false);
    expect(engine.isHeldForSwap(USER)).toBe(true);
    expect(engine.hub.emitEvent).not.toHaveBeenCalled();
  });

  it('does not put a replacement stay into an old swap hold', async () => {
    const engine = setup();
    engine.seatedPlayers[0].occupancy_id = REPLACEMENT;
    vi.spyOn(moves, 'pendingSeatMoves').mockResolvedValue([pending()]);
    await engine.announcePendingSeatMoves();
    expect(engine.isHeldForSwap(USER)).toBe(false);
  });

  it('a delayed pending read cannot mutate a retired engine or announce a move', async () => {
    const engine = setup();
    engine.heldForSwap.add(USER);
    let complete!: (value: moves.PendingSeatMove[]) => void;
    vi.spyOn(moves, 'pendingSeatMoves').mockReturnValue(
      new Promise((r) => {
        complete = r;
      })
    );
    const reading = engine.announcePendingSeatMoves();
    engine.lifecycleCanMutate.mockReturnValue(false);
    complete([]);
    await reading;
    expect(engine.isHeldForSwap(USER)).toBe(true);
    expect(engine.hub.emitEvent).not.toHaveBeenCalled();
  });
});
