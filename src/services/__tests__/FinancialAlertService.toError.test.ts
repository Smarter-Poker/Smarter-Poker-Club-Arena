/**
 * Regression test for JAVASCRIPT-REACT-AE:
 * Supabase PostgrestError objects (plain objects with .message) were being
 * converted to "[object Object]" when passed to reportError.
 * The toError helper now extracts .message properly.
 */

// We test the toError behavior indirectly by verifying reportError receives
// a proper Error with the original message, not "[object Object]".

import { reportError } from '../../utils/errorReporter';

// Mock Sentry so we don't need real Sentry in tests
jest.mock('../../core/SentryInit', () => ({
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

import { captureException } from '../../core/SentryInit';

describe('FinancialAlertService toError conversion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should preserve message from plain Supabase error objects', () => {
    // Simulate a Supabase PostgrestError (plain object, not an Error instance)
    const supabaseError = {
      message: 'relation "financial_alerts" does not exist',
      code: '42P01',
      details: null,
      hint: null,
    };

    reportError(supabaseError, 'TestContext');

    expect(captureException).toHaveBeenCalledTimes(1);
    const capturedErr = (captureException as jest.Mock).mock.calls[0][0];
    expect(capturedErr).toBeInstanceOf(Error);
    // The message should contain the original Supabase error message, NOT "[object Object]"
    expect(capturedErr.message).toContain('relation "financial_alerts" does not exist');
    expect(capturedErr.message).not.toContain('[object Object]');
  });

  it('should pass through actual Error instances unchanged', () => {
    const realError = new Error('something broke');
    reportError(realError, 'TestContext');

    const capturedErr = (captureException as jest.Mock).mock.calls[0][0];
    expect(capturedErr).toBeInstanceOf(Error);
    expect(capturedErr.message).toContain('something broke');
  });

  it('should convert string errors properly', () => {
    reportError('a string error', 'TestContext');

    const capturedErr = (captureException as jest.Mock).mock.calls[0][0];
    expect(capturedErr).toBeInstanceOf(Error);
    expect(capturedErr.message).toContain('a string error');
  });
});
