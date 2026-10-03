# The union sweep stops rebuilding an unread snapshot (2026-10-03)

Migration: `20261003225101_the_union_sweep_stops_rebuilding_an_unread_snapshot`.
Law: `tests/the-union-sweep-stops-rebuilding-an-unread-snapshot.law.test.ts`
(`docs/laws.d/the-union-sweep-stops-rebuilding-an-unread-snapshot.md`).

## Why (phase 7, availability)

`union-integrity-sweep` (`35 * * * *`, 300 s statement timeout) runs
`fn_union_integrity_sweep_all`. Since 2026-09-26 the open-week rake basis
rebuild ran last, after the money controls, and a timeout in it was trapped so
it could not roll them back. The rebuild is linear in the open week:

| snapshot computed | compute |
| --- | --- |
| 2026-09-14 06:35 | 6.5 s |
| 2026-09-17 17:35 | 8.3 s |
| 2026-09-26 12:35 | 66.9 s |
| 2026-09-28 21:35 | 74.4 s (last one that finished) |

From 2026-09-29 every run has lasted exactly 300 s (`cron.job_run_details`,
every run 09:35-22:35 UTC 2026-10-03): the rebuild is cancelled, the snapshot
stays at 2026-09-28, and about 250 s of a backend an hour, every hour, buys
nothing. Nothing reads `union_rake_basis_snapshot`: no function, view, job, or
source in `src`, `server/src` or `supabase/functions`.

## Change

The rebuild loop and its counters are removed from
`fn_union_integrity_sweep_all`. The money controls (integrity sweep, invoice
ageing, stop-loss, lock expiry and hygiene, period closes), their order and
their handlers are the live text. The answer keeps its `rake_basis` key with
zeros and `retired: true`. `fn_union_rake_basis_refresh`, its table and its rows
stay, so a person can still rebuild the snapshot on demand. No schedule is added
or changed. No money moves.

The law `the-union-sweep-commits-its-money-controls-before-the-snapshot` now
accepts a sweep with no rebuild at all.

## Proof

The migration was applied to a local PG17 holding the exact live pre-image
(md5 `729a5617...`, privileges `{postgres=X/postgres,service_role=X/postgres}`)
and produced the pinned post-image `6000297c...`.

## Applied

Applied to production at 23:05 UTC 2026-10-03, outside the break window
(recorded as `20261003230534`); the live definition reads back as `6000297c...`
with privileges `{postgres=X/postgres,service_role=X/postgres}`.
