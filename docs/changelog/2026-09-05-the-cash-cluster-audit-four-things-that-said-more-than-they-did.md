# The cash cluster audit: four things that said more than they did

2026-09-05. A line-by-line read of the cash-game / cluster surface built over
the last two days - `server/src/cluster/**`, the Horse\* fleet modules, the
lobby client, and the live `fn_cash_*` functions - for stubs, dead code,
wiring gaps, regressions, disagreeing numbers, swallowed errors and laws that
have drifted from what they guard.

Four defects were small enough and safe enough to fix here. The rest are
recorded in the pull request; the largest of them needs SQL and is written up
rather than half done.

## 1. A config flag with no reader, on a table named for it

`TableConfig.straddleEnabled` and the one entry that set it
(`NLH Straddle 1.00/2.00`) were the last of the V23 straddle table. Ruling R2
retired the lane, Gate 7 deleted every table writer in `HorseFleetManager`,
and Gate 5's snapshot applier now forces `straddle_enabled`,
`auto_utg_straddle` and `voluntary_straddle` false on every cash table each
tick. `LeaguePmAndStraddle.test.ts` already asserts nothing READS
`config.straddleEnabled`, and its comment allowed the field to stay declared.

A switch on a wall connected to nothing is the config an agent restores by
"wiring it up". Both are deleted; the entry keeps its name, which is a fleet
config key rather than a live game.

## 2. Four comments describing a method that was deleted

`retireSurplusTables()` is gone (Gate 7: a cash table is closed only by its
game's ClusterController). Four places still said it closes a drained table:
`HorseFleetManager.seedAllTables`, `HorseSessionRotator` twice,
`StableHandExecutor.RETIRE_FLAG`, and `StableHandController`.

The comments were the whole documentation of the `retire_when_empty`
mechanism, so the file said the drain ends in a closed row. It does not. The
drain still works - the fleet stops seeding, the rotator walks the horses out

- and then nothing closes the table.

Measured 2026-09-05: 0 tables carry the flag and 0 non-cluster cash tables
exist, and every path that would set it skips cluster tables, so the missing
closer costs nothing today. The comments now say that, in the place an agent
reads before re-adding a closer.

## 3. The SQL-side freeze was skipped without being counted

`ClusterController.tick()` learns about the maintenance break twice: locally,
before any I/O, and from `fn_cash_clusters_tick_all`, which checks again and
returns `skipped: 'frozen'` when the break began between the two. The local
exit incremented `poker_cluster_pass_skipped_frozen_total`. The SQL-side exit
set the summary flag and returned, counting nothing - so every break
undercounted by however many passes started just before :53.

Both exits go through one `frozenSkip` helper now. That is also what keeps
`theClusterPages.law.test.ts` counting exactly one `recordSkippedFrozen` call
in the file, which is the pin it uses to keep this controller's metric edits
to three lines while other branches work on it.

The pin in `TheTablesOpenAndCloseThemselves.law.test.ts` that read the literal
`if (frozen()) { summary.skippedFrozen = true;` MOVED TO THE NEW MECHANISM in
this same commit (CLAUDE.md 10.6), and now asserts both exits and the counter
rather than one exit's shape.

A skip is still deliberately not a pass: `recordPass` is not called, the last
pass timestamp keeps ageing, and the stall rule stays quiet only because it
carries the `poker_maintenance_break_active` guard.

## 4. The join door knew why it was refusing and would not say

`fn_cash_game_join` raises `GAME_BARRED:<seconds>` for a player booted for low
VPIP, and `joinGameRefusalText` had no entry for that code: Take A Chair on the
corner box (`CashClusterHUD`) answered "The Game Could Not Seat You Right Now."
while the buy-in modal three taps away said "You Were Removed For Low VPIP. You
May Rejoin This Game In 4 Minutes."

The bar is now delegated to `cashBuyInRefusalText`, which already writes that
sentence, rather than copied - two copies of one sentence is how two doors end
up describing one bar differently. Only `GAME_BARRED` is delegated: asking the
buy-in translator about every refusal would let a buy-in sentence answer a join
question.

## 5. A health probe that threw returned four zeroes and said nothing

`HorseFleetManager.getFleetHealth` deliberately answers `{0,0,0,0}` on an
INCOMPLETE read, with a comment saying a silent undercount is a lie. The
`catch` returned the same four zeroes for a THROWN read with nothing reported
anywhere, so the two indistinguishable answers had one visible cause between
them. It reports now; the zeroes still stand.

## What was checked and found clean

- No TODO, FIXME, `@ts-ignore` or `@ts-expect-error` anywhere on the surface.
- No `.single()` (CLAUDE.md rule 1) in any of it.
- No exported function without a caller. Every `catch` on the cluster and
  fleet path either reports or is annotated best-effort with a reason.
- `wakeCluster` cannot throw into the dealing loop: the engine wrapper and the
  exported function both swallow and report.
- `HorseDisabledGames`, `HorseBuyerAllocation` and `HorseRejoinConstraints`
  are pure, wired at one call site each, and fail OPEN on a short read with
  the failure counted on the beat.
- No pair of commits in the last two days moves one rule in opposite
  directions. #3172 and #3176 carry the same title and are two halves of one
  piece of work, not a revert.
