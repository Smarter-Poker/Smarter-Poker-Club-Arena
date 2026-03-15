/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — safeServiceCall
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { safeServiceCall, safeServiceCallSync } from '../../src/utils/safeServiceCall';

describe('safeServiceCall', () => {
  it('should return data for resolved promise', async () => {
    const result = await safeServiceCall(() => Promise.resolve(42));
    expect(result.data).toBe(42);
    expect(result.error).toBeNull();
  });

  it('should return error for rejected promise', async () => {
    const result = await safeServiceCall(() => Promise.reject(new Error('fail')));
    expect(result.data).toBeNull();
    expect(result.error).toBe('fail');
  });

  it('should capture the error message', async () => {
    const result = await safeServiceCall(() => Promise.reject(new Error('custom message')));
    expect(result.error).toBe('custom message');
  });

  it('should return typed data', async () => {
    const result = await safeServiceCall(() => Promise.resolve({ name: 'test' }));
    expect(result.data?.name).toBe('test');
    expect(result.error).toBeNull();
  });
});

describe('safeServiceCallSync', () => {
  it('should return data for synchronous value', () => {
    const result = safeServiceCallSync(() => 'hello');
    expect(result.data).toBe('hello');
    expect(result.error).toBeNull();
  });

  it('should return error for thrown exception', () => {
    const result = safeServiceCallSync(() => {
      throw new Error('boom');
    });
    expect(result.data).toBeNull();
    expect(result.error).toBe('boom');
  });
});
