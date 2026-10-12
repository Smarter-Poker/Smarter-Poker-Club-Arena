# The heavy hourly watches do not start together (2026-10-04)

Migration: `20261004002936_the_heavy_hourly_watches_do_not_start_together`
(applied 00:30 UTC, recorded as `20261004003020`).
Law: `tests/the-heavy-hourly-watches-do-not-start-together.law.test.ts`
(`docs/laws.d/the-heavy-hourly-watches-do-not-start-together.md`).

## Why (phase 7, availability)

`cron.job_run_details`, 24 h to 00:30 UTC 2026-10-04:

| job | minute | avg | max | failed |
| --- | --- | --- | --- | --- |
| 161 rake-law-adherence-hourly | :40 | 104 s | 601 s | 9 of 23 |
| 214 ca-ratchet-watch-hourly | :35 | 125 s | 311 s | 1 |
| 123 union-integrity-sweep | :35 | 266 s | 301 s | 1 |
| 236 ca-escrow-shadow-hourly | :35 | 104 s | 198 s | 0 |

Job 161 runs `SELECT public.fn_rake_law_check('2 hours'::interval);` with no
statement timeout of its own, so it inherits the postgres role's 2 minutes. Seven
of its nine failures are cancellations at exactly 120.0 s inside
`fn_rake_law_violations` / `fn_effective_rake`; the other two are pg_cron startup
timeouts during the outages. Warm, the whole check takes about 23 s; it passes
120 s only inside the :35-:42 pile-up. `20261002170500` gave nine heavy jobs a
300 s prefix and missed this one. The ratchet watch reads for 20-40 s on its own
and 52-169 s in production, the difference being that pile-up.

## Change

- Job 161 gets `SET statement_timeout = '300s'; ` in front of its unchanged
  command.
- Job 214 (ratchet watch) runs at :29 instead of :35, after the :25-:26
  rollups and clear of the :50-:03 break window. The escrow shadow keeps the :35
  its brief fixed (`tests/law/EscrowShadowNeverRefuses.law.test.ts`) and the union
  sweep keeps :35.

No job is created, no other job changes, no detector's verdict changes.
