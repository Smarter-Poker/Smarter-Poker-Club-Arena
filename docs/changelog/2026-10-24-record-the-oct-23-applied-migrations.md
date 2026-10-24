# Record the eight migrations applied on 2026-10-23 (2026-10-24)

`Installed and merged migrations agree` (scripts/ci/check-applied-migrations-are-recorded.mjs) went red on every pull request: eight migrations ran against production on 2026-10-23 and none was on `main`. Their authored copies sat in two unmerged, conflicted pull requests, #7822 (horse roster) and #7846 (Midway Lightning fill). Two had passed the 24-hour grace; the other six would have crossed it the same night.

## What is committed

| Version        | Name                                                         | Source                   | Bytes vs production                                                    |
| -------------- | ------------------------------------------------------------ | ------------------------ | ---------------------------------------------------------------------- |
| 20261023182203 | the_horse_roster_sizes_itself_to_the_floor_and_keeps_its_hor | authored copy from #7822 | production holds NULL statements; the authored file is the only record |
| 20261023192030 | plo_low_stakes_open_to_the_roster_on_the_floor_sized_roster  | authored copy from #7822 | NULL statements, as above                                              |
| 20261023213842 | midway_madness_lightning_test_games_keep_fifty_horses_each   | production               | byte-exact, md5 e2b73d86...                                            |
| 20261023214601 | midway_tables_fill_full_for_the_lightning_test               | production               | byte-exact, md5 cbf21d90...                                            |
| 20261023220839 | midway_lightning_fill_and_all_horse_limits_removed           | production               | byte-exact, md5 f1b48cf3...                                            |
| 20261023221147 | midway_plo_games_switched_back_on                            | production               | byte-exact, md5 1ac946fe...                                            |
| 20261023222643 | midway_lightning_fill_starts_with_horses_awake_and_free      | production               | byte-exact, md5 aa37f25c...                                            |
| 20261023224834 | midway_lightning_fill_draws_from_every_union_club            | production               | byte-exact, md5 49544dd0...                                            |

The six with stored statements are recordings of what ran, not of what #7846 says ran: two of #7846's files had drifted (220839 carried two extra blank lines; 222643 was missing four comment lines production holds and carried an install note added afterwards), and 224834 existed in no branch at all. Each was rebuilt from `supabase_migrations.schema_migrations.statements` and proved against `public.fn_ca_migration_text(version)` by md5 before it was written. All six have a row in `scripts/ci/recorded-migrations.manifest.json`; `check-definer-authorization`, `check-money-trigger-declared` and `check-no-new-band-aids` raise nothing against any of the eight.

Nothing is applied by this change. Every version is already in `schema_migrations`, so `Apply Merged Migration` skips them.

## Also

`tests/a-reminder-needs-a-device.law.test.ts` normalised every migration in the repo, joined into one string, to find one index: 3.4 to 4.8 s against a 5 s budget, failing under parallel load on `main` as well. It now normalises only the files that name the index (about 160 ms), with the same verdict.

## Still open

#7822 and #7846 carry application code as well as these migrations, and both are conflicted against `main`. Merging this does not merge or close them; their owners rebase onto it, and the eight identical files drop out of their diffs.
