-- A user's first appearance write is normally a partial upsert. PostgreSQL
-- fills the untouched columns from these defaults, and the entitlement trigger
-- validates all five values on INSERT. The original defaults predated the live
-- catalogs (`dark-felt`, `diamond-pattern`, `standard-red`) and are not valid
-- cosmetic_catalog IDs, so the first customization for a new user was rejected
-- even when the asset they tapped was free.
--
-- Keep these byte-for-byte aligned with useUserThemeSettings.DEFAULT_THEME and
-- ThemeSettingsModal.DEFAULT_SELECTION. All five are canonical free assets.

ALTER TABLE public.user_theme_settings
  ALTER COLUMN theme_id SET DEFAULT 'default-dark',
  ALTER COLUMN table_id SET DEFAULT 'classic_green',
  ALTER COLUMN button_id SET DEFAULT 'classic-white',
  ALTER COLUMN background_id SET DEFAULT 'midnight',
  ALTER COLUMN cards_id SET DEFAULT 'classic_red';

DO $verify$
DECLARE
  v_defaults jsonb;
BEGIN
  SELECT jsonb_object_agg(column_name, column_default)
    INTO v_defaults
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'user_theme_settings'
     AND column_name IN ('theme_id', 'table_id', 'button_id', 'background_id', 'cards_id');

  IF v_defaults ->> 'theme_id' NOT LIKE '%default-dark%'
     OR v_defaults ->> 'table_id' NOT LIKE '%classic_green%'
     OR v_defaults ->> 'button_id' NOT LIKE '%classic-white%'
     OR v_defaults ->> 'background_id' NOT LIKE '%midnight%'
     OR v_defaults ->> 'cards_id' NOT LIKE '%classic_red%'
  THEN
    RAISE EXCEPTION 'user_theme_settings defaults did not converge: %', v_defaults;
  END IF;
END
$verify$;
