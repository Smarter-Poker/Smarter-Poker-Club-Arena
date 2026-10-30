# Rake uses the displayed Stats calendar window

At 2026-10-30 05:00:36 UTC, the seven-day Stats calendar in America/Chicago began October 24 at 05:00 UTC, while the Rake read began October 23 at 05:00:36 UTC. For observed player MegaLimpRat, that rolling interval included 3,012 extra cash hands and 860.74 extra rake outside the displayed calendar range.

Add separate calendar Rake readers for All Clubs and a selected funded club. They use ca_stats_calendar_bounds, the same timezone/day validation and boundaries as the overview. The client sends its resolved timezone explicitly. Preserve the original RPCs for compatible callers. Hand rake, fixed UTC-effective redemption events and standing rake shares are bounded before aggregation; the bounded share helper preserves each rule/day's cent rounding, original funding resolution and allocator rules. No financial record changes.

The existing Stats observation hook also schedules the exact next local midnight, because a calendar window changes without a new hand. A short hidden-tab return crossing midnight refreshes once even if its pulse is unchanged. The boundary timer is scoped to the mounted view and canceled on cleanup; it is a display-calendar event, not a data repair or release timer.

Native PostgreSQL tests reproduce the rolling mismatch, execute the actual additive migration, and exercise inclusive start/exclusive end, assets, clubs, invalid/clamped days, timezone validation, 23/25-hour DST days, fixed redemption boundaries, bounded standing-share allocation, a recipient without own hands, old-contract preservation, private grants and replay refusal. Existing fee-redemption/standing-share assertions still execute before the new cases in the maintained required Data Console driver. Client tests check both RPC routes and timezone arguments, midnight without a hand, short hidden return, and cleanup.

Delivery order: protected merge and exact migration installation/readback before publishing the client that selects the additive RPCs. Existing clients remain on their existing APIs. No engine replacement is required.
