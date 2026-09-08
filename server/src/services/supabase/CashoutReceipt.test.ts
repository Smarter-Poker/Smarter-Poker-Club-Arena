import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('./client.js', () => ({ supabase: mock }));
vi.mock('../errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('./tables.js', () => ({ tableCountChangedFilter: () => 'current_players.neq.1' }));
import { atomicCashout, markSeatAsLeft, processLeavePending } from './seats.js';
const receipt = {
  ok: true,
  stack: 12.5,
  credited: true,
  seat_number: 2,
  idempotency_key: 'cashout:occupancy',
  tournament_table: false,
};
beforeEach(() => {
  vi.resetAllMocks();
});
function arrange(data: unknown, error: unknown = null) {
  mock.rpc.mockImplementation(async (name: string) =>
    name === 'atomic_seat_cashout_locked'
      ? { data, error }
      : { data: { ok: false, reason: 'nobody_waiting' }, error: null }
  );
  const chain: any = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    or: vi.fn().mockResolvedValue({ error: null }),
    is: vi
      .fn()
      .mockResolvedValue({ data: [{ user_id: 'player', seat_number: 2 }], count: 1, error: null }),
  };
  mock.from.mockReturnValue(chain);
}
const invalid = [
  null,
  {},
  { ...receipt, ok: false },
  { ...receipt, stack: null },
  { ...receipt, stack: 'garbage' },
  { ...receipt, stack: -1 },
  { ...receipt, stack: 12.501 },
  { ...receipt, stack: Infinity },
  { ...receipt, seat_number: 3 },
  { ...receipt, idempotency_key: '' },
  { ...receipt, credited: undefined },
  { ok: true, reason: 'no_active_seat', stack: 7 },
];
describe('callers without failure callbacks', () => {
  it.each(invalid)('rejects unconfirmed response %#', async (data) => {
    arrange(data);
    await expect(atomicCashout('player', 'table', 2)).rejects.toThrow();
  });
  it.each(['connection lost', 'LEAVE_LOCKED:1234'])(
    'rejects %s without a handler',
    async (message) => {
      arrange(null, { message });
      await expect(atomicCashout('player', 'table', 2)).rejects.toThrow();
    }
  );
});
describe('cashout departure proof', () => {
  it.each(invalid)('keeps pending player tracking on an unconfirmed receipt %#', async (data) => {
    arrange(data);
    expect(await processLeavePending('table', 'club')).toEqual([]);
    expect(mock.rpc.mock.calls.every(([name]) => name === 'atomic_seat_cashout_locked')).toBe(true);
  });
  it.each(invalid)('rejects markSeatAsLeft so callers cannot clear tracking %#', async (data) => {
    arrange(data);
    await expect(markSeatAsLeft('table', 'player', 2)).rejects.toThrow();
    expect(mock.rpc).toHaveBeenCalledTimes(1);
  });
  it.each([
    receipt,
    { ...receipt, stack: 0, credited: false },
    { ok: true, stack: 0, reason: 'no_active_seat' },
  ])('accepts confirmed departures %#', async (data) => {
    arrange(data);
    expect(await processLeavePending('table', 'club')).toEqual(['player']);
    await expect(markSeatAsLeft('table', 'player', 2)).resolves.toBeUndefined();
  });
  it('returns the confirmed amount and preserves voluntary mode', async () => {
    arrange(receipt);
    expect(await atomicCashout('player', 'table', 2, { leaveMode: 'voluntary' })).toBe(12.5);
    expect(mock.rpc).toHaveBeenCalledWith('atomic_seat_cashout_locked', {
      p_user_id: 'player',
      p_table_id: 'table',
      p_seat_number: 2,
      p_leave_mode: 'voluntary',
    });
  });
  it('preserves tracking on transport failure', async () => {
    arrange(null, { message: 'connection lost' });
    expect(await processLeavePending('table', 'club')).toEqual([]);
    await expect(markSeatAsLeft('table', 'player', 2)).rejects.toThrow();
  });
  it('retains the leave clock refusal callback', async () => {
    arrange(null, { message: 'LEAVE_LOCKED:1234' });
    const onLocked = vi.fn();
    expect(await processLeavePending('table', 'club', onLocked)).toEqual([]);
    expect(onLocked).toHaveBeenCalledWith('player', 1234);
  });
});
