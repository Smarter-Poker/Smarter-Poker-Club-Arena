-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828223636; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- TABLE SETTINGS FOLLOW THE USER, NOT THE BROWSER
-- Full reasoning: supabase/migrations/20260828230000_table_settings_follow_the_user.sql
-- Every default below MUST equal DEFAULT_SETTINGS in src/hooks/useTableSettings.ts,
-- because the save path is a per-key upsert: for a user with no row, changing one
-- setting inserts the row and every other column takes its column default.

ALTER TABLE public.user_table_settings
  ADD COLUMN IF NOT EXISTS sound_enabled         boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sound_volume          integer NOT NULL DEFAULT 70,
  ADD COLUMN IF NOT EXISTS haptic_enabled        boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS animation_speed       numeric NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS color_theme           text    NOT NULL DEFAULT 'black',
  ADD COLUMN IF NOT EXISTS four_color_deck       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_pot_odds         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_bet_size_presets boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_muck             boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_muck_explicit    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_muck_winners     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_post_blinds      boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS confirm_all_in        boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS card_back             text    NOT NULL DEFAULT 'classic_blue';

COMMENT ON COLUMN public.user_table_settings.sound_volume IS
  'Master volume 0-100. Mirrors DEFAULT_SETTINGS.soundVolume in src/hooks/useTableSettings.ts - the two defaults MUST agree, see the per-key upsert note in tests/user-table-settings-defaults.test.ts.';

COMMENT ON COLUMN public.user_table_settings.auto_muck_explicit IS
  'True only once the user has personally toggled auto-muck. The 2026-08-25 migration honours a stored auto_muck=false only when this is true, so it has to travel with the setting rather than staying in one browser.';

COMMENT ON COLUMN public.user_table_settings.color_theme IS
  'The table COLOR palette (black/green/blue/...), written to the data-color-theme attribute. Not the light/dark interface mode, which is data-theme and belongs to user_theme_settings.';

DO $$
DECLARE
  v_expected jsonb := jsonb_build_object(
    'sound_enabled', 'true', 'sound_volume', '70', 'haptic_enabled', 'true',
    'animation_speed', '1', 'four_color_deck', 'false', 'show_pot_odds', 'false',
    'show_bet_size_presets', 'true', 'auto_muck', 'true',
    'auto_muck_explicit', 'false', 'auto_muck_winners', 'false',
    'auto_post_blinds', 'true', 'confirm_all_in', 'true'
  );
  v_key text;
  v_actual text;
BEGIN
  FOR v_key IN SELECT jsonb_object_keys(v_expected) LOOP
    SELECT column_default INTO v_actual
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'user_table_settings'
       AND column_name = v_key;

    IF v_actual IS NULL THEN
      RAISE EXCEPTION 'column % was not created', v_key;
    END IF;

    IF split_part(v_actual, '::', 1) IS DISTINCT FROM (v_expected ->> v_key) THEN
      RAISE EXCEPTION 'column % defaults to % but the client expects %',
        v_key, v_actual, (v_expected ->> v_key);
    END IF;
  END LOOP;

  IF (SELECT split_part(column_default, '::', 1)
        FROM information_schema.columns
       WHERE table_schema='public' AND table_name='user_table_settings'
         AND column_name='color_theme') IS DISTINCT FROM '''black''' THEN
    RAISE EXCEPTION 'color_theme default does not match the client default';
  END IF;

  IF (SELECT split_part(column_default, '::', 1)
        FROM information_schema.columns
       WHERE table_schema='public' AND table_name='user_table_settings'
         AND column_name='card_back') IS DISTINCT FROM '''classic_blue''' THEN
    RAISE EXCEPTION 'card_back default does not match the client default';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='user_table_settings'
       AND column_name='show_ticker'
  ) THEN
    RAISE EXCEPTION 'show_ticker is missing - the client maps showTicker onto it';
  END IF;
END $$;
