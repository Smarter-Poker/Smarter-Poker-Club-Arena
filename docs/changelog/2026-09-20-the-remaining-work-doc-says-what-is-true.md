# The Remaining-Work Doc Says What Is True

Date: 2026-09-20. Documentation accuracy only. One file changed. No code, no
migration, no workflow, no client or engine behaviour.

`docs/DIAMOND-LAUNCH-REMAINING-WORK-2026-09-20.md` landed earlier today and is
the document the next Diamond lane reads. Two of its statements stopped being
true within hours of it being written, and one was too broad when written. Both
would have led a reader to a wrong diagnosis, which is what CLAUDE.md 10.86
is about: a note that retires a working tool costs more than the outage that
prompted it, because every agent afterwards reads it as current.

## Item 3 described PR #4951 as red, with eleven runners that never run

It is merged, squash `9e8ba0fe00`. The count is fourteen rather than eleven, and
the runners do now execute in CI. The paragraph now records the hosted proof
(run 35507223932, job 106069033618, step 55, with the retained evidence artifact
showing all fourteen runners at exit 0 and `pgBin: /usr/lib/postgresql/17/bin`),
because the open question on #4951 from the start was whether a wired step
actually runs, and in the two runs before it that step was skipped.

Its original phrasing also said each runner had a Homebrew psql path written in
as a literal. That was close but not right: they read `PG_BIN` with a Homebrew
default, and two read `PG17_BINDIR` instead, which was the disagreement that had
to be settled. The corrected paragraph says so, and records the three-place rule
for adding a runner.

## The gate diagnosis said the health watch never writes `resolved_at`

The conclusion was right and the mechanism was described too broadly. The
correction matters because it changes what the migration has to fit.

`resolved_at` is set on 33,180 rows, so resolution demonstrably works: `DR5` at
info has 24,277 resolved, `DR11:trial_balance_break` 41 of 49, and the sibling
`DR0:rule_flip_sweep` 25 of 32. What has never resolved once is
`DR0:health_critical` specifically, 45 of 45. The absent `resolution` column is
real and is why no reason can be recorded beside a closure, but this is a gap in
one rule family rather than a missing feature.

The paragraph also now states why resolving those rows is legitimate rather than
a band-aid, since that was not obvious and deserved checking. What the 45 rows
say is that 953 horse rewards worth 36,894 diamonds expired unclaimed, and under
CLAUDE.md 10.5 a horse is a player, so those were real diamonds really owed. Had
the condition still been live, closing the incidents would have been exactly the
plaster 10.11 and 10.12 forbid. It is not live: `fn_ca_diamond_health()` read on
2026-09-20 returns no area at `critical`, and the two areas these rows name both
read `ok` in so many words, with `ca-horse-claim-due-minute` succeeding ten times
in ten minutes. The resolver is bookkeeping catching up with a fix that landed.

## Verification

Every figure above was read from production through `execute_sql` inside
`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`. Nothing was
written, no migration was applied, and neither arena switch was touched.
