import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('./client.js', () => ({ supabase: mock }));
vi.mock('../errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('./tables.js', () => ({ tableCountChangedFilter: () => 'current_players.neq.1' }));
import {
  atomicCashout,
  markSeatAsLeft,
  processLeavePending,
  requestSeatDeparture,
  getAdminSeatCashoutReceipt,
} from './seats.js';
const occupancyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const receipt = {
  occupancy_id: occupancyId,
  user_id: 'player',
  table_id: 'table',
  ok: true,
  stack: 12.5,
  credited: true,
  seat_number: 2,
  idempotency_key: 'cashout:occupancy:' + occupancyId,
  tournament_table: false,
};
beforeEach(() => {
  vi.resetAllMocks();
});
function arrange(data: unknown, error: unknown = null) {
  mock.rpc.mockImplementation(async (name: string) =>
    name === 'fn_cashout_seat_occupancy'
      ? { data, error }
      : { data: { ok: false, reason: 'nobody_waiting' }, error: null }
  );
  const chain: any = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    or: vi.fn().mockResolvedValue({ error: null }),
    is: vi.fn().mockResolvedValue({
      data: [{ user_id: 'player', seat_number: 2, occupancy_id: occupancyId }],
      count: 1,
      error: null,
    }),
  };
  mock.from.mockReturnValue(chain);
}
const invalid = [
  { ...receipt, occupancy_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
  { ...receipt, user_id: 'another-player' },
  { ...receipt, table_id: 'another-table' },
  { ok: true, stack: 0, reason: 'no_active_seat' },
  null,
  {},
  { ...receipt, ok: false },
  { ...receipt, stack: null },
  { ...receipt, stack: 'garbage' },
  { ...receipt, stack: -1 },
  { ...receipt, stack: 12.501 },
  { ...receipt, asset: 'diamonds', stack: 12.5 },
  { ...receipt, stack: Infinity },
  { ...receipt, seat_number: 3 },
  { ...receipt, idempotency_key: '' },
  { ...receipt, credited: undefined },
  { ok: true, reason: 'no_active_seat', stack: 7 },
];
describe('callers without failure callbacks', () => {
  it.each(invalid)('rejects unconfirmed response %#', async (data) => {
    arrange(data);
    await expect(atomicCashout('player', 'table', 2, { occupancyId })).rejects.toThrow();
  });
  it.each(['connection lost', 'LEAVE_LOCKED:1234'])(
    'rejects %s without a handler',
    async (message) => {
      arrange(null, { message });
      await expect(atomicCashout('player', 'table', 2, { occupancyId })).rejects.toThrow();
    }
  );
});
describe('cashout departure proof', () => {
  it.each(invalid)('keeps pending player tracking on an unconfirmed receipt %#', async (data) => {
    arrange(data);
    expect(await processLeavePending('table', 'club')).toEqual([]);
    expect(mock.rpc.mock.calls.every(([name]) => name === 'fn_cashout_seat_occupancy')).toBe(true);
  });
  it.each(invalid)('rejects markSeatAsLeft so callers cannot clear tracking %#', async (data) => {
    arrange(data);
    await expect(markSeatAsLeft('table', 'player', 2, occupancyId)).rejects.toThrow();
    expect(mock.rpc).toHaveBeenCalledTimes(1);
  });
  it.each([
    receipt,
    { ...receipt, stack: 0, credited: false },
    { ...receipt, asset: 'diamonds', stack: 300 },
    { ...receipt, asset: 'diamonds', stack: 0, credited: false },
  ])('accepts confirmed departures %#', async (data) => {
    arrange(data);
    expect(await processLeavePending('table', 'club')).toEqual([{ userId: 'player', occupancyId }]);
    await expect(markSeatAsLeft('table', 'player', 2, occupancyId)).resolves.toBeUndefined();
  });
  it('returns the confirmed amount and preserves voluntary mode', async () => {
    arrange(receipt);
    expect(await atomicCashout('player', 'table', 2, { occupancyId, leaveMode: 'voluntary' })).toBe(
      12.5
    );
    expect(mock.rpc).toHaveBeenCalledWith('fn_cashout_seat_occupancy', {
      p_user_id: 'player',
      p_table_id: 'table',
      p_seat_number: 2,
      p_occupancy_id: occupancyId,
      p_leave_mode: 'voluntary',
    });
  });
  it('preserves tracking on transport failure', async () => {
    arrange(null, { message: 'connection lost' });
    expect(await processLeavePending('table', 'club')).toEqual([]);
    await expect(markSeatAsLeft('table', 'player', 2, occupancyId)).rejects.toThrow();
  });
  it('retains the leave clock refusal callback', async () => {
    arrange(null, { message: 'LEAVE_LOCKED:1234' });
    const onLocked = vi.fn();
    expect(await processLeavePending('table', 'club', onLocked)).toEqual([]);
    expect(onLocked).toHaveBeenCalledWith('player', 1234, occupancyId);
    expect(mock.from.mock.results[0].value.update).not.toHaveBeenCalled();
    // A fresh caller, with no old countdown map, must still see the request.
    arrange(receipt);
    expect(await processLeavePending('table', 'club')).toEqual([{ userId: 'player', occupancyId }]);
  });
});

describe('cashout request identity', () => {
  it.each([undefined, '', 'invalid'])(
    'rejects missing or invalid occupancy before transport %#',
    async (occupancyId) => {
      arrange(receipt);
      await expect(atomicCashout('player', 'table', 2, { occupancyId })).rejects.toThrow(
        'original seat occupancy'
      );
      expect(mock.rpc).not.toHaveBeenCalled();
    }
  );
});

describe('durable departure request receipts', () => {
  const accepted = {
    accepted: true,
    user_id: 'player',
    table_id: 'table',
    seat_number: 2,
    occupancy_id: occupancyId,
    leave_mode: 'forced',
    tournament_table: false,
  };
  it.each([
    null,
    {},
    { ...accepted, accepted: false },
    { ...accepted, user_id: 'other' },
    { ...accepted, occupancy_id: 'other' },
    { ...accepted, seat_number: 3 },
    { ...accepted, table_id: 'other' },
    { ...accepted, leave_mode: 'voluntary' },
    { ...accepted, tournament_table: undefined },
  ])('rejects unconfirmed forced authority %#', async (data) => {
    mock.rpc.mockResolvedValue({ data, error: null });
    await expect(requestSeatDeparture('player', 'table', 2, occupancyId, 'forced')).rejects.toThrow(
      'Departure Request Was Not Confirmed'
    );
  });
  it('passes the original scope and requires a confirmed durable request', async () => {
    mock.rpc.mockResolvedValue({ data: accepted, error: null });
    await expect(
      requestSeatDeparture('player', 'table', 2, occupancyId, 'forced')
    ).resolves.toBeUndefined();
    expect(mock.rpc).toHaveBeenCalledWith('fn_request_seat_departure', {
      p_user_id: 'player',
      p_table_id: 'table',
      p_seat_number: 2,
      p_occupancy_id: occupancyId,
      p_leave_mode: 'forced',
    });
  });
  const admin = {
    actorId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    clubId: 'club',
    reason: 'house decision',
  };
  it('uses the admin transaction and verifies retained authority before returning', async () => {
    mock.rpc.mockResolvedValue({
      data: {
        ...accepted,
        admin_authorization: {
          occupancy_id: occupancyId,
          actor_id: admin.actorId,
          club_id: admin.clubId,
          reason: admin.reason,
        },
      },
      error: null,
    });
    await expect(
      requestSeatDeparture('player', 'table', 2, occupancyId, 'forced', admin)
    ).resolves.toBeUndefined();
    expect(mock.rpc).toHaveBeenCalledWith('fn_request_admin_seat_departure', {
      p_user_id: 'player',
      p_table_id: 'table',
      p_seat_number: 2,
      p_occupancy_id: occupancyId,
      p_actor_id: admin.actorId,
      p_club_id: admin.clubId,
      p_reason: admin.reason,
    });
  });
  it.each([
    undefined,
    {},
    { occupancy_id: 'other' },
    {
      occupancy_id: occupancyId,
      actor_id: admin.actorId,
      club_id: 'wrong',
      reason: admin.reason,
    },
  ])('refuses missing or mismatched administrative proof %#', async (admin_authorization) => {
    mock.rpc.mockResolvedValue({ data: { ...accepted, admin_authorization }, error: null });
    await expect(
      requestSeatDeparture('player', 'table', 2, occupancyId, 'forced', admin)
    ).rejects.toThrow('Admin Departure Authority Was Not Confirmed');
  });
  it('propagates database failure instead of acknowledging the request', async () => {
    mock.rpc.mockResolvedValue({ data: null, error: { message: 'transaction rejected' } });
    await expect(
      requestSeatDeparture('player', 'table', 2, occupancyId, 'voluntary')
    ).rejects.toThrow('transaction rejected');
  });
});

describe('original administrative outcome service boundary', () => {
  it('sends verified actor and full original scope to the read-only RPC', async () => {
    mock.rpc.mockResolvedValue({ data: receipt, error: null });
    expect(await getAdminSeatCashoutReceipt('actor', 'player', 'table', 2, occupancyId)).toEqual(
      receipt
    );
    expect(mock.rpc).toHaveBeenCalledWith('fn_get_admin_seat_cashout_receipt', {
      p_actor_id: 'actor',
      p_user_id: 'player',
      p_table_id: 'table',
      p_seat_number: 2,
      p_occupancy_id: occupancyId,
    });
  });
  it('returns null only for a confirmed absent retained outcome', async () => {
    mock.rpc.mockResolvedValue({ data: null, error: null });
    expect(await getAdminSeatCashoutReceipt('actor', 'player', 'table', 2, occupancyId)).toBe(null);
  });
  it.each(invalid.filter((value) => value !== null))(
    'rejects malformed original outcome %#',
    async (data) => {
      mock.rpc.mockResolvedValue({ data, error: null });
      await expect(
        getAdminSeatCashoutReceipt('actor', 'player', 'table', 2, occupancyId)
      ).rejects.toThrow();
    }
  );
  it('propagates lookup failure rather than authorizing a replacement request', async () => {
    mock.rpc.mockResolvedValue({ data: null, error: { message: 'connection lost' } });
    await expect(
      getAdminSeatCashoutReceipt('actor', 'player', 'table', 2, occupancyId)
    ).rejects.toThrow('connection lost');
  });
});
