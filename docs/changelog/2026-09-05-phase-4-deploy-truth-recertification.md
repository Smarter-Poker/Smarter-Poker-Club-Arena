# Phase 4 Of 6 Deploy Truth Recertification

## What The Deep Dive Found

The deploy-truth watchdog was live, scheduled every minute, and healthy in
production. Its zero-engine outage repair and continuous engine-behind clock
were both present. However, the two repairs were applied live in merge order
while their migration filenames sort in the opposite order. A clean database
replay therefore applies the zero-engine function replacement last and silently
restores the old target-specific clock.

That old query measures the age of only the newest offered SHA. On a busy main
branch, each new target resets the eight-hour timer even when the running
engine never moves. A rebuilt environment could therefore keep a continuously
stale engine below the alarm threshold indefinitely.

## What Changed

- Chronological migration replay now ends with the same continuous clock that
  production already runs.
- The effective function measures from the first target that differed from the
  running engine after the pipeline last offered the running build.
- A new target SHA no longer resets an existing lag episode.
- Catching up to an offered build still resets the episode as intended.
- The migration refuses to rewrite an unfamiliar function body.
- The regression test now checks migration order, so any later complete
  watchdog replacement must either retain the continuous clock or fail the
  release gate.
- The source filename matches the production migration ledger version
  `20260906005803` exactly.

## Protected Data

This repair does not read or write Club Bank balances, Deep Stack Society chip
balances, horse funding, player rows, or memberships. It changes only the
operational deploy-truth function and its test coverage.
