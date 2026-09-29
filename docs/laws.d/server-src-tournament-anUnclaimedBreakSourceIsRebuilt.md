# server/src/tournament/anUnclaimedBreakSourceIsRebuilt.law.test.ts

A Killed Break Source Whose Park Was Never Claimed Is Rebuilt: on 2026-09-26
between 04:22 and 04:43 UTC ten tables in four events (55 players seated) had a
table-break row at `park_requested`, revision 0, custody null, and a dealer
killed by `dealing_loop_10_consecutive_errors` or `tournament_table_zombie`.
Engine recovery refused to replace them (`recovery:break_source_retained`)
because the break retained the source, and the break could not move because
its park probe had missed and a stopped engine only accepts an already-claimed
park. They were 22 of 30 stalled-table observations and `deadStalledCount`
went from 2 to 9. With a real ServerTableEngine and the real TournamentManager
recovery and break path this pins that, for both kill reasons, a retained
source whose park was never claimed is replaced by a fresh engine admitted
movement-only through `fn_f06_admit_parked_movement` and the break reaches
`begun` against that engine without a hand ever being allocated; and that a
source whose park WAS claimed keeps its quarantine and is not replaced.
