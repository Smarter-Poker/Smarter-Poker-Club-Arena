import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  leave: vi.fn(),
  emit: vi.fn(),
  activity: vi.fn(),
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock('../../src/services/GameServerAPI', () => ({ notifyServerLeave: mocks.leave }));
vi.mock('../../src/services/EngineStateClient', () => ({ engineChannelClient: {} }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { tableService } from '../../src/services/TableService';
const receipt = {
  ok: true,
  stack: 125,
  credited: true,
  seat_number: 2,
  idempotency_key: 'cashout:occupancy',
  tournament_table: false,
};
let seats: unknown[];
beforeEach(() => {
  vi.clearAllMocks();
  seats = [{ seat_number: 2, stack: 100, status: 'seated' }];
  mocks.leave.mockResolvedValue({ success: true, immediate: true, clientCashout: true });
  mocks.rpc.mockResolvedValue({ data: receipt, error: null });
  mocks.from.mockImplementation((table: string) => {
    const chain: any = {};
    for (const method of ['select', 'eq', 'is', 'order', 'update'])
      chain[method] = vi.fn(() => chain);
    chain.insert = vi.fn((data: unknown) => {
      mocks.activity(data);
      return chain;
    });
    const result = () => ({
      data: table === 'table_seats' ? seats : { club_id: 'club', tournament_id: null },
      error: null,
    });
    chain.maybeSingle = vi.fn(async () => result());
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
    return chain;
  });
});
describe('browser departure requires the canonical cashout receipt', () => {
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
  ])('refuses malformed or mismatched receipt %# before success effects', async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    expect((await tableService.leaveTable('table', 2, 'player')).success).toBe(false);
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.activity).not.toHaveBeenCalled();
  });
  it('reports and records the committed amount, not the stale pre-cashout stack', async () => {
    expect(await tableService.leaveTable('table', 2, 'player')).toEqual({
      success: true,
      chipsReturned: 125,
    });
    expect(mocks.activity).toHaveBeenCalledWith(expect.objectContaining({ chips_cashed_out: 125 }));
  });
  it('accepts a confirmed absent seat without inventing a cashout amount', async () => {
    mocks.rpc.mockResolvedValue({
      data: { ok: true, stack: 0, reason: 'no_active_seat' },
      error: null,
    });
    expect(await tableService.leaveTable('table', 2, 'player')).toEqual({
      success: true,
      chipsReturned: 0,
    });
  });
  it('acknowledges an engine-confirmed departure when the engine already removed the seat', async () => {
    mocks.leave.mockResolvedValue({ success: true, immediate: true });
    seats = [];
    expect(await tableService.leaveTable('table', 2, 'player')).toEqual({
      success: true,
      chipsReturned: 0,
      deferred: true,
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('does not report a tournament sit-out as a cashout', async () => {
    mocks.from.mockImplementation((table: string) => {
      const chain: any = {};
      for (const method of ['select', 'eq', 'is', 'order', 'update'])
        chain[method] = vi.fn(() => chain);
      chain.insert = vi.fn((data: unknown) => {
        mocks.activity(data);
        return chain;
      });
      const result = () => ({
        data: table === 'table_seats' ? seats : { club_id: 'club', tournament_id: 'event' },
        error: null,
        count: 1,
      });
      chain.maybeSingle = vi.fn(async () => result());
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
      return chain;
    });
    expect(await tableService.leaveTable('table', 2, 'player')).toEqual({
      success: true,
      chipsReturned: 0,
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.activity).toHaveBeenCalledWith(expect.objectContaining({ chips_cashed_out: 0 }));
  });
});

it('records an engine-owned cashout as pending without inventing the final amount', async () => {
  mocks.leave.mockResolvedValue({ success: true, immediate: true });
  expect(await tableService.leaveTable('table', 2, 'player')).toEqual({
    success: true,
    chipsReturned: 0,
    deferred: true,
  });
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.activity).toHaveBeenCalledWith(
    expect.objectContaining({
      chips_cashed_out: null,
      metadata: { chips_cashed_out: null, cashout_pending: true },
    })
  );
});
