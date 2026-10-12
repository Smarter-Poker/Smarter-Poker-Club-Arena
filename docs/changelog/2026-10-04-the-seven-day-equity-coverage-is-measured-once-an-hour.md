# The seven-day equity coverage is measured once an hour (2026-10-04)

Migration: `20261004003115_the_seven_day_equity_coverage_is_measured_once_an_hour`
(applied 00:33 UTC, recorded as `20261004003248`).
Law: `tests/the-seven-day-equity-coverage-is-measured-once-an-hour.law.test.ts`
(`docs/laws.d/the-seven-day-equity-coverage-is-measured-once-an-hour.md`).
Harness: `scripts/ci/test-the-seven-day-equity-coverage-is-measured-once-an-hour.py`.

## Why (phase 7, availability)

Job 263 (`ca-stats-witness-audit-15m`, :09/:24/:39/:54) ran 96 times a day at
106 s on average (max 660 s): about 10,000 s of database time a day. Section 2f,
the seven-day all-in equity coverage over 927,565 owed seats, measured 78.4 s on
its own, 75-80% of every run. Its two counts move by a few seats an hour
(929,615 / 1,433 at 00:24 against 927,929 / 1,436 at 23:39).

## Change

`ca_stats_witness_audit` measures 2f on the run in the first quarter of the hour
(the :09 run) or whenever there is no earlier reading or the latest reading is
NULL. The other three runs carry the latest log row's pair forward unchanged, so
every row still carries a reading and `ca_stats_health`, which reads the latest
row, shows a figure at most an hour old. Whenever 2f runs it runs exactly as
before. Sections 2a-2e and the schedule are untouched. Saves about 72 x 78 s,
roughly 5,600 s of database time a day.

Applied as a substitution of two fragments on the md5-pinned live text
(`0260f227...` to `962ed3ca...`, computed read-only on production first).

## Proof (local PG17, the shipped migration on a stand-in with the exact 2f statement)

| case | result |
| --- | --- |
| both fragments found once and replaced | ok |
| no earlier reading: measured outside the first quarter (35/5) | ok |
| outside the first quarter: carried unchanged although facts moved (35/5) | ok |
| inside the first quarter: measured, equal to the pre-image on the same data (45/5) | ok |
