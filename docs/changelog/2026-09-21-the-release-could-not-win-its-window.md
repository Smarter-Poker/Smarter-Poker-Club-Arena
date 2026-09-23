# The release could not win its window

**2026-09-21.** `auto-deploy-hetzner` failed about fifteen times in one day. The
engine stayed on `8825af51` for sixty-five hours with 49 players' seats and
4,908,000 chips stranded behind it across six tournaments, the oldest derelict
since 2026-09-14. Every substantive code blocker had already been merged -
`terminalBoundaryPendingGenerations` by #5020, the missing
`engine-release-inflight-hands.py` by #5013. Nothing was wrong with what the
release wanted to do. It could not arrive in time to do it.

## What the runs actually said

Three attempts on one stable sha, `db885b2941`:

| run         | created   | finished  | reason                   |
| ----------- | --------- | --------- | ------------------------ |
| 35613147982 | 14:35:12Z | 14:42:50Z | `fleet_identity_changed` |
| 35614192763 | 14:44:34Z | 14:55:48Z | `mixed_owner_changed`    |
| 35615604946 | 14:57:02Z | 15:06:42Z | `insufficient_reserve`   |

All three carried the identical receipt: `stage: "preflight"`,
`attemptedTables: 0`, `completedCalls: 0`, `checkpointOutcome: "not_started"`,
`restartAuthorized: false`. **Nothing was touched in any of them**, and the
release ended permanently anyway.

A hypothesis worth refuting first: that the two earlier attempts ran against a
live, moving fleet and only the third ran frozen. They did not. `checkMaintenance()`
requires `isMaintenanceFrozen() === true` and `phase === 'counting_down'`, and
those predicates sit _above_ both `insufficient_reserve` and
`fleet_identity_changed` in the same function. All three ran inside a genuine
freeze. The difference between them is only how far into it they arrived.

## The cause

**Four gates demand the same 285000ms against the same break, and the work
between them is budgeted at zero.**

1. `maintenance_certificate` — `engine-release-transaction.sh`
2. `legacy_checkpoint_countdown` — `engine-release-transaction.sh`
3. the physical countdown probe — `legacy-engine-checkpoint.sh`
4. `reserveMs` in `legacyEngineCheckpointGuard` — `legacy-engine-checkpoint-guard.mjs`

Between them sit the engine lock, a sealed-SHA read with a 10s ceiling, a second
countdown probe, `prove_rollback_readiness` (about twenty bounded host round
trips, a loopback health probe, a **public HTTPS** probe and a Supabase leader
proof), a durable intent write with two fsyncs, and a cold
`docker exec ... node --input-type=module` boot that streams two module files in
and then enumerates the fleet.

`BREAK_DEADLINE_SLACK_SECONDS=0`. The header comment says "the remaining nominal
15 seconds are entry slack for lock/freshness/certificate work" - but that slack
was never subtracted at any admission gate. Gate 2 would therefore admit happily
at 285001ms remaining and hand gate 4 a deficit it was obliged to refuse.

### The arithmetic, measured

`MaintenanceBreak.BREAK_DURATION_MS` is 300000 and `LAST_HAND_LEAD_MS` is 120000.
Run 35615604946 requested a recovery window stamped `1790002984288` =
**15:03:04.288Z**, so its break froze at **15:05:04.288Z** and ended at
**15:10:04.288Z**. The guard's refusal reached the runner at **15:05:31.77Z**,
about **272500ms** remaining. Gate 2 had admitted with at least 285000ms.

So the entry cost **at least 12500ms** of an allowance that is only 15000ms wide,
leaving a winning slice of at most **2500ms** - to be hit by a poll that sleeps
five seconds. That is not a race the release loses sometimes. It is a race it
wins almost never, which is what fifteen consecutive failures look like.

The engine's own bar for the same decision is `MIN_REMAINING_FOR_RESTART_MS` = 180000. The release demands 285000, and the script says so in a comment at
`engine-release-transaction.sh:464`. The reserve is not wrong; it was simply
never asked to leave room for the cost of reaching it.

## The fix

**The gates now form a descending ladder instead of a flat line.** Each demands
the guard's reserve _plus_ the cost of the work that still follows it, so passing
an earlier gate implies the last one can pass.

**The guard's own reserve does not move.** This change makes the release _arrive_
in time; it never relaxes what the release must prove. `fleet_identity_changed`,
`mixed_owner_changed` and `maintenance_not_durable_countdown` are untouched - a
moved fleet is still a refusal, and no cutover is certified with a hand in the air.

Every budget is **measured on the host that will pay it**, never a hand-tuned
millisecond count that outlives its hardware (CLAUDE.md 1.1.7, 10.84):

- `legacy-engine-checkpoint.sh` times the `docker exec ... node` runtime check it
  already performs - same container, same binary, same exec path, already paid
  for - and triples it, because the guard's boot additionally parses two modules
  and walks the table map. Floored at 1500ms so an implausibly fast probe cannot
  produce a zero budget, and ceilinged at 9000ms because no budget above the
  15000ms the break has over the reserve is satisfiable.
- `engine-release-transaction.sh` times `prove_rollback_readiness` where it runs
  and feeds the doubled measurement forward to the next admission, clamped to
  `BREAK_WINDOW_MS - MIN_BREAK_REMAINING_MS`. It is 0 until that first
  measurement exists, which is exactly today's behaviour - an admission can
  never become _more_ permissive than it is now.

