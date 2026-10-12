/**
 * A HORSE THAT BUSTS AT A DIAMOND TABLE IS RELEASED LIKE A PERSON (2026-10-06).
 *
 * `recoverBustedSeatedHorses` returns at once on a Diamond table (no treasury
 * funds a Diamond seat) and settlement skips the horse rebuy there, so before
 * this a busted horse at the Diamond Arena was neither rebought nor released:
 * it held a zero-stack chair for ever. The human stand-up now includes horses
 * at a Diamond cash table - same grace, same door - and still leaves them out
 * at a chip table, where their own recovery pass owns the seat.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw new Error('Unmodeled database read in busted-horse fixture');
    }),
    rpc: vi.fn(() => {
      throw new Error('Unmodeled database RPC in busted-horse fixture');
    }),
  },
  maintenanceSupabase: {},
}));

const { ServerTableEngine } = await import('./ServerTableEngine.js');

afterEach(() => {
  vi.useRealTimers();
});

function engineWith(asset: 'diamonds' | 'chips', players: Array<Record<string, unknown>>) {
  const engine = Object.create(ServerTableEngine.prototype) as any;
  engine.tableId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  engine.tableInfo = { arena: { asset } };
  engine.seatedPlayers = players;
  engine.bustedSince = new Map<string, number>();
  engine.rebuyPromptOpenAt = new Map<string, number>();
  engine.pendingAddOns = new Map<string, number>();
  engine.handController = null;
  engine.isTournamentTable = () => false;
  engine.usersWithPendingLedgerChips = vi.fn(async () => new Set<string>());
  engine.releaseBustedSeat = vi.fn(async () => true);
  return engine;
}

const horse = {
  user_id: 'horse-1',
  occupancy_id: 'occ-horse',
  username: 'riverhorse',
  seat_number: 2,
  stack: 0,
  is_horse: true,
};
const person = {
  user_id: 'person-1',
  occupancy_id: 'occ-person',
  username: 'someone',
  seat_number: 3,
  stack: 0,
  is_horse: false,
};

async function sweepPastGrace(engine: any) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-06T16:00:00Z'));
  await engine.standUpBustedCashPlayers(); // starts the grace clock
  vi.setSystemTime(Date.now() + ServerTableEngine.BUSTED_GRACE_MS + 1);
  await engine.standUpBustedCashPlayers(); // past the grace: released
}

describe('a busted seat at a Diamond cash table', () => {
  it('releases a busted horse through the same door and grace as a person', async () => {
    const engine = engineWith('diamonds', [{ ...horse }, { ...person }]);
    await sweepPastGrace(engine);
    const released = engine.releaseBustedSeat.mock.calls.map((c: any[]) => c[0].user_id);
    expect(released.sort()).toEqual(['horse-1', 'person-1']);
    for (const call of engine.releaseBustedSeat.mock.calls) {
      expect(call[1]).toBe('busted_no_rebuy');
    }
    expect(engine.seatedPlayers).toEqual([]);
  });

  it('does not release a horse before the grace, any more than a person', async () => {
    const engine = engineWith('diamonds', [{ ...horse }]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T16:00:00Z'));
    await engine.standUpBustedCashPlayers();
    expect(engine.releaseBustedSeat).not.toHaveBeenCalled();
  });

  it('still leaves a horse at a CHIP table to its own recovery pass', async () => {
    const engine = engineWith('chips', [{ ...horse }, { ...person }]);
    await sweepPastGrace(engine);
    const released = engine.releaseBustedSeat.mock.calls.map((c: any[]) => c[0].user_id);
    expect(released).toEqual(['person-1']);
  });
});
