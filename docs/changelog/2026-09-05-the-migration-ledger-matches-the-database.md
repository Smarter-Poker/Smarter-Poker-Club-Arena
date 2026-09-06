# The migration ledger matches the database

2026-09-05. Repo-only. **No migration was applied, no database object was
changed, and nothing was written to `supabase_migrations.schema_migrations`.**
Everything below is a file that DESCRIBES what production already has.

`supabase/migrations/` and `supabase_migrations.schema_migrations` are supposed
to be two views of one thing. They were not. Three separate ways they had come
apart, all three verified against production before anything was written.

---

## 1. Two applied migrations had no file at all

Recorded in the ledger, absent from `git ls-tree -r origin/main
supabase/migrations/` under any name:

| version          | name                                                      |
| ---------------- | --------------------------------------------------------- |
| `20260905155400` | `main_1_is_the_live_one_and_a_closed_table_owns_no_index` |
| `20260905155937` | `every_horse_plays_at_least_two_tables`                   |

Production carried DDL the repo could not reproduce. A rebuild from this repo
would not have had it, and no agent reading the repo could know it existed.

Both are now mirrored, at their recorded versions, reconstructed from
`schema_migrations.statements` and checked object by object against the live
catalogue.

**`20260905155400`** creates two BEFORE triggers on `public.tables`, both live
and enabled:

- `fn_closed_cluster_main_releases_index()` fired by
  `trg_tables_closed_main_releases_index`, `BEFORE INSERT OR UPDATE OF
lifecycle, is_deleted`, nulling `main_index` when a cluster main is closed
  or soft-deleted.
- `fn_cluster_table_ceiling()` fired by `trg_tables_cluster_table_ceiling`,
  `BEFORE INSERT`, returning NULL (skipping the insert) when a cluster is
  already at `cap_mains + 1 + optional second feeder + 2` live tables, and
  logging `table_refused_at_ceiling` into `cash_cluster_events`.

`pg_get_functiondef` and `pg_get_triggerdef` return exactly those bodies.

**`20260905155937`** dropped `sh_tourney_only_one_table`, lifted every
`stable_hand_membership_tags` row to `max_tables >= 2`, and narrowed the range
check to `CHECK (max_tables >= 2 AND max_tables <= 4)`.

## 2. One version drift

`supabase/migrations/20260906003931_the_tourney_tag_can_hold_the_one_table_its_own_migration_dec.sql`
was on `main`, but the ledger records that same NAME under version
`20260906004017`, and `20260906003931` appears nowhere in it. The version
Supabase stamps is the clock at apply time, not the filename, so the two
diverged by 46 seconds. A fresh apply built from this repo would have run that
file a second time under a version nothing had seen, re-running its
DROP/ADD constraint cycle and its tourney `UPDATE`.

The file is renamed to `20260906004017_<same slug>.sql` and its header records
why the number changed. The two references to the old filename, in
`docs/HANDOFF-TABLE-STAKES-CURRENT-STATE.md` and in
`docs/changelog/2026-09-05-a-horse-plays-the-stake-its-bankroll-supports.md`,
are updated.

### The two findings are the same story

`20260906004017` is what deliberately walked `20260905155937` back, because the
narrowed range made `MAX_TABLES_TOURNEY_ONLY = 1` in
`server/src/services/StableHand.ts` unwritable and no horse re-tag was possible
at all. Production today has `sh_tourney_only_one_table` back,
`stable_hand_membership_tags_max_tables_check` widened to `max_tables >= 0 AND
max_tables <= 4`, and 473 of 1,580 rows at `max_tables = 1`. Both files now
exist, in the order they ran, so a rebuild replays that decision instead of
landing somewhere neither migration intended.

## 3. Twenty-five no-op files that were never applied

`supabase/migrations/20260905085729..085753_squatter_holding_this_second.sql`,
each containing only `-- squatter`, tracked on `main`, and **none of the 25
versions in `schema_migrations`**. They are debris from an interrupted run of
`tests/a-migration-version-is-reserved-not-guessed.law.test.ts`, whose
squatting loop removes them in a `finally` a killed process never reaches.
`git rm`'d. `.gitignore` already carries the four fixture patterns (lines
204-207), and that test now writes its fixtures to
`.tmp-migration-reservation-probe/` rather than `supabase/migrations/`, so no
new squatter can reach the directory.

---

## What a mirror file is, and why nobody applies one

A mirror is a `.sql` file written AFTER the fact to describe DDL production
already has. It exists so the repo can rebuild the database it actually runs.
It is not a change request and it is not work waiting to be done.

