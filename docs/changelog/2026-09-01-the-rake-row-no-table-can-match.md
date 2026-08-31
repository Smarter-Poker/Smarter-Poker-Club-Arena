# The rake row no table can match — 5/5 deleted from the schedule

**Date:** 2026-09-01
**Files:** `src/config/RakeConfig.ts`, `server/src/config/RakeConfig.ts`,
`supabase/migrations/20260901050000_the_rake_row_no_table_can_match.sql`,
`tests/unit/RakeConfig.schedule.test.ts`,
`tests/unit/theFormOffersStakesTheScheduleCanPrice.test.ts`

## What existed

`RAKE_SCHEDULE` carried `{ sb: 5, bb: 5, rakePercent: 10, rakeCap: 7.5,
bbjFeeBB: 0.12 }` in both the client and the server copy, and the DB mirror
`public.ca_rake_schedule` carried the matching row (source `engine_mirror`),
seeded by `20260831140000_the_rake_law_gets_an_alarm.sql`.

## Why it went

Nothing could ever match it. `ca_rake_schedule` prices cash tables only, and
`trg_tables_creation_guard` -> `fn_tables_creation_guard` raises
"big blind must exceed small blind" for a cash table, so a 5/5 cash table
cannot exist. Production confirms it: zero tables at 5/5, zero hands ever
priced by it. `src/config/blindsPresets.ts` offers no 5/5 preset. The row also
sorted out of order between 2/5 and 3/6, which is the tell of a typo entered by
big blind where 5/10 belongs.

Dan ruled it a typo. Deleted, not legalised — `bb == sb` remains illegal and
the creation guard is untouched.

## What changed observably

Nothing that anything can ask. `findScheduleMatch` requires an exact sb/bb
match, so no live table's price moves. The only difference is hypothetical:
`fn_effective_rake_cap(5, 5)` returned 7.50 from the row and now returns 8.00
from the `mid` tier — a question no table can pose.

## How the delete is made permanent

`20260831140000`'s seed is re-runnable (`INSERT ... ON CONFLICT DO UPDATE`), so
the DELETE alone could be silently undone by an out-of-order replay of that
file. The migration therefore also adds
`CHECK (bb > sb)` as `ca_rake_schedule_bb_exceeds_sb`, so a re-seed carrying the
5/5 row fails loudly rather than resurrecting it. A clean ordered replay is
unaffected: `20260831140000` inserts before this file exists, and this file then
deletes and locks.

## Verified

- `node scripts/ci/check-rake-schedule-parity.mjs` — OK, 19 stakes identical on
  client and server (was 20). All three edits land in one commit, as the
  blocking parity gate requires.
- `npx vitest run` on the four client rake specs — 83 passed.
- `npx vitest run` in `server/` on the two server rake specs — 78 passed.
- `tests/unit/theFormOffersStakesTheScheduleCanPrice.test.ts` had a skipped spec
  ("AWAITING DAN: the 5/5 schedule row can never match a legal table"). Its
  `.skip` is removed in this commit, per CLAUDE.md section 5 rule 8, and it now
  also pins `bb > sb` for every row in the schedule.
- Production SELECT (read-only) before commit: 0 tables at 5/5, 0 hands, 1
  schedule row, and it was the only row in the table with `bb <= sb`.

The migration was NOT applied to production from this session.
