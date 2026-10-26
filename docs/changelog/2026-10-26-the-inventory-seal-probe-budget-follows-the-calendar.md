# The inventory-seal probe's budget follows the calendar (2026-10-26)

`Accounting transactions (PostgreSQL 17) shard 3/4` went red on `main` and on
every pull request from Monday 2026-10-26 07:00 UTC, at
`scripts/dev/test-inventory-seal-committed-pages.py`:

> AssertionError: Backlog never reached truthful readiness

That shard is folded into the required `Server Engine (typecheck + tests)`
aggregate, so nothing could merge behind it.

## Cause, read from the probe

The backlog scenario seeds a fixed fixture: a sealed week at 2026-10-05, a
build in progress for 2026-10-12, and then polls
`fn_union_pnl_inventory_checkpoint_due()` in chunked mode until it answers
`ready`. That function walks every closed week from the capture to the
current Monday (`fn_union_week_start`, Monday 00:00 America/Los_Angeles) and
seals each one in bounded steps. Reproduced on PostgreSQL 17.11 with the
loop widened and each answer printed:

| boundary   | chunked answers                                   |
| ---------- | ------------------------------------------------- |
| 2026-10-12 | 2 `committed_build_page`, then `pending_boundary` |
| 2026-10-19 | 3 `committed_build_page`, then `pending_boundary` |
| 2026-10-26 | 3 `committed_build_page`, then `ready`            |

Eleven calls. Through Sunday the walk stopped at 2026-10-19 and needed seven,
inside the probe's constant budget of ten. At 07:00 UTC Monday the week of
2026-10-26 closed, the walk gained a boundary and four more calls, and the
constant was exceeded. It would have stayed exceeded for ever, and grown by
four every Monday. A fixed fixture measured against a moving calendar with a
constant budget is a probe that answers "broken" about a platform doing
exactly what it should (CLAUDE.md 10.86).

## Fix

The budget is derived: the probe asks the database how many week boundaries
are due from 2026-10-12 to now (the same `fn_union_week_start` walk the
function makes) and allows five chunked calls per boundary, against a measured
need of four. Readiness is then checked for truth: every due week must carry
its checkpoint row, not just the last answer reading `ready`. The full native
probe passes on PostgreSQL 17.11 with the change (exit 0, every later scenario
unchanged), and the two law tests that pin the script's text still pass.

No production function, migration or schedule changes; the probe is the only
thing that was wrong.

## Not changed here

`Accounting transactions shard 1/4` was red in the same window for a
different reason (the current-ECO witness in
`scripts/ci/test_launch_reset_balance.py` cannot be established between the
Monday week boundary and the 04:00 Chicago close hour); that is #8163.
