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

`TournamentManager.admitCommittedCapacityTables` runs in the
`late_registration` wake branch, right after accepted entrants are seated and
before the stages a bust can rewind, gated by `isMaintenanceFrozen()`. It reads
the committed `tournament_capacity_table_receipts` still awaiting a dealer,
starts each engine through the one capacity start path
(`startCapacityTableEngine`, shared with the expansion stage, which runs
`prepareManagedTableEngineForPlay` so every break and hand-for-hand hold is
armed before dealing), and acknowledges exactly those receipts.

It creates no table, moves no seat and runs no rebalance. A first version
called the whole expansion routine early; CI's freeze law
(`theFreezeIsTotal.law.test.ts`) refused it, correctly: that routine also runs
the post-expansion rebalance (player moves), which must stay after table
balancing. Creation and rebalancing remain in the expansion stage, unchanged.

Pinned in `server/src/tournament/LateRegistrationCapacity.guard.test.ts`.

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
a bust not yet recorded is never offered. Only offers move early: once the persisted
deadline has passed, or a Free Buy closing drain is pending, the window is
closed (and the prize pool finalized) by stage 4 as before, after the bust
stage, so a bust recorded in the same pass keeps its rebuy
(`addOnOfferWindowOpen`).

Missed add-ons are not reissued: each window is closed and its blind levels
have been played; reopening one would change the event after the fact.

## Part 3: Every seated, funded horse adds on

Owner, 20:39 Chicago, after Sunday Funday Warm-Up (Midway Union) closed its
add-on window with 0 of 90 horses added on: "EVERY HORSE, IF THEY ARE IN THE
TOURNAMENT, AND HAVE THE CHIPS AVAILABLE TO ADD ON, SHOULD 100% BE ADDING ON IN
EVERY SINGLE TOURNAMENT IF THEY ARE STILL HAVE THERE SEAT!"

`HORSE_ADDON_PARTICIPATION_RATE` is 1 (was 0.9 from 2026-10-22). The purchase
RPC still refuses a seatless or unfunded entry; all 90 Warm-Up horses held at
least the 50 add-on cost (median wallet about 6,886).

The Warm-Up zero was not a rate. Its whole five-minute window was the parked
add-on break, so no bust was rewinding the cursor; the offer still never ran
because `tryTournamentAddOns` returns at once when the admission's 5-second
work budget is spent (`eliminationMutationAllowed()`), and 83% of admissions
spend it before stage 4. The head-of-admission offer from Part 2 runs while the
budget is still available, which is what lets this rate be reached.

## Part 4: The offer fills its sixty-second window

With a one-minute add-on break, a paid event's whole offer window is sixty
seconds. `process_tournament_rebuy` takes the tournament row FOR UPDATE, so
purchases are serial per event (production p50 363 ms, p95 927 ms, 20:00-02:25
UTC); the time lost was the wait between admissions, one 20-player batch each.
The head-of-admission offer now loops batch after batch (at most ten) while the
admission's budget lasts, stops when no horse is left, nothing was answered,
the window closes or the platform freezes, and runs ahead of the
late-registration branch, which can end an admission while the entry window
that precedes the add-on is being closed.
