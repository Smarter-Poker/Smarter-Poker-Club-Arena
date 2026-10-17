# The pilot preparation test reads the twenty-minute Action cadence

**Date:** 2026-10-17

## What broke

#7294 (`a61f56c8`) moved the Lightning pilot identity in
`scripts/ops/prepare-lightning-private-pilot.mjs` from the retired
`timed_15m` Action bomb cadence to the owner's current one (`timed_20m` for
Action, `timed_10m` for Madness; #7263, migration `20261017105834`). It
updated the `scripts/ops/lightning-pilot-*.test.mjs` fixtures but not the one
in `tests/lightning/private-pilot-preparation.test.ts`, whose Action pilot
still carried `trigger: 'timed_15m'`.

`selectPilotGame` therefore found the pilot by name and `assertPilotGame`
refused it as a configuration mismatch, so
`recovers the same private game among defaults after an unknown creation
acknowledgment` failed on `main`. That suite is in the client test gate of
`publish-club-arena.yml`, so every Club Arena client publication from
`a61f56c8` onward stopped at `client-tests (4)` (run 39052144523) and the live
bundle stayed at `0e97834c`.

## The fix

The fixture now carries `timed_20m`, the cadence the production code pins.
No behaviour changes; the test once again describes the pilot the setup
script actually accepts. `git grep` finds no other pilot fixture on the
retired cadence.
