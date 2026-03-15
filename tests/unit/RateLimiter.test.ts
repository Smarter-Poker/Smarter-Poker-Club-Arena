/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — RateLimiter
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RateLimiter, RATE_LIMITS, rateLimiter } from '../../src/utils/RateLimiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new RateLimiter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow first request', () => {
    const result = limiter.check('user-1', 'api_call' as any);
    expect(result.allowed).toBe(true);
  });

  it('should track remaining attempts', () => {
    const result = limiter.check('user-1', 'api_call' as any);
    expect(typeof result.remaining).toBe('number');
  });

  it('should block after exceeding limit', () => {
    const action = Object.keys(RATE_LIMITS)[0] as any;
    const limit = RATE_LIMITS[action as keyof typeof RATE_LIMITS];
    for (let i = 0; i < (limit?.maxAttempts ?? 10); i++) {
      limiter.check('user-flood', action);
    }
    const result = limiter.check('user-flood', action);
    expect(result.allowed).toBe(false);
  });
});

describe('RATE_LIMITS', () => {
  it('should define rate limit actions', () => {
    expect(typeof RATE_LIMITS).toBe('object');
    expect(Object.keys(RATE_LIMITS).length).toBeGreaterThan(0);
  });

  it('should have maxAttempts and windowMs for each action', () => {
    for (const [, config] of Object.entries(RATE_LIMITS)) {
      expect(typeof config.maxAttempts).toBe('number');
      expect(typeof config.windowMs).toBe('number');
    }
  });
});

describe('rateLimiter singleton', () => {
  it('should export a singleton instance', () => {
    expect(rateLimiter).toBeInstanceOf(RateLimiter);
  });
});

import { afterEach } from 'vitest';
