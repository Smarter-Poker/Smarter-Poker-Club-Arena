# The Diamond cash rake is swept to the house every hour (2026-10-07)

## What was missing

A raked Diamond cash hand does not pay the house when it settles. The settler
moves the rake from the payers' custody into `ca_diamond_rake_accrual`, inside
the arena float, and `fn_ca_diamond_sweep_cash_rake` carries it to
`ca_diamond_house` later, in one write per sweep (design R4, built by
`20261005151712` and `20261005183028`). Diamond cash reopened at 02:13 UTC on
2026-10-07, and nothing called the sweep: no cron job, no engine or client
path. Every Diamond of cash rake would have stayed in the arena float.

## The decision

No owner answer set how often the sweep runs. Decided by Claude on Dan's
delegation and recorded as ruling 26 in `docs/DIAMOND-RULINGS.md`: every hour,
at :14 UTC. Hourly keeps platform-owned rake in the player-side float for
under an hour, keeps the house current for the hourly Diamond snapshot (:10)
and trial balance (:20), and costs the house row one write an hour. :14
because no hourly job starts there (read from `cron.job` and
`cron.job_run_details` at 03:35 UTC) and it is far from the :50-:03 break
window.

## The change

`20261007034146_the_diamond_cash_rake_is_swept_to_the_house_every_hour`
schedules `ca-diamond-cash-rake-sweep-hourly` at `14 * * * *`. Its command
opens with its own `SET statement_timeout = '60s'`, takes an advisory lock on
its own name, skips the hour when `fn_platform_frozen()` says the platform is
frozen (CLAUDE.md section 13, invariant 5), and otherwise calls the sweep. A
skipped hour loses nothing: the rows stay unswept and counted, and the next run
takes them oldest first. The file checks that the sweep exists and that the
owner's destination is the house, removes any earlier job of the same name,
and before it commits proves the job (once, active, exact schedule and
command), the two arena switches (unchanged) and the Diamond identity (0). It
sends no DDL and never calls the sweep itself.

`docs/attestation/cron-roster.tsv` moves from 126 to 128 active jobs. The live
reading found two rows that had moved without the roster: the
`horse-presence-heartbeat` job (`20261005174041`) and
`ca-ratchet-watch-hourly` moved from :35 to :29 (`20261004002936`). Both are
recorded there, with this job.

Pinned by `tests/the-diamond-cash-rake-is-swept-to-the-house-every-hour.law.test.ts`
and `tests/the-scheduled-work-roster-is-pinned.law.test.ts`.
