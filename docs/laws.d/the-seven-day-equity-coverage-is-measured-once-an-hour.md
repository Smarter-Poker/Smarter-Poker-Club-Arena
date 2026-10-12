# tests/the-seven-day-equity-coverage-is-measured-once-an-hour.law.test.ts

The seven-day all-in equity coverage (section 2f of `ca_stats_witness_audit`)
is measured once an hour. It was 75-80% of every 15-minute run of job 263 (78.4 s
of about 100 s), about 7,500 s of database time a day, for two counts that move
by a few seats an hour. It is now measured on the run in the first quarter of
the hour, or when there is no earlier reading or the latest reading is NULL,
and otherwise carried forward from the latest log row, so `ca_stats_health`
shows a figure at most an hour old. The law pins the two fragments replaced on
the md5-pinned live text and the pinned post-image, the carry and measure
conditions, the unchanged 2f statement, and that no schedule changes. The CI
harness proves the first reading, the carry, and that a measured reading equals
the pre-image's on the same data.
