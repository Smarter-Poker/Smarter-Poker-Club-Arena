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
  it('should serialize plain objects instead of producing [object Object]', () => {
    const supabaseError = { message: 'permission denied', code: '42501', details: null };
    reportError(supabaseError, 'CreditService.getAgentInvoices');

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const capturedError = mockCaptureException.mock.calls[0][0] as Error;
    expect(capturedError).toBeInstanceOf(Error);
    // Must NOT contain "[object Object]"
    expect(capturedError.message).not.toContain('[object Object]');
    // Must contain the JSON-serialized content
    expect(capturedError.message).toContain('permission denied');
    expect(capturedError.message).toContain('42501');
    expect(capturedError.message).toContain('[CreditService.getAgentInvoices]');
  });

  it('should preserve Error instance messages', () => {
    const err = new Error('something broke');
    reportError(err, 'TestContext');

    const capturedError = mockCaptureException.mock.calls[0][0] as Error;
    expect(capturedError.message).toBe('[TestContext] something broke');
  });

  it('should handle string errors', () => {
    reportError('a string error', 'TestContext');

    const capturedError = mockCaptureException.mock.calls[0][0] as Error;
    expect(capturedError.message).toBe('[TestContext] a string error');
  });

  it('should handle null/undefined errors', () => {
    reportError(null, 'TestContext');
    const capturedError = mockCaptureException.mock.calls[0][0] as Error;
    expect(capturedError.message).toBe('[TestContext] null');
  });

  it('should pass extra context to Sentry', () => {
    reportError(new Error('test'), 'Ctx', { agentId: '123' });
    const sentryOpts = mockCaptureException.mock.calls[0][1];
    expect(sentryOpts.errorContext).toEqual({ source: 'Ctx', agentId: '123' });
  });
});

describe('reportWarning', () => {
  it('should add a breadcrumb via Sentry', () => {
    reportWarning('low balance', 'WalletService', { balance: 5 });
    expect(mockAddBreadcrumb).toHaveBeenCalledWith({
      message: '[WalletService] low balance',
      category: 'warning',
      level: 'warning',
      data: { balance: 5 },
    });
  });
});
