# The Dead Tour Scraper Is Retired

## What Was Wrong

`ScraperCritical` ("[tour-schedule-scraper] Scraper produced no output -
possible config error") paged on every run of the workers route
`/cron/tour-schedule-scraper`, every third day at 04:00 UTC: ten pages from
2026-09-16 to 2026-10-13. The route reads its tours from
`tour_schedule_sources` and `tour_schedule_registry`, created on 2026-04-26 to
replace the old on-disk JSONs. Neither table has ever held a row
(`n_tup_ins = 0`), so every run since the port scraped zero tours; its output
table `tour_event_details` was last written on 2026-04-08. The live tour
pipeline is the local tours runtime (`scripts/tour_stealth_scraper.py` in the
World Hub), which reads `tour_source_registry` (26 tours) and writes
`tour_stop_events` (last write 2026-10-13).

The detector is right. The job is the defect: its work moved and it was never
unscheduled.

## The Fix

- World Hub: `/api/cron/tour-schedule-scraper` leaves the OpenClaw
  dispatcher's `ALL_CRONS` and route map (companion pull request).
- Club Arena migration `20261015095255_the_dead_tour_schedule_scraper_is_a_retired_cron_job`
  registers `/cron/tour-schedule-scraper` in `ca_retired_cron_jobs`, which both
  silence readers exclude, so the job going quiet does not page
  `OpenClawJobsHaveGoneSilent` six days later. It refuses to run twice and
  refuses to retire the scraper if either configuration table has rows again.

## Pinned By

`scripts/ci/test-the-dead-tour-scraper-is-retired.py` on native PostgreSQL
with the production view captured 2026-10-15 (workflow
`the-dead-tour-scraper-is-retired.yml`): the quiet scraper pages before, leaves
the view after, a healthy job stays quiet and a stopped job still pages.
