# A decided event is paid before the break, not after it (2026-10-02)

Scope: the hourly maintenance break stopped every tournament finish two minutes
before the break began, and decided events waited out the whole break. Engine
only; no migration.

Law: `server/src/tournament/aDecidedEventIsPaidBeforeTheBreak.law.test.ts`
(`docs/laws.d/server-src-tournament-aDecidedEventIsPaidBeforeTheBreak.md`).

## What production showed (read-only, 2026-10-02)

`tournament_terminal_settlements.completed_at` per minute, against
`engine_maintenance_break_log`:

| Break | Last settlement before | First settlement after | Break ended |
| ----- | ---------------------- | ---------------------- | ----------- |
| 14:55 | 14:52:54               | 15:03:09               | 15:03:08    |
| 15:55 | 15:52:57               | 16:03:00               | 16:02:59    |
| 16:55 | 16:52:58               | 17:02:48               | 17:02:48    |

16-25 settlements a minute up to :52, none from :53, the first one within a
second of the thaw. Tournament b719bb0e (last bust 14:45:54, completed
15:05:52) is the shape `fn_ca_tournament_finished_but_not_completed(15)` files
as critical every hour.

## Root cause

`TournamentManagerEliminations.finishTournament` refused on
`isMaintenanceFrozen()`. That flag is set by `MaintenanceBreak.announceBreak`
at the **:53 announcement** (deliberately, for horses and sweeps: "nothing
these sweeps do cannot wait"), so the terminal settlement of an event already
down to one player was refused from :53 until the thaw. The database half of
the freeze (`fn_platform_frozen`) does not arm for the last-hand phase until
`announced_at + 2 minutes`, i.e. :55, and the last hand on every other table is
still being settled at :54 by design.

`GameServer.beginBreakCountdown` / the tournament synchronized break were
checked and are not the gate: `finishTournament` never reads `isOnBreak()`.

## The change

- `freezeState.ts`: `setMaintenanceFrozen(true, lastHandEndsAt)` records when
  the announced break starts; `isTerminalSettlementFrozen()` is false during
  the last-hand window until `TERMINAL_SETTLEMENT_LEAD_MS` (60 s) before the
  break, and true otherwise while frozen. 60 s is longer than the 45-second
  statement ceiling of `fn_complete_tournament_terminal`, so a finish admitted
  in the window has its answer before the five minutes begin. Any other way
  into the freeze (adoption, countdown, recovery hold, release boundary) passes
  no start and is closed from its first instant. `isMaintenanceFrozen()` is
  unchanged, and so is every other gate that reads it.
- `MaintenanceBreak.announceBreak` passes `announcedAt + LAST_HAND_LEAD_MS`;
  `beginCountdown` re-asserts the freeze with no start, so an early (manual)
  countdown closes the window immediately.
- `finishTournament` gates on `isTerminalSettlementFrozen()`. A finish deferred
  past the cutoff now declares its field decided (so its retries ride the
  scheduler's decided lane, which `next()` reads before every live lane) and
  subscribes once to the thaw edge, which asks for the decided pass the moment
  the freeze lifts. The subscription is released by the thaw that fires it,
  and a manager that is no longer running when it fires asks for nothing.

## Against CLAUDE.md 13

Dan's rule is the five minutes from :55 ("NO BUY INS, NO CHIP MOVEMENTS"). The
finish still refuses from one minute before :55 until the thaw, the database
freeze (rule 1) is untouched, and no seat, buy-in, horse or registration path
changes. Rule 5 ("sweeps check `isMaintenanceFrozen()` before moving money or
seats") is read as covering periodic sweeps; the finish is the settlement of
the hand that decided the event and still checks the freeze, on the settlement
boundary.

## Not fixed here, said plainly

Outside the break the finish queue still backs up (median bust to completion
0.5 s at 13:00Z, 203 s at 16:00Z). The causes measured on 2026-10-01 still
stand: one platform-wide finish lane (`fn_ca_lock_settlement_lane_for_finish`,
one finish at a time) and the elimination scheduler's four general slots. b719bb0e
had already waited seven minutes before the announcement. Those are structural
and not touched by this change.
