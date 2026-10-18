-- Owner request 2026-10-18: four colors are standard. Preserve chosen opt-outs.
-- @live-proof: EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_table_settings' AND column_name = 'four_color_deck' AND column_default = 'true')
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
ALTER TABLE public.user_table_settings ALTER COLUMN four_color_deck SET DEFAULT true;
UPDATE public.user_table_settings
SET four_color_deck = true
WHERE four_color_deck IS DISTINCT FROM true
  AND NOT COALESCE(settings_touched @> ARRAY['four_color_deck']::text[], false);
COMMIT;
