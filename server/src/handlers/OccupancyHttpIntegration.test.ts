import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
const mock = vi.hoisted(() => ({ from: vi.fn(), receipt: vi.fn(), engine: vi.fn() }));
vi.mock('../services/supabase.js', () => ({ supabase: { from: mock.from } }));
vi.mock('../services/supabase/seats.js', () => ({
  getSeatCashoutReceipt: mock.receipt,
  getAdminSeatCashoutReceipt: vi.fn().mockResolvedValue(null),
}));
vi.mock('../http/auth.js', () => ({
  authenticateRequest: async (req: any) =>
    req.headers.authorization === 'Bearer test-admin'
      ? { userId: 'admin' }
      : req.headers.authorization === 'Bearer test-player'
        ? { userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
        : null,
}));
import { createRouter } from '../router.js';
const tableId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const occupancyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const receipt = {
  ok: true,
  stack: 25,
  credited: true,
  seat_number: 2,
  occupancy_id: occupancyId,
  user_id: userId,
  table_id: tableId,
  tournament_table: false,
  idempotency_key: 'cashout:occupancy:' + occupancyId,
};
let server: Server;
let origin: string;
beforeAll(async () => {
  const router = createRouter({ gameServer: { getTableEngine: mock.engine } } as never);
  server = createServer((req, res) => {
    void router(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server unavailable');
  origin = 'http://127.0.0.1:' + address.port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});
beforeEach(() => {
  vi.clearAllMocks();
  mock.receipt.mockResolvedValue(receipt);
  mock.from.mockImplementation((name: string) => {
    const chain: any = {};
    for (const key of ['select', 'eq']) chain[key] = () => chain;
    chain.maybeSingle = async () => ({
      error: null,
      data: name === 'tables' ? { club_id: 'club', union_id: null } : { role: 'admin' },
    });
    return chain;
  });
});
describe('occupancy contracts over actual HTTP router and JSON bodies', () => {
  it.each([
    ['/leave-occupancy', 'test-player'],
    ['/admin/kick-occupancy', 'test-admin'],
  ])(
    '%s returns the original receipt without consulting a replacement seat',
    async (path, token) => {
      const response = await fetch(origin + path + '?request=original', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ tableId, userId, occupancyId, seatNumber: 2 }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        protocol: 'seat-occupancy-v1',
        cashout: receipt,
      });
      expect(mock.engine).not.toHaveBeenCalled();
      expect(mock.receipt).toHaveBeenCalledWith(userId, tableId, 2, occupancyId);
    }
  );
  it.each([
    ['/leave', 'test-player'],
    ['/admin/kick', 'test-admin'],
  ])('%s refuses the retired contract without cashout or receipt access', async (path, token) => {
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ tableId, userId, occupancyId, seatNumber: 2 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      success: false,
      code: 'SEAT_OCCUPANCY_REQUIRED',
      reloadRequired: true,
    });
    expect(body).not.toHaveProperty('clientCashout');
    expect(mock.engine).not.toHaveBeenCalled();
    expect(mock.receipt).not.toHaveBeenCalled();
  });
  it.each(['/leave-occupancy', '/admin/kick-occupancy', '/leave', '/admin/kick'])(
    '%s refuses unauthenticated replay',
    async (path) => {
      const response = await fetch(origin + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tableId, userId, occupancyId, seatNumber: 2 }),
      });
      expect(response.status).toBe(401);
      expect(mock.receipt).not.toHaveBeenCalled();
    }
  );
});
