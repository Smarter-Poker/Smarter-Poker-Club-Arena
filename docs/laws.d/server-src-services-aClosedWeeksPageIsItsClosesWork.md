# server/src/services/aClosedWeeksPageIsItsClosesWork.law.test.ts

A closed week's page is its close's work (2026-10-12): the rakeback settler never sends a page recompute (fn_rakeback_recompute_periods) for a week that has ended at 00:00 America/Los_Angeles; it counts the group as deferred because the weekly close recomputes every club-week of its scope from source, so a page of a closed week can no longer hold the watermark.
