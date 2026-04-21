import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock SentryInit before importing the module under test
vi.mock('../../core/SentryInit', () => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

import { reportError, reportWarning } from '../errorReporter';
import { captureException } from '../../core/SentryInit';

describe('reportError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('should include Error.message in Sentry report', () => {
    const err = new Error('something broke');
    reportError(err, 'TestContext');

    expect(captureException).toHaveBeenCalledTimes(1);
    const captured = (captureException as any).mock.calls[0][0] as Error;
    expect(captured.message).toBe('[TestContext] something broke');
  });

  it('should serialize plain objects with a message property (e.g. Supabase PostgrestError)', () => {
    const supabaseError = { message: 'permission denied for table credit_invoices', code: '42501', details: null, hint: null };
    reportError(supabaseError, 'CreditService.getAgentInvoices');

    expect(captureException).toHaveBeenCalledTimes(1);
    const captured = (captureException as any).mock.calls[0][0] as Error;
    expect(captured.message).toBe('[CreditService.getAgentInvoices] permission denied for table credit_invoices');
    // Must NOT contain "[object Object]"
    expect(captured.message).not.toContain('[object Object]');
  });

  it('should serialize plain objects without a message property via JSON.stringify', () => {
    const weirdError = { code: 500, detail: 'unknown' };
    reportError(weirdError, 'SomeService');

    expect(captureException).toHaveBeenCalledTimes(1);
    const captured = (captureException as any).mock.calls[0][0] as Error;
    expect(captured.message).toContain('SomeService');
    expect(captured.message).toContain('500');
    expect(captured.message).not.toContain('[object Object]');
  });

  it('should handle string errors', () => {
    reportError('raw string error', 'StringCtx');

    const captured = (captureException as any).mock.calls[0][0] as Error;
    expect(captured.message).toBe('[StringCtx] raw string error');
  });

  it('should handle null/undefined errors', () => {
    reportError(null, 'NullCtx');
    const captured = (captureException as any).mock.calls[0][0] as Error;
    expect(captured.message).toBe('[NullCtx] null');
  });
});
