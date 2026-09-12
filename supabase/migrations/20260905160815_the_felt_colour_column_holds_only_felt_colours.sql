-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905160815; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260905160815   (the stamp IS the apply time, UTC: 2026-09-05 16:08:15)
--   name        the_felt_colour_column_holds_only_felt_colours
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 2178 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260905160815 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     CONSTRAINT     user_table_settings_color_theme_is_a_felt_palette on public.user_table_settings
--
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- THE FELT COLOUR COLUMN HOLDS ONLY FELT COLOURS (2026-09-05)
--
-- `user_table_settings.color_theme` is the table FELT palette, typed `text`
-- with no constraint. On 2026-09-05 one row held 'light' - the light/dark
-- INTERFACE mode, a different setting on a different attribute. It was stamped
-- onto <html data-color-theme="light"> every page load and, because
-- design-tokens.css listed [data-color-theme='light'] beside
-- [data-theme='light'], selected the entire LIGHT token palette: --bg-primary
-- #f0f4f0 on a platform whose rule is solid black, for a player whose own
-- interface setting said dark.
--
-- The client fix is shipped (light answers to data-theme only; useTableSettings
-- coerces at both doors). This closes the loop in the database, because the
-- coercion is client-side and any reader that skips it would read the
-- contaminated value straight.
--
-- Probed in one self-aborting transaction first (rule 11.5):
--   total=3 illegal_before=1 illegal_after=0 constraint_accepted=yes

BEGIN;

UPDATE public.user_table_settings
   SET color_theme = 'black',
       updated_at = now()
 WHERE color_theme IS NOT NULL
   AND color_theme NOT IN ('black', 'blue', 'gold', 'purple', 'red');

ALTER TABLE public.user_table_settings
  ADD CONSTRAINT user_table_settings_color_theme_is_a_felt_palette
  CHECK (color_theme IS NULL OR color_theme IN ('black', 'blue', 'gold', 'purple', 'red'));

COMMENT ON CONSTRAINT user_table_settings_color_theme_is_a_felt_palette
  ON public.user_table_settings IS
  'color_theme is the table FELT palette, matching the [data-color-theme=...] rules in '
  'src/styles/design-tokens.css. The light/dark INTERFACE mode is a different setting and '
  'lives on data-theme. One row held ''light'' on 2026-09-05, which selected the entire '
  'light token palette app-wide.';

DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.user_table_settings
   WHERE color_theme IS NOT NULL
     AND color_theme NOT IN ('black', 'blue', 'gold', 'purple', 'red');

  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      'color_theme still holds % non-felt value(s) after the correction', v_bad;
  END IF;
END $$;

COMMIT;
