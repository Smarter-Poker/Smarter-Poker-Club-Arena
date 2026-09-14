# A new seat occupant starts without the previous player's away state

The existing turnover handler clears sit-out state when a seat is vacated or
revived, but does not clear it when `user_id` changes on an active seat row.
The occupancy handler gives that replacement a new occupancy ID while the
sit-out flag and clock still belong to the previous player. This was reproduced
with the four installed handlers on a temporary table in a rolled-back
production transaction, without changing a real seat or profile.

The migration makes a change of occupant clear both `is_sitting_out` and
`sit_out_at`, matching the existing fresh-insert contract. A move by the same
player keeps that player's clock. The handler stays an invoker function with
its existing grants and search path. Stack fields, admission doors, occupancy
identity enforcement and the existing freeze/thaw exception are unchanged.
There is no historical data rewrite. Historical customer impact has not been
established by this probe.

Installation refuses a changed predecessor definition or trigger binding before
replacing anything. A three-second lock timeout and thirty-second statement
timeout bound installation. The existing financial-trigger registry entry is
preserved and its note describes this derivative-state responsibility.

## Verification

The native PostgreSQL 17 harness has 25 passing checks, including the failing
predecessor behavior, atomic refusal on definition drift, unchanged seat data,
horse-to-human replacement, explicit away state on replacement, same-player
moves, ordinary clock reset rejection, the existing freeze/thaw contract,
leave/revival, new inserts, immutable occupancy identity, grants and rollback.
Two real database sessions prove that a replacement waiting behind an old
occupant's away update starts with a cleared flag and clock after that update
commits. The owned disposable cluster is stopped and removed.

The required CI workflow runs this harness. Its fixture composes the four real
sit-out/occupancy handlers with the existing freeze helper. It does not claim
qualification of every funded admission door or every financial trigger.

Run locally with PostgreSQL 17 installed:

```sh
PG_BIN=/opt/homebrew/opt/postgresql@17/bin python3 scripts/ci/test-seat-turnover-sitout.py
```
