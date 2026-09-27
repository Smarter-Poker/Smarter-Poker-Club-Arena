-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260506114919 "make_username_uniqueness_case_insensitive"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8b261dc4772fcc735b74982aa229d311 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- CASE-INSENSITIVE USERNAME UNIQUENESS
-- ─────────────────────────────────────────────────────────────────────────
-- The existing profiles_username_key UNIQUE(username) is case-sensitive,
-- so 'KingFish' and 'kingfish' are treated as distinct. claim_social_profile
-- writes lowercased values, which lets a lowercased duplicate of an existing
-- mixed-case username slip past — exactly the collision pattern we are
-- trying to prevent. Promote uniqueness to a CITEXT-style unique index on
-- lower(username) and drop the old constraint + the redundant non-unique
-- index that was added in the prior migration.
-- ═══════════════════════════════════════════════════════════════════════════

-- Drop the redundant non-unique index added in the prior migration; the new
-- unique index will serve the same lookup purpose.
DROP INDEX IF EXISTS public.idx_profiles_username_lower;

-- Drop the case-sensitive unique constraint
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_username_key;

-- New case-insensitive unique index. NULL usernames are allowed (multiple
-- nulls don't collide). Empty strings would collide — the existing
-- ensure-profile.js fallback uses 'PlayerN' so empty-string isn't a
-- realistic concern, but the WHERE clause guards against it.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_lower_key
  ON public.profiles (lower(username))
  WHERE username IS NOT NULL AND username <> '';

COMMENT ON INDEX public.profiles_username_lower_key IS
  'Case-insensitive uniqueness for profiles.username. Replaces the old case-sensitive profiles_username_key. Allows NULL/empty values (the legacy signup fallback writes empty strings into a few legacy rows).';
