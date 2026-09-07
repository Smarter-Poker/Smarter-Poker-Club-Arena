# server/src/maintenance/anAdoptedBreakEndsOnTheHour.law.test.ts

A break adopted at boot ends at the next :00, never five minutes after the
process happened to start (2026-09-06: a workflow_dispatch deploy across the
:53 announcement made the 19:00 break run 18:53:48 -> 18:58:49 and resume 71
seconds early, which the scorecard then reported as "it dealt 366 hands inside
the break" - it dealt zero); a `last_hand` row older than the whole
announcement-plus-break span is refused rather than adopted, so an orphaned
announcement can never freeze the fleet from a later boot; and a `counting_down`
row keeps the end instant the previous engine already computed.
