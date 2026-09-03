# 2026-09-02 - Phase 3 of 9: coming back up is fast (staggered resume)

Engine-restart programme, `docs/ENGINE-RESTART-PROGRAMME.md`. Stacked on
Phase 2 (#2715).

## The goal

Kill the 10-20 minute post-restart recovery Dan watched ("100% of the time
says reconnecting to the table ... hands keep stalling"). Target: fleet fully
dealing within ~60s of :00.

## What was measured

Recovery of the 20:57 restart, tables dealing per minute: 82 at :00, then a
dip, 18 at :04, 126 at :05, 194 / 223 / 246 climbing, ~280 (full) by :12 -
about ten minutes. Two costs dominated, and both are addressed OUTSIDE this
change:

1. The boot cash-out reap - 383 horse seats cashed out and re-seeded on every
   boot - is deleted by #2713 (merged; first restart without it is the 23:55
   window). This was the single biggest cost.
2. Database saturation makes every adoption query slow, which halves the
   engine-start budget to its floor (the control law's own comment records
   "budget pinned at 6, 16 tables adopted after 472s"). #2711 (merged)
   relieves the load; Phase 8 finishes it.

## What this change does

The remaining boot-time cost that is neither of those, and is safe to fix
here, is the resume BURST. `resumeEveryEngine` woke every table in one
synchronous loop, so at :00 all ~250 dealing loops hit a 2-core database in
the same instant - each loading seats, blinds and stacks. This change resumes
the first batch (25) immediately and rolls the rest out in batches 750ms
apart, spreading the :00 spike over the seconds after the hour instead of
firing it all at once.

Every table still receives exactly one `resumeFromMaintenance`; the only
difference is that some wake a few seconds later, which is gentler on the
database than the herd and never harsher. A batch scheduled by a break that
has since been superseded (a new break is holding the tables) is dropped
rather than waking a table into a pause - guarded by a resume token AND the
phase being idle.

The adoption control law (`engineStartBudget.ts`, `discoverCashTables`) is
deliberately NOT touched: its comments record several production incidents it
was tuned through, and its real constraint is database load, which #2711 and
Phase 8 remove. Changing it speculatively is the "high risk, do not build"
case.

## Proof

- `MaintenanceBreak.test.ts`: two new pins - the first batch resumes
  synchronously and the rest are scheduled at increasing delays; a superseded
  break's stale batch is dropped. The stagger pin FAILS on a synchronous
  resume, PASSES here. 37/37 in the file; full server suite green; tsc clean.
- Small fleets (and every existing test) fit in the first batch, so they
  resume synchronously exactly as before - no behaviour change below 25
  tables.

## Acceptance, measured on a live restart

The 23:55 restart is the first on a build carrying #2713 (no reap) + #2711
(load relief) + this stagger. `ca_break_scorecards.recovery_seconds` for that
window is the number to watch; target <= ~90s, against ~600s today.
