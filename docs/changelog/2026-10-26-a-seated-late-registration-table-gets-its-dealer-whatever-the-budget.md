# A seated late-registration table gets its dealer, whatever the sweep budget

2026-10-26. Reported by a player (Trustmefold) through Dan: "This a tournament
I'm in. I did a rebuy. That sat me at a table but no cards are being dealt."

## What happened

Production 13:28-13:55 UTC, engine `4dfd07ef`. Four busy rebuy events were
running: Sunrise Bounty (NLH) `3675640e` and `a5741141`, Morning Free Buy
(NLH) `540b3b42` and `247bde9d`, 168-346 entrants each, with constant busts,
rebuys and add-on offers.

Seven late-registration capacity tables were created (13:28:47-13:41:39) with
nine players seated at each. None was ever admitted
(`tournament_capacity_table_receipts.manager_admitted_at` stayed null), so no
dealer started and the players sat with no cards while every other table of the
same events dealt normally. Sunrise Bounty table 22 (`35a9c43f`), Trustmefold's
table, waited 26 minutes. Durable manager wakes for all four events stopped
being acknowledged at 13:27-13:29 (generations climbed to 104) because no pass
of their sweeps ever completed.

All seven were admitted at 13:55:41-13:55:43, the instant the :55 break
stopped the busting, through the expansion stage (6). That is the signature of
the cause below.

## Cause

`admitCommittedCapacityTables` (added 2026-10-25, #8093, to stop exactly this
kind of wait) was fenced by `eliminationMutationAllowed()`, which turns false
once the sweep's 5 s work budget is spent. It also ran after three steps that
spend that budget or end the pass: the add-on offer loop (up to ten batches,
run until the budget is gone), the entry-window RPC (which takes the
tournament row lock that every rebuy also takes), and the accepted-entry
seating read. On a busy field, every pass reached admission with the budget
spent, and admission returned silently without starting a dealer. Stage 6, the
other admission path, is reached only when busting stops, at the :55 break.

## Fix

- Admission runs straight after the entry-window reconcile (which adopts an
  external terminal outcome first and is not budget-fenced) and before the
  accepted-entry seating read, so neither the seating read nor a spent budget
  can end the pass before a seated table gets its dealer.
- `admitCommittedCapacityTables` is fenced only by manager stop, the
  scheduler's abort and the platform freeze, never by the work budget. It is
  one indexed read, a local dealer start for players already seated, and one
  acknowledgement. It creates no table, moves no seat and runs no rebalance;
  those stay in stage 6 after balancing, as before.

Pinned by `server/src/tournament/LateRegistrationCapacity.guard.test.ts`
(order: admission after the entry-window reconcile and before the seating
read; fence: no budget check).

## Damage

None to money: no chips moved while the tables waited, and every seated player
kept their stack. The seven tables were admitted at the 13:55 break and deal
from the end of that break.
