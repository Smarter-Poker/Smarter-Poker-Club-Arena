# server/src/theOriginalsOwnCheckIsReadAtTheProcessRoot.law.test.ts

The mixed-custody admission reads the in-process original manager's drained
custody check (`packet.current()`) at the process root through
`GameServer.drainedOriginalIsCurrent`, never inline: the admission's
`current()` is re-checked by `reservation.assertCurrent` inside the successor
manager's bound data authority, and the original's methods are bound to the
original lease generation, so the inline call threw "Tournament data authority
cannot be rebound inside another manager context" and tournament 4e2de62d was
retained on `GameServer.mixed_original_recovery_retained` at every re-admission
from 2026-09-28 13:50Z.
