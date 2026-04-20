import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock SentryInit before importing reportError
const mockCaptureException = vi.fn();
const mockAddBreadcrumb = vi.fn();
vi.mock('../../core/SentryInit', () => ({
  captureException: mockCaptureException,
  addBreadcrumb: mockAddBreadcrumb,
}));

import { reportError } from '../errorReporter';

describe('reportError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('handles Error instances correctly', () => {
    const err = new Error('test failure');
    reportError(err, 'TestContext');
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toBe('[TestContext] test failure');
  });

  it('handles plain objects with message property (e.g. Supabase errors)', () => {
    const supabaseError = {
      message: 'new row violates row-level security policy',
      code: '42501',
      details: null,
      hint: null,
    };
    reportError(supabaseError, 'AchievementService.incrementProgress.insert');
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toContain('new row violates row-level security policy');
    expect(captured.message).not.toContain('[object Object]');
  });

  it('handles plain objects without message but with code', () => {
    const errObj = { code: 'PGRST301', details: 'some detail' };
    reportError(errObj, 'SomeContext');
    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toContain('PGRST301');
    expect(captured.message).not.toContain('[object Object]');
  });

  it('handles plain objects with no message or code via JSON.stringify', () => {
    const errObj = { foo: 'bar', num: 42 };
    reportError(errObj, 'SomeContext');
    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toContain('"foo":"bar"');
    expect(captured.message).not.toContain('[object Object]');
  });

