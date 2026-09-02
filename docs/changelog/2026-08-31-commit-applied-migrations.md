# Five migrations that production had and the repo did not

Source-of-truth repair. Nothing here changes production. Every one of these
five migrations was already applied to `kuklfnapbkmacvwxktbh` through the
Supabase MCP `apply_migration` during the 2026-08-31 live cash-game audit, and
none of them was ever committed. The database therefore carried schema and
behaviour the repository did not record.

## What was missing

| version        | file                                                       | what it does                                                  |
| -------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| 20260831002318 | `20260831002318_backfill_completed_tournaments_ended_at.sql` | stamps `ended_at` on 10 tournaments flipped to COMPLETED without it |
| 20260831090516 | `20260831090516_repair_double_stamped_spin_prize_column.sql` | realigns a double-stamped `tournament_players.prize` with the money actually paid |
| 20260831101605 | `20260831101605_schedule_reconcile_ledger_nightly.sql`       | schedules `reconcile-ledger-integrity-6h` (pg_cron, `55 */6 * * *`) |
| 20260831111557 | `20260831111557_bomb_backfill_repairs_multi_winner_pots.sql` | creates `fn_backfill_bomb_multi_winner_units` so multi-winner bomb pots can be repaired at all |
| 20260831112020 | `20260831112020_schedule_bomb_multi_winner_repair.sql`       | schedules `bomb-multi-winner-repair-hourly` (pg_cron, `20 * * * *`) |

## Why it mattered

Three of the five are not data repairs, they are standing machinery:

- `reconcile-ledger-integrity-6h` is the pg_cron entry for the money alarm that
  found the 1,033 unaccounted seat exits. Before it, `reconcile_ledger_nightly`
  had no schedule at all.
- `bomb-multi-winner-repair-hourly` keeps multi-winner bomb pots repaired.
- `fn_backfill_bomb_multi_winner_units` is the function that job calls.

A pg_cron job lives only in `cron.job`, and a function lives only in
`pg_proc`. Neither is in any file. Rebuilding this database from
`supabase/migrations/` would have produced a schema with no ledger alarm, no
bomb-pot repair sweep, and no function behind either. That is exactly the
failure `scripts/ci/check-migrations-applied.mjs` was written to prevent, in
the opposite direction: it catches a migration the repo has and production does
not, and nothing was watching the reverse.

## How the files were reconstructed

Each file is `array_to_string(statements, E';\n')` read back out of
`supabase_migrations.schema_migrations` for its version. Every one is a single
statement array, so no join could corrupt a dollar-quoted body, and each file
was verified byte-for-byte against production by md5 before being committed:

    20260831002318  8e0cc084d1d1aa1d9ed7d90910808df6
    20260831090516  a062503facdf96edb58f3583d30133bd
    20260831101605  ccfac9be92180fb70051e2aa2bf5b8e5
    20260831111557  c58e991d0f0311f665c2a6c9f3adb174
    20260831112020  a114ab445e52e484e60dd4fb27d91b9c

## Do not re-apply

These are already in `supabase_migrations.schema_migrations`. They are
committed as history, not as work to run. Both repair migrations are
idempotent anyway (each opens with a pre-flight that returns early when the
condition it repairs is already gone), and both schedule migrations
`cron.unschedule` before re-scheduling, but that is a safety property, not an
invitation.

## Manifest

`scripts/ci/supabase-schema-manifest.json` gained exactly one line:
`fn_backfill_bomb_multi_winner_units`, inserted in sorted position so the
generator's output is unchanged in every other respect. It was added by hand
rather than by regenerating, because other agents have unrelated live schema
drift and a wholesale regeneration would have swept that into this diff. The
two pg_cron jobs need no manifest entry; the manifest records tables and
functions only.
