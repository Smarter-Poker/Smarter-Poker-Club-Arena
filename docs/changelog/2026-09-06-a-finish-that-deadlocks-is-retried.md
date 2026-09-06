# A finish that deadlocks is retried, and a manager that never came back does not hide the row (2026-09-06)

## What happened

Alertmanager at 10:00 CDT held `TournamentStuckCompleting` (since 07:01 UTC),
`TournamentCompletedUnpaid` and `SpinPrizeUnpaid`. Read from production:

| id       | event                      | finished    | paid                          | rake         | status                                    |
| -------- | -------------------------- | ----------- | ----------------------------- | ------------ | ----------------------------------------- |
| b88db8d6 | 1 Chip Deep Stack Spin NLH | 15:01Z      | prize 2 to 66bfd1ea at 10:01  | 0.24 settled | COMPLETING                                |
| 80fdff30 | 1 Chip Spin PLO4           | 15:06Z      | prize 3 to 5a2be214 at 10:06  | 0.24 settled | COMPLETING                                |
| db05ecf2 | PLO4 Heads-Up 20           | 15:07Z      | prize 38 to 00000000 at 10:07 | 2.00 settled | COMPLETING                                |
| 3e281f5c | PLO4 Heads-Up 25           | 09-03 14:20 | nothing                       | nothing      | COMPLETING, 2 players still holding chips |

The three from this hour were PAID. Each one's engine log reads
`COMPLETE! Winner ... Rake settled ... COMPLETING -> COMPLETED failed:
deadlock detected - left for recoverStuckCompletingTournaments`, and then
nothing, ever again, for that event. Two more followed while this was being
read (40102ace at 15:22Z, ab102e3d at 15:26Z).

`recoverStuckCompletingTournaments` did not recover them. The discovery
watchdog skips any COMPLETING row whose id is still in `tournamentEngines`,
on the theory that a live manager is finishing it. After the failed flip,
`finishTournament` never reached `stop()` (no seat-release line, no engine
stop, nothing), `running` stayed true, the manager stayed registered, and the
watchdog walked past all three every pass for fifty minutes.

## The deadlock

Postgres log, 15:26:34Z: the engine's `UPDATE tournaments SET status =
'COMPLETED' ...` holds the game row and its trigger
`fn_clear_seats_on_game_end -> fn_clear_table_seats` is locking every seat of
the event; `atomic_seat_cashout_locked` holds one of those seats and wants the
game row. Migration `20260906152756_a_seat_cashout_locks_the_game_before_the_
seat` (another agent, applied 15:27:56Z, one minute after the last one read
here) takes the game row first in the cashout, so the pair now waits instead
of dying. A second pair - `fn_settle_tournament_rake` against
`atomic_distribute_rake` on `club_wallets` / `union_wallets` - was ordered by
`20260906152700` the same minute. Neither is redone here; the engine-side
deadlock rate went from 21 an hour to 2 in the five minutes after they landed.

## What this change does

1. **The flip is retried.** `finishTournament` issues the COMPLETING ->
   COMPLETED update up to three times, 250 ms then 500 ms apart, when the
   error is a deadlock (40P01), a lock timeout (55P03) or a serialization
   failure (40001). A deadlock victim is chosen in milliseconds and the other
   side commits; the same statement a moment later succeeds. Any other error
   is a refusal and is not retried. `completedFlip.ts`, pure and pinned.
2. **A manager past the grace is the thing that is stuck.** The watchdog
   trusts a registered manager for one grace period past the five-minute
   dwell (ten minutes, `COMPLETING_MANAGED_GRACE_MS`) and no longer: after
   that it stops the manager, drops it, and recovers the row through the same
   `recoverStuckCompletingTournaments` it would have used had no manager
   existed - idempotent, keyed per place and per user, guarded on COMPLETING.
   `managerHasOverstayed`, pure and pinned.

## What was done by hand (CLAUDE.md 10.9)

- The three paid rows were flipped with the engine's own statement
  (`UPDATE tournaments SET status = 'COMPLETED', ended_at = now(), on_break =
false, break_ends_at = null WHERE id IN (...) AND status = 'COMPLETING'`),
  probed in a rolled-back transaction first, committed at 15:25:41Z. No chips
  moved; the winners had been paid at 10:01, 10:06 and 10:07 and the ledger
  rows say so. Everybody who was owed was already paid; nobody was paid
  twice; nothing was taken back.
- `3e281f5c` PLO4 Heads-Up 25 (09-03) is a different case: two horses still
  hold 2,000 and 1,000 chips, no prize was ever paid, and the platform's own
  recovery refuses it by design ("still being PLAYED when its engine died ...
  left for a live engine to resume or an operator to settle"). A suspended
  heads-up match is played out, not chopped: it was flipped back to RUNNING
  at 15:25:41Z, the same revival the satellite branch performs, so the
  discovery loop can attach a manager and the winner is paid through the
  ordinary finish. If it has not dealt a hand by the next handoff, the
  remaining option is a chip-proportional deal (47.50 / 23.75 of 71.25),
  recorded as `final_table_deal`.
