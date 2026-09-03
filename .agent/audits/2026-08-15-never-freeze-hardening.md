# 2026-08-15 — "Games can never freeze": full-surface hardening

Dan, verbatim: _"It's important to make sure games never ever ever die, or
freeze... do a deep dive on any and all things that can cause this to ever
happen again, literally everything, and prevent it. Then harden the process so
games can never do this again."_

Four parallel audits (hand engine / timers+deadlines / process+infra+lifecycle /
horses+transport). **20 distinct defects**, every one a real permanent-freeze
path, each traced to file:line before being fixed. Shipped as PR #56
(`ce678b73`). The morning's first-pass fixes are in PR #54.

## The watchdog shipped that morning was itself broken

Worth stating plainly: the freeze recovery added in PR #54 did not work, and in
one case was actively harmful. All three were found by the audit, not in
testing.

1. `markProgress()` ran unconditionally after a forced action, and it zeroes
   `watchdogTrips`. When the force was REJECTED — the exact state a stale turn
   pointer produces — the ladder reset every cycle, so **Tier 3 (kill and
   rebuild) was unreachable**. The table logged a stall every 45s, forever.
2. Tier 1 armed a clock but never reset `lastProgressAtMs`, so Tier 2 force-
   folded the player on the next 10s heartbeat — 7s before the clock Tier 1 had
   just granted would have expired. Tier 1 never did anything.
3. `HandController.advanceStage` emits `ALL_IN_RUNOUT` without clearing
   `currentPlayerSeat`. The watchdog therefore took its "stalled turn" branch on
   a perfectly healthy parked runout: it armed an action clock on an **all-in**
   player and forced check/folds from them, advancing the runout one street per
   watchdog cycle and writing phantom actions into hand history.

Lesson recorded: a recovery mechanism needs its own tests and its own review.
`FreezeRegression.test.ts` now covers all three.

## Two permanent freezes that were live in production during the audit

**Tournament tables had ZERO freeze recovery.** The zombie reaper gates on
`cash_tables_with_players`, whose SQL contains `t.tournament_id IS NULL`. So
when a tournament table's engine died, the `!isRunning()` branch deleted it from
`tableEngines` and **nothing anywhere rebuilt it**. `getTableEngine()` then
returns undefined, so `POST /action` answers 404 and reconnecting clients are
refused at the WS upgrade gate. Three tables with 13 seated players were frozen
this way (one in a RUNNING tournament, idle 20 minutes) while the audit ran.
Fixed with a `TournamentManager` liveness sweep + a `tournamentOwnedTables` set
so progress-based reaping applies to them.

**`dropTable()` orphaned every connected player.** It is called on _every_
engine teardown — watchdog kill, zombie rebuild, failed start, tournament table
break — all of which happen while players are connected. It deleted the room and
its subscriber Set, and the ONLY `hub.subscribe` call site is a new WebSocket
upgrade. Nothing re-subscribes an existing socket. So the rebuilt engine
published into a fresh empty room while every player's socket stayed open and
perfectly healthy (server PINGs, client PONGs) and received no SNAPSHOT, DELTA
or EVENT ever again.

> **A table could be fully recovered server-side and still be frozen forever on
> every single screen.** This is very likely what the ten tables that morning
> actually looked like to players, even where recovery worked.

## `performAction` returns false — five call sites, five freezes

