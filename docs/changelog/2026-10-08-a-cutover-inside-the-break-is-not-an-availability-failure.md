# A Cutover Inside The Break Is Not An Availability Failure

## What Fired

`SLOEngineAvailability` (critical) fired six times on 2026-10-07/08, always at
:16 and always resolved at :26 ("Engine availability 97.5% over 30m"). Each
one followed a break that replaced the engine late in its countdown:
`ready_for_restart_at` at 02:56:39, 07:56:37, 12:56:41, 14:56:44, 16:56:21 and
23:56:47. Breaks that replaced the engine before :56:10 did not fire, and no
break without a replacement fired.

## Why

`sp:engine_availability:ratio30m` averaged every scrape of the engine over 30
minutes, including the scrapes that failed while the engine was being
replaced inside the scheduled break. The alert's break guard only looks back
six minutes, so from :06 the ratio still carried those in-break failures, the
10 minute `for` ran out at :16, and the failures aged out of the window at
:26. The rule's own comment says the guard is what makes 99% the right
number; the ratio did not honour it.

## The Fix

The recording rule now drops a scrape when the break flag was up in the six
minutes before it, the same window the alert guard uses. That also covers the
minutes the old engine is gone and its flag with it. The 99% objective and
the 10 minute `for` are unchanged. An outage outside a break, or an engine
that stays down after the break, counts in full.

## Regression

`tests/monitoring/slo-engine-availability.test.yml` (run by
`scripts/ci/test-slo-stall-duration.sh` in CI) reproduces the production
shape and fails on the old rule (pending at :10, firing at :22), and proves
the same outage outside a break and an engine that never comes back both
still fire.
