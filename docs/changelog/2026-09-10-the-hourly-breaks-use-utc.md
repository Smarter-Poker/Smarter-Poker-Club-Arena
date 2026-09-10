# The Hourly Breaks Use UTC

The Phase 3 UTC/DST audit reproduced seven scheduling failures in the actual break methods. Local Date setters could skip a synchronized break during the repeated autumn hour. The maintenance announcement could return a negative delay in that same hour. A fractional-hour timezone also shifted both boundaries away from UTC.

Both schedulers now use UTC setters. Announcements stay at :53 and synchronized breaks at :55; durations and the normal deployment window are unchanged. A delayed firing still recomputes its next boundary from the current wall clock.

Verification: nine actual GameServer scheduler cases pass, and the existing maintenance suite passes all 66 cases, including six new UTC boundary cases. The cases cover Chicago and Berlin autumn transitions, Chicago spring transition, a fractional-hour offset, year rollover, exact boundaries and delayed firing. These are controlled-clock checks, not a claim that a future DST event was observed in production.

This is evidence for the UTC cadence portion of K03, K04 and K12. Phase 3 and those complete controls remain open pending their other requirements and release verification.
