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
  it('handles Error instances and preserves message', () => {
    const err = new Error('something broke');
    reportError(err, 'TestContext');

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toBe('[TestContext] something broke');
  });

  it('handles plain objects with a message property (e.g. Supabase PostgrestError)', () => {
    const supabaseError = {
      message: 'new row violates row-level security policy',
      details: null,
      hint: null,
      code: '42501',
    };
    reportError(supabaseError, 'AchievementService.incrementProgress.insert');

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toBe(
      '[AchievementService.incrementProgress.insert] new row violates row-level security policy'
    );
    // Must NOT contain "[object Object]"
    expect(captured.message).not.toContain('[object Object]');
  });

  it('handles plain objects without a message property via JSON.stringify', () => {
    const weirdError = { code: 500, detail: 'unknown' };
    reportError(weirdError, 'SomeContext');

    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toContain('SomeContext');
    expect(captured.message).toContain('500');
    expect(captured.message).not.toContain('[object Object]');
  });

  it('handles string errors', () => {
    reportError('simple string error', 'Ctx');

    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toBe('[Ctx] simple string error');
  });

  it('handles null and undefined', () => {
    reportError(null, 'NullCtx');
    const captured1 = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured1.message).toBe('[NullCtx] null');

    reportError(undefined, 'UndefCtx');
    const captured2 = mockCaptureException.mock.calls[1][0] as Error;
    expect(captured2.message).toBe('[UndefCtx] undefined');
  });
});
