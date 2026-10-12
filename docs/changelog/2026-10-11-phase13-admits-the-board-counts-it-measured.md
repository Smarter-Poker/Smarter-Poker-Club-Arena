# Phase 13 Admits The Board Counts It Measured

**Date:** 2026-10-11

Phase 13 admission no longer requires every board-count cell of the natural completion record to clear the floor. It requires every street to clear it (preflop, flop, turn, river) and at least one board count, and it admits only the board counts whose own cells clear it. The joint candidate acts only on a hand with an admitted board count; every other hand keeps the variant's current brain.

## Why

Production has never dealt a three-board joint decision: `phase13_board_3` has not appeared in `horse_brain_telemetry` since telemetry began on 2026-09-12. Under the old rule the three-board cell always had no evidence, so no variant could ever be admitted however well its measured cells played. A cell with no evidence still admits nothing; it no longer blocks the cells that do have evidence.

## What Changed

- `HorsePhase13Authority.ts`: `horsePhase13CompletionAdmittedBoardCounts` reads a record (empty unless every street clears the floor, then each board count whose cell clears it); admission refuses `completion_below_floor` only when that is empty. An admitted authority carries `admittedBoardCounts`, and `HORSE_PHASE13_COMPLETION_ADMISSION` (`horse-phase13-completion-admission-v1`) is bound into its authority key with the admitted counts. `horsePhase13AdmittedMode` takes the decision's `boardCount` and the holder's authority, and returns candidate only on an admitted board count (`horsePhase13BoardCountAdmitted`; absent means one board).
- `HorseQualifiedAuthority.ts`: the authority record gains `admittedBoardCounts`; the gate exposes `mainAuthority()` (read only).
- `workerRuntime.ts`: the worker passes the request's board count and the holder's current authority.
- `ServerTableEngineTurns.ts`: at acceptance the table re-checks the board count against the main holder's authority; an applied candidate on a board count it did not admit is treated as `mismatched` and never acts.

None of these four files is in a Phase 10, 11, 12 or 13 policy digest list, so no policy digest changes with this.

Tests: `HorsePhase13Authority.test.ts` (which counts are admitted, the key binding, a failing street admitting nothing, the admitted mode by board count) and `HorsePhase13Selection.test.ts` (candidate only on an admitted board count, and a candidate on an unadmitted board count stays shadow and plays the reference at the worker boundary).
