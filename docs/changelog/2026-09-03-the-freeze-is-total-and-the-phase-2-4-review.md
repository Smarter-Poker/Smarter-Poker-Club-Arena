# 2026-09-03 - The freeze is total, and the review of phases 2-4

Dan, 2026-09-03 00:20 UTC, after the 23:55 measurement: "THIS SOUNDS LIKE
YOU DIDN'T TRULY FREEZE ALL TRANSACTIONS FROM BEING ABLE TO HAPPEN, AND NEED
TO FIX THAT!" And before that: review everything built in phases 2-4 for
bugs, gaps, stubs, wiring, and confirm it is pushed and published.

## Part 1 - the review of phases 2, 3, 4

Production serves `f2cfd4aa`, which contains every phase 2-4 commit
(#2715, #2729). All files are on `main`. Live evidence for each phase is in
the programme doc's status log. The review found ONE real bug and two
smaller gaps:

**Bug (phase 3): a slow outcome insert could drop resume batches.** The
staggered resume batches each check `phase === 'idle'` so a batch left over
from a superseded break cannot wake a table the next break is holding. But
`end()` reached `'idle'` only after `await recordOutcome(...)` - a database
insert made at :00, the slowest instant of the hour. An insert slower than
750ms would have dropped batch 1; slower than 10s, every batch of a
355-table fleet. A dropped table cannot recover: the pause safety timeout
wakes it, the loop's own gate sees `maintenancePaused` still set and parks
it again, forever. The 23:55 insert took 170ms - luck. Fixed: the break goes
idle (and the freeze flag clears) BEFORE the first table is woken; the
outcome was already captured so the record stays honest. Pinned by a test
that holds the insert open, fires the batches, and requires every table up;
it fails on the old ordering.

**Gap: the boot-time read of the break row failed open on one error.** The
engine boots at ~:55-:58 because of the restart, exactly when the database
is slowest; one timed-out read meant the fleet came back dealing into a
break every screen still showed. Now three attempts, 1.5s apart, then fail
open. Two tests.

**Gap: `thawInstallments.test.ts` was not in the named regression step** of
the required Server Engine check (the full suite still ran it). Added.

## Part 2 - the freeze is total

### What happened

The 23:55 break parked every table and started zero hands, and still
recorded `freeze_conserved = false`, +1,282,347 chips onto the felt. All of
it was seating by the engine, as `service_role`, which the seven-door guard
(`fn_refuse_while_frozen`, 20260902090000) exempts on the premise that "the
engine is already frozen by its own machinery":

| when        | what                                                              | chips     |
| ----------- | ----------------------------------------------------------------- | --------- |
| 23:55:32-52 | 68 horses bought into 38 cash tables                              | 2,487     |
| 23:55-23:59 | 48 horses late-registered into "$100 Freeroll"                    |           |
| 23:57-23:59 | 8 Spins launched, 3 completed                                     |           |
| 23:59:04-31 | "Wednesday PLO Stack" (00:00 start) pre-seated its 34-horse field | 1,020,000 |

### Why the engine's own machinery did not stop it

1. **Boot order.** `maintenanceBreak.start()` - which adopts the persisted
   break and sets `isMaintenanceFrozen()` - was Step 7b of `GameServer.start`,
   AFTER discovery, the horse fleet, the recurring launcher and the scheduler.
   Every one of those runs an immediate first pass on `start()`, and none of
   those first passes was gated. The engine booted at 23:55:23 and adopted
   the break at 23:55:26; the seats landed in and after that window.
2. **In-flight ramps.** `registerHorses` and the seat-first fill loops buy in
   one horse per RPC for minutes; the freeze check was only on the interval
   that starts them, so a ramp that began before :53 ran straight through.
3. **The start decision itself.** `discoverTournaments` decides `shouldStart`
   (with a 60s pre-seat lead) and the seat-first fast lane starts full Spins;
   neither consulted the freeze.

### The fix, two layers

**Engine.** `maintenanceBreak.start()` is now Step 0b, before anything that
can seat a player. Every launcher, the top-up, the seeding cycle, the
scheduler poll and the two start decisions gate themselves (not only their
intervals), and every horse buy-in loop checks the freeze per horse so a
ramp stops at :53 and the next tick finishes it after the thaw - exactly
when a human's buy-in would be accepted. Fourteen call sites, all pinned by
`theFreezeIsTotal.law.test.ts` (fails on main: 6 pins).

**Database backstop** - `20260903003000_engine_restart_phase6a_the_freeze_is_total`.
Three writes are a buy-in or a launch BY DEFINITION and are never part of
settling a hand in flight, so they are refused for EVERY role while frozen,
`service_role` included, with the same 55006 a browser already gets:

- `INSERT INTO table_seats` for a **cash** table (a tournament seat is a
  balance move or an already-paid seating, never refused mid-move);
- `INSERT INTO tournament_players` (a registration);
- `UPDATE tournaments SET status = 'RUNNING'` (a launch).

Only `app.freeze_bypass` (the thaw) passes. Stack UPDATEs - the last hand's
settlement - are untouched, so the original guard's engine exemption stands
for what it was built for. Probed on production in a rolled-back
transaction with a simulated freeze row and `service_role` claims: a launch
is refused 55006, an event finishing is not, the same launch passes once
the row is gone.

**Apply timing.** `CREATE TRIGGER` on `table_seats` takes a lock the engine
contends for - two probes at 00:3x deadlocked and were rolled back - so the
migration is applied inside the break (:55-:00), when the felt is quiet,
with `lock_timeout` set. The engine gates ship on the next restart after
this merges; until then a refused write from an ungated path is a logged
55006 that the next tick retries after the thaw.

### Acceptance (next live break with both layers on)

- `ca_freeze_circulation_marks`: post.total == pre.total (`freeze_conserved`
  true) on a break with zero hands;
- `table_seats.joined_at` inside the window: 0 rows (cash);
  `tournament_players.registered_at` inside the window: 0 rows;
  `tournaments.started_at` inside the window: 0 rows;
- no `PLATFORM_FROZEN` in the engine log once the gates are live (the
  backstop exists to catch the path nobody remembered, not to be hit hourly).

### Not touched

`fn_refuse_while_frozen` and its seven doors; the adoption control law; any
balance column.
