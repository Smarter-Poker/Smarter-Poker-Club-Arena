# Waitlist callers reach their installed database doors

The September 10 migration revoked browser writes to `table_waitlist` and
installed authenticated join/leave functions, but the live service still used
direct inserts and updates. Joining or leaving through those callers could only
be refused. The migration law checked that the callers were named in a comment,
without checking that they had actually changed.

All three live service writers now call the installed doors. They validate the
returned outcome and caller/table identity, recover a concurrent duplicate only
from an authoritative active-row read, and retain failure when cancellation is
unconfirmed. The page wrapper refuses a stale caller identity. The law now checks
the actual service and the discarded-read baseline tightens to zero.

The full-table footer and table-menu waiting-list entry now open the existing
Must-Move lobby for a cluster game. Previously they opened a read-only list for
one table with no Join action; the game-level queue was unreachable there. Manual
tables retain their existing destination. No layout, styling, or button markup
changes are included.

Verification: read-only production ACL/function inspection confirmed the mismatch;
17 behavior cases failed before the service fix. The focused suite passes 44
checks, including duplicate recovery and both table entry routes. A broader client
run passed 20,403 tests and found one baseline update handled here; nine other
failures require missing local Terser/Capacitor packages, which are deferred to
required CI under the Mac dependency policy. Live release and Phase 2 readiness
remain unconfirmed.
