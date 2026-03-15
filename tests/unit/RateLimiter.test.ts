/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — RateLimiter
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    const result = limiter.check('BUY_IN', 'user-1', 5, 60000);
    expect(result.allowed).toBe(true);
  });

  it('should track remaining attempts', () => {
    const result = limiter.check('BUY_IN', 'user-1', 5, 60000);
    expect(typeof result.remaining).toBe('number');
  });

  it('should block after exceeding limit', () => {
    for (let i = 0; i < 5; i++) {
      limiter.check('BUY_IN', 'user-flood', 5, 60000);
    }
    const result = limiter.check('BUY_IN', 'user-flood', 5, 60000);
    expect(result.allowed).toBe(false);
  });

  it('should isolate by action+user key', () => {
    for (let i = 0; i < 5; i++) {
      limiter.check('BUY_IN', 'user-a', 5, 60000);
    }
    const resultOtherUser = limiter.check('BUY_IN', 'user-b', 5, 60000);
    expect(resultOtherUser.allowed).toBe(true);
  });
});

describe('RATE_LIMITS', () => {
  it('should define rate limit actions', () => {
    expect(typeof RATE_LIMITS).toBe('object');
    expect(Object.keys(RATE_LIMITS).length).toBeGreaterThan(0);
  });

  it('should have maxPerWindow and windowMs for each action', () => {
    for (const [, config] of Object.entries(RATE_LIMITS)) {
      expect(typeof config.maxPerWindow).toBe('number');
      expect(typeof config.windowMs).toBe('number');
    }
  });
});

describe('rateLimiter singleton', () => {
  it('should export a singleton instance', () => {
    expect(rateLimiter).toBeInstanceOf(RateLimiter);
  });
});
