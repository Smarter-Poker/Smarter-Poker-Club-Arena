/**
 * The starvation alarm's decision, proved against the episodes that actually
 * happened rather than against invented ones.
 *
 * Source of every fixture below: `ca_engine_deploy_attempts` on production,
 * queried 2026-09-12. The ledger begins 2026-09-01 14:58Z and held 94 episodes
 * of consecutive non-shipping attempts; 28 had >= 3 attempts, 15 spanned
 * >= 120 minutes, and 15 met both.
 */
import { describe, expect, it } from 'vitest';
import {
  assess,
  ATTEMPTS_THRESHOLD,
  SPAN_MINUTES_THRESHOLD,
} from '../../.github/scripts/check-engine-deploy-starvation.mjs';

const NOW = Date.parse('2026-09-12T05:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

/** Build `n` unshipped attempts evenly spread over `spanMinutes`. */
const episode = (n: number, spanMinutes: number, reason: string) =>
  Array.from({ length: n }, (_, i) => ({
    at: minutesAgo(spanMinutes - (i * spanMinutes) / Math.max(n - 1, 1)),
    target_sha: `${i}`.padStart(40, 'a'),
    reason,
  }));

const STOOD_DOWN = 'stood down before cutover; protected main had moved to 96c00643d';
const CUTOVER_FAILED =
  'the release sealed but production identity could not be independently proved';

describe('the engine deploy starvation alarm', () => {
  it('fires on the 2026-09-12 episode and names the pipeline, not the code', () => {
    // 00:21:37Z -> 05:00:04Z, 15 attempts, every one a stand-down.
    const verdict = assess({
      rows: episode(15, 278.4, STOOD_DOWN),
      lastShipped: '2026-09-11T23:57:54Z',
      now: NOW,
    });
    expect(verdict.starving).toBe(true);
    expect(verdict.attempts).toBe(15);
    expect(verdict.spanMinutes).toBeGreaterThanOrEqual(SPAN_MINUTES_THRESHOLD);
    expect(verdict.supersededCount).toBe(15);
    expect(verdict.verdict).toContain('THE PIPELINE IS THE PROBLEM, NOT THE CODE');
  });

  it('fires on the worst recorded episode', () => {
    // 2026-09-09 18:07:44Z -> 21:43:31Z, 30 attempts over 215.8 minutes, and
    // the 739.4-minute one on 2026-09-02. Both are incidents by any reading.
    expect(
      assess({ rows: episode(30, 215.8, STOOD_DOWN), lastShipped: null, now: NOW }).starving
    ).toBe(true);
    expect(
      assess({ rows: episode(9, 739.4, CUTOVER_FAILED), lastShipped: null, now: NOW }).starving
    ).toBe(true);
  });

  it('stays silent on a normal merge burst', () => {
    // 2026-09-11 22:40:46Z -> 23:31:35Z: 6 attempts in 50.8 minutes, then it
    // shipped. Supersession doing its job is not an incident, and paging on it
    // is how an alarm gets muted.
    const verdict = assess({ rows: episode(6, 50.8, STOOD_DOWN), lastShipped: null, now: NOW });
    expect(verdict.starving).toBe(false);
    expect(verdict.verdict).toContain('Within the accepted envelope');
  });

  it('stays silent when it self-resolved inside two breaks', () => {
    // 2026-09-10 01:06:57Z -> 02:16:35Z: 9 attempts, 69.6 minutes.
    expect(
      assess({ rows: episode(9, 69.6, STOOD_DOWN), lastShipped: null, now: NOW }).starving
    ).toBe(false);
  });

  it('stays silent on a quiet period with one stale attempt', () => {
    // Time alone must not page: one unshipped attempt from five hours ago,
    // with nothing else offered, is not a pipeline that is refusing commits.
    const verdict = assess({ rows: episode(1, 300, STOOD_DOWN), lastShipped: null, now: NOW });
    expect(verdict.starving).toBe(false);
    expect(ATTEMPTS_THRESHOLD).toBeGreaterThan(1);
  });

  it('distinguishes a starving pipeline from releases that genuinely broke', () => {
    // Same count and span; different half of the pipeline at fault. Sending an
    // agent to look at the engine when the release lane stood down is the four
    // and a half hours this alarm exists to save.
    const broken = assess({ rows: episode(4, 200, CUTOVER_FAILED), lastShipped: null, now: NOW });
    expect(broken.starving).toBe(true);
    expect(broken.supersededCount).toBe(0);
    expect(broken.verdict).toContain('reached cutover and did not complete');
  });

  it('reports nothing to worry about when the last attempt shipped', () => {
    const verdict = assess({ rows: [], lastShipped: '2026-09-12T04:55:00Z', now: NOW });
    expect(verdict.starving).toBe(false);
    expect(verdict.attempts).toBe(0);
  });
});
