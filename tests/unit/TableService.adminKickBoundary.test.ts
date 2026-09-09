import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  emit: vi.fn(),
  kick: vi.fn(),
  seat: vi.fn(),
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock('../../src/services/GameServerAPI', () => ({
  notifyServerKickOccupancy: mocks.kick,
  notifyServerLeaveOccupancy: vi.fn(),
}));
vi.mock('../../src/services/EngineStateClient', () => ({ engineChannelClient: {} }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { tableService } from '../../src/services/TableService';
const table = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const player = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const occupancy = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const receipt = {
  ok: true,
  stack: 25,
  credited: true,
  seat_number: 2,
  occupancy_id: occupancy,
  user_id: player,
  table_id: table,
  tournament_table: false,
  idempotency_key: 'cashout:occupancy:' + occupancy,
};
const accepted = {
  success: true,
  immediate: true,
  protocol: 'seat-occupancy-v1',
  occupancyId: occupancy,
  seatNumber: 2,
  cashout: receipt,
};
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  mocks.kick.mockResolvedValue(accepted);
  mocks.seat.mockResolvedValue({ data: { seat_number: 2, occupancy_id: occupancy }, error: null });
  mocks.from.mockImplementation(() => {
    const chain: any = {};
    for (const key of ['select', 'eq', 'is']) chain[key] = vi.fn(() => chain);
    chain.maybeSingle = mocks.seat;
    return chain;
  });
});
describe('TableService administrative occupancy contract', () => {
  it('uses the captured occupancy and never calls the direct financial RPC', async () => {
    expect(await tableService.kickPlayer(table, player, 'house decision')).toBe(true);
    expect(mocks.kick).toHaveBeenCalledWith(table, player, 2, occupancy, 'house decision');
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from.mock.calls.every(([name]) => name === 'table_seats')).toBe(true);
  });
  it.each([{}, null, { success: false, error: 'All In' }, { success: 'true' }])(
    'refuses unconfirmed removal %#',
    async (response) => {
      mocks.kick.mockResolvedValue(response);
      await expect(tableService.kickPlayer(table, player)).rejects.toThrow();
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.emit).not.toHaveBeenCalled();
    }
  );
  it('does not fall back to SQL on a lost response', async () => {
    mocks.kick.mockRejectedValue(new Error('response lost'));
    await expect(tableService.kickPlayer(table, player)).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('retries the original occupancy and original reason after a lost response', async () => {
    mocks.kick.mockResolvedValueOnce({ success: false, error: 'response lost' });
    await expect(tableService.kickPlayer(table, player, 'original decision')).rejects.toThrow();
    mocks.seat.mockResolvedValue({
      data: { seat_number: 4, occupancy_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
      error: null,
    });
    expect(await tableService.kickPlayer(table, player, 'new text')).toBe(true);
    expect(mocks.seat).toHaveBeenCalledTimes(1);
    expect(mocks.kick).toHaveBeenLastCalledWith(table, player, 2, occupancy, 'original decision');
  });
});
