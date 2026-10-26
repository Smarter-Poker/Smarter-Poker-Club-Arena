# The engine log outlives the incident (2026-10-25)

Lease follow-ups, phase 2 of 5. Phase 0 (PR #8066) and phase 1 (PR #8089)
fixed the lease loss at its root. This phase fixes the thing that made the
incident hard to read: by the time the 13:27:10 UTC kill storm was being
investigated, the engine's own log of it was gone.

## What was measured on engine-01

- The engine container logs through Docker's json-file driver with a window of
  5 x 50 MB = 250 MB. `save_outgoing_log` in `server/scripts/engine-up.sh`
  dumps that window to `/var/log/club-arena-engine/` when the container is
  replaced, so the archive can only ever hold what the daemon still had.
- The engine wrote 94-140 MB of log an hour. The window therefore held under
  two hours of play. An incident at 13:27 UTC read at 19:50 UTC had rotated
  out six times over.
- 85% of the volume was two routine emitters, neither of them a fault:
  - `[TurnFSM] FORCED state: timer_running -> waiting` 49,517 times and
    `[PreActionFSM] FORCED state: idle -> idle` 2,601 times in ten minutes
    (about 80 lines a second). Both come from `StateMachine.forceState`,
    whose warning exists for a state the table did not expect, called from
    the two designed boundary resets: turn start in
    `ServerTableEngineTurns.handleTurnChange` ("reset to waiting at turn
    start") and hand end in `PreActionEngine.clearTable` ("reset all player
    FSMs back to idle").
  - `Error: opponent memory unavailable: busy` with a full stack, 17,921 times
    in ten minutes (115,311 stack lines). That is the opponent-memory read
    admission refusing a ninth concurrent read, which is what it is designed
    to do under load, already counted in horse telemetry
    (`horse_opponent_memory_read_busy`), and reported through `reportError`
    as if it were an unexpected failure.
- The archive dump had a 20 s budget. That was right when it ran in line,
  inside the cutover, and since 2026-10-19 it runs in the background after the
  replacement has started, where a bigger window would simply have been cut
  off.

## What changed

1. `StateMachine.reset(state)` - returns to a boundary state by design and
   logs nothing. The two designed resets above call it. `forceState` keeps its
   warning for the genuine recovery sites (for example the turn clock re-arm
   that cannot transition).
2. `errorReporter.reportThrottled(context, message)` - one `console.warn` per
   60 s window per context, the first refusal of a quiet window printed at
   once so a new episode is visible the moment it starts, the rest held and
   reported as `(N more in the last 60s)` on the next line. Never a stack.
   `isOpponentMemoryBusyRefusal` recognises exactly the admission refusal.
   Every opponent-memory reader routes that one refusal through it:
   `HorseOpponentMemory` (decision and donor reads), `HandHistory`
   (completed-hand read) and `LightningHorseObservation`. Any other error at
   those sites is reported exactly as before.
3. `engine-up.sh` json-file window 5 x 50 MB -> 24 x 100 MB
   (`LOG_WINDOW_FILE_SIZE`, `LOG_WINDOW_FILES`; 2.4 GB of the 241 GB free on
   engine-01). At the old rate that is a day; at the rate after (1) and (2)
   it is about a week. The background retirement dump gets a 600 s budget
   (`LOG_DUMP_BUDGET_BACKGROUND`); the in-line fallback inside the cutover
   keeps 20 s (`LOG_DUMP_BUDGET_INLINE`). The pipeline string, archive naming
   and retention (14 days / 6 GB) are unchanged.

## Pins

- `server/src/engine/aDesignedResetIsNotARecovery.test.ts` - `reset()` is
  silent, `forceState()` still warns, and the two boundary sites use `reset`.
- `server/src/services/errorReporter.local.test.ts` - the throttle window,
  the held count, the quiet-window restart, no stack, and every reader routes
  the busy refusal through it.
- `tests/the-replacement-is-created-during-the-outgoing-grace.law.test.ts` -
  the run-spec carries `max-size=100m` and `max-file=24`.

## What goes live when

The `engine-up.sh` and engine source changes ride the next engine release
(daily 04:00 America/Chicago unless an emergency restart happens first); the
new window applies to the container that release creates. Nothing here
changes player-facing behaviour, money, seats or timing.

## Not in this phase

- The lease loss at 21:41:18 UTC (tournament 5469ba74) with no `busy`
  heartbeat answer: the engine-side renewal refusal is still lumped under the
  `unproven` verdict (10.86 shape). Later phase.
- The engine restarts outside 04:00 today (18:29, 19:29, 21:05, 23:56 UTC) and
  the failed 18:15 UTC deploy attempt (run 40220380663). Phase 5.
