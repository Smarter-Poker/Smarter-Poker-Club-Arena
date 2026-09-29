# server/src/tournament/aWedgedTableAsksTheDoorItself.law.test.ts

A Wedged Table Asks The Door Itself, And An Ask With No Answer Is A Number:
the abandoned-generation door was wired into `resumeLifecycle` only, and
`resumeLifecycle` runs once per manager - a manager on the adoption path holds
its event's lease for the rest of its life - so any adoption whose single ask
ended without a decision left the table blocked for that manager's whole life.
Measured after the 2026-09-25 15:29 cutover: 526 tables in 388 RUNNING events
held a reserved permit of a dead generation, carrying 2,061 seated players and
14,210,568 chips; all 388 events were adopted between 15:42:08 and 15:44:33;
the adoption read every table (1,411 `fn_f06_hand_number_state` calls, all HTTP
200, all returning a well-formed `hand_permit_unresolved` naming a generation
that was not the lease holder); and the door was never requested once, with
zero on all five labels of `poker_f06_abandoned_generation_closures_total` -
because the one exit from an ask that never reaches the door, the maintenance
freeze outlasting the wait, returned in silence, and zero on every label is
what a healthy fleet reads. This pins both halves: `startManagedTableEngine`,
the line that meets the refusal and throws `f06_engine_admission_unproven`
every fifteen seconds, asks the door itself on an exact
`hand_permit_unresolved` answer about its own table and then still refuses that
attempt so nothing deals on an unproven projection; and every end of an ask is
a number, including `frozen` and `unreadable`, with no error coerced into an
empty state. Plus the two refinements that keep the ask from becoming a loop: a
rule the door names is asked once per manager, and an undecided answer waits a
cooldown longer than the door's own retry ladder.
