# A killed break source whose park was never claimed is rebuilt, and a full field is not the last table (2026-09-26)

## Defect 1: a dead break source waited for a break that waited for it

### What production showed

2026-09-26, 04:22-04:43 UTC. Ten tables in four events each had a table-break
row in `smarter_private.f06_operations` at `park_requested`, revision 0,
`custody_id` null, and a dealer that had been killed by
`dealing_loop_10_consecutive_errors` or `tournament_table_zombie`:

| Table    | Event    | Break    | Requested (UTC) | Seated |
| -------- | -------- | -------- | --------------- | ------ |
| bc2d52a8 | 97891eba | c4791289 | 04:22:26        | 3      |
| 65e73842 | 97891eba | c28f10c6 | 04:23:50        | 2      |
| 0168f878 | 494355f1 | c58f532d | 04:26:57        | 6      |
| 127b9363 | 494355f1 | c51a0075 | 04:28:45        | 6      |
| 587ad1e6 | b9086e8a | e4d833dd | 04:30:41        | 4      |
| 9702ef3c | 494355f1 | 71a8d686 | 04:32:00        | 6      |
| 155227b2 | 494355f1 | 866735dc | 04:34:35        | 6      |
| 80fe03f3 | 839f4ca3 | 5bd17749 | 04:35:12        | 5      |
| 3d08b81d | 494355f1 | 812e0337 | 04:36:27        | 5      |
| 7341017f | 494355f1 | 49266247 | 04:37:27        | 6      |

55 players seated, none of the ten rebuilt. They were 22 of the 30
stalled-table observations from 04:31 to 04:43, and `deadStalledCount` went
from 2 to 9. Each stopped engine stayed registered and counted in
`/health.stalledTables`.

### Why

Engine recovery (`performManagedTableEngineRecovery`) asks the seat-move
certificate (`resolveTournamentSeatMoveQuarantine`) whether the stopped engine
may be replaced. Its recovery branch refused
(`recovery:break_source_retained`) because the break still retained that
engine as its source, and recovery rescheduled itself for ever.

The break could not move either. Its one-second park probe had missed (the
table was mid-hand), so the park was armed but never claimed, and the kill
dropped the unclaimed owner (`clearUnclaimedTournamentMovePauses`). On a
stopped engine `parkForTournamentMove` answers yes only for a park that was
already claimed, so `prepareParkedTournamentBreak` returned null on every pass.
Recovery waited for the break and the break waited for a live engine.

### What changed

`TournamentManager.resolveTournamentSeatMoveQuarantine`, recovery branch: a
retained break source whose engine has no claimed move boundary
(`hasClaimedTournamentMoveBoundary()` false) has its retention released, and
recovery replaces the engine. A claimed boundary still refuses exactly as
before: a move may have been decided against that generation, and the stopped
engine is the quarantine that replays it.

An unclaimed retention protects nothing a replacement could cross: no move was
decided, none is in flight, and while the row exists the database refuses
every hand on the table (`source_excluded`). The replacement meets
`source_excluded` at admission and takes the existing path,
`startParkedMovementEngine` then `fn_f06_admit_parked_movement` (which claims a
null custody; confirmed in production on table 715aee14 at 04:16:14), and the
break retains and parks that engine on its next pass. No new state, no timer,
no migration.

## Defect 2: a capacity shortage was read as the last table

### What production showed

Event 45b5b001, table 7441f3b1. A hand permit of generation 1aafc375 was left
unresolved, so the original-admission recovery requested a break (row
4c53987e, `park_requested`, 04:30:20) and retired the stopped original under
custody (revision 1). The permit was decided `never_started`. The table held
9 players; the four other open 9-max tables held 7 + 7 + 8 + 7 when read at
04:50 (8 + 7 + 8 + 7 in the incident window), so there were 6 to 7 free seats
for 9 players. `prepareParkedTournamentBreak` correctly answered null, and the
stopped-original path in `retireTournamentBreak` read every null as "this is
the last table": it called `continueNoStartLastTable`, SQL refused
(`F06_CONTINUATION_LAST_TABLE_REQUIRED`, five tables open), and every sweep
threw "F06 original placement remains pending".

### Was the planner wrong?

No. The balancer never plans a break the other tables cannot absorb:
`TableBalancer.shouldBreakTable` returns false when the other tables' free
seats are fewer than the source's players, and the planner in
`checkTableBalance` requests a park only when `breakTable` places the whole
roster. This break came from `recoverF06OriginalAdmissions`, which parks any
table whose permit is unresolved; for a never-started original the F06
contract has exactly two lawful outcomes, the last-table continuation and a
break, so a non-last table has to wait for seats.

### What changed

- The stopped-original path asks the continuation only when the source is the
  event's only open table (`isOnlyOpenTournamentTable`, the read-only hint
  `continueExcludedNoStartTable` already used; SQL repeats the locked check).
- Any other source ends the attempt as a named wait
  (`TournamentBreakAwaitsSeatsError`), thrown inside retirement custody so the
  custody keeps the table fenced under the same identity, and turned back into
  a pending break by `retireTournamentBreak`: no error is reported, the
  Manager's existing redrive is requested (`requestUrgentEliminationSweepAfter`,
  and a bust elsewhere wakes the sweep anyway), and the wait is logged once per
  break.
- A capacity refusal from BEGIN itself (row still pre-manifest) is the same
  wait.
- The true last open table keeps today's behaviour.

## Proof

`server/src/tournament/anUnclaimedBreakSourceIsRebuilt.law.test.ts` (real
ServerTableEngine, real TournamentManager recovery and break path): the break
is requested mid-hand, the probe misses, the engine is killed, and the real
restart signal drives recovery. Before: 2 of 3 fail (both kill reasons, with
`recovery:break_source_retained` and no replacement); the claimed-boundary
case passes. After: 3 of 3, with a fresh engine admitted movement-only, the
break at `begun` against it, and no hand allocated.

`server/src/tournament/aFullFieldIsNotTheLastTable.law.test.ts` (real Manager,
custody, permit and balancer; 9 players on the source, four 9-max tables
holding 8 + 7 + 8 + 7): before, 1 of 2 fails with "F06 original placement
remains pending"; the last-table case passes. After: 2 of 2. The source never
asks the continuation, raises nothing across three sweeps, keeps the same
custody and a fenced table, and when three players bust elsewhere the break
begins, moves all nine and is acknowledged.

Adjusted: `aRetainedBreakSourceIsNotASeatMove.test.ts` (the recovery refusal
is now pinned with a claimed park, plus the unclaimed release) and
`F06OriginalManagerFlow.test.ts` (the last-table fixture has one open table;
the two-table capacity delay now waits instead of throwing).

Suites: every server test file importing ServerTableEngine(Base),
TournamentManager(Base) or GameServer, 188 files: 2,683 passed, 166 skipped.
`tsc --noEmit -p server` clean.

Composes with PR #5291 (break-held park): its durable-break owner is unclaimed
and is dropped on kill like any unclaimed owner, so its killed sources take
this path; its hunks are not touched.
