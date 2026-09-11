# 2026-09-11 — The frozen build can be replaced (one build, one night)

## What happened

Build `404948b3` booted at 01:56 UTC and its process-wide deadline clock
started inside one tournament's data-authority context. Node timers inherit
their async context, so every deadline of every _other_ tournament ran inside
the wrong authority and threw `Tournament data authority cannot be rebound
inside another manager context` (263 of them in two minutes at 05:05). Those
tables froze mid-hand; the zombie reaper voided and rebuilt them every ~183s
(917 kills in one dealRate window). Cash tables were unaffected.

#4225 fixes the clock (`bindToProcessRoot`). It could not ship:

| break | engine   | unparked at countdown | peak | readyForRestart |
| ----- | -------- | --------------------- | ---- | --------------- |
| 02:55 | 404948b3 | 514                   | 514  | never           |
| 03:55 | 404948b3 | 526                   | 526  | never           |
| 04:55 | 404948b3 | 523                   | 523  | never           |

A table frozen mid-hand never parks, so a build with this defect can never
open `maintenance.readyForRestart`, and the deploy correctly refuses to stop
an engine without it. Peak equal to the count at countdown means not one of
those tables landed during any countdown: they were not live hands finishing
late, they were hands the engine itself voids minutes after the thaw.

## The decision

Dan, 05:22 UTC, choosing option 1 of 2:

1. a one-time override bound to exactly this broken build;
2. hold, and let the fix land only when the process dies of something else.

## What changed

`auto-deploy-hetzner.yml` carries two job constants,
`FROZEN_BUILD_OVERRIDE: '404948b3'` and `FROZEN_BUILD_OVERRIDE_UNTIL`.
The break gate still asks for the full certificate first. Only when it is
incomplete, and only when the serving `/health.version` is exactly that build,
the engine is running, and the break is active, `counting_down`, durable and
has at least 180s left, the gate cuts over once 200-235s remain. The cutover
step re-proves the exact build on the host, under the engine lock, before the
mutation marker; the seal records the reason. It is not an input — no
dispatch can name a build — and it is dead after the expiry or the moment any
other build serves.

`tests/unit/deployCannotPinStaleCode.test.ts` pins all of that. Remove both
constants (and that describe block) once production has moved off
`404948b3`.

## What stops the next one

The deeper defect is in the engine: `pauseForMaintenance` marks a table
"paused by design" at :53 even while it is still mid-hand, and the zombie
reaper exempts paused-by-design tables for ten minutes, longer than the whole
break. A table frozen mid-hand is therefore invisible to the reaper for
exactly the window in which it blocks the certificate. The follow-up makes a
break-flagged table exempt only once it has actually parked, so a frozen
table is reaped on its usual clock inside the break and rebuilt parked, and a
broken build can still earn its certificate honestly — no exception needed.
