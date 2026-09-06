-- 20260906003931_the_tourney_tag_can_hold_the_one_table_its_own_migration_dec.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY
--
-- `stable_hand_membership_tags` on production carries
--   CHECK (max_tables >= 2 AND max_tables <= 4)
-- and nothing in this repo asks for it. The repo's own creating migration,
-- 20260904060838_stable_hand_tag_and_state_tables.sql, declares
--   max_tables smallint NOT NULL DEFAULT 1 CHECK (max_tables BETWEEN 0 AND 4)
--   CONSTRAINT sh_tourney_only_one_table CHECK (mode <> 'tourney' OR max_tables = 1)
-- and it never took effect, because that file creates the table with
-- CREATE TABLE IF NOT EXISTS and the table was already there. So production
-- kept an older shape and the file was a no-op that read as applied.
--
-- The drift is not cosmetic. `MAX_TABLES_TOURNEY_ONLY = 1` in
-- server/src/services/StableHand.ts is what `assignTags` writes for a
-- tourney-only horse ("A tourney-only horse holds one MTT slot and never a
-- second table"), so EVERY run of `npm run horses:tag -- --force` since that
-- constant landed has died on the first 500-row upsert with
--   violates check constraint "stable_hand_membership_tags_max_tables_check"
-- and no re-tag has been possible at all. Measured 2026-09-05: the 473
-- tourney rows in production carry max_tables 2, 3 and 4 - the persona values
-- an older tagger wrote - which is the fingerprint of a table that has not
-- been re-tagged since.
--
-- This is not two rules in conflict (club-arena CLAUDE.md 10.8). One side is
-- written down twice, in the migration file and in the engine constant, and
-- they agree with each other. The other is a constraint on the live table with
-- nothing behind it in this repo. That is the defect, and this aligns
-- production with what the repo already declared.
--
-- The updated rows are fleet METADATA, not money. `tagMaxTables` is read in
-- exactly one place - HorseSitVerdict, sizing the CASH table cap - and a
-- tourney-only horse never reaches it, because `tagAllowsCash` has already
-- dropped it. Nothing a player can see changes.
--
-- ROLLBACK:
--   BEGIN;
--   ALTER TABLE public.stable_hand_membership_tags
--     DROP CONSTRAINT IF EXISTS sh_tourney_only_one_table;
--   UPDATE public.stable_hand_membership_tags SET max_tables = 2
--    WHERE mode = 'tourney' AND max_tables < 2;
--   ALTER TABLE public.stable_hand_membership_tags
--     DROP CONSTRAINT IF EXISTS stable_hand_membership_tags_max_tables_check,
--     ADD  CONSTRAINT stable_hand_membership_tags_max_tables_check
--          CHECK (max_tables >= 2 AND max_tables <= 4);
--   COMMIT;

BEGIN;

-- 1. The range the repo declared: 0 through 4, so 1 is legal.
ALTER TABLE public.stable_hand_membership_tags
  DROP CONSTRAINT IF EXISTS stable_hand_membership_tags_max_tables_check;

ALTER TABLE public.stable_hand_membership_tags
  ADD CONSTRAINT stable_hand_membership_tags_max_tables_check
  CHECK (max_tables BETWEEN 0 AND 4);

-- 2. The rows an older tagger wrote before the constant existed. A tourney
--    row's max_tables is never read (see the header), so this is bringing
--    stored data into line with the rule, not changing any behaviour.
UPDATE public.stable_hand_membership_tags
   SET max_tables = 1
 WHERE mode = 'tourney'
   AND max_tables <> 1;

-- 3. The rule itself, from the creating migration.
ALTER TABLE public.stable_hand_membership_tags
  DROP CONSTRAINT IF EXISTS sh_tourney_only_one_table;

ALTER TABLE public.stable_hand_membership_tags
  ADD CONSTRAINT sh_tourney_only_one_table
  CHECK (mode <> 'tourney' OR max_tables = 1);

-- 4. ABORT IF THE BOARD MOVED. A migration that asserts nothing is a
--    migration that can succeed against a table it did not understand.
DO $$
DECLARE
  v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.stable_hand_membership_tags
   WHERE mode = 'tourney' AND max_tables <> 1;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'stable_hand: % tourney tags still hold more than one table', v_bad;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.stable_hand_membership_tags'::regclass
       AND conname = 'sh_tourney_only_one_table'
  ) THEN
    RAISE EXCEPTION 'stable_hand: sh_tourney_only_one_table did not land';
  END IF;
END $$;

COMMIT;
