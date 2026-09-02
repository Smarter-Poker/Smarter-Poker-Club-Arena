import { beforeEach, describe, expect, it, vi } from 'vitest';

const insert = vi.fn().mockResolvedValue({ error: null });
vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: vi.fn(() => ({ insert })) },
}));

import {
  cashierReasonCode,
  recordCashierOperation,
  shouldRecordCashierOperation,
} from '../../src/services/CashierOperationsTelemetry';

describe('CashierOperationsTelemetry', () => {
  beforeEach(() => insert.mockClear());

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

  it('writes a bounded failure row without amounts, targets, notes, or messages', async () => {
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
    await vi.waitFor(() => expect(insert).toHaveBeenCalledOnce());
    expect(insert).toHaveBeenCalledWith({
      user_id: 'user-1',
      club_id: 'club-1',
      event: 'batch_partial',
      operation: 'send',
      duration_ms: 300_000,
      item_count: 30,
      page_number: null,
      success_count: 29,
      failure_count: 1,
      reason_code: 'pgrst_204',
      sample_weight: 1,
    });
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
    expect(insert).not.toHaveBeenCalled();
  });
});
