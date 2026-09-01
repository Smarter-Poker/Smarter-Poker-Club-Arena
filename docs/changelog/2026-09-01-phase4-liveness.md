# Phase 4 of 7 - liveness: a tournament that stops dealing is noticed

2026-09-01. Branch `phase4/liveness`.

Phase 4 was scoped from an earlier audit as four items. Three were real and are
fixed here. The fourth did not reproduce, and the measurement that says so is
below rather than a fix nobody needed.

---

## 4.1 RUNNING but not dealing - the stranded player

**Found live, not inferred.** At 12:12 UTC on 2026-09-01:

```
"$100 Freeroll - 12:00 AM"  (73ebcc3b)
  status RUNNING, started 05:00 UTC, level 78
  7,844 hands dealt, then NOTHING for 5 hours 21 minutes
  tournament_players:  2 'playing'
  table 43  status 'running'   1 live seat   stack 4,680,246.92
  table 37  status 'closed'    1 live seat   stack     11,481.50
```

The second entrant was never moved off table 37 and never released from it. The
engine therefore counted two live players, the one table that could deal held
one of them, and the hand that would have ended the tournament could not be
dealt. The event and 11,482 chips sat there.

**Why nothing caught it.** Three sweeps exist and this shape falls between all
three, which is exactly why it can sit for hours:

| sweep                   | requires       | this row       |
| ----------------------- | -------------- | -------------- |
| decided-but-running     | `playing <= 1` | 2 playing      |
| started-but-never-dealt | 0 hands        | 7,844 hands    |
| reopen-closed-tables    | NO open table  | one open table |

The third is the closest and it declines on purpose: reopening table 37 would
put a second felt under a two-player tournament. The repair is the other
direction - bring the stranded player to the felt that is already open, which
is what the balancer would have done had it ever seen the seat. It cannot:
`checkTableBalance` iterates `tableEngines`, and a closed table has no engine.

**The fix.** `server/src/tournament/orphanedSeatRepair.ts` is a pure planner
(12 tests). `TournamentManager.absorbOrphanedSeats()` does the two reads, both
failing CLOSED, and hands the plan to `executePlayerMoves` - the one hardened
seat-move path on the platform. It adds no second way to move a player, and a
test pins that it never writes `table_seats` itself, because every
duplicate-seat incident here (2026-08-20, 2026-08-25) came from a seat write
that was not that one. `GameServer.repairOrphanedTournamentSeats()` runs it on
the same one-minute cadence as its two neighbouring sweeps.

What the planner refuses to do, each pinned by a test:

- a player already holding a live seat on open felt is never re-seated - two
  live seats is a money question (which stack is real), not a repair;
- a stranded seat with no chips is never moved - that is a busted player and
  the elimination path owns it;
- with no open table there is no plan - `liveTournamentTableRecovery` owns that;
- a player stranded on two closed tables at once is left alone;
- destinations are deterministic (emptiest open table, ties by id, lowest free
  seat) so two engines planning the same repair plan the same move;
- at most 9 moves a pass, so a broken board cannot become its own outage.

**How common.** Over the 24 hours to 12:12 UTC, of 5,017 tournaments that dealt
at least one hand, 13 had a gap of more than 15 minutes between consecutive
hands and recovered; none recovered from a gap of more than 60 minutes. The one
above had been silent 321 minutes and was still silent.

## 4.2 The five-minute rule that only existed in a comment

`GameServer.ts` has carried this above the stuck-COMPLETING scan since the scan
was written:

```
// If a tournament has been in COMPLETING status for > 5 minutes, force it to COMPLETED.
```

The query underneath was `.eq('status', 'COMPLETING')` and nothing else. There
was no age test, and there cannot be one from the row: `tournaments.updated_at`
is not maintained by the writers on this path (checked live - a tournament that
was RUNNING and changing every few seconds carried an `updated_at` three days
old), so "how long has this been COMPLETING" is not a question the database can
answer.

It matters because `finishTournament` flips the row to COMPLETING **before** it
pays, and a manager leaves `tournamentEngines` the moment it stops - so there is
a window where a finish that is mid-payout looks abandoned. Idempotent ledger
keys are what have kept that race from costing money; they are not a reason to
keep running it.

`server/src/tournament/completingDwell.ts` measures the dwell in the process
that is watching (7 tests): a row is due only after it has been seen
continuously in COMPLETING for the full five minutes, a row that leaves the
state is forgotten so a completed event and a later stall never share a clock,
and an unreadable scan keeps the clocks rather than restarting all of them.

Three rows were sitting in COMPLETING at 12:09 UTC, aged 19 to 27 minutes -
past the window either way, so this changes what they wait for, not whether
they are recovered.

## 4.3 `tournamentOwnedTables` only ever grew

`registerTableEngine` adds to the set; nothing has ever removed from it. On a
board creating roughly 7,000 tournament tables a day it grew without bound for
the life of the process, and the memory is the least of it: a table id in that
set is treated as "should be dealing" by the zombie reaper and is skipped by
`tableStateHub.dropTable`, so every long-dead table kept a hub room alive and
kept telling the reaper a false story about the board.

Pruned once per discovery pass against what is genuinely still owned: this
process's engines plus every table its live `TournamentManager`s hold
(`TournamentManagerBase.getTableIds()`, new). Pruning against `tableEngines`
alone would have been wrong, and the comment at the hub-drop site says why: a
tournament table can be briefly without an engine while its manager rebuilds
it, and dropping the room there costs the seated players a sequence reset.

## 4.4 The scheduled Duel born a husk - not reproducing

Measured rather than assumed. Every REGISTERING duel and Spin on the board
(32 and 32) owns a table; none is a husk. The 49 REGISTERING MTTs with no table
row are all scheduled for a future `start_time` (the nearest 105 minutes away),
which is the normal shape - an MTT gets its tables at start.

Nothing was changed for this item. If it returns, the shape to look for is a
2-max SNG that is REGISTERING with no table and a `start_time` in the past.

---

## Verification

- `npx tsc --noEmit` in `server/`: clean.
- New tests: 23 (12 planner, 7 dwell, 4 wiring pins).
- `npx vitest run src/tournament`: 50 files, 613 tests, all green.
- Every symbol the wiring pins assert is absent on `origin/main`, so all four
  of those assertions are red without this change.

## Not done here

The live `$100 Freeroll - 12:00 AM` is still stalled as this is written. Engine
code lands at the next restart window (Section 1 of CLAUDE.md), and the sweep
repairs it on the first discovery pass after that. Nothing was changed by hand
in production - rule 11.5.
