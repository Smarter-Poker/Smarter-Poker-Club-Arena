# Phase 15 exact replay: addendum to the predeclared window (2026-10-16)

Written 2026-10-16 after the copy and the rule-based selection, BEFORE any record was replayed.

1. The serving release changed inside the declared window. A scheduled engine maintenance break began
   18:53:00Z (break 1792176780001); release `098071833b4e4a8240f60cb884882ffb11d55787` (#7116, on main)
   resumed the tables at 19:00:53Z (/health `releaseSha` read 19:06Z, uptime 610 s). The copy holds
   decision records of `4c3509e5` from 18:49Z to 18:54Z and of `09807183` from 19:00Z to 19:04Z, and none
   in between. `git diff 4c3509e5 09807183` touches no file under server/src/engine, server/src/gto,
   server/src/services/horseDecisionJournal, server/scripts or the server package files (only Lightning
   files differ), but a record replays only on the exact source it names.
2. Copy: taken 19:04:34Z to 19:04:49Z, 30,500 segment files (archive 9,068, shard-1 9,954, shard-2
   11,478); 134,587 records (31,156 decision, 31,162 execution, 1,986 plan_receipt, 7,509 accepted_hand,
   62,545 request_lifecycle, 114 discard_decision, 115 discard_execution); copy sha256
   `6cbfff3fa569f7394c65d46b47aa32c161696c0c54bca171dd07e1e3874d5e1e`.
3. The declared rules, applied unchanged:
   - Batch A (18:55:00Z to 18:56:30Z) selects 0 records: the window fell inside the maintenance break.
   - Batch V selects 450 records (50 for each of the nine variants), all made by `09807183`.
   - Batch Q selects 600 records, all made by `09807183`.
     Each is therefore replayed on a clean checkout of `09807183` (the release serving now), not of
     `4c3509e5` as the declaration assumed. Nothing else in the rules changes.
4. Supplementary batch P, chosen after the copy was read and therefore NOT predeclared: every decision
   record in the declared window [18:52:00Z, 19:02:00Z) whose decision carries a qualified pack receipt
   with `applied: true` (16: 10 by `4c3509e5`, 6 by `09807183`; all cash; plo4, plo5, plo6, plo8, flh).
   Each is replayed on the checkout of its own source.
