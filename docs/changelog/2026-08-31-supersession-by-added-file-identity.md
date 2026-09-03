# 2026-08-31 - The reaper asks the wrong question, and here is the one that works

## The measurement

`close-superseded-prs.sh` closes a pull request only when EVERY added line
already exists in main (`MISSING -eq 0`). Its last ten runs each reported
`closed=0 kept=100 of 100 candidates`.

Checked why, across all 97 open pull requests:

```
byte-identical to main                            0 of 97
every ADDED FILE already exists on main          64 of 97
```

Zero byte-identical is not a near miss - it is the reason the line test can
never fire on this repo. Sibling branches do not land byte-for-byte; main's
version keeps evolving after it lands.

## The question that discriminates

Every branch in this estate brings its own **new** files: a test, a migration, a
changelog entry. If all of those are already on main, the work reached main
through a sibling branch under a different SHA - the pattern CLAUDE.md section
12 describes - and this branch is a leftover, not lost work.

Ten were verified BY HAND against main and against production before this signal
was trusted anywhere near a close:

| PR        | Verified how                                                                                                                              | Verdict                                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| #1105     | index + downline check live in prod; every claim-back call site on main already carries `p_op_id`; main's test has 11 assertions to its 3 | superseded                                |
| #1108     | both added test files on main; 10 `%seat_first%` migrations applied, incl. a later hardening                                              | superseded                                |
| #1021     | both added test files on main; `current_players_is_counted_not_narrated` applied                                                          | superseded                                |
| #1742     | added test + changelog + migration on main; `fn_apply_prize_guarantee` grantees already `postgres, service_role` only                     | superseded                                |
| #1439     | main's `BreakClockIntegrity.test.ts` already pins DEFECT 1; both migrations applied as `20260827153108` / `20260827153334`                | superseded                                |
| #1450     | `20260827163617 league_pooling_and_analysis_watchdog` applied                                                                             | superseded                                |
| #1118     | main's guard test already has _"a tournament that started and never dealt is rescued whatever its variant"_                               | superseded                                |
| #1091     | `difficultyHint`, `HALVING`, `adaptive` all present on main                                                                               | superseded                                |
| #1110     | `SEAT_LOOKUP_RETRIES`, `findMySeat`, `SeatLookup` all present on main                                                                     | superseded                                |
| **#1971** | `recoveryFieldGuard.ts` and three test files **absent** from main                                                                         | **GENUINELY STRANDED - rescued in #2198** |

Nine of ten. **#1971 is why this stays a REPORT and never an auto-close**: its
work was real and unshipped, and it guarded the boot-time rescue against paying
out live tournaments.

## What changed

`scripts/ci/triage-open-prs.mjs` gains a `LIKELY-SUPERSEDED` verdict and an
`added on base` column (`addedOnBase/addedFiles`). It closes nothing. It ranks
supersession above everything else so an operator does not spend a conflict
resolution on work already in production.

Guards: the signal requires the branch to ADD at least one file - a modify-only
branch says nothing either way - and the script warns loudly and disables the
signal when no `origin/main`/`main` is present, so a shallow checkout cannot
silently report every branch as novel.

## What this says about the backlog

The 97-PR pile is a **bookkeeping** failure, not a value leak. Throughput is
fine: main took 254 squash merges in 24 hours. The work landed; nobody closed
the branches.
