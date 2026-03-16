/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — formatTimeAgo
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatTimeAgo } from '../../src/utils/formatTimeAgo';

describe('formatTimeAgo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Freeze at 2026-03-16T12:00:00Z
    vi.setSystemTime(new Date('2026-03-16T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Full mode (default) ──────────────────────
  it('returns "Active now" for <1 minute ago (full)', () => {
    expect(formatTimeAgo('2026-03-16T11:59:30Z')).toBe('Active now');
  });

  it('returns "5m ago" for 5 minutes ago (full)', () => {
    expect(formatTimeAgo('2026-03-16T11:55:00Z')).toBe('5m ago');
  });

  it('returns "2h ago" for 2 hours ago (full)', () => {
    expect(formatTimeAgo('2026-03-16T10:00:00Z')).toBe('2h ago');
  });

  it('returns "3d ago" for 3 days ago (full)', () => {
    expect(formatTimeAgo('2026-03-13T12:00:00Z')).toBe('3d ago');
  });

  // ── Compact mode ──────────────────────────────
  it('returns "Now" for <1 minute ago (compact)', () => {
    expect(formatTimeAgo('2026-03-16T11:59:30Z', true)).toBe('Now');
  });

  it('returns "5m" for 5 minutes ago (compact)', () => {
    expect(formatTimeAgo('2026-03-16T11:55:00Z', true)).toBe('5m');
  });

  it('returns "2h" for 2 hours ago (compact)', () => {
    expect(formatTimeAgo('2026-03-16T10:00:00Z', true)).toBe('2h');
  });

  it('returns "3d" for 3 days ago (compact)', () => {
    expect(formatTimeAgo('2026-03-13T12:00:00Z', true)).toBe('3d');
  });

  // ── Edge cases ────────────────────────────────
  it('handles exactly 60 minutes as "1h ago"', () => {
    expect(formatTimeAgo('2026-03-16T11:00:00Z')).toBe('1h ago');
  });

  it('handles exactly 24 hours as "1d ago"', () => {
    expect(formatTimeAgo('2026-03-15T12:00:00Z')).toBe('1d ago');
  });

  it('handles 0 seconds difference as "Active now"', () => {
    expect(formatTimeAgo('2026-03-16T12:00:00Z')).toBe('Active now');
  });
});
