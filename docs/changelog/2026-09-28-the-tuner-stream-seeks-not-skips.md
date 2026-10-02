# 2026-09-28 - The self-tuner's hand stream seeks instead of skipping

## What was wrong

`horse_self_tune_log` received zero rows for 2026-09-26, 2026-09-27 and
2026-09-28, while `horse_job_runs` showed the `self_tuner` job claimed on each
day. No `horse_tuner_study_rosters` row exists for any of the three dates, so
every run died before it prepared its cohort.

Postgres logs for 2026-09-28 show the tuner's ten-minute tick hitting its own
claim from 08:16 to 10:56 UTC, with a stale-claim takeover at 10:26:52. Every
attempt therefore started and failed quickly and silently. The engine's stderr
for those hours had already rotated out (5 x 50 MB), so the error text itself
was not recoverable. The cause was reproduced instead.

## Cause

`runSelfTune` streams up to 120,000 cash hands from `hand_history` as a
gap-filler for horses with no `horse_daily_play` rows. It paged with
`.range(offset)`. OFFSET reads and discards every row before the page, and the
planner walks `created_at` and filters tournament hands out one row at a time.
Measured on production 2026-09-28 (read-only `EXPLAIN ANALYZE`):

| page           | result                                                        |
| -------------- | ------------------------------------------------------------- |
| offset 0       | 29 ms (1,000 cash rows kept, 5,447 tournament rows discarded) |
| offset 20,000  | over 25 s, cancelled                                          |
| offset 119,000 | over 20 s, cancelled                                          |

The engine's service role times out at 8 s. When the fleet swung toward
tournaments on 2026-09-26 (`decide_tournament` 1.72M to 2.22M) the deep pages
crossed that limit. The loop had no local catch, so the timeout unwound the
whole study.

## Fix

- The stream pages by keyset on `(created_at, id)`. The cursor is the last
  row's raw `created_at` string (microseconds preserved) and id.
- Each page sends a plain `created_at <= cursor` beside the strict OR. The OR
  alone is only a filter, measured at 5.2 s for depth 15,000 because the scan
  still started at the newest row. With the bound it is an index condition:
  1.1 s at a five-day depth with cold pages, about 40 ms warm.
- A failed stream now costs only the horses it gap-fills. The play-row study
  still completes, as the sibling reads (real nets, leak tags, tournament
  leaks) already did.

Pinned by `server/src/services/TheTunerStreamSeeksNotSkips.law.test.ts`.

## Not done, and why

- **No backfill for 2026-09-26/27.** The study reads a rolling seven-day
  window at run time, so re-running it under a past date would only relabel
  today's study. The next scheduled run covers the whole window.
- **No new liveness guard.** A claimed night without a completion receipt
  already stays open for takeover, and the nightly audit already filed
  `nightly_job_incomplete` as critical on day one. Another net would not have
  changed the outcome (CLAUDE.md 10.11, 10.12).
