# A club's day rake row is taken at commit

2026-10-01. Migration `20261001005431_a_club_day_rake_row_is_taken_at_commit`, applied to
production at 01:10 UTC and recorded in `supabase_migrations.schema_migrations` with the
file's exact bytes (md5 `edef6b4c0315e1ae39903a1799d44787`). Law:
`tests/a-club-day-rake-row-is-taken-at-commit.law.test.ts`. Isolated proof:
`scripts/qualification/club-rake-daily-at-commit.py`.

## What was expensive, read from production

Production Postgres cancels 700 to 1,300 statements every 10 minutes on the 8 s statement
timeout. The three largest consumers of database time in `pg_stat_statements` (about 55 h
window) are the PostgREST calls of the hand path, about 2.17M calls each:

| RPC (expanded from `pgrst_source`)           | mean   | total      | WAL per call |
| -------------------------------------------- | ------ | ---------- | ------------ |
| `fn_project_hand_side_effects`               | 131 ms | ~285,400 s | 24 kB        |
| `fn_ca_process_hand_post_commit_obligations` | 131 ms | ~283,700 s | 16 kB        |
| `fn_ca_commit_hand_submission`               | 115 ms | ~249,700 s | 64 kB        |

`track_functions` is `none` and `pg_stat_statements.track` is `top`, so nested time is not
counted anywhere. The cost was named instead from what the statements wait on: sampled
`pg_stat_activity` / `pg_locks` / `pg_blocking_pids`, and the Postgres log, whose
`parsed.context` names the exact line every cancelled statement was waiting on.

Statement timeouts, 24 h to 2026-10-01 00:45 UTC, by RPC and by the line they died on:

| RPC                            | line                                                         | cancelled |
| ------------------------------ | ------------------------------------------------------------ | --------- |
| post-commit obligations        | `INSERT INTO public.ca_club_rake_daily ... ON CONFLICT`      | 11,373    |
| post-commit obligations        | `club_wallets` (00:05-00:17 wallet-first window, reverted)   | 2,949     |
| post-commit obligations        | `vip_points_carry` (per player)                              | 1,453     |
| post-commit obligations        | `profiles` FK from `rake_attributions` (the horse claims)    | 421       |
| post-commit obligations        | other                                                        | 857       |
| `fn_project_hand_side_effects` | `ca_club_rake_daily`                                         | 1,172     |
| `fn_ca_resume_hand_submission` | its candidate scan of `hand_submissions` (see "Not changed") | 9,339     |

Lock waits over one second on the day rake row (`log_lock_waits`), 30-minute buckets from
19:00 to 00:30 UTC: 200 to 2,400 waits per bucket, mean 1.7 to 2.9 s, p90 2.3 to 5.4 s, 370 to
6,800 seconds of waiting per half hour.

## Why that row

