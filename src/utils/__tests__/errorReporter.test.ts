import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock SentryInit before importing the module under test
const mockCaptureException = vi.fn();
const mockAddBreadcrumb = vi.fn();
vi.mock('../../core/SentryInit', () => ({
  captureException: (...args: any[]) => mockCaptureException(...args),
  addBreadcrumb: (...args: any[]) => mockAddBreadcrumb(...args),
}));

import { reportError, reportWarning } from '../errorReporter';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reportError', () => {
  it('handles Error instances correctly', () => {
    const err = new Error('something broke');
    reportError(err, 'TestContext');

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toBe('[TestContext] something broke');
  });

  it('handles string errors correctly', () => {
    reportError('string error', 'TestContext');

    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toBe('[TestContext] string error');
  });

  it('handles plain objects (e.g. Supabase errors) without producing [object Object]', () => {
    // Supabase PostgrestError shape
    const supabaseError = {
      message: 'permission denied for table credit_invoices',
      code: '42501',
      details: null,
      hint: null,
    };
    reportError(supabaseError, 'CreditService.getAgentInvoices');

    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).not.toContain('[object Object]');
    expect(captured.message).toContain('permission denied for table credit_invoices');
    expect(captured.message).toContain('[CreditService.getAgentInvoices]');
  });

  it('handles plain objects without a message property via JSON.stringify', () => {
    const weirdError = { code: 'UNKNOWN', detail: 'no message field' };
    reportError(weirdError, 'SomeService');

    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).not.toContain('[object Object]');
    expect(captured.message).toContain('UNKNOWN');
    expect(captured.message).toContain('no message field');
  });

  it('handles null and undefined gracefully', () => {
    reportError(null, 'NullCtx');
    const captured1 = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured1.message).toBe('[NullCtx] null');

    reportError(undefined, 'UndefCtx');
    const captured2 = mockCaptureException.mock.calls[1][0] as Error;
    expect(captured2.message).toBe('[UndefCtx] undefined');
  });

  it('handles numeric errors', () => {
    reportError(42, 'NumCtx');
    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toBe('[NumCtx] 42');
  });
});

describe('reportWarning', () => {
  it('adds a breadcrumb via Sentry', () => {
    reportWarning('low balance', 'WalletCheck', { balance: 5 });
    expect(mockAddBreadcrumb).toHaveBeenCalledTimes(1);
    expect(mockAddBreadcrumb.mock.calls[0][0].message).toContain('low balance');
  });
});
