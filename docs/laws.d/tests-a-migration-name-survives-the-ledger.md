# tests/a-migration-name-survives-the-ledger.law.test.ts

On 2026-09-28, 194 migrations production had applied had no file in Club Arena
or World Hub by the rule of `check-applied-migrations-are-recorded.mjs`, and
about 45 of them did have a file: the author's, under a letter-suffixed stamp
(`20260724f_...`) or a name longer than the 60 characters one apply path keeps,
so neither the version nor the name tied the ledger row to it. 188 of the 194
were older than the seven-day window the scheduled audit had ever read. This
law pins three fixes: `check-new-migration-version-collisions.mjs` refuses a
NEW migration with a letter-suffixed stamp or a name over 60 characters (a
verified recording keeps production's version and name and is exempt);
`applied-migrations-recorded.yml` reads the whole history since 2026-04-01 on
the Monday-morning run of its existing schedule, with `--fail`; and
`scripts/dev/export-applied-migrations.sh` decides "missing" with the CI rule,
never deletes or overwrites a file, and reads production read-only.
