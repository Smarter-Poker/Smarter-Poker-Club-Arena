import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    rpc,
    from: () => {
      throw new Error('Unexpected database write');
    },
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { reportError } from '../services/errorReporter.js';
import { ServerTableEngine } from './ServerTableEngine.js';
const engines: any[] = [];
const table = '20000000-0000-4000-8000-000000000001';
const manifest = '60000000-0000-4000-8000-000000000001';
const generation = '70000000-0000-4000-8000-000000000001';
beforeEach(() => {
  rpc.mockReset();
  vi.mocked(reportError).mockClear();
});
afterEach(() => {
  for (const engine of engines.splice(0)) {
    engine.running = false;
    (ServerTableEngine as any).releaseCurrentEngine(engine.tableId, engine);
    engine.preciseTimer.dispose();
    engine.engineTelemetry.dispose();
  }
});
function fixture() {
  const engine = new ServerTableEngine(table) as any;
  engines.push(engine);
  expect(engine.claimProcessOwnership()).toBe(true);
  engine.running = true;
  engine.tableInfo = {
    id: table,
    club_id: 'club',
    game_variant: 'nlh',
    game_type: 'cash',
    tournament_id: null,
    max_players: 6,
    small_blind: 1,
    big_blind: 2,
    ante: 0,
    ante_enabled: false,
  };
  const seats = [1, 2, 3].map((seat) => ({
    seat_number: seat,
    user_id: `30000000-0000-4000-8000-00000000000${seat}`,
    username: `Player ${seat}`,
    stack: 100,
    is_horse: seat > 1,
    seat_id: `40000000-0000-4000-8000-00000000000${seat}`,
    occupancy_id: `50000000-0000-4000-8000-00000000000${seat}`,
    seat_joined_at: '2026-09-17T22:00:00.123456+00:00',
  }));
  engine.seatedPlayers = seats;
  engine.preparedHandNumberValue = {
    n: 1000010,
    at: Date.now(),
    epoch: engine.f06AllocationEpoch,
  };
  engine.allocateGlobalHandNumber = vi.fn().mockResolvedValue(1000011);
  engine.getEngineLeaseAuthority = () => ({ verified: true, generation, scope: 'cash' });
  engine.hasCurrentEngineLeaseAuthority = vi.fn(() => true);
  engine.bombPotSchedPersistedJson = 'null';
  engine.eventShadowEnabled = false;
  engine.hub = { emitEvent: vi.fn() };
  engine.refreshRakeConfig = async () => {};
  const prepared = new Error('real controller prepared; stop before transport and hand start');
  engine.fetchTimeBankExtras = vi.fn(async () => {
    throw prepared;
  });
  return { engine, seats, prepared };
}
describe('original cash provenance at the real deal boundary', () => {
  it('binds the complete real controller roster including horses before controller construction', async () => {
    const { engine, seats, prepared } = fixture();
    rpc.mockImplementation(async () => {
      expect(engine.handController).toBeNull();
      return { data: { version: 1, manifest_id: manifest }, error: null };
    });
    await expect(engine.dealHand(seats)).rejects.toBe(prepared);
    const request = rpc.mock.calls[0][1];
    expect(request.p_hand_number).toBe(1000010);
    expect(request.p_participants.map((p: any) => p.user_id)).toEqual(seats.map((p) => p.user_id));
    expect(request.p_participants.filter((p: any) => p.is_horse)).toHaveLength(2);
    for (const seat of seats)
      expect(engine.currentHandSeatGenerations.get(seat.user_id)).toMatchObject({
        funding_manifest_id: manifest,
        occupancy_id: seat.occupancy_id,
        funding_stack_before: 100,
      });
  });
  it.each(['response lost after database commit', 'Original cash manifest identity reused'])(
    'keeps gameplay and uncertified state on %s',
    async (message) => {
      const { engine, seats, prepared } = fixture();
      rpc.mockResolvedValue({ data: null, error: { message } });
      await expect(engine.dealHand(seats)).rejects.toBe(prepared);
      expect(engine.handController).not.toBeNull();
      for (const value of engine.currentHandSeatGenerations.values())
        expect(value).not.toHaveProperty('funding_manifest_id');
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        'Accounting.original_cash_manifest'
      );
    }
  );
  it('consumes the old hand number after a prestart failure and freezes a new roster for the next attempt', async () => {
    const { engine, seats, prepared } = fixture();
    rpc.mockResolvedValue({ data: { version: 1, manifest_id: manifest }, error: null });
    await expect(engine.dealHand(seats)).rejects.toBe(prepared);
    expect(engine.preparedHandNumberValue).toBeNull();
    engine.handController = null;
    engine.seatedPlayers = seats.slice(0, 2);
    await expect(engine.dealHand(engine.seatedPlayers)).rejects.toBe(prepared);
    expect(rpc.mock.calls.map(([, request]) => request.p_hand_number)).toEqual([1000010, 1000011]);
    expect(rpc.mock.calls[1][1].p_participants).toHaveLength(2);
    expect(engine.currentHandSeatGenerations.size).toBe(2);
  });
  it.each(['stop', 'pause'] as const)(
    'does not construct a controller when %s arrives during capture',
    async (action) => {
      const { engine, seats } = fixture();
      rpc.mockImplementation(async () => {
        if (action === 'stop') engine.running = false;
        else engine.adminPause();
        return { data: { version: 1, manifest_id: manifest }, error: null };
      });
      await expect(engine.dealHand(seats)).resolves.toBeUndefined();
      expect(engine.handController).toBeNull();
      expect(engine.fetchTimeBankExtras).not.toHaveBeenCalled();
    }
  );
  it('preserves the existing lease fence when the proof expires during capture', async () => {
    const { engine, seats } = fixture();
    rpc.mockResolvedValue({ data: { version: 1, manifest_id: manifest }, error: null });
    engine.hasCurrentEngineLeaseAuthority.mockReturnValue(false);
    await expect(engine.dealHand(seats)).rejects.toThrow('lease_proof_expired');
    expect(engine.handController).toBeNull();
  });
});
