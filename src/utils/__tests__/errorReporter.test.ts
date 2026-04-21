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
  it('should serialize plain objects with a message property (e.g. Supabase PostgrestError)', () => {
    const supabaseError = {
      message: 'new row violates row-level security policy',
      details: null,
      hint: null,
      code: '42501',
    };

    reportError(supabaseError, 'AchievementService.incrementProgress.insert', {
      userId: 'test-user',
    });

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const capturedError = mockCaptureException.mock.calls[0][0] as Error;
    expect(capturedError).toBeInstanceOf(Error);
    expect(capturedError.message).toContain('new row violates row-level security policy');
    expect(capturedError.message).toContain('AchievementService.incrementProgress.insert');
    // Must NOT contain [object Object]
    expect(capturedError.message).not.toContain('[object Object]');
  });

  it('should handle plain objects without a message property', () => {
    const weirdError = { code: 500, detail: 'something broke' };

    reportError(weirdError, 'SomeService.method');

    const capturedError = mockCaptureException.mock.calls[0][0] as Error;
    expect(capturedError.message).toContain('something broke');
    expect(capturedError.message).not.toContain('[object Object]');
  });

  it('should pass through Error instances preserving the original message', () => {
    const realError = new Error('connection timeout');

    reportError(realError, 'NetworkService.fetch');

    const capturedError = mockCaptureException.mock.calls[0][0] as Error;
    expect(capturedError).toBe(realError);
    expect(capturedError.message).toBe('[NetworkService.fetch] connection timeout');
  });

  it('should handle string errors', () => {
    reportError('simple string error', 'TestContext');

    const capturedError = mockCaptureException.mock.calls[0][0] as Error;
    expect(capturedError.message).toBe('[TestContext] simple string error');
  });

  it('should handle null and undefined errors', () => {
    reportError(null, 'TestContext.null');
    const err1 = mockCaptureException.mock.calls[0][0] as Error;
    expect(err1.message).toBe('[TestContext.null] null');

    reportError(undefined, 'TestContext.undefined');
    const err2 = mockCaptureException.mock.calls[1][0] as Error;
    expect(err2.message).toBe('[TestContext.undefined] undefined');
  });
});
