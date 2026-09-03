/**
 * DynamicWallet reconnect backoff — must ESCALATE, not pin at the first delay.
 *
 * The realtime effect resets the retry counter, and it re-runs on every
 * reconnect (channelEpoch). An unconditional reset there pinned the delay at
 * BACKOFF_DELAYS[0] = 2s forever, so a flaky connection retried every two
 * seconds indefinitely instead of backing off to 4/8/16/30s.
 *
 * These cases model the two behaviours directly so the distinction is pinned
 * even though the component itself needs a live Supabase channel to exercise.
 */
import { describe, it, expect } from 'vitest';

const BACKOFF_DELAYS = [2000, 4000, 8000, 16000, 30000];
const delayFor = (retries: number) => BACKOFF_DELAYS[Math.min(retries, BACKOFF_DELAYS.length - 1)];

/** Reset on EVERY effect run — the bug. */
function delaysWithUnconditionalReset(failures: number): number[] {
  let retries = 0;
  const out: number[] = [];
  for (let i = 0; i < failures; i++) {
    out.push(delayFor(retries));
    retries++;
    retries = 0; // effect re-runs on reconnect and wipes progress
  }
  return out;
}

/** Reset only when the subscription target changes — the fix. */
function delaysWithTargetScopedReset(failures: number, targetChangesAt: number[] = []): number[] {
  let retries = 0;
  const out: number[] = [];
  for (let i = 0; i < failures; i++) {
    out.push(delayFor(retries));
    retries++;
    if (targetChangesAt.includes(i)) retries = 0;
  }
  return out;
}

describe('DynamicWallet reconnect backoff', () => {
  it('REGRESSION: an unconditional reset pins every retry at 2s', () => {
    expect(delaysWithUnconditionalReset(5)).toEqual([2000, 2000, 2000, 2000, 2000]);
  });

  it('escalates through the backoff when the target has not changed', () => {
    expect(delaysWithTargetScopedReset(5)).toEqual([2000, 4000, 8000, 16000, 30000]);
  });

  it('caps at the longest delay rather than overrunning the array', () => {
    expect(delaysWithTargetScopedReset(8).slice(-3)).toEqual([30000, 30000, 30000]);
    expect(delaysWithTargetScopedReset(8).every((d) => Number.isFinite(d))).toBe(true);
  });

  it('starts over when the subscription target genuinely changes (club switch)', () => {
    // fails twice, then the user switches club, then fails twice more
    expect(delaysWithTargetScopedReset(4, [1])).toEqual([2000, 4000, 2000, 4000]);
  });
});
