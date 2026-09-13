-- 20260905160815_the_felt_colour_column_holds_only_felt_colours.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE FELT COLOUR COLUMN HOLDS ONLY FELT COLOURS (2026-09-05)
--
-- `user_table_settings.color_theme` is the table FELT palette. It is typed
-- `text` with no constraint, and on 2026-09-05 one row held 'light' - the
-- light/dark INTERFACE mode, a different setting that lives on a different
-- attribute.
--
-- HOW IT GOT THERE. `data-theme` once carried both the felt colour and the
-- interface mode, last writer winning; useTableSettings.ts documents that
-- fight and the split that ended it. The split stopped NEW contamination but
-- nothing cleaned what was already stored, so the value survived, was stamped
-- onto `<html data-color-theme="light">` on every page load, and - because
-- design-tokens.css listed `[data-color-theme='light']` beside
-- `[data-theme='light']` - selected the entire LIGHT token palette. Measured
-- live before the fix: --bg-primary #f0f4f0, --bg-secondary #e8ede8, on a
-- platform whose standing rule is "THE WHOLE BACKGROUND SHOULD BE SOLID BLACK
-- AND ALL THE SAME COLOR" (Dan 2026-08-30), for a player whose own interface
-- setting said dark.
--
-- The client side is already fixed and shipped: the light palette answers to
-- `data-theme` only, and useTableSettings coerces a non-felt value at BOTH
-- doors - on load, and in applySideEffects, which matters because a bus
-- message from another tab and a server settings row never pass through load.
--
-- THIS MIGRATION CLOSES THE LOOP IN THE DATABASE, for two reasons:
--   1. the stored row and the value every client actually uses disagree, and a
--      row that says one thing while the app does another is the next agent's
--      mystery;
--   2. the coercion is client-side, so any future reader that does not go
--      through useTableSettings would read the contaminated value straight.
--
-- Read, not assumed, immediately before writing this file:
--   total rows       3
--   illegal rows     1     (the value is 'light')
--   existing CHECKs  0
--
-- One transaction, as the production DDL policy requires. The UPDATE is data;
-- the CHECK is the part that matters long term - a client guard can be edited
-- away by accident, a database constraint cannot.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- 1. Correct forward. A value that is not a felt palette becomes the default
--    the client already coerces it to, so the row and the app finally agree.
UPDATE public.user_table_settings
   SET color_theme = 'black',
       updated_at = now()
 WHERE color_theme IS NOT NULL
   AND color_theme NOT IN ('black', 'blue', 'gold', 'purple', 'red');

-- 2. And it cannot come back. NULL stays legal: the column is optional and a
--    null means "use the client default", exactly as it did before.
ALTER TABLE public.user_table_settings
  ADD CONSTRAINT user_table_settings_color_theme_is_a_felt_palette
  CHECK (color_theme IS NULL OR color_theme IN ('black', 'blue', 'gold', 'purple', 'red'));

COMMENT ON CONSTRAINT user_table_settings_color_theme_is_a_felt_palette
  ON public.user_table_settings IS
  'color_theme is the table FELT palette, matching the [data-color-theme=...] rules in '
  'src/styles/design-tokens.css. The light/dark INTERFACE mode is a different setting and '
  'lives on data-theme. One row held ''light'' on 2026-09-05, which selected the entire '
  'light token palette app-wide.';

-- 3. Assert the outcome, so this aborts rather than reporting a success it did
--    not achieve.
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
