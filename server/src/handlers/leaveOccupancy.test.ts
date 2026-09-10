import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../http/auth.js', () => ({ authenticateRequest: vi.fn() }));
vi.mock('../http/body.js', () => ({ readBody: vi.fn() }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../services/supabase/seats.js', () => ({ getSeatCashoutReceipt: vi.fn() }));
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { getSeatCashoutReceipt } from '../services/supabase/seats.js';
import { handleLeaveOccupancy } from './leaveOccupancy.js';
import { mockReq, mockRes, parseJson } from './_testHelpers.js';
const tableId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const occupancyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const input = { tableId, occupancyId, seatNumber: 2 };
const receipt = {
  ok: true as const,
  stack: 25,
  credited: true,
  seat_number: 2,
  occupancy_id: occupancyId,
  user_id: 'owner',
  table_id: tableId,
  tournament_table: false,
  idempotency_key: 'cashout:occupancy:' + occupancyId,
};
const leaveTable = vi.fn();
const getTableEngine = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(authenticateRequest).mockResolvedValue({ userId: 'owner' });
  vi.mocked(readBody).mockResolvedValue(JSON.stringify(input));
  vi.mocked(getSeatCashoutReceipt).mockResolvedValue(null);
  leaveTable.mockResolvedValue({ success: true, immediate: false });
  getTableEngine.mockReturnValue({ leaveTable });
});
async function request() {
  const { res, captured } = mockRes();
  await handleLeaveOccupancy(mockReq(), res, { gameServer: { getTableEngine } });
  return { status: captured.statusCode, body: parseJson(captured) };
}
describe('occupancy leave protocol', () => {
  it('requires authentication before looking up receipts or seats', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue(null);
    expect((await request()).status).toBe(401);
    expect(getSeatCashoutReceipt).not.toHaveBeenCalled();
    expect(getTableEngine).not.toHaveBeenCalled();
  });
  it.each([
    null,
    [],
    {},
    { ...input, occupancyId: undefined },
    { ...input, seatNumber: 1.5 },
    { ...input, tableId: 'invalid' },
  ])('rejects invalid scope before dispatch %#', async (body) => {
    vi.mocked(readBody).mockResolvedValue(JSON.stringify(body));
    expect((await request()).status).toBe(400);
    expect(getSeatCashoutReceipt).not.toHaveBeenCalled();
    expect(leaveTable).not.toHaveBeenCalled();
  });
  it('returns the original receipt before consulting a replacement engine seat', async () => {
    vi.mocked(getSeatCashoutReceipt).mockResolvedValue(receipt);
    expect(await request()).toMatchObject({
      status: 200,
      body: { protocol: 'seat-occupancy-v1', occupancyId, cashout: receipt },
    });
    expect(getTableEngine).not.toHaveBeenCalled();
  });
  it('does not authorize browser cashout when no engine exists', async () => {
    getTableEngine.mockReturnValue(null);
    expect(await request()).toMatchObject({ status: 503, body: { success: false } });
    expect(leaveTable).not.toHaveBeenCalled();
  });
  it('passes authenticated ownership and captured identity, never caller-supplied authority', async () => {
    vi.mocked(readBody).mockResolvedValue(
      JSON.stringify({ ...input, userId: 'victim', forced: true })
    );
    expect(await request()).toMatchObject({
      status: 200,
      body: { immediate: false, cashout: null },
    });
    expect(leaveTable).toHaveBeenCalledWith('owner', { occupancyId, seatNumber: 2 });
    expect(getSeatCashoutReceipt).toHaveBeenCalledWith('owner', tableId, 2, occupancyId);
  });
  it('requires a durable receipt for an immediate cash departure', async () => {
    leaveTable.mockResolvedValue({ success: true, immediate: true });
    expect(await request()).toMatchObject({ status: 503, body: { success: false } });
  });
  it('returns the receipt after the engine commits', async () => {
    leaveTable.mockResolvedValue({ success: true, immediate: true });
    vi.mocked(getSeatCashoutReceipt).mockResolvedValueOnce(null).mockResolvedValueOnce(receipt);
    expect(await request()).toMatchObject({ status: 200, body: { cashout: receipt } });
  });
  it('does not invent a cash payout for a tournament sit-out', async () => {
    leaveTable.mockResolvedValue({ success: true, immediate: true, tournament: true });
    expect(await request()).toMatchObject({
      status: 200,
      body: { tournament: true, cashout: null },
    });
    expect(getSeatCashoutReceipt).toHaveBeenCalledTimes(1);
  });
  it('refuses to mutate when the receipt lookup is unavailable', async () => {
    vi.mocked(getSeatCashoutReceipt).mockRejectedValue(new Error('connection lost'));
    expect((await request()).status).toBe(503);
    expect(leaveTable).not.toHaveBeenCalled();
  });
  it('preserves a stale-occupancy refusal', async () => {
    leaveTable.mockResolvedValue({ success: false, immediate: false, code: 'STALE_OCCUPANCY' });
    expect(await request()).toMatchObject({
      status: 409,
      body: { success: false, code: 'STALE_OCCUPANCY' },
    });
  });
});
