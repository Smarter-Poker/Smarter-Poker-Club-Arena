-- 20261017111532_four_colour_deck_is_the_standard.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-10-17: "USE THE 4 COLOR DECK AS THE STANDARD AND IF USERS WANT TO
-- CHANGE IT, THEY CAN CHANGE IT BACK TO THE TRADITIONAL DECK IN THE TABLE
-- SETTINGS."
--
-- `user_table_settings.four_color_deck` defaulted to FALSE. This flips the
-- column default to TRUE (the client's DEFAULT_TABLE_USER_SETTINGS moves with
-- it, pinned by tests/user-table-settings-defaults.test.ts, because the
-- per-key upsert inserts every other column at its default) and lifts every
-- row still holding the old default that the account never deliberately set.
-- A false nobody chose is the old standard, not a preference. Rows whose
-- settings_touched names four_color_deck are a choice and are left alone -
-- the same rule 20260905001550 applied when card_slide's default moved.
--
-- No function, view or policy changes; one ALTER and one UPDATE, one
-- transaction, one schema-cache reload.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.user_table_settings
  ALTER COLUMN four_color_deck SET DEFAULT true;

UPDATE public.user_table_settings
   SET four_color_deck = true
 WHERE four_color_deck = false
   AND NOT ('four_color_deck' = ANY (COALESCE(settings_touched, '{}'::text[])));

DO $$
DECLARE
  v_default text;
BEGIN
  SELECT column_default INTO v_default
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'user_table_settings'
     AND column_name = 'four_color_deck';
  IF v_default IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'four_color_deck default is % - expected true', v_default;
  END IF;
END $$;

COMMIT;
