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
  mockCaptureException.mockClear();
  mockAddBreadcrumb.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('reportError', () => {
  it('formats Error instances correctly', () => {
    const err = new Error('something broke');
    reportError(err, 'TestContext');
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toBe('[TestContext] something broke');
  });

  it('formats string errors correctly', () => {
    reportError('string error', 'TestContext');
    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toBe('[TestContext] string error');
  });

  it('formats plain objects (e.g. Supabase errors) with .message property', () => {
    const supabaseError = { message: 'permission denied for table credit_invoices', code: '42501', details: null, hint: null };
    reportError(supabaseError, 'CreditService.getAgentInvoices');
    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toBe('[CreditService.getAgentInvoices] permission denied for table credit_invoices');
    // Must NOT contain [object Object]
    expect(captured.message).not.toContain('[object Object]');
  });

  it('formats plain objects without .message via JSON.stringify', () => {
    const weirdError = { code: 500, detail: 'something' };
    reportError(weirdError, 'SomeService');
    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toContain('SomeService');
    expect(captured.message).toContain('500');
    expect(captured.message).not.toContain('[object Object]');
  });

  it('handles null and undefined gracefully', () => {
    reportError(null, 'NullCtx');
    const captured1 = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured1.message).toBe('[NullCtx] null');

    reportError(undefined, 'UndefCtx');
    const captured2 = mockCaptureException.mock.calls[1][0] as Error;
    expect(captured2.message).toBe('[UndefCtx] undefined');
  });
});
