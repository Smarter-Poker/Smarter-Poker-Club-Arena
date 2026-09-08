# Reconnect allowance across the maintenance restart

Date: 2026-09-08

## Finding

The unified 30-second regular / 45-second eligible VIP allowance is an absolute
deadline. Maintenance thaw shifted SQL seat and tournament deadlines but omitted
the disconnect FSM JSON. A player with time remaining at the freeze could therefore
return from the scheduled restart with that protection already consumed.

## Change

- Shift only allowance time overlapping the established maintenance freeze interval.
- Expired allowances stay expired. Heartbeats do not refill an allowance.
- Carry the original grant timestamp and completed-freeze marker in snapshots.
- Apply compensation lazily in the disconnect FSM and countdown, covering engines
  restored before or after the database thaw.
- Shift fresh parked presence and incomplete hand snapshots in the existing
  checkpointed, four-second-budget thaw procedure. Its first claimed duration remains
  authoritative. Existing completed breaks are not reopened.
- Restrict the pure JSON helper to service_role. No membership or money rules change.
  Incomplete snapshots use the existing partial unique index (one per table).

## Verification

75 focused server tests passed, including actual countdown deadlines, both restore
orders, legacy snapshots, heartbeat flapping, paid-bank handoff and maintenance.
Server TypeScript passed. Eleven SQL assertions passed on the applied helper;
they cover regular/VIP remaining time, expired/mid-freeze/legacy/connected entries,
malformed JSON, preserved fields, repeated calls and invalid intervals.
Function privileges checked: anon=false, authenticated=false, service_role=true.
Security advisors reported no finding for the helper. Existing internal presence
and thaw tables retain RLS with no client policies.

Applied database version: 20260908032311_reconnect_allowance_survives_maintenance.
The CLI-created migration was reserved against sibling worktrees and then recorded
under the database-assigned version after application.

## Remaining verification

Engine deployment and a real scheduled restart must still be checked. This follows
the existing fn_thaw_platform interval convention; time spent executing the thaw
itself is not added to that claimed interval. This is not evidence that every
maintenance-related timer or the overall disconnect audit is complete.
The next-hand gap, Rabbit Hunt paid-request idempotency, mobile/network-switch
recovery and cross-session subscription ownership remain separate audit items.
