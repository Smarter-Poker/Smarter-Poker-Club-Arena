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
  it('handles Error instances correctly', () => {
    const err = new Error('test failure');
    reportError(err, 'TestContext');

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toBe('[TestContext] test failure');
  });

  it('handles string errors correctly', () => {
    reportError('string error', 'TestContext');

    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toBe('[TestContext] string error');
  });

  it('handles plain objects (e.g. Supabase PostgrestError) with message property', () => {
    const supabaseError = {
      message: 'new row violates row-level security policy',
      details: null,
      hint: null,
      code: '42501',
    };
    reportError(supabaseError, 'AchievementService.incrementProgress.insert');

    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toBe(
      '[AchievementService.incrementProgress.insert] new row violates row-level security policy'
    );
    // Must NOT contain "[object Object]"
    expect(captured.message).not.toContain('[object Object]');
  });

  it('handles plain objects without message property via JSON.stringify', () => {
    const weirdError = { code: 500, detail: 'something broke' };
    reportError(weirdError, 'SomeContext');

    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toContain('SomeContext');
    expect(captured.message).toContain('something broke');
    expect(captured.message).not.toContain('[object Object]');
  });

  it('handles null and undefined gracefully', () => {
    reportError(null, 'NullContext');
    const captured1 = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured1.message).toBe('[NullContext] null');

    reportError(undefined, 'UndefContext');
    const captured2 = mockCaptureException.mock.calls[1][0] as Error;
    expect(captured2.message).toBe('[UndefContext] undefined');
  });

  it('passes extra context to Sentry', () => {
    reportError('err', 'Ctx', { userId: '123' });

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        errorContext: { source: 'Ctx', userId: '123' },
      })
    );
  });
});

describe('reportWarning', () => {
  it('adds a breadcrumb via Sentry', () => {
    reportWarning('low chips', 'WalletService', { balance: 0 });

    expect(mockAddBreadcrumb).toHaveBeenCalledWith({
      message: '[WalletService] low chips',
      category: 'warning',
      level: 'warning',
      data: { balance: 0 },
    });
  });
});
