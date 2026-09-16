import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeError, reportError, reportWarning } from './errorReporter.js';
afterEach(() => vi.restoreAllMocks());
describe('local engine diagnostics', () => {
  it('records the original error and operational context without mutating it', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = Object.freeze(new Error('database unavailable'));
    const data = { tableId: 'fixture-table' };
    reportError(error, 'Table.settle', data);
    expect(spy).toHaveBeenCalledWith('[Table.settle]', error, data);
    expect(error.message).toBe('database unavailable');
  });
  it('keeps failed console writes inside the reporting boundary', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('EPIPE');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('EAGAIN');
    });
    expect(() => reportError(new Error('original failure'), 'Table.read')).not.toThrow();
    expect(() => reportWarning('retry refused', 'Table.read')).not.toThrow();
  });
  it('keeps warning context and structured financial error descriptions', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reportWarning('lease unavailable', 'Table.claim', { reason: 'conflict' });
    expect(spy).toHaveBeenCalledWith('[Table.claim] lease unavailable', { reason: 'conflict' });
    expect(describeError({ message: 'permission denied', code: '42501' })).toBe(
      'permission denied (42501)'
    );
  });
});
