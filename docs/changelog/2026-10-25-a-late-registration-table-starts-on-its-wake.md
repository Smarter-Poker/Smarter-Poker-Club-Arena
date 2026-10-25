# Deadline Work Is Served Before The Stages A Bust Rewinds

Two owner reports on the same Sunday, one cause: a late-registration table that
never dealt, and add-on windows that closed with almost no horse add-ons.

## Part 1: A late-registration table starts dealing on the wake that opened it

Owner report, October 25, 2026, 17:56 America/Chicago, with a screenshot of
Sunday Funday Happy Hour (Midway Union) table 14: "THIS TOURNAMENT IS FROZEN
AND NEEDS TO BE FIXED RIGHT NOW!"

## What happened

`fn_ensure_late_registration_capacity` opens a capacity table, seats the
late entrants, and commits a `late_registration` manager wake in the same
transaction. The engine only started that table's dealer in the elimination
sweep's expansion stage (6). Every new bust calls `bustAwaitsItsStage`, which
rewinds the sweep cursor to stage 0, and on a busy field each 5-second
admission spent its budget on stages 0-5. Stage 6 was reached only when
busting stopped: at the synchronized :55 break.

Measured from `tournament_capacity_table_receipts`:

- Through 2026-10-24 morning the median wait from table creation to engine
  admission was about 4 seconds.
- 2026-10-25 13:00-23:00 UTC: 99 of 132 capacity tables waited more than a
  minute; median 12.0 minutes, maximum 53.8, with admission clustered at :55.
- Happy Hour table 14 (`f3f8475b`) opened 22:39:28 UTC with nine late entrants
  on 20,000 each, dealt nothing, and was admitted at 22:55:08 as the break
  began. It dealt its first hand after the break ended.

## Fix

`TournamentManagerEliminations` now runs `checkDynamicTableExpansion` in the
`late_registration` wake branch, right after accepted entrants are seated and
before the stages a bust can rewind, gated by `isMaintenanceFrozen()`.
Admission is idempotent (admit-before-ack against the same database
authority), adds no seats of its own, and `prepareManagedTableEngineForPlay`
arms the synchronized break, add-on, stage-end and hand-for-hand holds before
the dealer starts. The expansion stage itself is unchanged.

Pinned by a new case in
`server/src/tournament/LateRegistrationCapacity.guard.test.ts`.

## Damage

No chips moved while the tables waited: seated players posted no blinds and
kept their stacks. The cost was lost playing time, not money.

## Part 2: An open add-on window is served ahead of the rewindable stages

Owner, 18:18 Chicago: "WHY ... DID ONLY 1 HORSE ADD ON!? 70% OF HORSES ARE
SUPPOSED TO ADD ON! NOT ZERO EVER!!" The configured participation is 90%
(owner update 2026-10-22). The offer lived only in stage 4. On 2026-10-25 the
engine counted 14,182 of 17,047 sweep admissions (83%) over the 5-second work
budget, so stage 4 was rarely reached inside a window on a busy field.

Measured horse add-on share among horses alive at the window, 2026-10-25:
Happy Hour (Midway Union) 0 of 135, Bounty Builder 0 of 192, PLO Classic 0 of
132, PLO PKO 4 of 201, Six-Max 4 of 139; quiet satellites 89-92%. The add-on
purchase RPC was called about eight times across the whole platform between
23:08 and 23:20 UTC, so the offers were never made rather than refused.

The offer now runs at the head of every admission while the window is open,
on the same 20-second cadence (stage 4 keeps its call; the cadence prevents a
double offer), and `tryTournamentAddOns` reads only players holding chips so
a bust not yet recorded is never offered.

Missed add-ons are not reissued: each window is closed and its blind levels
have been played; reopening one would change the event after the fact.
