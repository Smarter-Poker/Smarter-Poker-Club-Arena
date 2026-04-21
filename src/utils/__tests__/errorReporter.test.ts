import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock SentryInit before importing the module under test
const mockCaptureException = vi.fn();
const mockAddBreadcrumb = vi.fn();
vi.mock('../../core/SentryInit', () => ({
  captureException: mockCaptureException,
  addBreadcrumb: mockAddBreadcrumb,
}));

import { reportError, reportWarning } from '../errorReporter';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reportError', () => {
  it('wraps a plain Error and prefixes context', () => {
    const err = new Error('something broke');
    reportError(err, 'TestCtx');

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toBe('[TestCtx] something broke');
  });

  it('wraps a string error', () => {
    reportError('oops', 'TestCtx');

    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toBe('[TestCtx] oops');
  });

  it('extracts .message from Supabase-style PostgrestError objects instead of [object Object]', () => {
    // This is the exact shape of a Supabase PostgrestError
    const postgrestError = {
      message: 'relation "financial_alerts" does not exist',
      details: null,
      hint: null,
      code: '42P01',
    };

    reportError(postgrestError, 'FinancialAlertService._log.insert');

    const captured = mockCaptureException.mock.calls[0][0] as Error;
    // Must NOT contain "[object Object]"
    expect(captured.message).not.toContain('[object Object]');
    expect(captured.message).toBe(
      '[FinancialAlertService._log.insert] relation "financial_alerts" does not exist'
    );
  });

  it('JSON-stringifies objects without a .message property', () => {
    const weirdError = { code: 500, detail: 'unknown' };
    reportError(weirdError, 'Ctx');

    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).not.toContain('[object Object]');
    expect(captured.message).toContain('500');
    expect(captured.message).toContain('unknown');
  });

  it('handles null and undefined gracefully', () => {
    reportError(null, 'Ctx');
    const captured1 = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured1.message).toBe('[Ctx] null');

    reportError(undefined, 'Ctx');
    const captured2 = mockCaptureException.mock.calls[1][0] as Error;
    expect(captured2.message).toBe('[Ctx] undefined');
  });
});

describe('reportWarning', () => {
  it('adds a breadcrumb with context prefix', () => {
    reportWarning('heads up', 'WarnCtx', { extra: 1 });

    expect(mockAddBreadcrumb).toHaveBeenCalledWith({
      message: '[WarnCtx] heads up',
      category: 'warning',
      level: 'warning',
      data: { extra: 1 },
    });
  });
});
