# 2026-09-02 - Phase 4 of 9: the thaw cannot time out, and gives every clock back

Programme: `docs/ENGINE-RESTART-PROGRAMME.md`. Phases 1-3 are on main
(#2710, #2715). This is Phase 4, in two commits so each can be read on its own.

## What was wrong

The thaw (`fn_thaw_platform`, 20260902091000) is the half of "picks back up
exactly as it was" that is about CLOCKS: at :00 it shifts every in-flight
absolute deadline forward by the frozen duration. Two defects, both measured
on production today:

1. **The sit-out shift was silently discarded.** Every thaw since 21:00 UTC
   reported `sit_out_at: N` and moved nothing. `trg_stamp_sit_out_at`
   (20260828210000, a BEFORE UPDATE trigger on `table_seats`) holds the
   original stamp for a seat that stays sitting out - correctly, so that an
   unrelated stack or time-bank write cannot restart the five minutes - and
   the thaw's UPDATE is, to that trigger, just another unrelated write.
   Rolled-back probe: `shifted_by = 00:00:00`. A player who sat out at :53
   lost the five minutes the freeze promised them.

2. **The thaw could still time out.** It is one PostgREST call as
   `service_role` (8s statement timeout). #2703's indexes took it from 19.9s
   to ~3.5s uncontended, but one step is proportional to the number of
   running tournaments: `tournaments.level_started_at` costs ~20ms/row
   through the table's seven unconditional UPDATE triggers (121 rows = 2.46s,
   measured 23:12 UTC). At :00, against a saturated 2-core database with
   every table waking, that statement can spend the whole budget, and a
   timed-out thaw rolls back WHOLE - ledger row included - so every clock
   keeps the minutes it lost. The 20:00 thaw did exactly that.

## Commit 1 - `20260902232500` the sit-out stamp lets the thaw through

`fn_stamp_sit_out_at` gains one branch: while a seat is still sitting out,
the stamp is held UNLESS the transaction is running under
`app.freeze_bypass` (which only the thaw sets - 20260902090000 defines it,
20260902091000 is its sole caller) AND the writer supplied a new non-null
value. Every other path is byte-for-byte the previous behaviour.

Probe (rolled back): old trigger + bypass `00:00:00`; new trigger + bypass
`00:05:00`; new trigger, no bypass `00:00:00`. APPLIED live 23:18 UTC.

## Commit 2 - `20260902233000` the thaw runs in installments

Same function, same arguments, same idempotency key, but the work is split
into named steps and the function does as many as fit inside a 4s budget of
its own wall clock before returning `{complete: false}`. Every completed
step is checkpointed in `engine_maintenance_thaws.shifted`, in its own
committed transaction, so a later call resumes exactly where the last one
stopped and never runs a step twice. The tournaments level-clock step is
chunked by primary key (40 rows per call, cursor in the same JSONB), so no
single statement is larger than ~1s. Each call takes `FOR UPDATE` on the
ledger row, so racing engines serialise per call. `frozen_seconds` is read
from the ledger once it exists, so two engines that measured the freeze a
second apart still move the platform by one number.

Engine side, `server/src/maintenance/thawInstallments.ts`:
`runThawInstallments(call)` calls until `complete`, retries a call that died
(a timeout committed nothing, so the retry is exactly right), gives up after
3 consecutive errors or 12 calls, and never retries a refusal
(`implausible_frozen_seconds`). `GameServer`'s `thaw` dependency goes
through it. 10 unit tests including two source-law pins: GameServer imports
the helper, and its single `fn_thaw_platform` RPC site is inside the loop.

Probes (rolled back, production data): full thaw in one call, 131 running
events in 4 chunks, 3.07s, `complete: true`; a second call answers
`already_thawed`; with the budget squeezed to 700ms, three calls
(7 quick steps + 40 rows -> 40 more -> the last 54 and `complete`), cursor
advancing 40 -> 80 -> 134, then `already_thawed`; `9999` frozen seconds
refused.

**Apply order matters for this one.** The old engine calls the thaw ONCE. If
the new function is live before the engine loop is, a call that runs out of
budget leaves the remaining steps for a second call that never comes -
strictly worse, in the 4-8s band, than the one-statement version. So
`20260902233000` is applied to production only once this PR is on main and
the deploy carrying the loop is the next restart. (It was briefly on
production at 23:14 UTC by a probe whose transaction did not open; restored
to the original within four minutes, no break in the window.)

## Not touched

The adoption control law, the freeze triggers, any balance column. The
thaw moves deadline columns only; `chip_transactions.reversible_until` is the
cashier claim-back WINDOW, not an amount.

## Acceptance (measured on the next live break after deploy)

- one `engine_maintenance_thaws` row per break, `shifted.complete = true`,
  `frozen_seconds` 280-330;
- the engine log shows `thaw: complete in N call(s)` with N >= 1 and no
  `THAW FAILED`;
- a seat sitting out across the break has `sit_out_at` moved forward by the
  frozen duration (compare against `ca_seat_stack_exits`-free seats before
  and after);
- `ca_break_scorecards.thaw_ran = true` on every break.
