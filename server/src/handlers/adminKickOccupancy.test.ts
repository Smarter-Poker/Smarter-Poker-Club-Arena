import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ from: vi.fn(), insert: vi.fn() }));
vi.mock('../http/auth.js', () => ({ authenticateRequest: vi.fn() }));
vi.mock('../http/body.js', () => ({ readBody: vi.fn() }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../services/supabase.js', () => ({ supabase: { from: mocks.from } }));
vi.mock('../services/supabase/seats.js', () => ({ getSeatCashoutReceipt: vi.fn() }));
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { getSeatCashoutReceipt } from '../services/supabase/seats.js';
import { handleAdminKickOccupancy } from './admin.js';
import { mockReq, mockRes, parseJson } from './_testHelpers.js';
const tableId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const occupancyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const input = { tableId, userId, occupancyId, seatNumber: 2, reason: 'house decision' };
const receipt = {
  ok: true as const,
  stack: 25,
  credited: true,
  seat_number: 2,
  occupancy_id: occupancyId,
  user_id: userId,
  table_id: tableId,
  tournament_table: false,
  idempotency_key: 'cashout:occupancy:' + occupancyId,
};
const leaveTable = vi.fn();
const getTableEngine = vi.fn();
let role = 'admin';
beforeEach(() => {
  vi.resetAllMocks();
  role = 'admin';
  vi.mocked(authenticateRequest).mockResolvedValue({ userId: 'admin' });
  vi.mocked(readBody).mockResolvedValue(JSON.stringify(input));
  vi.mocked(getSeatCashoutReceipt).mockResolvedValue(null);
  leaveTable.mockResolvedValue({ success: true, immediate: false });
  getTableEngine.mockReturnValue({ leaveTable });
  mocks.insert.mockResolvedValue({ error: null });
  mocks.from.mockImplementation((table: string) => {
    if (table === 'anti_cheat_events') return { insert: mocks.insert };
    const chain: any = {};
    for (const name of ['select', 'eq']) chain[name] = vi.fn(() => chain);
    chain.maybeSingle = async () => ({
      error: null,
      data: table === 'tables' ? { club_id: 'club', union_id: null } : { role },
    });
    return chain;
  });
});
async function request() {
  const { res, captured } = mockRes();
  await handleAdminKickOccupancy(mockReq(), res, { gameServer: { getTableEngine } });
  return { status: captured.statusCode, body: parseJson(captured) };
}
describe('occupancy-bound administrative removal', () => {
  it('requires authentication before reading an old financial receipt', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue(null);
    expect((await request()).status).toBe(401);
    expect(getSeatCashoutReceipt).not.toHaveBeenCalled();
    expect(leaveTable).not.toHaveBeenCalled();
  });
  it('requires admin authority even when an original receipt exists', async () => {
    role = 'player';
    vi.mocked(getSeatCashoutReceipt).mockResolvedValue(receipt);
    expect((await request()).status).toBe(403);
    expect(getSeatCashoutReceipt).not.toHaveBeenCalled();
  });
  it('returns the original cashout without touching a replacement engine seat', async () => {
    vi.mocked(getSeatCashoutReceipt).mockResolvedValue(receipt);
    expect(await request()).toMatchObject({
      status: 200,
      body: { success: true, cashout: receipt, occupancyId },
    });
    expect(getTableEngine).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it('passes forced authority and the captured target only after authorization', async () => {
    expect((await request()).body).toMatchObject({
      success: true,
      immediate: false,
      cashout: null,
      occupancyId,
    });
    expect(leaveTable).toHaveBeenCalledWith(userId, {
      forced: true,
      occupancyId,
      seatNumber: 2,
      admin: { actorId: 'admin', clubId: 'club', reason: 'house decision' },
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it('takes administrative identity from authorization, never the request body', async () => {
    vi.mocked(readBody).mockResolvedValue(
      JSON.stringify({
        ...input,
        actorId: userId,
        clubId: 'forged',
        admin: { actorId: userId },
      })
    );
    await request();
    expect(leaveTable).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        admin: { actorId: 'admin', clubId: 'club', reason: 'house decision' },
      })
    );
  });
  it.each([{}, '', ' '.repeat(3), 'x'.repeat(2001)])(
    'rejects invalid reason %# before an engine mutation',
    async (reason) => {
      vi.mocked(readBody).mockResolvedValue(JSON.stringify({ ...input, reason }));
      expect((await request()).status).toBe(400);
      expect(leaveTable).not.toHaveBeenCalled();
    }
  );
  it('does not report or audit a refused kick as successful', async () => {
    leaveTable.mockResolvedValue({ success: false, immediate: false, error: 'All In' });
    expect((await request()).body).toMatchObject({ success: false });
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it('requires a receipt for an immediate cash departure', async () => {
    leaveTable.mockResolvedValue({ success: true, immediate: true });
    expect((await request()).status).toBe(503);
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it('returns the receipt after the transaction commits', async () => {
    leaveTable.mockResolvedValue({ success: true, immediate: true });
    vi.mocked(getSeatCashoutReceipt).mockResolvedValueOnce(null).mockResolvedValueOnce(receipt);
    expect((await request()).body).toMatchObject({ cashout: receipt });
  });
  it.each([null, [], {}, { ...input, occupancyId: undefined }, { ...input, seatNumber: 1.5 }])(
    'rejects invalid identity %# before dispatch',
    async (body) => {
      vi.mocked(readBody).mockResolvedValue(JSON.stringify(body));
      expect((await request()).status).toBe(400);
      expect(leaveTable).not.toHaveBeenCalled();
    }
  );
});
