# Reconnected horses receive their decision on the retained clock

Received production alerts 39698, 39699 and 39739 report horse turn timeouts
and forced sit-outs. The September 14 18:05-18:43 UTC log capture contains
329 timed-out turns across 123 tables; all 183 distinct player IDs were
independently confirmed as horses. Selected table histories show the same
sequence repeatedly: restored disconnect state, disconnected TURN_CHANGE,
heartbeat reconnect, then a clock-forced fold without a decision request.

The reconnect protection branch restored only the remaining action clock
and returned. The preceding disconnected turn had returned before scheduling
the horse's input. The ordinary reconnect branch already resumes that input,
but the retained-deadline branch did not. The actual disconnect and heartbeat
callbacks reproduce this in a regression test: three horse cases failed
because no worker request or computed action existed; the human clock case
passed.

The retained-deadline branch now resumes the horse decision with the same
absolute deadline. It preserves the suppressed time bank, bounds the visible
think delay to the available time, and rejects responses or commits after
that deadline even before the timer's enforcement tick. A deadline rejection
is counted as `clock_expired` in the existing abandonment metric. Existing
hand, seat, engine lease and lifecycle checks remain authoritative. Human
reconnects do not dispatch horse work. Worker errors leave the existing clock
available to resolve the turn; no fresh clock or time bank is granted.

This repairs a reproduced path, not every historical timeout. Exact individual
forced-sit-out histories and the separate table-lease rebuild failures remain
under investigation. The source change does not restart production, alter
standings or payments, clear alerts, or qualify the release by itself.

Retained historical validation used shared dependencies on the local Mac. The focused
tests cover the actual reconnect callback, computed action execution, a long
tank with 700 ms remaining, human clock parity, and late-response refusal both
before and after the enforcement tick. Related time-bank, recovered-clock,
turn ownership, action-effect and abandonment tests remain required. Native
release checks, installation provenance and natural production behavior must
be verified before the received incidents can be closed.

The completed local run passed 174 tests across nine files and the server
TypeScript check on macOS 26.5.2 arm64, Node 26.3.0 and Vitest 4.1.11. It used
the existing shared dependency installation. These results do not qualify
the installed Linux / Node 22 runtime or establish production deployment.

Current delivery uses the restored GitHub-hosted checks and original Hetzner publisher. The final composed version still requires its own hosted and live verification.
