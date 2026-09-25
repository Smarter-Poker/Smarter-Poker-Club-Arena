# The tuner health check could not see an inert loop

2026-09-21, found by the daily horse audit analysis for 2026-09-20.

## What was wrong

`fn_audit_tuner_health` asked four questions about the self-tuner, and every
one of them counted ROWS in `horse_self_tune_log`:

- are there rows at all,
- what share of the reason strings say "regress dials halfway",
- what share say "too loose",
- what share came from `horse_daily_play`.

None of them asked whether a single horse's profile actually moved. A tuner
that studies the fleet and changes nothing writes exactly the same rows as a
tuner that retunes it, so the two were indistinguishable to the audit.

## Why that mattered on this date

PR #4578 landed 2026-09-14 02:31 UTC. Since then `HorseSelfTuner` records every
study through `recordObservationalHorseStudy`
(`server/src/services/HorseTunerObservationalAudit.ts`), which sets
`nextProfile = expectedProfile`, `modsAfter = modsBefore` and
`causal_permission = 0`, and prefixes every reason with
`diagnostic proposal, not applied: `. That is deliberate and correct - a
frequency or review correlation is not causal permission to move a dial - and
this change does not touch it.

But the decision had no reader. Measured on production 2026-09-21,
`mods_before IS NOT DISTINCT FROM mods_after` on every row since 2026-09-14:

| run_date | rows | applied | rows matching "regress dials halfway" |
|---|---|---|---|
| 2026-09-13 | 706 | 688 | 131 |
| 2026-09-14 | 705 | 0 | 139 |
| 2026-09-15 | 692 | 0 | 116 |
| 2026-09-16 | 651 | 0 | 102 |
| 2026-09-17 | 622 | 0 | 93 |
| 2026-09-18 | 649 | 0 | 111 |
| 2026-09-19 | 594 | 0 | 106 |
| 2026-09-20 | 581 | 0 | 107 |
| 2026-09-21 | 565 | 0 | 104 |

Eight consecutive nights in which the self-tuning loop moved nothing, and the
daily audit raised no finding, because "did it write rows" was the only
question it knew how to ask. That is CLAUDE.md 10.86: an instrument that
answers confidently when it cannot tell.

The second half of the defect is worse than silence. `tuner_regressed_the_fleet`
and `tuner_tightened_the_fleet` call their subjects "tuned horses" and fire at a
0.4 share. With nothing applied those counts are PROPOSALS, so the sentence
asserts horses were moved when none were. It had not fired yet only because the
shares sat at 0.15-0.20; 2026-09-14 reached 139/705.

## What changed

Both inside `fn_audit_tuner_health`, same signature, same return shape:

1. New `tuner_applied_nothing` (warn) when the tuner wrote rows and moved no
   profile, carrying `consecutive_inert_nights` so a one-night pause reads
   differently from a loop that has been dark for a week.
2. `tuner_regressed_the_fleet` and `tuner_tightened_the_fleet` now require
   applied changes, and the row-count findings say "proposed" rather than
   "tuned" when the run was inert.

## What this does NOT do

It does not make the tuner apply anything, and it is not a fix for the loop
being inert - CLAUDE.md 10.11 and 10.12. The inert loop is a deliberate design
state whose "separately qualified control path" does not exist in the code:
`recordObservationalHorseStudy` has exactly one caller
(`HorseSelfTuner.ts:1120`) and there is no causal activation path beside it.
Deciding whether that path gets built is the open item; this change only makes
sure nobody has to notice it by accident again.

## Verified

Against PostgreSQL 17 with fixtures reproducing the production shape (never
against production - CLAUDE.md production DDL policy rule 3 forbids DDL probes):

- 7-night inert streak -> `tuner_applied_nothing`, `consecutive_inert_nights: 7`,
  and `tuner_regressed_the_fleet` correctly suppressed at a 1.0 proposal share;
- a night with applied changes -> `tuner_regressed_the_fleet` still fires;
- no rows and no claim -> `tuner_not_yet_run` note, unchanged;
- no rows with a claim -> `tuner_no_rows` warn, unchanged.
