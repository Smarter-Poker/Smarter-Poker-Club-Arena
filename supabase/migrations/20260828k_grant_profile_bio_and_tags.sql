-- ═══════════════════════════════════════════════════════════════════════════
-- GRANT BIO AND PLAYER TAGS (2026-08-28)
-- ═══════════════════════════════════════════════════════════════════════════
-- The previous migration added these columns, but because public.profiles
-- relies on column-level grants rather than table-level SELECT grants for 
-- authenticated users (to protect private columns), the new columns were 
-- completely unreadable by the API, causing PostgREST to return PGRST204 
-- and crashing the Profile page.

GRANT SELECT (bio, player_tags), UPDATE (bio, player_tags) ON public.profiles TO authenticated;
GRANT SELECT (bio, player_tags) ON public.profiles TO anon;
