-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821200501 "horse_avatar_swap_backup_table"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 db71038b1196301df6444838ad785a88 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE TABLE IF NOT EXISTS public.horse_avatar_swap_backup (
  user_id        uuid PRIMARY KEY,
  old_avatar_url text NOT NULL,
  new_avatar_url text NOT NULL,
  swapped_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.horse_avatar_swap_backup IS
  'Pre-swap avatar_url for every HORSE moved off a photo-shaped avatar on 2026-08-21, so the swap is reversible. Horses only: real players share avatar_url with social media and are handled render-side in the Club Arena client instead.';
