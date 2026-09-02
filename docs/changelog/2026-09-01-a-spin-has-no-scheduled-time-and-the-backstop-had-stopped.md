# A Spin has no scheduled time, and the backstop had stopped

2026-09-01. Two findings, one of them the cause of the 112 unbooked Spins found
earlier the same day.

## 1. The backstop had not completed a single run in two days

`fn_spin_sweep_unbooked` is the only thing standing under "a Spin ran, drew a
multiplier, paid its player, and never booked a reserve ledger row". Open Claw
fires it every fifteen minutes through `/api/cron/spin-sweep`.

Every run since 2026-08-30 had failed:

```
13:15:15 [WARNING] /api/cron/spin-sweep -> vercel 500 [15.0s]:
  {"status":"failed","stage":"sweep","error":"canceling statement due to
   statement timeout", ... }
13:15:15 [INFO] Job "/api/cron/spin-sweep ..." executed successfully
```

Note the second line. The dispatcher reports the JOB, not the response, so a
two-day outage of a money backstop looked like a healthy schedule.

The cause was a well-intentioned change. On 2026-08-30 the endpoint's lookback
was widened from 30 minutes to 14 days, reasoning that an idempotent settle
makes a wide window free. It is not free: the sweep settles the games it finds
one at a time inside a single statement, the caller is `service_role`, and that
role's `statement_timeout` is eight seconds. Worse, a timeout rolls the whole
statement back, so a pass did not even keep the games it had already settled.
The backlog could never shrink by even one.

**Fixed by bounding the work, not by narrowing the window** — a narrow window is
what stranded three Spins on 2026-08-23. `fn_spin_sweep_unbooked` now takes
`p_limit` (default 25, measured at ~3.1s a pass against a 112-game backlog) and
returns `remaining`, so a backlog drains deterministically oldest-first and is
visible while it does. Verified through the real caller path, as `service_role`
over PostgREST rather than as `postgres` in the SQL editor: **HTTP 200 in
1.26s**.

The one-argument overload is dropped rather than left beside the new one. The
first attempt kept it and its own assertion refused the migration: PostgREST
resolves `{p_lookback_mins: 20160}` to the exact one-argument match, so the cron
would have gone on calling the unbounded version while the fix read as applied.

**Backlog drained**: 112 settled, 0 failed, 0 remaining, across five passes.
Deep Stack Society's reserve pool went from a balance of 0 with no record of
5,737.00 in prizes it had paid, to 20,873.20 with all 112 games booked.

## 2. The gauge could not see it

`booking_gaps` is guarded in SQL on the booked amount being non-null, so it asks
only whether a game that WAS booked paid something different. A game with no
ledger row at all is excluded from the count. The one number watching prize
money leave the reserve pool read 0 for the whole outage.

`fn_spin_metrics` now returns `unbooked_spins` on the same predicate the sweep
uses, the engine emits `poker_spin_draw_unbooked`, and `SpinDrawNeverBooked`
alerts at `> 0` for 15m. It is a separate number rather than folded into
`booking_gaps` because "paid more than it drew" and "never touched the pool" are
different incidents with different first moves.

## 3. A Spin and a Heads-Up have no scheduled time

Dan, verbatim: "SPINS AND HEADS UP DO NOT HAVE SCHEDULED TIMES THEY START WHEN
3 PLAYERS HAVE BOUGHT IN AND PAID FOR SPINS, AND WHEN TWO PLAYERS FOR HEADS UP."

The START decision already obeyed this. `GameServer` reads

```ts
const shouldStart = isSngOrSpin ? seatFirstReady : maxReached || timeReached;
```

so a Spin or a heads-up is gated on paid seats and excluded from the clock sweep
entirely. Twenty thousand Spins over seven days agree: not one started with
anything other than exactly three players, and not one started before its own
`start_time`. On a seat-first row `start_time` is not a start, it is the human
window - the deadline after which the engine tops the remaining seats up.

CREATION did not obey it. `ScheduledTournamentService` could spawn a row typed
`SPIN`, or a two-seat SNG, on a cron `HH:MM` or `now + 5 minutes`, and its
restart clone could do the same at `ended_at + restart_every_minutes`. Neither
creates the open-seat table the seat gate counts seats on.

One was live and had been for ten days: **"Spin Royale", every 30 minutes, at a
25-chip buy-in the Spin board does not offer** (`SPIN_BOARD_BUYINS` is
`[1,2,3,5,10,20,50,100]`). 253 games since 2026-08-22, and **exactly one human
entry in the whole run**. The mechanism is worth understanding because it looks
like it worked: the game could not fill from a board it was not on, so it sat
until its scheduled instant passed, the past-start top-up filled all three seats
with horses, and the seat gate then started it 20 to 40 seconds late.

Corrected three ways:

- `buildInsertRow` refuses a spin or a two-seat shape and returns null, reporting
  once per schedule rather than on every poll;
- `maybeRestartTournament` refuses to clone either onto a clock;
- the `Spin Royale` schedule row is deactivated, with an assertion that no active
  schedule asks for a seat-first format.

A database trigger to make the rule structural was attempted and **abandoned**:
attaching it needs an `AccessExclusiveLock` on `tournaments`, the hottest table
on the platform, and the attempt deadlocked against live traffic. The rule is
held by the engine guards and by
`server/src/services/seatFirstStartsOnSeatsNotAClock.law.test.ts` instead, which
is where a future creation path would be added anyway. `fn_create_tournament`
still writes `now() + 1 minute` for an operator-created Spin, which lands inside
the 60-180s human window and is therefore correct by accident; an explicitly
supplied far-future `startTime` remains the one unguarded hole, and no live case
exists.

## Not fixed, needs one action

`infra/monitoring/spin-rules.yml` carries `SpinDrawNeverBooked` and the file is
correct on engine-01, but the running Prometheus has not loaded it. The deploy
step used `mv`, and a Docker single-file bind mount pins the inode: the
container still reads the file the rename unlinked, and a `/-/reload` cannot
help because the path inside the container resolves to the old inode. It needs
one `docker restart sp-prometheus`. Deploy rules by writing in place, never by
renaming over the path.
