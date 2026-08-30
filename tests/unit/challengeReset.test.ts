import { describe, expect, it } from 'vitest';
import {
  formatChallengeCountdown,
  getChallengeResetAt,
  getUtcDateKey,
  msUntilChallengeReset,
} from '../../src/utils/challengeReset';

describe('challenge reset clock', () => {
  const sundayNight = Date.parse('2026-08-30T23:59:30.000Z');

  it('uses exact UTC period boundaries', () => {
    expect(getChallengeResetAt('daily', sundayNight).toISOString()).toBe(
      '2026-08-31T00:00:00.000Z'
    );
    expect(getChallengeResetAt('weekly', sundayNight).toISOString()).toBe(
      '2026-08-31T00:00:00.000Z'
    );
    expect(getChallengeResetAt('monthly', sundayNight).toISOString()).toBe(
      '2026-09-01T00:00:00.000Z'
    );
  });

  it('counts down with seconds inside the final hour', () => {
    expect(msUntilChallengeReset('daily', sundayNight)).toBe(30_000);
    expect(formatChallengeCountdown(30_000)).toBe('0m 30s');
    expect(formatChallengeCountdown(3_630_000)).toBe('1h 0m');
    expect(formatChallengeCountdown(90_000_000)).toBe('1d 1h');
    expect(formatChallengeCountdown(0)).toBe('Resetting');
  });

  it('derives rollover keys from the supplied clock', () => {
    expect(getUtcDateKey(sundayNight)).toBe('2026-08-30');
    expect(getUtcDateKey(sundayNight + 30_000)).toBe('2026-08-31');
  });
});