`ca_club_rake_daily` holds one row per (club, UTC day). Every raked cash hand upserts it, from
the `AFTER INSERT ... FOR EACH STATEMENT` trigger on `rake_records`, which fires inside
`atomic_distribute_rake`: after the VIP award, and before the rake attributions (whose
`profiles` foreign key waits behind `fn_ca_horse_claim_due`'s `FOR UPDATE`), the legs, the
club and union wallets, the BBJ pool, the promo playthrough, the insurance and add-on
receipts, and the PostgREST round trip to COMMIT. A union hand also writes the row of every
member club it attributes rake to (Midway Union's hands write SHARK CLUB's and Midway's).
The row lock is held to COMMIT, so every hand of the club - and every union hand - queued
behind the slowest hand in front of it, including one parked behind a horse claim's profile
lock. A reporting rollup was serialising the club. It also lost hands: the trigger swallows
its own deadlock, and 130 hands a day were missing from the Financials per-day rake for
exactly that reason (`docs/evidence/chip-deadlocks-2026-10-01.md`).

## What changed

Only WHEN the same upsert runs: at COMMIT.

- The `rake_records` trigger is untouched (same name, definition, function, filter).
- Its function `trg_ca_club_rake_daily_insert` changes by one asserted substitution (pinned
  md5 before and after, reverse substitution proved, grants unchanged): instead of calling
  `fn_ca_club_rake_daily_apply(v_ids)` there and then, it writes the same ids into
  `smarter_private.ca_club_rake_daily_at_commit`.
- That table is UNLOGGED and per transaction: its `DEFERRABLE INITIALLY DEFERRED` row trigger
  `smarter_private.fn_ca_club_rake_daily_apply_at_commit` deletes the row and calls the
  unchanged `fn_ca_club_rake_daily_apply(ARRAY[id])` at COMMIT, with the old failure rule word
  for word (WARNING, the hand commits). No WAL, no foreign key, no grant to any client role.
- `fn_ca_club_rake_daily_apply` and `fn_ca_club_rake_daily_compute` are not touched (md5
  pinned before and after). No money table or money function changes: `atomic_distribute_rake`
  and the post-commit obligations are byte for byte what they were.

The club's day row is now locked for the commit and nothing else. In the one order of
`2026-10-01-the-chip-estate-takes-its-locks-in-one-order.md` it now sits where that order
puts club-day rollups: after the club's bank.

### The first version was refused, and why that matters

The first version swapped the trigger on `rake_records` itself (a deferred constraint trigger
replacing the statement trigger). At 01:05 UTC its own 2 s `lock_timeout` refused it, having
changed nothing: `DROP TRIGGER` needs ACCESS EXCLUSIVE on `rake_records`, and some open hand
always holds that table for longer than 2 s (read at the time: post-commit obligations 3 to 4
s old, a tournament finish 6.7 s old) - the convoy this is for. The applied version takes no
lock on any hot relation: it creates a new table and a trigger on it, and replaces one
function body.

## Proof

**Same values, on production rows (rolled back).** One `execute_sql` call, one `DO` block
ending in `RAISE EXCEPTION 'PROBE ...'`: 4,003 cash rake rows of 2026-09-29 12:00 to 14:00
UTC (2,399 of them on union tables, split across clubs). Sub-block 1 applied them in one
statement-form call, read every 2026-09-29 day row as text, rolled itself back; sub-block 2
applied them one id at a time in insert order, read again, rolled back. Result:
`statement_form_equals_row_form=t` (text-identical on all 4 club rows, including the 20-digit
union shares), `rollup_moved=t` (the test was not vacuous). Nothing committed.

**Same values and the lock, in isolation.** `scripts/qualification/club-rake-daily-at-commit.py`
builds its own PostgreSQL 17 cluster with chip-deadlocks.py's machinery and production's
md5-pinned bodies, adds production's `rake_attributions.player_id -> profiles` foreign key,
and runs each case before and after executing the migration file itself:

- `stalled-hand-holds-its-club`: a third session holds one player's profile FOR UPDATE (the
  horse claims). Hand 1 of a club names that player and stalls on the foreign key. BEFORE:
  hand 2 of the same club waits on `ca_club_rake_daily` behind it (read from the cluster's
  `log_lock_waits` line, as production logs it). AFTER: hand 2 rakes and commits in 0.03 s
  while hand 1 is still stalled. Both hands complete; the day row is identical.
- `same-rows`: two raked hands through `atomic_distribute_rake`, a multi-row INSERT of cash
  rows (a union table attributed to two member clubs, plus a standalone row), a tournament row
  (excluded) and a rolled-back hand. Every day-row value identical before and after; the
  scratch table is empty once every transaction has ended; no deadlock.

```
PG_BIN=/opt/homebrew/opt/postgresql@17/bin \
python3 scripts/qualification/club-rake-daily-at-commit.py --work <short empty dir>
```

## Production before and after

AFTER_MEASUREMENT

## Not changed here, and why

- **`fn_ca_resume_hand_submission`** (9,339 timeouts in 24 h, 98% of them its candidate
  scan). The scan reads every `hand_submissions` row of the table (5.9M rows, 28 GB) joined to
  `hand_atomic_commits` to find the lowest unfinished one, so its cost grows with a table's
  whole history. The real fix is to make that scan O(unfinished), which rewrites its
  predicate - and open PR #5432 (HELD for an owner decision) rewrites that exact predicate
  (horse-only commit rows pruned at 8 days read as "unfinished"), as do #5363 and #5058 nearby.
  Racing them would break their pinned substitutions. Reported, not touched.
- **The club and union banks.** After this change a raked hand still serialises its club from
  the `club_wallets` UPDATE to COMMIT, and a union hand its union from `union_wallets`. That is
  `atomic_distribute_rake`, which the lock-order work of 2026-10-01 owns (pair 3 open); not
  touched.
- **The horse claims holding `profiles` FOR UPDATE** across a whole run (pair 4,
  `20260930233500_a_horse_claim_run_ends_inside_its_timeout`). Not touched.
- **WAL.** Commits wait on `LWLock:WALWrite` (the most frequent wait in every sample, about 12
  backends at once). The hand path writes about 150 kB of WAL per hand (commit 64 kB,
  projection 24 kB, post-commit 16 kB, retain 14 kB, facts 11 kB, ...), about 5 MB/s at peak,
  and `hand_atomic_commits` takes 4.3M non-HOT updates (0 HOT: the post-commit completion
  UPDATE changes a column in a partial index's predicate). Shrinking that is a design change
  on the settlement path, reported with these numbers, not attempted here.
