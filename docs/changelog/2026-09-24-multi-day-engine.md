# 2026-09-24: Multi-Day Tournaments, Engine Half (R2 and R5)

Assignment CA-PRODUCT-COMPLETION-2026-09-22. Design:
`docs/handoffs/club-arena-product-completion/MULTI-DAY-DESIGN.md` (sections 3,
5, 6, 8, 9 and 11). Database half: migrations `20260924043217` to
`20260924043239`. Nothing here is reachable until a sealed stage plan exists
AND `fn_capability_available('tournament.multi_day.single_flight')` is true;
before the migrations are installed a missing table or function (42P01, 42883,
PGRST202, PGRST205) reads as "no multi-day".

## R2: every server reader understands BAGGED

`server/src/types.ts` carries `BAGGED`. Reader decisions:

| Reader                                                                                                                           | Decision                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `TournamentManagerBase.startLifecycle` status exclusion                                                                          | BAGGED added: a launch never touches a bagged row.                                        |
| `TournamentManagerBase.resumeLifecycle` (`status !== 'RUNNING'` returns)                                                         | Unchanged: BAGGED has no manager.                                                         |
| `GameServer.discoverRunningResumes` board (`.eq('status','RUNNING')`)                                                            | Unchanged: ignores BAGGED; pinned by a test.                                              |
| `TournamentRecurringService.horseLoadMap` registration load                                                                      | BAGGED added: a bagged event occupies its horses (no seats exist, so no double count).    |
| `TournamentRecurringService` live-MTT floor count, XMTT duplicate guard, `getActiveCount`                                        | BAGGED added: a bagged instance is live, not a gap to refill.                             |
| `ScheduledTournamentService.LIVE_STATUSES`                                                                                       | BAGGED added: an interval schedule does not respawn over a bagged event.                  |
| `liveTournamentTableRecovery.isLiveTournamentStatus`                                                                             | Unchanged, documented: the bag closes tables on purpose; reopening one would be wrong.    |
| GameServer RUNNING sweeps (decided finish, never dealt, 12h stale, seat-first stuck, restart count)                              | Unchanged: none of them may act on an event with no seats.                                |
| Break release, blind publication, thaw resync, add-on window, launch receipts, final-table deal, terminal and satellite outcomes | Unchanged: RUNNING-only by design; no window crosses a bag.                               |
| `TournamentBrainContext` registration, add-on, rebuy windows                                                                     | Unchanged: closed while BAGGED, as the database closes them.                              |
| `HorseLifecycleManager` finished-event reset (COMPLETED, CANCELLED)                                                              | Unchanged: a bagged event's horses still belong to it.                                    |
| `HorseFleetManager` and `HorseSessionRotator` booking reads                                                                      | Unchanged: they mirror `fn_concurrent_game_load` and a start_time window; see follow-ups. |

## R5: the engine's stage lifecycle

- `advanceBlindLevel`: when the level that just expired is the running stage's
  `end_after_level` and a next stage exists, `fn_begin_stage_end` records the
  intent and the stage-end pause takes the event; nothing is published and the
  level clock stays unarmed.
- `stageEndPause` is a fourth pause authority beside the break, the add-on
  break and hand-for-hand. Replacement engines inherit it
  (`prepareManagedTableEngineForPlay`); `isOnBreak()` answers for it so the
  maintenance resume, hand-for-hand and the bubble burst cannot lift it; the
  break end and the add-on break end neither resume its tables nor arm its
  clock; `pauseForBreak` is refused while it is set.
- The barrier bags (`fn_bag_tournament_stage`, per-table watermarks from
  `hand_atomic_commits`) once every table is parked, no elimination sweep is
  running and no table is recovering. It is driven by edges only: a table
  parking, a sweep finishing, the maintenance thaw. A `platform_frozen`
  refusal waits for the thaw notification (`onMaintenanceThaw`); a felt not yet
  at rest re-drives the elimination sweep, bounded; a lost answer stands the
  manager down so the durable record decides.
- `resumeLifecycle` re-arms the pause from a `day_ending` stage before any
  replacement dealer exists.
- `GameServer.discoverStageResumes` reads the BAGGED board every 30 seconds and
  keeps one wake timer per due time (`tournament/stageResumeSchedule.ts`). The
  wake admits a manager in `stage_resume` mode: `fn_begin_stage_resume` with
  the first level from the engine's own `resolveBlindLevel`,
  `fn_seat_stage_entitlement` per entitlement (one random draw, humans and
  horses together), `fn_complete_stage_resume`, then the ordinary running
  manager. Every step waits out the :55 freeze.
- Broadcasts on `t-break-<id>`: `stage_day_ending` and `stage_bagged`.

## Tests

`server/src/tournament/MultiDayStageLifecycle.test.ts`,
`server/src/tournament/stageResumeSchedule.test.ts`, and the law
`server/src/tournament/aBaggedHorseIsABaggedPlayer.law.test.ts`
(`docs/laws.d/a-bagged-horse-is-a-bagged-player.md`). Two pinned source tests
were extended in the same change: the break-release pins in
`FreeBuyAddOnLifecycle.guard.test.ts` now also name the stage-end pause, and
`DirectEngineRecovery.guard.test.ts` counts five discovery lanes.
