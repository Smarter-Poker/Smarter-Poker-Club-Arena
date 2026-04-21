/**
 * Tests for FinancialAlertService — specifically that Supabase PostgrestError
 * objects are converted to proper Error instances before being passed to
 * reportError, preventing "[object Object]" messages in Sentry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the service
vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: vi.fn(),
      select: vi.fn(),
      update: vi.fn(),
    })),
  },
}));

vi.mock('../../core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
  },
}));

vi.mock('../../utils/retryAsync', () => ({
  retryAsync: vi.fn((fn: any) => fn()),
}));

const mockReportError = vi.fn();
vi.mock('../../utils/errorReporter', () => ({
  reportError: (...args: any[]) => mockReportError(...args),
}));

import { supabase } from '../../lib/supabase';
import { FinancialAlertService } from '../FinancialAlertService';

describe('FinancialAlertService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should convert PostgrestError objects to Error instances with .message preserved', async () => {
    // Simulate a Supabase PostgrestError (plain object, not an Error instance)
    const postgrestError = {
      message: 'relation "financial_alerts" does not exist',
      details: 'some details',
      hint: '',
      code: '42P01',
    };

    (supabase.from as any).mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: postgrestError }),
    });

    await FinancialAlertService.logCritical('TestSource', 'Test message', { foo: 'bar' });

    // reportError should have been called with a real Error, not the raw object
    expect(mockReportError).toHaveBeenCalledTimes(1);
    const errorArg = mockReportError.mock.calls[0][0];
    expect(errorArg).toBeInstanceOf(Error);
    expect(errorArg.message).toBe('relation "financial_alerts" does not exist');
    // Should NOT contain "[object Object]"
    expect(errorArg.message).not.toContain('[object Object]');
  });

  it('should not call reportError when insert succeeds', async () => {
    (supabase.from as any).mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: null }),
    });

    await FinancialAlertService.logCritical('TestSource', 'Test message');

    expect(mockReportError).not.toHaveBeenCalled();
  });

  it('should handle PostgrestError with no message by falling back to JSON.stringify', async () => {
    const postgrestError = {
      details: 'some details',
      code: '42P01',
    };

    (supabase.from as any).mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: postgrestError }),
    });

    await FinancialAlertService.logWarning('TestSource', 'Test message');

    expect(mockReportError).toHaveBeenCalledTimes(1);
    const errorArg = mockReportError.mock.calls[0][0];
    expect(errorArg).toBeInstanceOf(Error);
    // Should contain the JSON representation, not "[object Object]"
    expect(errorArg.message).toContain('42P01');
    expect(errorArg.message).not.toContain('[object Object]');
  });
});