**And a refusal that provably did not act is now a deferral, not a death.**
`legacy-engine-checkpoint.sh` gains `defer()` (exit 75), reachable only _above_
its `O_EXCL` intent write - no intent file, no inspector, no write. The
transaction honours 75 only after proving from the filesystem that the intent is
absent; an intent file present means the operation really did start and a retry
stays forbidden however the helper exited. Anything that is not a clean 75 still
ends the release. "This attempt arrived late" and "this attempt is unsafe" are
different facts and now have different names (CLAUDE.md 10.86 rule 1).

This is not a repair job, a sweep or a retry loop (10.12). It is one release
attempt waiting for the moment it was always supposed to act in.

## The reader, and a second finding

Roughly fifteen failed releases over sixty-five hours paged nobody. The alarm
written for precisely this outage, `EngineCannotBeReplaced`, reads
`poker_maintenance_breaks_since_restart_certified` - a series `GameServer.ts` has
published since #4909. **The engine that needed watching predates that commit
and does not emit it.**

Measured against `https://engine.smarter.poker/metrics` on 2026-09-21: 1185
series, including `poker_maintenance_break_active`,
`poker_maintenance_break_ready_for_restart`, `poker_uptime_seconds` and
`poker_engine_info{version="8825af51"}` - and not one series matching `certif`
or `since_restart`. The alarm could not fire during the outage it was written
about, and its silence read as good news.

`EngineReplacementWatchdogBlind` is that sentence said out loud: `absent()` on
the series, `and on() (count(poker_maintenance_break_active) > 0)` so a plain
scrape failure cannot fire it, the CLAUDE.md 13 rule 6 break guard, and `for: 30m`
to clear a restart's own scrape gap. No threshold was invented - the condition is
exactly "the engine is reporting, and the one series its deploy-route watchdog
needs is missing". It resolves the moment a newer engine lands, which is the same
moment `EngineCannotBeReplaced` gets its sight back.

Repeated `auto-deploy-hetzner` failures are otherwise already read by
`check-main-is-green.mjs` through `production-integrity-audit.yml`, which asks
GitHub for every active workflow with no allowlist. Issue #4219 ("Engine
watchdog: production is not running main") is open but stale - last touched
2026-09-11, and it names the watchdog deleted in #4189, so it is not a live
reader for this episode.

**This alert file is not live because it merged** (CLAUDE.md 10.84). It is live
when `bash infra/monitoring/deploy.sh` has run on the box and
`curl -s localhost:9090/api/v1/rules` says so.

## Law

`tests/the-release-enters-the-break-with-time-to-finish.law.test.ts` pins the
ladder, the untouched guard floor, the measured-not-chosen budgets, the exact
admission boundary driven through the real shell function as a subprocess, that
`defer` is only reachable above the durable intent, and that the transaction
proves the intent absent before deferring.

`tests/legacyEngineCheckpointAdmission.test.ts` had a pin on the post-lock
admission call site that now carries the headroom argument; it is updated in this
same commit (CLAUDE.md 5.8).

## Files

- `server/scripts/engine-release-transaction.sh`
- `server/scripts/legacy-engine-checkpoint.sh`
- `infra/monitoring/alert-rules.yml`
- `tests/the-release-enters-the-break-with-time-to-finish.law.test.ts`
- `docs/laws.d/tests-the-release-enters-the-break-with-time-to-finish.md`
- `tests/legacyEngineCheckpointAdmission.test.ts`

## Reconciled, later the same day: the budget contains the entry

The ladder above was right about the shape and wrong about the top rung. It
kept the guard at 285000ms and added the measured entry budget to the
_admission_ threshold, so after one miss the admission demanded up to
285000 + 15000 = 300000ms of a countdown that is 300000ms long and costs
~15000ms to enter. The probe in `legacy-engine-checkpoint.sh` added its
1500-9000ms boot term on top of 285000 as well. Neither figure is satisfiable
once the entry has been paid, so the deferral - correct in itself - would have
fired at every break for ever. Same arithmetic, one gate earlier.

The reconciliation, in "The Legacy Checkpoint Gets The Seconds It Needs"
(same date), keeps everything here that was right and moves the budget to
where it can be paid:

- `LEGACY_CHECKPOINT_BUDGET_SECONDS=40`: ~15 s of entry (run 35615604946:
  detection ~4.7 s, rollback proof ~5.3 s, helper preamble ~5.2 s, then the
  intent write and the guard's boot), 20 s of publisher work, 5 s of cleanup.
- The guard's `reserveMs` is 245000 at every check, and the certificate read
  straight after the checkpoint accepts the same 245000
  (`LEGACY_MIN_BREAK_REMAINING_MS`). The 135 s rollback reserve is untouched;
  the candidate proof inside it is 110 s against 51-112 s measured.
- The admission stays at 285000. `legacy_checkpoint_countdown` keeps its
  headroom argument and `prove_rollback_readiness` is still timed, but the
  headroom's ceiling is derived - what the break offers above 285000 minus
  the entry allowance the budget already holds - and that is 0.
- The helper's probe demands `245000+40000`, the same 285000 the transaction
  admitted on, with no boot term added; the boot is measured and reported.
- `defer()` / exit 75, the filesystem proof of an absent intent, the reset of
  `LEGACY_CHECKPOINT_ATTEMPTED`, and `EngineReplacementWatchdogBlind` are all
  kept as written above.

`tests/the-release-enters-the-break-with-time-to-finish.law.test.ts` now pins
the reconciled contract: entry at 285000, guard at 245000, the 40000 between
them containing the entry, a ceiling that evaluates to 0 through the real
constants block, and the deferral exactly as before.
