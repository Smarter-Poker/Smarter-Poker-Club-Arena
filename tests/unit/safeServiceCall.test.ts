/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — safeServiceCall
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { safeServiceCall, safeServiceCallSync } from '../../src/utils/safeServiceCall';

describe('safeServiceCall', () => {
  it('should return success for resolved promise', async () => {
    const result = await safeServiceCall(() => Promise.resolve(42));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe(42);
  });

  it('should return error for rejected promise', async () => {
    const result = await safeServiceCall(() => Promise.reject(new Error('fail')));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeDefined();
  });

  it('should capture the error message', async () => {
    const result = await safeServiceCall(() => Promise.reject(new Error('custom message')));
    expect(result.ok).toBe(false);
  });

  it('should return typed data', async () => {
    const result = await safeServiceCall(() => Promise.resolve({ name: 'test' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.name).toBe('test');
  });
});

describe('safeServiceCallSync', () => {
  it('should return success for synchronous value', () => {
    const result = safeServiceCallSync(() => 'hello');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe('hello');
  });

  it('should return error for thrown exception', () => {
    const result = safeServiceCallSync(() => {
      throw new Error('boom');
    });
    expect(result.ok).toBe(false);
  });
});
