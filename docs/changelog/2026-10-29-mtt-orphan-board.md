# Complete tournament seat recovery inputs

`TournamentManager.absorbOrphanedSeats` read all tournament tables and live
chairs with unpaged queries. PostgREST can return only the first 1,000 rows.
A stranded player after that boundary disappeared; a second closed-table source
for the same player could disappear and make an ambiguous source look unique.
The entire table-ID inventory also went into one URL filter.

The original planning path now reads both complete inventories by stable ID,
using the explicit seat-to-table relationship to scope chairs to the tournament.
Incomplete reads and withdrawn manager admission cannot reach the planner or
movement path. The existing atomic movement authority, source-custody checks,
seat reuse, receipts, and per-pass budget remain authoritative. No new scheduled
repair or alternate mutation path was introduced.

Three real-manager regressions failed before the change, including a realistic
1,000-chair field across 112 tables and a late-page read failure. After the fix,
54 connected manager, retirement, planner, and wiring cases passed, including
late source ambiguity, partial chair inventory, and admission withdrawal.
The existing diagnostic fixture now supports the ordered read and checks the
named tournament relationship while preserving its no-movement assertions.
Both compilers are checked separately; hosted checks and engine activation
remain required. This boundary defect is not established as the cause of the
current smaller frozen tournaments. Separate requests remain separate database
snapshots; atomic movement validation still decides whether a proposed move is
legal at execution.
