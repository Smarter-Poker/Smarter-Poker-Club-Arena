# An Unstarted Hand Permit Release Is A Recovery Event

**Date:** 2026-10-17
**Migration:** `20261017010023_an_unstarted_hand_permit_release_is_a_recovery_event.sql`

#6957 made the engine record `unstarted_hand_permit_released` when a failed
deal attempt releases its F06 permit, but `engine_recovery_events_event_check`
still allowed only the five values of 2026-08-30. Postgres refused every such
row (19 in 24 hours), so the recovery worked and its record was lost. The
CHECK now admits the sixth value, added `NOT VALID` so the 1.9M existing rows,
which all satisfy the narrower check, are not rescanned under the table lock.
No reader's count changes: every reader filters by event.
