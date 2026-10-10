# The Spin Reserve Gauge Counts Pools That Fund Spins (2026-10-08)

## What Fired

`SpinReservePoolThin` (`poker_spin_reserve_thin_clubs > 0` for 30m) fired
continuously from 2026-10-02: "641 club(s) cannot cover Spin's top tier".

## Root Cause

`v_spin_reserve_health` holds 645 reserve pools. 641 are thin, and every one of
them has balance 0, `spin_count` 0 and no Spin tournament in the last 7 days:
empty pools of clubs that have never run a Spin. No draw is constrained by them.
The 4 pools that fund Spins are all above the thin line. `fn_spin_metrics`
counted every thin pool, so the alert paged on nothing.

## Fix

Migration `20261008044926`: `reserve_thin_clubs` counts a thin pool only once it
has funded a Spin (`spin_count > 0`). A pool that runs Spins and drops below the
line still pages. Pinned-text substitution; detector-only, it moves no money.

## Hardening

- Regression: `scripts/ci/test-spin-reserve-thin.py` (native PostgreSQL, fails on
  the production preimage, passes on the candidate, reproduces the derived
  postimage md5).
- CI: `.github/workflows/spin-reserve-thin.yml`, path scoped.
- Detection: `SpinReservePoolThin` itself keeps routing to the alert store if a
  pool that funds Spins runs thin.
