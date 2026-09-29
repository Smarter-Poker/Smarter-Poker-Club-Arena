# server/src/tournament/aFreshAdoptionAsksTheDoorBeforeHoldingTheEvent.law.test.ts

A Fresh Adoption Asks The Door Before It Holds The Event: a reserved F06 hand
permit at adoption made the successor a custody-only recovery owner even when
nothing could ever continue that ownership. With no drained packet and no
durable mixed transfer - every fresh process adopting a RUNNING event - the
"existing strict recovery" the admission deferred to does not exist; the only
owner of a dead generation's reserved hand is the abandoned-generation door,
which the adoption asks from inside `resume()`, downstream of the gate that
stopped `resume()` from running. Measured on 2026-09-26: after the 01:58
restart of 778075b4, 68 RUNNING events (114 tables) held their lease and dealt
nothing for over an hour; after the 03:23 cutover to 1fc82ca8, 75 events with a
dead generation's reserved permit were admitted and 0 of them reached
`Resuming...`, while 267 other adopted events did. This pins the owner the
admission names before anyone holds the event (`f06RecoveryDispositionOwner`):
a mixed transfer keeps strict mixed recovery, a drained in-process packet keeps
strict ownership, a fresh `resume` with neither runs the real `resume()` and
asks the door before any dealer is built (and a hand the door refuses stays
reserved), and a recovery-required admission with no owner at all is refused
rather than admitted.
