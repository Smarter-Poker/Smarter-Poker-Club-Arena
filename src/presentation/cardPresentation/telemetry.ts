/**
 * RIVER SQUEEZE 2026-09-04 (spec 62, 63). Presentation telemetry goes to the
 * existing analytics client (PostHog via src/lib/analytics, a no-op without a
 * key). Sampled: a river happens tens of thousands of times a day across the
 * fleet and nobody needs every one of them. Failures and drops are NOT
 * sampled - a cancelled or duplicate animation is the signal.
 *
 * Never carries the card. The key names the hand and slot, never the rank.
 */

import { capture } from '../../lib/analytics';
import type { CardPresentationTelemetry, TelemetrySink } from './types';

/** One in twenty starts/completions; every cancel, skip and duplicate. */
export const TELEMETRY_SAMPLE_RATE = 0.05;

const ALWAYS: ReadonlySet<CardPresentationTelemetry['event']> = new Set([
  'animation_cancelled',
  'animation_skipped',
  'animation_duplicate_ignored',
  'animation_performance_degraded',
]);

export function createAnalyticsTelemetrySink(random: () => number = Math.random): TelemetrySink {
  return (t) => {
    if (!ALWAYS.has(t.event) && random() >= TELEMETRY_SAMPLE_RATE) return;
    capture(`card_presentation_${t.event}`, {
      key: t.key,
      street: t.street,
      board_index: t.boardIndex,
      profile: t.profile,
      platform: t.platform,
      mode: t.mode,
      duration_expected_ms: t.durationExpected,
      duration_actual_ms: t.durationActual,
      reason: t.reason,
    });
  };
}
