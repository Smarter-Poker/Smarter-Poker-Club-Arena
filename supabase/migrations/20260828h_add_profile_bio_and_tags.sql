-- ═══════════════════════════════════════════════════════════════════════════
-- ADD BIO AND PLAYER TAGS TO PROFILES (2026-08-28)
-- ═══════════════════════════════════════════════════════════════════════════
-- The Edit Profile modal in Club Arena allows users to set a bio and up to
-- 3 player tags. These columns were missing from the profiles table.

ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT '',
ADD COLUMN IF NOT EXISTS player_tags TEXT[] DEFAULT '{}';
