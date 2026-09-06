-- BACKFILLED 2026-09-05 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905155937; the .sql file was never committed at the
-- time. Content is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR, AND IT IS A MIRROR OF SOMETHING THAT WAS LATER UNDONE.
--  READ THE WHOLE HEADER BEFORE YOU DO ANYTHING WITH THIS FILE.
-- ===========================================================================
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. This file is the one sanctioned exception, and
-- the exception is what makes it safe: 20260905155937 IS ALREADY IN
-- supabase_migrations.schema_migrations, recorded under the name
-- `every_horse_plays_at_least_two_tables`. A reserved version would open a
-- SECOND ledger row for DDL that has run once, and a rebuild would apply it
-- twice. The file must carry the version the ledger already holds.
--
-- WHAT IT DID
--
-- Dan, 2026-09-05: "100% OF THEM SHOULD BE PLAYING A MINIMUM OF 2 AT A TIME
-- 33% PLAYING 3 AT A TIME AND 33% PLAYING 4 AT A TIME." So it dropped
-- sh_tourney_only_one_table, lifted every stable_hand_membership_tags row to
-- max_tables >= 2, and narrowed the range check to CHECK (max_tables >= 2 AND
-- max_tables <= 4).
--
-- WHAT PRODUCTION HAS TODAY, AND WHY IT IS DIFFERENT (read 2026-09-05)
--
-- 20260906004017 `the_tourney_tag_can_hold_the_one_table_its_own_migration_dec`
-- (this repo:
--  supabase/migrations/20260906004017_the_tourney_tag_can_hold_the_one_table_its_own_migration_dec.sql)
-- deliberately walked most of this back, because the narrowed range made
-- MAX_TABLES_TOURNEY_ONLY = 1 in server/src/services/StableHand.ts unwritable
-- and no horse re-tag was possible at all. Production now carries:
--
--   sh_tourney_only_one_table
--       CHECK (mode <> 'tourney' OR max_tables = 1)          -- back
--   stable_hand_membership_tags_max_tables_check
--       CHECK (max_tables >= 0 AND max_tables <= 4)          -- widened again
--   473 of 1,580 rows at max_tables = 1 (the tourney-only tags)
--
-- The two are not in conflict and this is not a 10.8 stop-and-ask. A
-- tourney-only horse holds one MTT slot; max_tables on a tourney tag is never
-- read for cash seating, because tagAllowsCash has already dropped that horse
-- before HorseSitVerdict looks at tagMaxTables. "Every horse plays at least
-- two tables" governs the CASH fleet and is unaffected by the tourney tag's
-- ceiling.
--
-- APPLYING THIS FILE BY HAND WOULD REVERT 20260906004017 AND BREAK THE RE-TAG
-- AGAIN. It exists so that a rebuild from this repo replays history in order -
-- this file, then 20260906004017 - and lands on the state production is in.
-- Nothing else may run it.
--
-- The assertion at the bottom is therefore about the OBJECT, not about the
-- superseded predicate: the table, the column and the named range constraint
-- must all exist. That is true before 20260906004017 and after it, so it is a
-- real check on the mirror rather than a check on which of the two ran last.
-- ===========================================================================

BEGIN;

-- EVERY HORSE PLAYS AT LEAST TWO TABLES (Dan, 2026-09-05, BINDING).
-- "100% OF THEM SHOULD BE PLAYING A MINIMUM OF 2 AT A TIME 33% PLAYING 3 AT A
-- TIME AND 33% PLAYING 4 AT A TIME." sh_tourney_only_one_table pinned 473 of
-- 1,000 horses at exactly one table and refused the retagger's upsert.
ALTER TABLE public.stable_hand_membership_tags
  DROP CONSTRAINT IF EXISTS sh_tourney_only_one_table;

-- Lift every row below the new floor BEFORE the floor is declared.
UPDATE public.stable_hand_membership_tags
   SET max_tables = 2
 WHERE max_tables < 2;

ALTER TABLE public.stable_hand_membership_tags
  DROP CONSTRAINT IF EXISTS stable_hand_membership_tags_max_tables_check;
ALTER TABLE public.stable_hand_membership_tags
  ADD CONSTRAINT stable_hand_membership_tags_max_tables_check
  CHECK (max_tables >= 2 AND max_tables <= 4);

DO $assert$
DECLARE v_low integer; v_high integer;
BEGIN
  SELECT count(*) INTO v_low FROM public.stable_hand_membership_tags WHERE max_tables < 2;
  SELECT count(*) INTO v_high FROM public.stable_hand_membership_tags WHERE max_tables > 4;
  IF v_low > 0 OR v_high > 0 THEN
    RAISE EXCEPTION 'ABORT: % row(s) below two tables, % above four', v_low, v_high;
  END IF;
END $assert$;

COMMIT;

-- ===========================================================================
--  THE MIRROR'S OWN ASSERTION (added by the backfill, not part of what ran).
--  The objects 20260905155937 touched must still be in the catalogue. The
--  PREDICATE is deliberately not asserted - 20260906004017 replaced it on
--  purpose, and pinning the old predicate here would make this file demand a
--  revert of a decision that was taken with its reasons written down.
-- ===========================================================================
DO $mirror$
BEGIN
  IF to_regclass('public.stable_hand_membership_tags') IS NULL THEN
    RAISE EXCEPTION
      'MIRROR IS WRONG: 20260905155937 is recorded as applied but public.stable_hand_membership_tags does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'stable_hand_membership_tags'
       AND column_name = 'max_tables'
  ) THEN
    RAISE EXCEPTION
      'MIRROR IS WRONG: stable_hand_membership_tags has no max_tables column';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.stable_hand_membership_tags'::regclass
       AND conname = 'stable_hand_membership_tags_max_tables_check'
  ) THEN
    RAISE EXCEPTION
      'MIRROR IS WRONG: the max_tables range constraint is absent, so neither 20260905155937 nor 20260906004017 is describable';
  END IF;
END $mirror$;
