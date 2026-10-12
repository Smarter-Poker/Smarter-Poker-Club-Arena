# The Diamond snapshot reads the register once per holder (2026-10-04)

Migration `20261004231413_the_diamond_snapshot_reads_the_register_once_per_holder`.
Law `tests/the-diamond-snapshot-reads-the-register-once-per-holder.law.test.ts`.

## The defect

Three critical `DR0:health_critical` rows, each "Trial balance is incomplete: require one known comparison for each of the five reconciling accounts", status `unknown`, each self-resolved:

| ca_diamond_incidents | filed (UTC)         | resolved (UTC)      |
| -------------------- | ------------------- | ------------------- |
| 869217               | 2026-10-01 16:35:01 | 2026-10-01 18:35:02 |
| 869298               | 2026-10-01 17:35:08 | 2026-10-01 18:35:02 |
| 874553               | 2026-10-03 19:35:02 | 2026-10-03 21:35:00 |

No trial balance broke. In each of those hours the hourly Diamond snapshot (`ca-diamond-snapshot-hourly`, job 201, minute 10) stored nothing, and `fn_ca_diamond_trial_balance` measures every movement from the first snapshot at or after its window start. With none, `player_diamonds`, `fixture_accounts`, `diamond_house` and `total` return a NULL difference, `fn_ca_diamond_health` reads `unknown`, and the watch filed critical.

## The evidence

`cron.job_run_details` for job 201, read on production 2026-10-04 23:10 UTC:

| start (UTC)         | status    | duration | return_message                                                                                                                                                                                        |
| ------------------- | --------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-01 15:10:01 | succeeded | 34.40 s  | 1 row                                                                                                                                                                                                 |
| 2026-10-01 16:10:00 | failed    | 12.04 s  | job startup timeout                                                                                                                                                                                   |
| 2026-10-01 17:10:01 | failed    | 120.04 s | ERROR: canceling statement due to statement timeout. CONTEXT: SQL function "fn_ca_is_fixture_account" statement 1. SQL statement "SELECT (SELECT COALESCE(sum(diamonds),0) FROM public.profiles), ... |
| 2026-10-01 18:10:04 | succeeded | 30.54 s  | 1 row                                                                                                                                                                                                 |
| 2026-10-03 18:10:01 | succeeded | 18.60 s  | 1 row                                                                                                                                                                                                 |
| 2026-10-03 19:10    | no run    |          | the database restarted 19:07-19:12                                                                                                                                                                    |
| 2026-10-03 20:10:00 | succeeded | 13.55 s  | 1 row                                                                                                                                                                                                 |

- 16:10 on 10-01: pg_cron could not open the job's connection. 22 of the 135 jobs started between 16:05 and 16:15 failed the same way; 262 jobs did that day, 255 the next, 81 on 10-03, none on 10-04.
- 17:10 on 10-01: the snapshot's first statement was cancelled at the `postgres` role's `statement_timeout` (2min), inside the per-row fixture test. Jobs 144 (`tourney_money_conservation_hourly`) and 263 (`ca-stats-witness-audit-15m`) were cancelled at 120 s in the same two minutes. The host was saturated, and this was the statement that could not finish.
- Over 347 successful runs since 2026-09-20 the snapshot's p50 is 7.8 s, p95 26.2 s, max 40.3 s.

The hourly `DR11:trial_balance_summary` rows are not missing for those hours: 869216 (16:20), 869220 (17:20) and 874450 (19:20) exist. Each says `accounts_reported: 11, incidents_filed: 0` while four of its comparisons were NULL, which is a "could not tell" recorded as a clean hour.

## The statement

`EXPLAIN (ANALYZE, BUFFERS)` of the snapshot's first statement on production, warm cache, 2026-10-04 23:12 UTC: 3,474 ms, 917,586 buffer reads. One subquery is 855,590 of those reads (93%):

```sql
SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0)
  FROM public.ca_mint_ledger m
 WHERE m.asset = 'diamonds' AND m.holder_type = 'player'
   AND public.fn_ca_is_fixture_account(m.holder_id)
```

`fn_ca_is_fixture_account` is `SECURITY DEFINER` with a `SET` clause, so the planner never inlines it. It ran once per ledger row: 209,249 calls, three index probes each, to keep 23 rows. The register has 8,404 distinct player holders. `fn_ca_diamond_trial_balance` carries the same subquery beside two more passes over the same rows, and it is run by both the :20 watch (job 247) and the :35 health watch (job 347).

## The fix

1. `fn_ca_diamond_snapshot`: the player register is netted per holder in one pass, in a CTE inside the same statement as the balances (still one SQL snapshot), and `fn_ca_is_fixture_account` is put to each holder once. Measured read-only on production: both register figures in 443 ms and 84,975 buffer reads, against 3,269 ms and 856,637 for the fixture figure alone.
2. `fn_ca_diamond_trial_balance`: the same for its three register passes (player, fixture, house): 464 ms and 85,012 buffer reads. `fn_ca_mint_supply('diamonds')` stays the one definition of the register total.
3. `fn_ca_diamond_trial_balance`: with no snapshot at or after the window start it measures from the newest snapshot before it. The comparisons are stock against stored stock, so this is the same question over a longer span, and the note names the snapshot. `fn_ca_diamond_health` has passed that snapshot in by hand since `20261003220245`; the hourly watch and the staff desk did not. No snapshot at all still reads unknown.

No schedule, retry, backfill, index, grant or alert threshold changes. The `ca_mint_ledger` write path is untouched.

## What this does not fix

A snapshot can still be missed when pg_cron cannot start the job or the database is down at minute 10. Those two causes are outside this function. After this change a missed snapshot no longer makes any reader of the trial balance say `unknown`; the next comparison spans the gap.

## The three hours

There is no door that computes a snapshot for a past hour, because the snapshot reads live balances. None is written. The hours are covered by the snapshots either side, each of which stores `unexplained` against the one before it:

| snapshot | taken (UTC)         | compared with  | basis moved | unexplained |
| -------- | ------------------- | -------------- | ----------- | ----------- |
| 767      | 2026-10-01 18:10:04 | 766 (15:10:01) | 29,951      | 0.00        |
| 815      | 2026-10-03 20:10:00 | 814 (18:10:01) | 3,625       | 0.00        |

Whether those three `unknown` hours reset the seven clean days is still the owner's open question in `docs/POKER-ARENA-DIAMOND-BUILD-PROGRAMME.md`; this change does not answer it.

## Proof

- Pre-images transcribed from `pg_get_functiondef` on production and checked by md5 (`d4b4d63f...`, `f744e044...`).
- Local Postgres 16 with the live definitions of both functions and their five helpers, 600 profiles (horses, cert-tagged, `.invalid`, zero-prefix ids) and 28,004 register rows including departed holders, a NULL holder, house, circulation and chip rows. The migration applied; post-image md5s read back as pinned; the snapshot row and all 11 trial-balance rows (notes included) are byte-identical before and after on the same data; a window with no snapshot returned NULL differences before and the in-window figures after; no snapshot at all still returns NULL; a second apply refuses on the pinned pre-image; both `@live-proof` lines read true.
- On production, read-only, one statement at 2026-10-04 23:17:15 UTC: per-row and per-holder reads agree, players 9,099,574.00, fixtures 3,160.00, house 0.00. The migration repeats that comparison before it replaces anything and refuses if a figure differs.
- Not applied to production from this branch.
