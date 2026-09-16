/**
 * reportError COPIES the error it reports; it never rewrites the caller's.
 *
 * Found 2026-09-09 (must-move audit, lane I) through the cash create flow,
 * which reports an unknown failure and then shows the host the server's own
 * sentence (tests/a-control-that-says-none-must-mean-none.law.test.ts). The
 * reporter's own comment said "the caller's error object is left alone", and
 * the code beneath it did `err.message = '[context] ' + err.message` for
 * every error that would let it - copying only the DOMException that would
 * not. So the host's toast read "[CashGameCreateFlow.create_failed] Failed to
 * fetch". the local console still gets the prefixed copy; the caller's object does not
 * change.
 */
import { describe, expect, it, vi } from 'vitest';

import { reportError } from '../../src/utils/errorReporter';

describe('reportError leaves the caller error alone', () => {
  it('a plain Error keeps its message; the local console gets the prefixed copy with the same name', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new TypeError('Failed to fetch');
    reportError(err, 'CashGameCreateFlow.create_failed');
    expect(err.message).toBe('Failed to fetch');
    expect(spy.mock.calls.at(-1)?.[1]).toMatchObject({
      message: '[CashGameCreateFlow.create_failed] Failed to fetch',
      name: 'TypeError',
    });
    spy.mockRestore();
  });

  it('a DOMException (read-only message) is reported the same way and never throws out of the reporter', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dom = new DOMException('The operation is insecure.', 'SecurityError');
    expect(() => reportError(dom, 'Somewhere')).not.toThrow();
    expect(dom.message).toBe('The operation is insecure.');
    expect(spy.mock.calls.at(-1)?.[1]).toMatchObject({
      message: '[Somewhere] The operation is insecure.',
      name: 'SecurityError',
    });
    spy.mockRestore();
  });

  it('a Supabase-shaped plain object is coerced without touching the object', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const obj = { message: 'permission denied for table cash_games', code: '42501' };
    reportError(obj, 'Flow');
    expect(obj.message).toBe('permission denied for table cash_games');
    expect((spy.mock.calls.at(-1)?.[1] as Error)?.message).toBe(
      '[Flow] permission denied for table cash_games'
    );
    spy.mockRestore();
  });
});
