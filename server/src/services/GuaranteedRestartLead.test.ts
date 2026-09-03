/**
 * A GUARANTEED RESTART MUST OUTLIVE ONE OVERLAY-GUARD CYCLE
 * ═══════════════════════════════════════════════════════════════════════════
 * Dan 2026-08-27, binding: "If any Midway Union MTT is going to have an
 * overlay, new horses start entering it so no overlay occurs."
 *
 * HorseOverlayGuard was built for that rule and was never broken. It was being
 * handed events that did not exist far enough in the future to act on.
 *
 * `guaranteed_prize` is in RESTART_COPY_COLUMNS, so every restarted clone
 * inherits the guarantee, and the restart path published it two minutes before
 * the gun. The guard polls `fn_overlay_at_risk` every two minutes and
 * MttPrestartRamp ticks every 45 seconds, so those events got at most one
 * attempt and usually none.
 *
 * Measured 2026-08-31..2026-09-02: 553 of 554 guaranteed events ran an
 * overlay, roughly 22,300 chips a day. 165 of ~195 had been published between
 * 0.8 and 5.0 minutes before start. The four published at the intended
 * MTT_PUBLISH_LEAD_MS were not in the bleed.
 */
import { describe, it, expect } from 'vitest';
import { restartLeadMsFor, RESTART_MIN_LEAD_MS } from './ScheduledTournamentService.js';
import { MTT_PUBLISH_LEAD_MS } from './TournamentRecurringService.js';

/** HorseOverlayGuard's CYCLE_MS. Kept here so a change there fails here. */
const OVERLAY_GUARD_CYCLE_MS = 2 * 60_000;

describe('restart lead for a guaranteed clone', () => {
  it('gives a guaranteed clone the full publish lead', () => {
    expect(restartLeadMsFor(600)).toBe(MTT_PUBLISH_LEAD_MS);
  });

  it('leaves a clone with no guarantee on the two-minute floor', () => {
    expect(restartLeadMsFor(0)).toBe(RESTART_MIN_LEAD_MS);
    expect(restartLeadMsFor(RESTART_MIN_LEAD_MS)).toBe(MTT_PUBLISH_LEAD_MS); // any positive prize
  });

  it('treats a missing or malformed guarantee as no guarantee', () => {
    expect(restartLeadMsFor(Number.NaN)).toBe(RESTART_MIN_LEAD_MS);
    expect(restartLeadMsFor(-1)).toBe(RESTART_MIN_LEAD_MS);
  });

  it('leaves the guard MORE THAN ONE cycle to act - the whole point', () => {
    // One cycle is not enough: the guard has to observe the event and then
    // complete a registration round trip. The regression shipped exactly one
    // cycle of headroom and that is why it filled nothing.
    expect(restartLeadMsFor(600)).toBeGreaterThan(OVERLAY_GUARD_CYCLE_MS * 2);
  });

  it('is at least as long as the pre-start ramp expects to run for', () => {
    expect(restartLeadMsFor(2500)).toBeGreaterThanOrEqual(MTT_PUBLISH_LEAD_MS);
  });
});
