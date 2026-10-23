# 2026-10-23 The PLO Board Fits Its Players

Dan, 15:50 CDT: "GO AHEAD AND FULLY BUILD, FIX AND ENHANCE ALL OF THESE."

## Fuller Tables Fill First

The fleet's seeding walk went by table id inside a rank, so a scarce pool
landed two horses on every table (71 players on 22 of 36 PLO tables at
15:00). `fillFirstRank` (HorseLoneTable.ts) now ranks the table with more
players ahead inside the same rank; the short-handed human, the opening feeder
and the main order still come first. Pinned by `HorseFillFirst.test.ts`.

## One PLO Game Per Stake

Midway Union carried Classic, Action and Madness at every PLO stake. Per
variant and big blind the game with the most players stays on (people first,
then Classic); the other 22 were switched off at 20:55 UTC. A switched-off
game seeds nobody and closes its tables once empty, and a kept game still opens
feeders when its Main is full. `HorseSessionRotator` now stands horses up at
the end of the hand at a switched-off game's table, never while a person is
seated there (`horsesLeaveSwitchedOffGame`, `HorseSwitchedOffGame.test.ts`).

## The Roster Rules Are Written Down

Three sessions rewrote the roster functions today, two from branches that never
reached main, and one put back the PLO tag stripping. Migration
`20261023205714` records the installed bodies, the winners-rule refresh job
(50 at cash; PLO list 1 bb/100 over 2,000 PLO hands across 90 days) and the
PLO board trim. `tests/the-horse-roster-keeps-its-rules.law.test.ts` pins the
rules in whichever migration defines the functions last.

## The Winners Re-Rank Every Six Hours

`ca-horse-roster-refresh` runs at 03:15, 09:15, 15:15 and 21:15 UTC with the
winners rule, so a horse that starts losing at PLO leaves the list and a newly
proven winner joins it.
