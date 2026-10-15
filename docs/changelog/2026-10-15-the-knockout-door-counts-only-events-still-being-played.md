# The Knockout Door Counts Only Events Still Being Played

Date: 2026-10-15

## What Happened

`fn_ca_conservation_sweep:fn_ca_knockout_door_stalled` paged in episodes for weeks (34 open alert rows plus drift receipts, the latest on 2026-10-14 14:52 to 16:23 UTC). Every episode read "1 candidate(s) are waiting with no open rebuy decision, the oldest for 37002.3 minute(s)".

Exactly one knockout candidate had been unresolved for more than a day: `607ad6b3`, created 2026-09-18, in tournament `5a387a75`, which `atomic_cancel_tournament` cancelled on 2026-09-27 (the field was refunded and the entrant marked eliminated). No player was behind that door. But the read counted every unresolved candidate in the table, so whenever the platform went fifteen minutes without a knockout, that one stale row turned a quiet door into a "stopped" one.

## The Fix

Migration `20261015024956` edits `fn_ca_knockout_door_stalled` in place (pinned preimage, single anchor, derived postimage, owner and grants unchanged). An unresolved candidate counts only while its tournament is not COMPLETED, CANCELLED or CANCELED. COMPLETING still counts. Resolved rows still date the door. A pending candidate of a running event still pages exactly as before. Measured read-only on production: one primary-key probe per pending row, the same 0.3 s scan as today.

## Tests

`scripts/ci/test-knockout-door-terminal-events.py` (native PostgreSQL, run by `.github/workflows/knockout-door-terminal-events.yml`): the captured production definition fires on the stale cancelled candidate; after the migration it does not, while a real stall (RUNNING or COMPLETING) still fires, a recent knockout keeps the door quiet, the postimage md5 matches production's derived value, grants are unchanged, and a second run is refused. 21 of 21 checks pass on PostgreSQL 16.
