import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ from: vi.fn(), leave: vi.fn(), kick: vi.fn(), read: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: mocks.from } }));
vi.mock('../../src/services/GameServerAPI', () => ({
  notifyServerLeaveOccupancy: mocks.leave,
  notifyServerKickOccupancy: mocks.kick,
}));
import { leaveSeatWithIntent, kickSeatWithIntent } from '../../src/services/SeatLeaveIntent';
const user = '11111111-1111-4111-8111-111111111111';
const table = '22222222-2222-4222-8222-222222222222';
const occupancy = '33333333-3333-4333-8333-333333333333';
const replacement = '44444444-4444-4444-8444-444444444444';
const key = 'ca:seat-leave:v1:' + user + ':' + table;
const receipt = () => ({
  ok: true,
  user_id: user,
  table_id: table,
  occupancy_id: occupancy,
  seat_number: 2,
  idempotency_key: 'cashout:occupancy:' + occupancy,
  tournament_table: false,
  credited: true,
  stack: 125,
});
const response = () => ({
  success: true,
  protocol: 'seat-occupancy-v1',
  occupancyId: occupancy,
  seatNumber: 2,
  immediate: true,
  cashout: receipt(),
});
beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  localStorage.clear();
  mocks.read.mockResolvedValue({ data: { seat_number: 2, occupancy_id: occupancy }, error: null });
  mocks.from.mockImplementation(() => {
    const chain: any = {};
    for (const method of ['select', 'eq', 'is']) chain[method] = vi.fn(() => chain);
    chain.maybeSingle = mocks.read;
    return chain;
  });
  mocks.leave.mockResolvedValue(response());
  mocks.kick.mockResolvedValue(response());
});
describe('original seat departure identity', () => {
  it('persists the target before requesting and reports the committed amount', async () => {
    mocks.leave.mockImplementation(async () => {
      expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({
        occupancyId: occupancy,
        state: 'pending',
      });
      return response();
    });
    expect(await leaveSeatWithIntent(table, user)).toEqual({ success: true, chipsReturned: 125 });
  });
  it('retries a lost response against the original occupancy despite a new seat', async () => {
    mocks.leave.mockResolvedValueOnce({ success: false, error: 'response lost' });
    expect((await leaveSeatWithIntent(table, user)).success).toBe(false);
    mocks.read.mockResolvedValue({
      data: { seat_number: 4, occupancy_id: replacement },
      error: null,
    });
    expect((await leaveSeatWithIntent(table, user)).chipsReturned).toBe(125);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.leave).toHaveBeenLastCalledWith(table, 2, occupancy);
  });
  it('reuses a persisted pending target after module reload', async () => {
    localStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        userId: user,
        tableId: table,
        seatNumber: 2,
        occupancyId: occupancy,
        state: 'pending',
      })
    );
    expect((await leaveSeatWithIntent(table, user)).success).toBe(true);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it.each([
    { ...response(), protocol: undefined },
    { ...response(), occupancyId: replacement },
    { ...response(), cashout: { ...receipt(), reason: 'no_active_seat' } },
    { ...response(), cashout: { ...receipt(), stack: 0.001 } },
    { ...response(), cashout: { ...receipt(), user_id: replacement } },
    { ...response(), cashout: null },
  ])('refuses unverifiable outcome %# and retains original intent', async (value) => {
    mocks.leave.mockResolvedValue(value);
    expect((await leaveSeatWithIntent(table, user)).success).toBe(false);
    expect(JSON.parse(localStorage.getItem(key)!).state).toBe('pending');
  });
  it('does not send when storage fails before the request', async () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage failed');
    });
    expect((await leaveSeatWithIntent(table, user)).success).toBe(false);
    expect(mocks.leave).not.toHaveBeenCalled();
  });
  it('returns deferred success without inventing a cashout amount', async () => {
    mocks.leave.mockResolvedValue({ ...response(), immediate: false, cashout: null });
    expect(await leaveSeatWithIntent(table, user)).toEqual({
      success: true,
      chipsReturned: 0,
      deferred: true,
    });
  });
  it('does not fabricate success for a missing seat without an original request', async () => {
    mocks.read.mockResolvedValue({ data: null, error: null });
    expect((await leaveSeatWithIntent(table, user)).success).toBe(false);
    expect(mocks.leave).not.toHaveBeenCalled();
  });
  it('coalesces concurrent requests into one request', async () => {
    const outcomes = await Promise.all([
      leaveSeatWithIntent(table, user),
      leaveSeatWithIntent(table, user),
    ]);
    expect(outcomes.every((x) => x.success)).toBe(true);
    expect(mocks.leave).toHaveBeenCalledTimes(1);
  });
});

describe('captured bulk removal identity', () => {
  const target = { seatNumber: 2, occupancyId: occupancy };
  it('sends the captured target without looking up a replacement', async () => {
    expect((await kickSeatWithIntent(table, user, 'house decision', target)).success).toBe(true);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.kick).toHaveBeenCalledWith(table, user, 2, occupancy, 'house decision');
  });
  it('refuses a replacement while an earlier removal remains unconfirmed', async () => {
    mocks.kick.mockResolvedValueOnce({ success: false, error: 'response lost' });
    await kickSeatWithIntent(table, user, 'first', target);
    expect(
      (await kickSeatWithIntent(table, user, 'next', { seatNumber: 4, occupancyId: replacement }))
        .success
    ).toBe(false);
    expect(mocks.kick).toHaveBeenCalledTimes(1);
    expect((await kickSeatWithIntent(table, user, 'retry', target)).success).toBe(true);
    expect(mocks.kick).toHaveBeenLastCalledWith(table, user, 2, occupancy, 'first');
  });
  it('rejects an invalid captured identity before transport', async () => {
    expect(
      (await kickSeatWithIntent(table, user, 'reason', { seatNumber: NaN, occupancyId: 'bad' }))
        .success
    ).toBe(false);
    expect(mocks.kick).not.toHaveBeenCalled();
  });
  it('does not count an unrelated running request as this selected removal', async () => {
    let finish!: (value: ReturnType<typeof response>) => void;
    mocks.kick.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const first = kickSeatWithIntent(table, user, 'reason', target);
    await vi.waitFor(() => expect(mocks.kick).toHaveBeenCalledTimes(1));
    expect(
      (await kickSeatWithIntent(table, user, 'reason', { seatNumber: 4, occupancyId: replacement }))
        .success
    ).toBe(false);
    finish(response());
    expect((await first).success).toBe(true);
  });
});
