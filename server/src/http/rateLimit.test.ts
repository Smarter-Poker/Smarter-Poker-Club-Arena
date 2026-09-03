/**
 * Dan 2026-08-19, bug list item 13: "'Server error (429)' popup must never
 * happen on a live game."
 *
 * The engine's window was keyed by userId alone, so every table a player sat
 * at shared one 250ms budget. Multi-tabling is ordinary play, and it was
 * rate-limiting players against their own other tables - the second action was
 * REJECTED, not queued. These tests pin the per-table keying and the anti-spam
 * property it must not lose.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { checkRateLimit, __resetRateLimiterForTests } from './rateLimit.js';

describe('checkRateLimit', () => {
  beforeEach(() => {
    __resetRateLimiterForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('still blocks rapid-fire actions at the SAME table', () => {
    expect(checkRateLimit('u1', 't1')).toBe(true);
    expect(checkRateLimit('u1', 't1')).toBe(false);
    vi.advanceTimersByTime(100);
    expect(checkRateLimit('u1', 't1')).toBe(false);
  });

  it('lets the same player act again once the window passes', () => {
    expect(checkRateLimit('u1', 't1')).toBe(true);
    vi.advanceTimersByTime(250);
    expect(checkRateLimit('u1', 't1')).toBe(true);
  });

  it('NEVER throttles one player across two different tables', () => {
    // The regression. Folding at t1 and calling at t2 in the same instant is
    // normal multi-table play and must both go through.
    expect(checkRateLimit('u1', 't1')).toBe(true);
    expect(checkRateLimit('u1', 't2')).toBe(true);
    expect(checkRateLimit('u1', 't3')).toBe(true);
    expect(checkRateLimit('u1', 't4')).toBe(true);
  });

  it('keeps players independent at the same table', () => {
    expect(checkRateLimit('u1', 't1')).toBe(true);
    expect(checkRateLimit('u2', 't1')).toBe(true);
  });

  it('falls back to per-user keying when no table is supplied', () => {
    expect(checkRateLimit('u1')).toBe(true);
    expect(checkRateLimit('u1')).toBe(false);
  });
});