`HandController.performAction` returns `false` on an illegal action; it does not
throw. Every `try { performAction(...) } catch { fallback }` in the engine was
silently doing nothing on rejection, leaving a seat with **no clock and no
action**. The human path was fixed for this in July ("the table froze with no
clock"), the horse path this morning — and the audit found three more:
pre-action, disconnect auto-action, and timer/time-bank expiry. All now route
through one `forceResolveSeat()` helper so it cannot reappear one call site at a
time. A regression test asserts the boolean contract directly.

## Everything else fixed

| Area            | Defect                                                                                                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Heartbeat       | Re-arm was the LAST statement in an unguarded callback — a throw killed that table's heartbeat, and with it horse liveness, disconnect detection and the watchdog. Now in a `finally`.                                                    |
| Runout          | `handleAllInRunout` called the SYNCHRONOUS `broadcastCurrentState()` upstream of `continueRunout()`, unwrapped — same shape as the TURN_CHANGE bug.                                                                                       |
| RIT / insurance | `onComplete` (the whole settlement cascade) ran in bare timer callbacks with interval+timeout already cleared: a throw meant nothing would ever retry. No hand-identity guard either, so a late wait could run out the NEXT hand's board. |
| Pineapple       | Auto-discard timer had no try/catch and no identity guard; its clear-branch tested a pre-discard snapshot copy that can never change, so the timer never cleared.                                                                         |
| Settlement      | `completeHand` mutates before it can fail; a throw left the pot refunded-but-undistributed with `HAND_COMPLETE` never emitted, hanging the loop for the 10-minute void. Now fails closed.                                                 |
| Deck            | `Deck.deal` throws on exhaustion, but `HAND_START` fires first and marks progress — an undealable table (plo6 @ 8+ seats) hot-looped forever with a GREEN watchdog.                                                                       |
| Roster          | `loadSeatedPlayers` returned `[]` on DB error, indistinguishable from an empty table: stopped synthetic horse heartbeats (mass disconnect at 30s) and made the watchdog read the table as idle-by-design.                                 |
| Time bank       | Auto-activation armed the turn clock with the whole remaining POOL (60s in prod) instead of the 15s granted — and that value is what `turn_deadline_ms` broadcasts, so clients were told 60s and auto-folded at 15.                       |
| Time bank       | Expiry guard tested a PER-TABLE FSM; an orphaned deadline from seat A could consume it and suppress seat B's auto-fold. Seat identity is now authoritative.                                                                               |
| Lifecycle       | `registerTableEngine` overwrote the map without stopping the predecessor — two live engines dealing one table.                                                                                                                            |
| Scheduler       | `killForRestart` leaked `insurance_offer:*` / `rit_offer` / `table_break:*` entries bound to a dead engine.                                                                                                                               |
| Services        | Horse interval services had no overlap guard — cycle pile-up under DB slowness is amplification that fires precisely during a freeze.                                                                                                     |

## Self-healing (the part Dan explicitly asked for)

`/health` returned `{"status":"ok","running":true}` for a process where every
table was frozen — and the deploy gate grepped for exactly that string. That is
why the morning's incident was reported by a player rather than by monitoring.

- **`liveness` field**: `dead` when any table with 2+ dealable seats has made no
  progress for 2 minutes, or discovery has stalled >60s. Plus per-table
  `msSinceProgress`, `stalledTables`, `discoveryStaleMs`.
- **Docker `HEALTHCHECK` bound to it.** There was none, so Docker's only restart
  trigger was process exit and a wedged-but-alive process was invisible to the
  supervisor. A frozen platform now restarts itself in ~60s, no human.
- **`uncaughtException` exits** instead of swallowing. Staying up left the
  process serving `/action` with half-settled hands and stuck locks, with an
  unused supervisor sitting right there. Exiting costs one hand; staying up cost
  every table.
- **Sentry stopped hiding the cause.** `beforeSend` dropped EVERY Supabase
  connectivity error — the exact class behind the incident. Now rate-limited to
  one per message per minute rather than silenced.
- Bounded, idempotent shutdown + `docker stop -t 45` (the 10s default SIGKILLed
  the engine mid snapshot-flush on every deploy).

## The test suite was dead and nobody knew

`npx vitest run` had been failing on an esbuild host/binary version mismatch:
`node_modules/vite/node_modules/@esbuild/` contained only a **linux** binary on
a Mac. The entire 485-test server suite was un-runnable, silently. Repaired, and
made durable via `server/scripts/fix-vitest-esbuild.mjs` wired to `pretest`, so
`npm test` self-heals. **A silently dead test suite is its own outage** — worth
a periodic check that the suite actually runs, not just that it passes.

## Verification

- 485/485 server tests pass, including the new `FreezeRegression.test.ts`.
- `tsc --noEmit` clean (client + server); `vite build` clean.
- Production `engine.smarter.poker/health` serves the new `liveness` field:
  `liveness: ok`, `stalledTableCount: 0`, per-table `msSinceProgress` in the
  1-3s range. The field's presence is itself proof the new code is executing.

## Known remaining / deferred

- `clearTurnTimer()` is still a no-op. The correct fix is seat-scoped
  cancellation plus removing the call from `startTurnTimer` — `clearTable()`
  there would cancel the timebank clock armed moments earlier by the
  auto-activation path. Deferred deliberately; documented in the audit trail.
- Crash recovery ABANDONS in-flight hands. Chips are safe (`table_seats.stack`
  is only written at settlement) but `deadlineScheduler.rehydrate()` has zero
  call sites, so the per-second `pending_deadlines` snapshot write is currently
  paying for data nothing reads.
- `HorseLogic.decide()` runs synchronously on the turn-change path (measured
  worst case 9.3ms, PLO6). Fine at today's ~40 tables; saturates the shared
  100ms scheduler tick around 200-250 tables. Move it into the think-time
  callback before scaling.
- No independent, engine-external stall alarm yet. The Docker HEALTHCHECK covers
  self-healing, but a DB-side query (tables with 2+ seats and no hand for 3 min)
  run from Open Claw would catch a class the engine cannot self-report.
- `scale/` (ShardManager, CrossNodeBus, TableRouter) is dead code — not imported
  outside `scale/`. Do not plan capacity around it.
