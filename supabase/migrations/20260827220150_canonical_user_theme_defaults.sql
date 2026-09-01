-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827220150; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

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
