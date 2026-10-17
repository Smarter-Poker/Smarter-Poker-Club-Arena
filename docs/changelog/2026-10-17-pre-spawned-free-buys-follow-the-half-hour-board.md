# Pre-spawned Free Buys follow the half-hour board (2026-10-17)

## What was left after #7173

Dan, 2026-10-16: the five daily Free Buys run "AT 8:30AM, 12:30PM 4:30PM
8:30PM AND 12:30AM EVERY DAY", guarantees doubled (standard 500, Prime Time
feature 1,000). #7173 taught the engine board writer that spec, and every
active Free Buy **schedule** row read :30 Chicago by 10:45Z. Read from rows,
two things it did not reach:

1. **28 occurrences already spawned** for 2026-10-17..19 (14 Midway chip, 14
   Diamond Arena) still ran at :00 with the old guarantees. Nothing conforms a
   pre-start spawned occurrence when its schedule changes; the hourly
   freeBuyAudit had held "40 problem(s) across 20 event(s)" open since 03:01Z,
   and the 8:30 AM slot was two hours away.
2. **A duplicate-spawn hazard.** Spawn keys embed the slot time
   (`sched:2026-10-18:08:00`). With schedules at :30, the spawner computes
   unspent `:30` keys for dates whose `:00` keys are already spent - reaching
   back over 10-18/19 it would have put two Morning Free Buys on the same
   board.

## Two production guards fired; both were honored

The draft conform also doubled the 28 events' guarantees, the Diamond half
through the earmark ledger (release + reopen under
`fn_ca_diamond_earmark_guard`, house availability read first: 2,185,818
available against a +4,000 net raise). Production said no, twice:

- **`fn_guard_managed_game_lifecycle`** - "This tournament cannot be modified
  after a player has registered"; only the engine's `service_role` is exempt.
  Whether an agent may wear the engine's claim is the owner's call, so the
  three options were put to Dan. His answer, 2026-10-17: **"THIS IS ON YOU TO
  DECIDE WHATS BEST FOR US, YOU CAN MAKE THE CHOICE. GET THIS FINISHED UP."**
  The apply therefore carried the engine's transaction-local claim (pattern
  `20260908043200`) - this conform is the engine's own board catching up with
  its own schedule.
- **`trg_freeze_registered_tournament_settlement_contract`** - "settlement
  class, guarantee, Bubble Protection and buy-in are frozen after its first
  entrant". This one binds the engine too, deliberately: the 2026-10-16
  fixed-board audit records it refusing any change to a funded contract,
  *correctly*. A registered player's advertised contract is immutable even
  when the change is an improvement. **Honored, not overridden.**

## What was applied (migration `20261017105003`, times and keys only)

- All **28 occurrences moved +30 minutes** onto their own slots - Dan's own
  clock: 8:30a / 12:30p / 4:30p / 8:30p / 12:30a Chicago. Start time is not
  part of the frozen settlement contract; every event was a freeroll in
  REGISTERING with a zero, unfinalized pool, more than 20 minutes out. The
  8:30 AM slot was saved with about two hours to spare.
- All **28 spawn keys renamed `:00` -> `:30`**, so the spawner sees those
  dates' :30 slots as already delivered - the duplicate-spawn hazard is
  structurally closed. 2026-10-20 onward mints `:30` keys natively (first
  rows observed 05:30Z).
- Every number asserted in-transaction: 28 targets, the exact five-slot
  board, 28 keys, no :30 twins, 28 moved, 28 renamed, zero future :00
  occurrences, every moved row read back at :30 with its guarantee untouched.
- Verified after commit: next Free Buys at 13:30Z / 17:30Z / 21:30Z
  (8:30a / 12:30p / 4:30p Chicago), `any_future_on_the_hour = 0`, version
  recorded. The two remaining `%:00` keys in a loose ad-hoc sweep are
  **today's already-COMPLETED midnight events** (started 05:00Z, before the
  conform) - past keys, out of scope by design.

## What Dan will still see through 2026-10-19, and why it is right

The 28 transition events keep their advertised **250 / 500** guarantees. The
freeBuyAudit's guarantee lines for them stay up until each plays out - that is
the settlement-contract law speaking, not an unfixed defect. From **2026-10-20**
every Free Buy carries the doubled **500 / 1,000** tier natively, minted from
the schedule, and the audit falls silent.

## The root cause that remains open (follow-up, documented)

The class defect is that the engine board writer conforms **schedules** but
not **pre-spawned, zero-paid occurrences** when a schedule changes. This
migration settled the live board; the engine-side conform (the board writer
moving its own unfunded future occurrences on resync, under the same contract
freeze) is the hard-coded root fix and is logged as follow-up work - a data
migration must never be needed twice for this cause.
