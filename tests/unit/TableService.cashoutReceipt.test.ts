import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  leave: vi.fn(),
  emit: vi.fn(),
  activity: vi.fn(),
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock('../../src/services/GameServerAPI', () => ({ notifyServerLeaveOccupancy: mocks.leave }));
vi.mock('../../src/services/EngineStateClient', () => ({ engineChannelClient: {} }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { tableService } from '../../src/services/TableService';
const user = '11111111-1111-4111-8111-111111111111';
const table = '22222222-2222-4222-8222-222222222222';
const occupancy = '33333333-3333-4333-8333-333333333333';
const receipt = {
  ok: true,
  stack: 125,
  credited: true,
  seat_number: 2,
  user_id: user,
  table_id: table,
  occupancy_id: occupancy,
  idempotency_key: 'cashout:occupancy:' + occupancy,
  tournament_table: false,
};
const response = () => ({
  success: true,
  immediate: true,
  protocol: 'seat-occupancy-v1',
  occupancyId: occupancy,
  seatNumber: 2,
  cashout: receipt,
});
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.leave.mockResolvedValue(response());
  mocks.activity.mockResolvedValue({ error: null });
  mocks.from.mockImplementation((name: string) => {
    if (name === 'table_activity') return { insert: mocks.activity };
    expect(name).toBe('table_seats');
    const chain: any = {};
    for (const method of ['select', 'eq', 'is']) chain[method] = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({
      data: { seat_number: 2, occupancy_id: occupancy },
      error: null,
    }));
    return chain;
  });
});
describe('TableService wired to the occupancy receipt contract', () => {
  it.each([
    null,
    {},
    { ...receipt, ok: false },
    { ...receipt, ok: 'true' },
    { ...receipt, stack: 125.001 },
    { ...receipt, stack: '125' },
    { ...receipt, stack: NaN },
    { ...receipt, stack: -1 },
    { ...receipt, seat_number: 3 },
    { ...receipt, idempotency_key: '' },
    { ...receipt, credited: undefined },
    { ...receipt, tournament_table: true },
    { ...receipt, reason: 'no_active_seat' },
  ])('refuses invalid receipt %# before success effects', async (cashout) => {
    mocks.leave.mockResolvedValue({ ...response(), cashout });
    expect((await tableService.leaveTable(table, 2, user)).success).toBe(false);
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.activity).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('uses the committed amount and original database identity despite stale UI seat', async () => {
    expect(await tableService.leaveTable(table, 8, user)).toEqual({
      success: true,
      occupancyId: occupancy,
      chipsReturned: 125,
    });
    expect(mocks.leave).toHaveBeenCalledWith(table, 2, occupancy);
    expect(mocks.activity).toHaveBeenCalledWith(expect.objectContaining({ chips_cashed_out: 125 }));
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('retains confirmed success if activity presentation logging fails', async () => {
    mocks.activity.mockRejectedValue(new Error('activity unavailable'));
    expect(await tableService.leaveTable(table, 2, user)).toEqual({
      success: true,
      occupancyId: occupancy,
      chipsReturned: 125,
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('does not fabricate an immediate cashout for an acknowledged pending leave', async () => {
    mocks.leave.mockResolvedValue({ ...response(), immediate: false, cashout: null });
    expect(await tableService.leaveTable(table, 2, user)).toEqual({
      success: true,
      occupancyId: occupancy,
      chipsReturned: 0,
      deferred: true,
    });
    expect(mocks.activity).toHaveBeenCalledWith(
      expect.objectContaining({
        chips_cashed_out: null,
        metadata: { chips_cashed_out: null, cashout_pending: true },
      })
    );
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('rejects an old engine handoff instead of issuing a direct financial RPC', async () => {
    mocks.leave.mockResolvedValue({ success: true, immediate: true, clientCashout: true });
    expect((await tableService.leaveTable(table, 2, user)).success).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.activity).not.toHaveBeenCalled();
  });
  it('tournament leave records no cash credit', async () => {
    mocks.leave.mockResolvedValue({ ...response(), tournament: true, cashout: null });
    expect(await tableService.leaveTable(table, 2, user)).toEqual({
      success: true,
      occupancyId: occupancy,
      chipsReturned: 0,
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
