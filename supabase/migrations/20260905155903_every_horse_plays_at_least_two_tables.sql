-- ═══════════════════════════════════════════════════════════════════════════
--  EVERY HORSE PLAYS AT LEAST TWO TABLES (Dan, 2026-09-05, BINDING)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, verbatim: "EVERY HORSE SHOULD 100% BE ABLE TO PLAY 4 TABLES AT ONCE ...
-- 100% OF THEM SHOULD BE PLAYING A MINIMUM OF 2 AT A TIME 33% PLAYING 3 AT A
-- TIME AND 33% PLAYING 4 AT A TIME."
--
-- WHAT WAS MEASURED THE HOUR BEFORE THIS. Of 364 seated horses, 270 held
-- exactly one table, 76 held two, 17 held three, and ONE held four. The
-- seeding weight written for Dan's 2026-09-02 instruction ("THEY SHOULD BE
-- PLAYING 4 TABLES AT ONCE") was working; it had nothing to work with. Two
-- things were holding the fleet down, and this migration is the second:
--
--   1. `MAX_TABLES_BY_PERSONA` derived the ceiling from the cash persona
--      (grinder 4, regular 3, mixer 2, night_owl 2, weekend_heavy 3) and
--      `MAX_TABLES_TOURNEY_ONLY` pinned 473 of 1,000 horses at ONE. Fixed in
--      the same PR: one deterministic mix over the whole fleet, 34/33/33.
--   2. THIS TABLE SAID THE SAME THING IN SQL. `sh_tourney_only_one_table`
--      refuses any tourney-mode row whose `max_tables` is not exactly 1, so
--      the retagger could not write Dan's number even after the code changed
--      - it failed on the upsert, which is how this constraint was found.
--
-- A tourney-only horse registering for two events at once is what a human
-- does. There is no reason for the schema to forbid it, and Dan has now said
-- so explicitly.
--
-- THE FLOOR IS ENFORCED HERE, NOT ONLY IN THE TAGGER. `max_tables >= 2`
-- replaces `max_tables >= 0`, so a future writer cannot quietly put a horse
-- back on one table the way the persona map did. Reading is defended too
-- (`StableHandTags.tagMaxTables` clamps to the same floor), because a
-- constraint only binds rows written after it exists.
--
-- Tier 3 (DROP CONSTRAINT), one transaction, one schema reload.
--
-- ROLLBACK
--   BEGIN;
--   ALTER TABLE public.stable_hand_membership_tags
--     DROP CONSTRAINT stable_hand_membership_tags_max_tables_check;
--   ALTER TABLE public.stable_hand_membership_tags
--     ADD CONSTRAINT stable_hand_membership_tags_max_tables_check
--     CHECK (max_tables >= 0 AND max_tables <= 4);
--   UPDATE public.stable_hand_membership_tags SET max_tables = 1 WHERE mode = 'tourney';
--   ALTER TABLE public.stable_hand_membership_tags
--     ADD CONSTRAINT sh_tourney_only_one_table
--     CHECK (mode <> 'tourney' OR max_tables = 1);
--   COMMIT;
--   -- then re-run `npm run horses:tag -- --club=all --force` on the OLD code.

BEGIN;

-- The tourney exception is retired outright.
ALTER TABLE public.stable_hand_membership_tags
  DROP CONSTRAINT IF EXISTS sh_tourney_only_one_table;

-- Lift every row that is below the new floor BEFORE the floor is declared.
-- The retagger rewrites all 1,580 rows immediately after this migration; this
-- is what makes the table legal in the window between the two, and what makes
-- the migration safe to apply on its own.
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
