# The Create Club certifier reads the no-dollar welcome schedule

**Date:** 2026-10-12

## What was red

`Club Create Certification` failed on every `main` run from 2026-10-11 20:03
UTC (run 38170604011, `a76ebb9a6`) through run 38200648584 (`b085fb9cc0`):

    Error: Daily 7 PM $25 Welcome Tournament Was Not Configured Exactly.

The fixture club was created and retired correctly every time; only the schedule
assertion failed.

## Cause

Migration `20261011200429_the_jackpot_notice_and_search_show_no_dollar`
(PR #6682, Dan 2026-10-09: no dollar sign anywhere in the Club Arena) renamed the
welcome package schedule in `fn_club_welcome_package_config` from
`Daily $25 Freezeout` to `Daily 25 Chip Freezeout`. It was applied to production
at about 20:04 UTC, before the PR merged, so the first red run predates the merge.
`scripts/ci/certify-club-create.mjs` still demanded the old name. Product was
correct; the certifier was stale.

## Fix

The certifier now expects `Daily 25 Chip Freezeout` on both the schedule row and
its stored `config.name`, and refuses any dollar sign anywhere in the stored row.
Every other assertion (daily cadence, all seven days, `19:00` UTC, 25 buy-in,
10,000 stack, no interval, active) is unchanged. Its own error message no longer
carries the sign.

`tests/unit/clubCreateCertificationContract.test.ts` pins the certifier to the
name the migration's own post-condition asserts, so the two cannot drift again
without a red unit test.