It carries the version the ledger already holds. That is the one case where you
do **not** run `scripts/new-migration.mjs` (CLAUDE.md 4.5), and the reason is
the same reason 4.5 exists: a reserved version would open a SECOND ledger row
for DDL that has run once, and a rebuild would then apply it twice.

Its first line is `-- BACKFILLED <date> from
supabase_migrations.schema_migrations.statements.` That marker is not
decoration. `scripts/ci/check-migrations-applied.mjs` reads it and exempts the
file from the "a migration this branch adds must already exist in the live
schema" gate, which is the right question for new work and a false positive for
a record of old work. 557 files on `main` already carry it.

**Applying one by hand is the hazard.** `20260905155400`'s body ends in an
`UPDATE` that nulls `main_index` on every closed cluster main - 2,935 rows
today. `20260905155937`'s body would revert `20260906004017` and break the
horse re-tag again. Both headers say so in full.

Each mirror ends with a `DO $mirror$ ... RAISE EXCEPTION ... $mirror$` block
asserting that the OBJECTS it describes are in the catalogue, so a mirror that
has drifted from the database fails loudly instead of reading as documentation.
The assertions are about objects, not predicates, on purpose: `20260906004017`
replaced `20260905155937`'s predicate deliberately, and pinning the old
predicate would make the mirror demand a revert of a decision that has its
reasons written down.

## One thing found on the way, not fixed here

`20260905155400`'s own `DO $assert$` was true when it ran and is not true now.
2,935 closed cluster mains hold a `main_index` again, every one of them stamped
`updated_at = 2026-09-05 15:57:38.603261+00` - a single bulk write about three
minutes after the migration, setting `main_index` on rows that were ALREADY
closed. `UPDATE OF lifecycle, is_deleted` does not fire for an update touching
neither column, so `trg_tables_closed_main_releases_index` never saw it. That
is a live gap in whatever performs the renumber pass. It is recorded in the
mirror's header and here, and it is not repaired on this branch, which is
repo-only bookkeeping.

## How to check the invariant in future

Both directions, from a psql session against production:

```sql
-- A. RECORDED BUT NO FILE. Compare against the repo's filenames.
--    Run this, then diff its output against:
--      git ls-tree -r --name-only origin/main supabase/migrations/ \
--        | sed 's|.*/||; s|_.*||' | sort -u
SELECT version, name
  FROM supabase_migrations.schema_migrations
 WHERE version ~ '^\d{14}$'
   AND version >= '20260901000000'
 ORDER BY version;
```

```bash
# The whole comparison in one place, from a checkout with psql available.
psql "$SUPABASE_DB_URL" -At -F'|' \
  -c "select version from supabase_migrations.schema_migrations order by version" \
  | cut -d'|' -f1 | sort > /tmp/ledger.v
git ls-tree -r --name-only origin/main supabase/migrations/ \
  | sed 's|.*/||' | sed -E 's/^([0-9]+)_.*/\1/' | sort > /tmp/files.v

comm -23 /tmp/ledger.v /tmp/files.v   # applied, no file  -> needs a mirror
comm -13 /tmp/ledger.v /tmp/files.v   # file, never applied -> apply it or delete it
```

The repo already has the CI half of this:
`node scripts/ci/check-applied-migrations-are-recorded.mjs --since 20260901000000`
asks the first direction (seven-day window by default, reports without
blocking), and `scripts/ci/check-migrations-applied.mjs` asks the second for
the migrations a branch adds, blocking.
`scripts/ci/backfill-unrecorded-migrations.mjs` writes the mirrors in bulk.

### The scale of what remains

Measured 2026-09-05 against the full ledger (3,650 rows) and the full
directory (2,288 files):

- **2,476** recorded versions have no file, **231** of them since
  `20260901000000`. Most of the pre-September mass is history the estate has
  deliberately not audited (`check-migrations-applied.mjs` calls the old files
  "history, not truth"); the recent 231 is live drift.
- **1,114** files have no recorded version, **207** of them since
  `20260901000000`. A large share of those are the drift shape of finding 2 -
  the recorded NAME still carries the file's original version as a prefix, for
  example file `20260905015127_...` against ledger row `20260905015308
20260905015127_the_bbj_page_names_players_by_their_arena_alias`. Those are
  applied; only the number moved.

Two named in `docs/HANDOFF-TABLE-STAKES-CURRENT-STATE.md` alongside the two
mirrored here are still fileless and were left alone, because they are cluster
work that may be sitting on another agent's branch:
`20260905104226 the_third_seat_waits_90_to_350_seconds_for_a_human` and
`20260906011318 the_feeder_tables_stay_within_one_player_of_each_other`.
Find whose branch they are on before writing a mirror for either.
