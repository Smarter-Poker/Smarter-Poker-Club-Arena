# Lightning showdown losers can rebuy after the result presentation

The Lightning rebuy watch required an empty roster and an idle snapshot. A
normal completed Lightning hand retains its final roster and hand identity:
`LightningHandHost.complete` sends the completion presentation and settlement
receipt, while its idle snapshot is sent on a fold or abandon. A player who
busted at showdown therefore never became a rebuy candidate.

The client now uses the existing finished-hand presentation marker to check
that retained roster after its animations finish. The hand number binds the
marker to its hand, so a new hand and an all-in still playing remain excluded.
The database still confirms an open owned session, no hand in progress, a
live eligible anchor and an actual zero stack before the sheet opens. A stale
zero contradicted by a funded database answer never opens it. The existing
funding, idempotency and leave paths are unchanged.

The bounded read budget now belongs to the same room identity as the prompt
state, so a previous room's exhausted budget cannot silence another room.
There is no new poll, timer service, engine contract or production data write.

Two regression cases failed before the correction: a retained showdown roster
never prompted, and an exhausted old room prevented a new room's first read.
The focused Lightning transition suites pass after the correction (74 tests).
Compilation, required protected checks, publication and live verification are
recorded separately in the continuation evidence.
