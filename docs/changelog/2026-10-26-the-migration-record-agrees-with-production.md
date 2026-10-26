# 2026-10-26 - The migration record agrees with production again

`Installed and merged migrations agree` had been red on `main` since the
2026-10-25 23:23 UTC run. It is not a required check, so nothing was blocked,
but it was right: the repository and the database disagreed in both directions.

## Applied to production with no file in this repo

Three migrations were applied straight from pull requests that are still open,
so production ran SQL that `main` has never seen:

| Applied version  | Name                                                     | From  |
| ---------------- | -------------------------------------------------------- | ----- |
| `20261024233424` | `a_refunded_earlier_registration_is_not_a_second_entry`  | #7968 |
| `20261025024527` | `lightning_earning_club_is_the_funding_chair_club`       | #7983 |
| `20261025052637` | `a_refunded_diamond_or_free_entry_is_not_a_second_entry` | #8019 |

Each is now a **recording** (`scripts/ci/recording-only.mjs`): the file is
`array_to_string(statements, chr(10))` byte for byte, named for the version
production holds, with a row in `scripts/ci/recorded-migrations.manifest.json`
whose md5 equals `public.fn_ca_migration_text(version)` (read 2026-10-26 01:10
UTC). No alias was used: #7968 and the merged #7974 are separate fixes to the
same function, so neither is "the same change already here".

What each one left live, read from production at the same time:

- `fn_cash_earning_club` is exactly the post-image `20261025024527` asserts
  (`b1c21e14021e0e2e7bba28048dcec90e`).
- `smarter_private.f06_movement_never_dealt_prior` carries both refunded-entry
  clauses, under later merged edits.

Recordings are history and are never replayed. If any of the three pull
requests merges its own migration file afterwards, that file's preimage guard
refuses it on a replay (the function has moved on), so nothing applies twice.

## Merged with no install

`20261024232449_flash_pool_join_never_takes_chips.sql` (#7970) merged at
2026-10-25 03:07 UTC and no apply was ever dispatched for it, so
`public.join_flash_pool(uuid,uuid,numeric)`, which takes a buy-in from the
frozen `public.wallets` pool and never seats anyone, stayed callable by any
signed-in or signed-out player.

Installed 2026-10-26 01:18 UTC through `apply-merged-migration.yml`
(repository_dispatch, dry run first, then one transaction, committed in 49 ms,
recorded as `flash_pool_join_never_takes_chips`). Read back: the function still
exists, `authenticated` and `anon` can no longer execute it, and
`flash_pool_players` has 0 rows, so no player lost chips to it.
