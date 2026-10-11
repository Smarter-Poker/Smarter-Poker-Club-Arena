import { afterEach, expect, it, vi } from 'vitest';
import { supabase } from './supabase/client.js';
import { readPendingOperatorCashClose } from './operatorCashClose.js';
const TABLE = '11111111-1111-4111-8111-111111111111';
afterEach(() => vi.restoreAllMocks());
it.each([
  null,
  [],
  {},
  { hold: null },
  { hold: null, close: {} },
  { hold: null, close: { table_id: TABLE, status: 'closed', operation_id: TABLE } },
  { hold: null, close: { table_id: 'other', status: 'pending', operation_id: TABLE } },
  { hold: null, close: { table_id: TABLE, status: 'pending', operation_id: 'bad' } },
])('refuses malformed or incorrectly bound closure authority %j', async (data) => {
  vi.spyOn(supabase, 'rpc').mockResolvedValue({ data, error: null } as any);
  await expect(readPendingOperatorCashClose(TABLE)).rejects.toThrow(
    'operator_cash_close_authority_unknown'
  );
});
it('does not accept a transport error with a valid-looking close', async () => {
  vi.spyOn(supabase, 'rpc').mockResolvedValue({
    data: { hold: null, close: { table_id: TABLE, status: 'pending', operation_id: TABLE } },
    error: { message: 'offline' },
  } as any);
  await expect(readPendingOperatorCashClose(TABLE)).rejects.toThrow(
    'operator_cash_close_authority_unknown'
  );
});
it('distinguishes a confirmed absent close from a bound pending close', async () => {
  vi.spyOn(supabase, 'rpc')
    .mockResolvedValueOnce({ data: { hold: null, close: null }, error: null } as any)
    .mockResolvedValueOnce({
      data: { hold: null, close: { table_id: TABLE, status: 'pending', operation_id: TABLE } },
      error: null,
    } as any);
  await expect(readPendingOperatorCashClose(TABLE)).resolves.toBeNull();
  await expect(readPendingOperatorCashClose(TABLE)).resolves.toBe(TABLE);
});
