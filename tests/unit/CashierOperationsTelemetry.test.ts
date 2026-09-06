import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn().mockResolvedValue({ error: null }) }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc },
}));

import {
  cashierReasonCode,
  recordCashierOperation,
  shouldRecordCashierOperation,
} from '../../src/services/CashierOperationsTelemetry';

describe('CashierOperationsTelemetry', () => {
  beforeEach(() => rpc.mockClear());

  it('retains every failure and samples routine successes', () => {
    expect(shouldRecordCashierOperation('batch_failed', 0.999)).toBe(true);
    expect(shouldRecordCashierOperation('batch_partial', 0.999)).toBe(true);
    expect(shouldRecordCashierOperation('roster_page_failed', 0.999)).toBe(true);
    expect(shouldRecordCashierOperation('batch_succeeded', 0.099)).toBe(true);
    expect(shouldRecordCashierOperation('batch_succeeded', 0.1)).toBe(false);
  });

  it('uses bounded error categories and never stores a free-form message', () => {
    expect(cashierReasonCode({ code: 'PGRST-204', message: 'private recipient data' })).toBe(
      'pgrst-204'
    );
    expect(cashierReasonCode({ name: 'Network Error', message: 'private recipient data' })).toBe(
      'network_error'
    );
    expect(cashierReasonCode(new Error('private recipient data'))).toBe('error');
  });

  it('calls the server-owned RPC with bounded fields and no caller-selected identity', async () => {
    recordCashierOperation({
      userId: 'user-1',
      clubId: 'club-1',
      event: 'batch_partial',
      operation: 'send',
      durationMs: 999_999,
      itemCount: 30,
      successCount: 29,
      failureCount: 1,
      reasonCode: 'PGRST 204',
    });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce());
    expect(rpc).toHaveBeenCalledWith('fn_record_cashier_operation', {
      p_club_id: 'club-1',
      p_event: 'batch_partial',
      p_operation: 'send',
      p_duration_ms: 300_000,
      p_item_count: 30,
      p_page_number: null,
      p_success_count: 29,
      p_failure_count: 1,
      p_reason_code: 'pgrst_204',
    });
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('user_id');
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('sample_weight');
  });

  it('does not attempt a write without both signed-in user and club scope', () => {
    recordCashierOperation({
      userId: null,
      clubId: 'club-1',
      event: 'batch_failed',
      operation: 'send',
    });
    recordCashierOperation({
      userId: 'user-1',
      clubId: null,
      event: 'batch_failed',
      operation: 'send',
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});
