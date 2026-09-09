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

**Added 2026-09-03 from the 23:55 measurement - THE FREEZE IS NOT YET TOTAL
ON THE ENGINE SIDE.** With every table parked and zero hands dealt, the new
engine still SEATED horses during the break: 68 cash seats on 38 tables at
23:55:32-52 (the boot seeding path), and 160 tournament seats between 23:55
and 23:59 - the "$100 Freeroll" took 48 late-reg horses, eight Spins were
launched, seated and three COMPLETED inside the freeze (23:57-23:59), and
"Wednesday PLO Stack" (starts 00:00) seated its 34-horse field at 23:59 for
1,020,000 chips. That is why `freeze_conserved` was false (+1.28M into the
felt from club treasuries) on a break that otherwise froze perfectly. The
`isMaintenanceFrozen()` gate is on the RecurringService tick callbacks and
the boot seeder is not gated at all; whichever path launched those Spins and
seated that MTT field is not gated either. Phase 6 must find every seating /
launch / late-reg writer and gate it on the freeze (a scheduled start that
falls inside :55-:00 is delayed to :00, exactly as a human's buy-in would be),
then pin it: `table_seats.joined_at` inside a freeze window = 0 rows.

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
- **2026-09-07/08 re-dive (Dan: "several issues, full redive").** Verified live
  before anything else: 26/26 breaks clean, thaw 26/26 complete, dispatcher
  firing hourly. Then built and shipped, each measured after deploy:
  - engine logs survive the deploy (#3539): `/var/log/club-arena-engine/`
    gets one gzipped file per hourly cutover (13-15 MB each) - three there
    already;
  - Phase 8 part 1 (#3550 + `20260908020500`): completed hand snapshots kept 6
    hours not 7 days, pruner in 2,000-row rounds under a 20s budget, every two
    minutes; backlog of ~3.6 M rows draining;
  - seat-first fills (#3555): a registration for an event more than 30 minutes
    out no longer counts as one of a horse's four games - 615 of 1,000 horses
    had read as busy on next Sunday's bookings; "0 of 3 claimable" and
    "CANNOT FILL" went from 200+ per half hour to zero. Boards still take a
    median 12-22 min for their FIRST horse (only ~33% within 3 min) and ~4 min
    from first horse to start: that first-horse wait is the deliberate
    hold-empty share (`seatFirstHeldEmpty`, 33%/50% per 30-min bucket) and
    the opening-horse rule, a product decision left as designed;
  - the balancer does not move players during the break (#3560):
    `freeze_conserved` true on every break since (was flipping false on
    table-balance moves caught halfway by the :00 mark);
  - money (#3534, #3569): the hourly bounty backpay sweep no longer aborts on
    one refused pool; a spin champion owed 100 whose prize leg had fallen
    into `settlement_suspense` is paid through the one payer; the spin
    disbursement audit compares against buy_in x multiplier (34 false
    positives resolved). Root cause of the suspense fall-through filed as
    #3568 for the chip-standard workstream; stale-PR catalogue #3570.
- 2026-09-02 ~21:45 Phase 1 merged (#2710); migrations applied; scorecard,
  freeze marks, disarmed dispatcher and deploy-start marker live.
- 2026-09-02 23:18 Phases 2+3 merged (#2715) after two CI reds that were
  not about the break (a same-minute migration-version collision, and a
  10s test budget the shared runner could not meet).
- 2026-09-02 23:29 Phase 4 merged (#2729). Both migrations applied live.
- **2026-09-02 23:55 restart - the first on a build with phases 2, 3, 4.**
  Deploy dispatched by hand at 23:41 (GitHub's cron dropped 22:40/45/50
  again); escalation fired at 23:55:00 (old engine, 342 "unparked" by its old
  predicate, 191 min behind); new engine `f2cfd4aa` up 23:55:23, resumed the
  break, parked everything: `unparked_at_countdown 0, peak 0,
ready_for_restart_at 23:55:28` (the gate opened - first time ever on a live
  break). **Hands with a start inside the break on the new engine: 0** (202
  in the window, all ended before 23:55:30 = the old engine's last seconds;
  previous breaks 955-3110). Thaw: 1 installment call, 697ms, complete,
  `sit_out_at 6, level_started_at 151`, frozen 300s. Resume: 355 tables at
  00:00:07. **Recovery: 294 tables / 774 hands in the 00:01 minute vs a
  295-310 / 700 pre-break steady state** - full fleet inside ~60-90s (was
  600-1000s). Kill-rebuilds after :00: 0, with tables genuinely parked.
  Horse seat exits during the break on the new engine: 0 (#2713 holds).
  Open: `freeze_conserved` false, +1.28M - horses were SEATED during the
  break (see Phase 6 addendum). Phases 2, 3, 4: accepted on this evidence,
  except that Phase 4's sit-out acceptance (a sampled deadline actually
  moved) is proven by rolled-back probe and by `sit_out_at: 6` under the
  fixed trigger, not yet by a before/after sample on a live seat.
- **2026-09-05 the resume arrives in installments (engine side of phase 3,
  revisited).** Prometheus: the 04:00 UTC break ended with 720 tables parked,
  the one core saturated within 30s and the container was replaced at 04:07.
  `resumeEveryEngine` now deals the fleet into 8 waves 1.5s apart (10.5s
  first to last), stable-hash order, cash and tournaments interleaved,
  `/health maintenance.resumeWaves` while it runs. Humans-first ordering was
  rejected under 10.5. `docs/changelog/2026-09-05-the-resume-arrives-in-installments.md`.
