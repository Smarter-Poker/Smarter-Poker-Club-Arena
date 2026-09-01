# A table created at level 8 advertised level 1

2026-09-01. The last instance in `TournamentManagerBase.ts` of reaching into
the blind structure by index instead of asking `resolveBlindLevel`.

The table-creation loop runs whenever a tournament needs more tables than it
has — late registration, a rebalance — which by definition happens after the
clock has started. It stamped the new table's `stakes` from
`blindStructure[0]` regardless, so a table born at level 8 advertised the level
1 blinds for the rest of its life.

**197 tables across 60 tournaments** in the last three days were created after
their tournament started. Every one carries level 1.

## How much this matters, honestly

`stakes` is a display string. The engine takes its blinds from the tournament
level and never reads this row, and the lobby shows buy-in rather than stakes
on a tournament row — so this is a lie that is currently hard to see, not one
anybody has complained about.

It is still a lie, and it is the exact hazard Phase 2.3 (2026-08-31) went
through the rest of this file to remove: an index into a structure the
tournament may already have run off the end of. `resolveBlindLevel` exists to
synthesise the level in that case rather than clamping to a stale row. This was
the one caller left that did not ask it.

## What was already fixed, and is not this

The note that sent me here described the _resume_ path computing a level's
**duration** from `blind_structure[0]`. That is gone — `startBlindTimer`,
`advanceBlindLevel` and the break paths all route through `resolveBlindLevel`
now, with `blindStructure[0]` only as an empty-structure fallback. Someone
fixed it between then and now. Recording that so the note does not get chased a
third time.
