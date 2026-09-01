# The total platform freeze: nothing moves for the five minutes

**Dan, 2026-09-01, binding:**

> "THE ENTIRE PLATFORM NEEDS TO FREEZE FOR THE 5 MINUTES, NO BUY INS, NO CHIP
> MOVEMENTS, NO BUY INS OR CASH OUTS... NOTHING HAPPENS FOR THE 5 MINUTES.
> HORSES SHOULD NOT STAND UP OR ROTATE, EVERYTHING JUST FREEZES, THEN PICKS
> BACK UP EXACTLY AS IT WAS BEFORE THE FREEZE AND RESTART..."

Builds on `2026-09-01-scheduled-maintenance-break.md`, which made the restart
happen inside an announced break. That covered the CARDS. This covers the
MONEY, the SEATS and the CLOCKS.

## Why the freeze lives in Postgres

The engine is dead for ~2 of the 5 minutes - that is the point of the break -
so an engine-side guard is absent for exactly the window it must cover. And
the platform does not stop when the engine does. Verified against production
`cron.job`: `sp_evict_sitting_out_cash_players` and
`credit-stalled-seat-first-stacks` run EVERY MINUTE inside Postgres, moving
seats and chips; `ca-payout-sweep-hourly` fires at :52 and
`reconcile-ledger-integrity-6h` at literally `55 */6`.

## Why the tables and not the functions

The audit counted **190 functions** that write a money/seat table across 1310
migrations, plus trigger-driven writers, pg_cron, direct engine writes, and
~30 legacy RPCs still carrying default PUBLIC EXECUTE (`mass_fund_horses`,
`add_to_player_wallet`, ...). A per-function list can be wrong and cannot
cover the non-function paths. Those 190 functions write **seven tables** -
`table_seats`, `club_members`, `wallets`, `clubs`, `chip_transactions`,
`wallet_transactions`, `chip_ledger` - so the guard is a `BEFORE` trigger on
each (`zz_freeze_guard`, name-prefixed to fire last). Complete by
construction: the 191st money function gets the freeze for free.

Column-scoped: an UPDATE that touches no money column (presence, heartbeat,
timebank) passes untouched, so login and liveness work during the break.
Refusals are errcode 55006 with a `PLATFORM_FROZEN` message the client maps to
a Title Case explanation.

## The exemptions, and why each is safe

- **The `last_hand` phase is not frozen.** Hands finishing at :53-:55 pay
  pots; freezing then would strand settlements mid-hand.
- **service_role passes.** The engine cannot SET LOCAL a GUC through
  PostgREST, must flush state on SIGTERM and do boot bookkeeping at ~:58, and
  is already frozen by its own machinery (parked tables + gated sweeps). What
  the triggers must stop is what does NOT die with the engine: browsers,
  legacy RPCs, pg_cron - all enforced.
- **`app.freeze_bypass` (SET LOCAL)** exists for the thaw only.

## Self-arming: `enforce_freeze`

The engine build serving production when the migrations were applied still
carries the hand-for-hand-deals-mid-break bug (#2537 not yet deployed).
Honouring ITS break rows would freeze the ledger under a live pot. So
`fn_platform_frozen` requires `enforce_freeze` on the break row, and only the
freeze-aware engine build writes that flag. The freeze arms itself on that
build's first break; no human sequencing.

## The thaw: `fn_thaw_platform`

"Picks back up exactly as it was" is a statement about clocks. On break end -
BEFORE the first table resumes - the engine shifts every in-flight absolute
deadline forward by the frozen duration: `sit_out_at`, waitlist
`hold_expires_at` (60s), `addon_period_ends_at` (60s), `level_started_at` for
running events NOT on the synchronized break (this is what saves Spins, whose
wall-clock levels ran through the park - the 2026-08-27 incident class),
`reversible_until` (10-min claim-back), `reveal_deadline_at`,
`rebuy_prompt_until`, `bomb_pot_next_due_at`. Idempotent per freeze via
`engine_maintenance_thaws` (PK on the freeze start instant), so two engines
racing at :00 cannot double-shift. Bounded at 15 minutes. A thaw failure
never leaves the platform frozen - resume proceeds; clock drift heals, a
frozen platform does not.

Deliberately NOT shifted: `late_reg_mins` (parity with the existing hourly
tournament break, which has always consumed that wall time) and ban/promotion
expiries (time genuinely passing).

## Engine-side gates (`freezeState.ts`)

Set at the :53 announcement, cleared at :00, restored on boot adoption.
Gated: HorseSessionRotator (no stand-ups - the tell), HorseFleetManager
seeding/buy-ins, HorseLifecycleManager, FeeReconciler, RakebackSettler, bomb
ledger repair, ScheduledTournamentService, TournamentRecurringService
launchers, and - not a courtesy - `finishSeatFirstGamesThatAreOver`, which
judges "over" partly by "no hand in 3 minutes" and would have force-finished
every live Spin after each break. `DealRateVerifier.check` skips and resets
during a freeze; the earlier empty-list approach was itself the below-floor
condition and primed a critical page hourly.

## Bugs caught during this build

1. **`end()` was not re-entrant.** Phase goes idle only after the awaited
   thaw, so the armed end-timer and a concurrent caller both passed the guard:
   the test saw `['thaw','thaw','resume','resume']`. Latched now.
2. **First deadlock on apply (40P01).** CREATE TRIGGER takes
   AccessExclusiveLock per table against live traffic. Reapplied with
   `lock_timeout='8s'` - fail fast and clean beats queueing while holding.
3. **Probe wrote a fictional column** (`last_heartbeat`); the "failure" was
   the probe, not the guard. Re-proved with `is_away`/`time_bank_remaining`.

## Verified in production (rolled back, rule 11.5)

Inert until armed · money INSERT refused 55006 · `stack` UPDATE refused ·
presence/timebank UPDATE passes · bypass works · both cron guards stand down
quietly · thaw shifts exactly +300s, idempotent (`already_thawed`), refuses
implausible durations.

## The orphan-work watchdog

Dan: "no work ever gets lost, orphaned or not published... EVER."
publish-watchdog and engine-watchdog ask whether MERGED work reached
production; `orphan-work-watchdog.sh` (runs with them) asks the question
upstream: branches ahead of main with no PR, PRs with conflicts autopilot
cannot land, forgotten drafts - one self-updating, self-closing issue naming
each piece and its remedy. It never merges or deletes anything itself.
`engine-watchdog.sh` was also retuned for hourly :55 windows (the five-hour
Chicago window list would have kept it silent for six hours over genuinely
stranded code; the top-of-hour anchor would have alarmed 55 minutes early,
hourly, about a platform working as designed).
