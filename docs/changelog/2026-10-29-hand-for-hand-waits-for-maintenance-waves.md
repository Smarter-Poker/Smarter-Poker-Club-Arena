# Hand-For-Hand Waits For The Last Maintenance Wave

A reproduced overlap can leave a bubble parked after both breaks end. The
tournament releases its hand-for-hand barrier while maintenance still holds
the engines. That clears the hand-for-hand flag without releasing their
existing waiters. The barrier's normal 500ms re-pause then raises the flag
again. Each later maintenance wave clears its own flag and returns for the
hand-for-hand owner, without entering another park or publishing a new edge.

The barrier now waits until every expected engine's maintenance owner has
released it. A maintenance wave that leaves an existing waiter co-held offers
that same pause-ready callback after clearing its own flag. The last wave
therefore releases the original barrier once. Other pause owners keep their
flags and waiters; no polling, timer repair, forced action or new hand number
supplies the release.

The regression uses two actual engines, their actual pause-gate promises, the
actual manager barrier and fake timers. It fails before the change when the
barrier attempts release before the waves, and passes after the change with
the first wave held and the last wave releasing both original waiters once.
Additional tests retain a final-table owner and refuse a readiness edge for an
engine that has not parked. This proves the source race and repair; production
attribution and installed behavior require their separate runtime evidence.
