# The Diamond Migrations Are On Record Again

Date: 2026-09-19. Branch: `agent/cw-diamond-p0/fix/diamond-p0-migration-records`. Scope: repository records only. No migration is applied, replayed or changed by this delivery.

## What was wrong

The September 16 restoration (PR #4711, `ea498c1fab`) returned the application tree to the September 13 baseline. Twenty Diamond Arena migrations that had been applied to production `kuklfnapbkmacvwxktbh` on September 13 through 16 lost their repository files in that reset, while the objects they created stayed live and later migrations on `main` kept calling them (`20260917233447_tournament_original_funding_and_obligation_receipts.sql` calls `fn_poker_diamond_tournament_charge` and `fn_poker_diamond_tournament_pay`; more than twenty later migrations reference `fn_poker_diamond_tournament`). `Applied Migrations Are Recorded` therefore had twenty Diamond names with no file, and nobody reading the repository could see the definition of a function the repository itself depends on.

One of the twenty, `20260914114052 the_diamond_kind_map_names_every_writer`, never had a file in any commit: it was applied straight from the transport and exists only in `supabase_migrations.schema_migrations.statements`.

## What this delivery does

Nineteen files are restored byte for byte from the last pre-restoration tree (`72a9b275fd`) under their original names, plus the eight `scripts/ci/schema-manifest.d/` fragments that declare the objects they own:

| File                                                                         | Applied as (version, name)                                             |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `20260913171905_the_diamond_ledger_sums_itself.sql`                          | 20260913172013 the_diamond_ledger_sums_itself                          |
| `20260913235649_the_diamond_seat_guards_know_a_tournament_seat.sql`          | 20260914004611 the_diamond_seat_guards_know_a_tournament_seat          |
| `20260914015457_the_wallet_learns_the_diamond_arena.sql`                     | 20260914020333 the_wallet_learns_the_diamond_arena                     |
| `20260914024241_a_diamond_tournament_entry_is_custody.sql`                   | 20260914024241 (same)                                                  |
| `20260914032315_a_diamond_tournament_pays_from_its_own_custody.sql`          | 20260914032315 (same)                                                  |
| `20260914034708_a_diamond_tournament_door_answers_the_client.sql`            | 20260914034708 (same)                                                  |
| `20260914040416_the_diamond_tournament_doors_state_their_grants.sql`         | 20260914040416 (same)                                                  |
| `20260914041258_the_diamond_tournament_money_doors_are_watched.sql`          | 20260914041258 (same)                                                  |
| `20260914041635_the_play_state_columns_fix_their_search_path.sql`            | 20260914041635 (same)                                                  |
| `20260914043752_the_diamond_tournament_ledger_indexes_its_arena.sql`         | 20260914043752 (same)                                                  |
| `20260914062900_diamond_health_requires_known_comparisons.sql`               | 20260914063002 diamond_health_requires_known_comparisons               |
| `20260914101812_the_wallet_knows_the_cheapest_seat_in_the_diamond_arena.sql` | 20260914101922 the_wallet_knows_the_cheapest_seat_in_the_diamond_arena |
| `20260914103736_the_diamond_arena_reconciles.sql`                            | 20260914103833 the_diamond_arena_reconciles                            |
| `20260914103912_a_diamond_seat_exit_goes_home_through_its_own_door.sql`      | 20260914103912 (same)                                                  |
| `20260914110559_where_the_diamonds_go.sql`                                   | 20260914111215 where_the_diamonds_go                                   |
| `20260914111558_a_diamond_rebuy_proves_its_generation.sql`                   | 20260914111558 (same)                                                  |
| `20260914111709_a_diamond_bounty_is_paid_from_its_own_bank.sql`              | 20260914111709 (same)                                                  |
| `20260914113514_a_diamond_mystery_chest_holds_whole_diamonds.sql`            | 20260914113514 (same)                                                  |
| `20260916050120_diamond_bonus_club_foreign_key_is_indexed.sql`               | 20260916072541 diamond_bonus_club_foreign_key_is_indexed               |

The twentieth, `20260914114052_the_diamond_kind_map_names_every_writer.sql`, is written from the stored statements of that version: 9,903 bytes, md5 `32d5dcbbf9329ef09272e0bb311e3089`, identical to what the database recorded. It redefines `fn_diamond_kind_bucket` after `where_the_diamonds_go`, so the live function is the one in this file, not the one in `20260914110559`.

Eight of the nineteen carry a file stamp that differs from the version the transport recorded; the recorded-migrations check keys on either the version or the name, and every name matches. No stamp collides with a file already on `main`.

## What this delivery does not do

It restores no client, engine or test code. The Phase 8 engine boundary, the Phase 9 bounty and mystery engine work, the wallet phases and the priced-in-Diamonds client are still absent from `main` and are re-landed separately, each against the doors these files define. Both arena switches stay off. Other archived migrations from the same reset that are not Diamond Arena work (horse observation, chip statement cursor, sponsor billing, video library) are outside this delivery and remain unrecorded.

## Verification

- Every restored file's bytes equal `git show 72a9b275fd:<path>`; the backfilled file's md5 equals `md5(array_to_string(statements, E'\n'))` for version 20260914114052 in production.
- Every object named in the eight fragments exists in production (`pg_proc` / `pg_class`, read 2026-09-19).
- `node scripts/ci/check-new-migration-version-collisions.mjs` and the migration-file unit tests pass on the candidate; the applied-migrations-recorded check clears these twenty names on its next scheduled run.
