# A Movement-Proof Refusal Of A Begin Is A Refusal (2026-10-02)

## What Happened

f8c6f298 (11 playing) froze nine players on table 199a1efc from 04:51 UTC.
Break 7ef06537's begin was refused by the database with
`F06_MOVEMENT_ROSTER_CHANGED` (a player bought the add-on after the park's
movement proof was taken), and the engine logged
`F06 fn_f06_begin_break outcome unproven: F06_MOVEMENT_ROSTER_CHANGED` and
re-sent the identical request on every pass.

## Cause

The movement-proof check runs from a trigger when the begin writes the
manifest; its named refusal (SQLSTATE 55000) rolls the whole begin back, so
nothing was begun. The engine only recognised `F06_WHOLE_ROSTER_REQUIRED` and
`F06_SOURCE_NOT_EXACT` as definitive refusals and treated everything else as
an unknown outcome to replay.

## Fix

`F06_MOVEMENT_ROSTER_CHANGED`, `F06_MOVEMENT_ELIMINATION_CHANGED`,
`F06_MOVEMENT_WHOLE_ROSTER_REQUIRED` and `F06_MOVEMENT_BOUNDARY_CHANGED`
(55000) from `fn_f06_begin_break` take the refused-roster path: the proposal
becomes history, the refusal is noted as `begin_refused:<code>`, and the next
pass re-reads the roster. Anything else stays outcome unproven. The database
side (the add-on itself) is fixed by #5789.
