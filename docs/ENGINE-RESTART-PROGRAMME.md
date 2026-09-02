# Club Arena - Engine Restart & Platform Hardening Programme

Dan's directive (2026-09-02): take everything found needed for the hourly
invisible engine restart AND the horse/platform issues surfacing alongside it,
break it into phases, build ONE phase at a time, fully coded + wired + tested,
and report "Phase N of 9 is done ... ready to start Phase N+1" before moving on.

This document is the map. Each phase has a goal, the concrete work, and the
acceptance test that must pass before the phase is called done. Build order is
chosen so each phase makes the next one easier or safer, and so the highest-risk
change (a second live engine) comes only after the database stops being the
bottleneck.

---

## The one root cause behind almost everything

The database is saturated, and everything that runs at :00 hits it at once.
Measured 2026-09-02: 10-50 statement timeouts and lock-wait warnings every five
minutes all day, spiking past 200 in the :55-:00 bucket. That single fact
explains the 47-minute horse-seeder cycle, the 8-second thaw timeout, the
one-table-per-5-seconds re-adoption after a restart, and the ~480 daily
watchdog kill-rebuilds. Fixing the restart choreography without relieving the
load just makes the restart fail more politely, so several phases attack the
load directly.

Two hard rules hold across every phase: **horses are players** (CLAUDE.md 10.5 -
never excluded, never a different deal, timing included) and **money paths are
not touched** without an explicit, separately-reviewed reason. Every DB change
is proven with a rolled-back probe before it is applied; every engine change
ships with a test that fails on the old code and passes on the new.

---

## Phase 1 of 9 - Every break is measured, and every deploy fires

**Goal.** Make the system observable and self-triggering before changing any
choreography, so that from here on a good or bad hour is a row anyone can read,
not a screenshot someone happens to catch.

- `ca_break_scorecards`: one row per break - window, hands dealt inside it,
  peak tables unparked, thaw success + frozen_seconds, seconds-to-full-fleet
  after resume, what shipped, and a pass/fail verdict.
- `fn_ca_record_break_scorecard()` fills the row from `hand_history`,
  `engine_maintenance_thaws`, `engine_recovery_events` and the deploy-attempt
  table; cron at :06 each hour.
- Freeze proof: circulation total captured at the break edges; assert equal.
- Failure push: a failed break notifies the incident recipients (info→never
  push rule respected; a broken break is a warning).
- DB-side dispatcher: pg_cron + pg_net fires `auto-deploy-hetzner` at :41 when
  no run for the coming window exists - GitHub cron dropped two ticks today.

**Acceptance.** Scorecard row written for a real break with correct hands count;
freeze-proof numbers present; a simulated failed break produces a push;
dispatcher proven (dry-run row) to fire only when no run exists.

## Phase 2 of 9 - The gate counts a live hand, not a raised hand

**Goal.** The single biggest correctness fix: the deploy's "all tables parked"
signal must mean "no hand is in flight," not "every table object exists." Today
64-70 idle tables read as unparked forever and the gate never opens even on the
good build.

- Rework `readyForRestart` / `unparkedTables` so a table with no live hand does
  not hold the gate; a truly mid-hand table still does.
- Pin it with an integration test that parks a real (test-harness) engine and
  asserts the gate opens with idle tables present and stays shut with a live one.
- Required CI check so a #2537-class regression cannot merge.

**Acceptance.** On a live break, `readyForRestart` goes true and the deploy
takes the CLEAN path (not the straggler escalation); scorecard shows ~0 unparked.

## Phase 3 of 9 - Coming back up is fast (boot ramp) and staggered

**Goal.** Kill the 10-20 minute post-restart recovery. Target: fleet fully
dealing within ~60s of :00.

- Raise/parallelise table adoption off the 25-per-5s serial path; make horse
  re-seat not block table adoption; stagger the resume burst over 10-15s.
- Horses come back in their seats - a restart never releases a horse seat or
  forces a re-seed (ties into Phase 6).

**Acceptance.** Scorecard seconds-to-full-fleet ≤ ~90s on a real restart
(vs ~1000s measured 2026-09-02 18:02).

## Phase 4 of 9 - The thaw cannot time out, and gives every clock back

**Goal.** Make "picks back up exactly as it was" true of the clocks.

- Thaw runs in installments (several sub-8s idempotent calls) - indexes already
  shipped (#2703); this finishes it.
- Fix `fn_stamp_sit_out_at` discarding the sit-out shift.

**Acceptance.** One `engine_maintenance_thaws` row per break, frozen_seconds
280-330, and a sampled sit-out / waitlist deadline actually moved forward.

## Phase 5 of 9 - Break only when a deploy is armed

**Goal.** Stop paying the five-minute pause when nothing changed.

- Deploy workflow writes an "armed" flag once the image is built; engine calls
  last-hand at :53 only when armed. No flag → no break.

**Acceptance.** An hour with no server change records NO break; an hour with one
records exactly one.

## Phase 6 of 9 - Horse continuity is a pinned rule

**Goal.** Horses treated identically to humans across a restart, as law.

- A restart never orphans a horse seat/stack; horse re-seat is idempotent.
- Pin every hourly horse failure mode (seeder speed, union-wallet sizing from
  #2704, seat retention) with tests that fail on the old behaviour.

**Acceptance.** Before/after a real restart, horse seat + stack counts match;
pins fail on reverted code.

## Phase 7 of 9 - Safety nets

**Goal.** Turn silent failures loud and reversible.

- Auto-rollback: a failed-break or non-recovering scorecard redeploys `:previous`
  at the next window without a human.
- Deploy kill switch + per-feature DB flags.
- Freeze conservation asserted hourly (built on Phase 1's numbers).

**Acceptance.** A deliberately bad build is rolled back automatically; the kill
switch stops a deploy; a forced conservation break raises (rolled-back probe).

## Phase 8 of 9 - Relieve the database (the real fix)

**Goal.** Remove the saturation that causes the whole class of problems.

- Engine talks to Postgres directly (own pool) rather than through PostgREST's
  8s cap, starting with the hot paths (adoption, thaw, seeder).
- Move reporting/analytics reads off the primary (replica or scheduled offload).
- Partition `hand_history` / `hand_state_snapshots` by day.
- pg_stat_statements top-10 offenders fixed. Right-size DB compute (recommend).
- Use the freeze window for VACUUM/ANALYZE on hot tables.

**Acceptance.** Statement-timeout rate in the :55-:00 bucket down materially;
seeder cycle back under a minute; adoption at full budget.

## Phase 9 of 9 - Toward no break at all (staging + rolling deploy)

**Goal.** The endgame: a deploy that needs no break, and a staging fleet so
production is never the first place a change meets real load.

- Staging engine on a Supabase branch runs one simulated break per merge before
  production is allowed the build.
- Load test (1,000 horses / 1,100 tables / one hour) runnable on demand.
- Two-engine rolling handover using the existing lease system - new engine warms
  beside the old, claims the fleet in one sweep, no break.
- Client-side break test (overlay/countdown/resume) as a required check.

**Acceptance.** A merge deploys to staging and passes a simulated break before
production; a rolling handover deploys with zero hands lost and no announced
break.

---

## Status log (updated as phases land)

- Programme opened 2026-09-02. Build order above. Phase 1 in progress.
