-- ============================================================================
-- TABLE SETTINGS FOLLOW THE USER, NOT THE BROWSER
--
-- Dan 2026-08-28: "WHEN YOU DO TURN THINGS ON OR OFF IN THE TABLE SETTINGS,
-- THEY NEED TO SAVE GLOBALLY IN REAL TIME ON ALL TABLES, AND ALL PAGES. AND
-- NEVER REGRESS OR AUTO CHANGE BACK UNLESS THE USER CHANGES THEM MANUALLY."
--
-- The "all tables and all pages" half was fixed in code earlier today: the
-- settings now live in ONE module store instead of a per-component copy, so
-- eight mounted consumers can no longer overwrite each other's blob. What that
-- did NOT fix is WHERE they are kept. Every one of these lived only in
-- `localStorage['club-arena-table-settings']` — a single unscoped key, per
-- BROWSER:
--
--   * sign in on a phone and none of your settings are there;
--   * two accounts on one machine share one blob, so signing in as someone
--     else inherits their table;
--   * clearing site data loses the lot.
--
-- Fourteen columns below move them onto `user_table_settings`, which is already
-- per-user (PK user_id, RLS auth.uid() = user_id) and is already in the
-- `supabase_realtime` publication — so `PostgresSyncHooks`'s existing
-- subscription starts delivering these to a second device live, with no new
-- transport.
--
-- ─── THE HAZARD, AND WHY EVERY DEFAULT BELOW IS DELIBERATE ───
--
-- The save path on this table is a PER-KEY upsert:
--
--     upsert({ user_id, [key]: value }, { onConflict: 'user_id' })
--
-- so for a user with NO row, changing any ONE setting inserts the row and every
-- OTHER column takes its column default. That is not hypothetical: it is
-- documented at length in tests/user-table-settings-defaults.test.ts, where
-- `card_slide` and `enhanced_view` were "on since forever, off the moment you
-- touched anything else".
--
-- So each default below is set to the value `DEFAULT_SETTINGS` in
-- src/hooks/useTableSettings.ts already uses. If the two ever disagree, a user
-- who toggles one setting silently has the others rewritten underneath them, on
-- every device. The same test now pins these fourteen alongside the originals.
--
-- `show_ticker` is NOT added here: it already exists on this table, and until
-- today it had TWO owners — that column and the localStorage blob — which is
-- its own quiet source of settings changing back. The client now maps
-- `showTicker` onto this existing column, so there is one owner again.
--
-- NOTHING IS BACKFILLED. A column default is what a new row gets; an existing
-- row keeps whatever it has. The client merges the server row over its local
-- cache on sign-in and writes any local value the server has never seen, so a
-- player's current browser settings are adopted on their next sign-in rather
-- than being replaced by defaults.
-- ============================================================================

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
  'Master volume 0-100. Mirrors DEFAULT_SETTINGS.soundVolume in src/hooks/useTableSettings.ts — the two defaults MUST agree, see the per-key upsert note in that file and in tests/user-table-settings-defaults.test.ts.';

COMMENT ON COLUMN public.user_table_settings.auto_muck_explicit IS
  'True only once the user has personally toggled auto-muck. The 2026-08-25 migration honours a stored auto_muck=false only when this is true, so it has to travel with the setting rather than staying in one browser.';

COMMENT ON COLUMN public.user_table_settings.color_theme IS
  'The table COLOR palette (black/green/blue/...), written to the data-color-theme attribute. Not the light/dark interface mode, which is data-theme and belongs to user_theme_settings.';

-- ── Guards. A default that drifts from the client is the whole hazard. ──────
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

    -- Postgres reports a boolean default as `true`/`false` and an integer one
    -- as `70`; both compare cleanly once a numeric cast suffix is stripped.
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

  -- show_ticker must still be here and still default true: the client now maps
  -- its localStorage `showTicker` onto THIS column rather than owning a second
  -- copy of the same setting.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='user_table_settings'
       AND column_name='show_ticker'
  ) THEN
    RAISE EXCEPTION 'show_ticker is missing — the client maps showTicker onto it';
  END IF;
END $$;

-- ROLLBACK:
--   ALTER TABLE public.user_table_settings
--     DROP COLUMN IF EXISTS sound_enabled, DROP COLUMN IF EXISTS sound_volume,
--     DROP COLUMN IF EXISTS haptic_enabled, DROP COLUMN IF EXISTS animation_speed,
--     DROP COLUMN IF EXISTS color_theme, DROP COLUMN IF EXISTS four_color_deck,
--     DROP COLUMN IF EXISTS show_pot_odds, DROP COLUMN IF EXISTS show_bet_size_presets,
--     DROP COLUMN IF EXISTS auto_muck, DROP COLUMN IF EXISTS auto_muck_explicit,
--     DROP COLUMN IF EXISTS auto_muck_winners, DROP COLUMN IF EXISTS auto_post_blinds,
--     DROP COLUMN IF EXISTS confirm_all_in, DROP COLUMN IF EXISTS card_back;
--   -- The client falls back to localStorage when a column is absent, so a
--   -- rollback degrades to the pre-2026-08-28 per-browser behaviour rather
--   -- than breaking the panel.
