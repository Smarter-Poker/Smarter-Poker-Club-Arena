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
  it('handles a real Error instance', () => {
    const err = new Error('something broke');
    reportError(err, 'TestContext');

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toBe('[TestContext] something broke');
  });

  it('handles a string error', () => {
    reportError('string error', 'TestContext');

    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toBe('[TestContext] string error');
  });

  it('handles a Supabase-style PostgrestError object with .message (not an Error instance)', () => {
    // This is the exact shape that caused the [object Object] bug
    const supabaseError = {
      message: 'relation "financial_alerts" does not exist',
      details: 'some details',
      hint: '',
      code: '42P01',
    };

    reportError(supabaseError, 'FinancialAlertService._log.insert');

    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toBe(
      '[FinancialAlertService._log.insert] relation "financial_alerts" does not exist'
    );
    // Must NOT contain "[object Object]"
    expect(captured.message).not.toContain('[object Object]');
  });

  it('handles a plain object without .message by JSON-stringifying', () => {
    const obj = { code: 42, detail: 'no message field' };
    reportError(obj, 'Ctx');

    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).not.toContain('[object Object]');
    expect(captured.message).toContain('42');
  });

  it('handles null and undefined gracefully', () => {
    reportError(null, 'Ctx');
    expect(mockCaptureException.mock.calls[0][0].message).toBe('[Ctx] null');

    reportError(undefined, 'Ctx');
    expect(mockCaptureException.mock.calls[1][0].message).toBe('[Ctx] undefined');
  });
});

describe('reportWarning', () => {
  it('adds a breadcrumb via Sentry', () => {
    reportWarning('test warning', 'Ctx', { foo: 'bar' });
    expect(mockAddBreadcrumb).toHaveBeenCalledTimes(1);
    expect(mockAddBreadcrumb.mock.calls[0][0].message).toBe('[Ctx] test warning');
  });
});
