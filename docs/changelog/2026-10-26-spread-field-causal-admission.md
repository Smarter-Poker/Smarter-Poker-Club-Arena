# Admit an undealable tournament at its causal edge

TournamentManagerBase previously declared consolidation only after a balance pass or a held blind level. The last hand leaving players alone on separate tables merely joined the general scheduler queue. A saturated general queue could delay that first balance pass even with the existing consolidation slot idle. Manager registration also discarded the mark and waited for a later pass.

The hand-completion callback now classifies a spread field from the complete finite final stacks of its own current dealer and conservative occupied-chair counts on the other dealers. Registration classifies an already spread adopted field. Both use the existing consolidation lane; the authoritative elimination/balance transaction still decides every bust and move. A healthy table, partial/invalid completion, single-table finish, stopped manager or replaced dealer does not acquire consolidation priority. No new timer, retry loop, concurrency capacity or financial write is introduced.

The maintained consolidation law includes real hand callbacks and a real saturated scheduler with 200 waiting peers. Before the change the new hand-edge case failed because only the busy peer was admitted; after the change the spread event takes the existing consolidation slot. Adoption and negative ownership/roster cases are retained. Historical alert attribution is recorded separately in the task evidence and is not inferred from this reproduction.

Verification: source reread; focused regression passes. Connected suites, compilation and protected runtime delivery are pending.
