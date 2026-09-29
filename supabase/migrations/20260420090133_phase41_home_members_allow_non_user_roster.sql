-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420090133 "phase41_home_members_allow_non_user_roster"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2d51e48a3e679f256d34575b32aed4d8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 41 Part C: relax commander_home_members to support non-user roster entries.
-- Dan's product answer #7: hosts can add members by name (not on Smarter.Poker yet).
-- Those entries persist to the group's roster for future seat-claims.

-- 1) Replace full unique (group_id, user_id) with partial unique WHERE user_id IS NOT NULL.
--    This preserves "one membership per user per group" while allowing multiple roster-only entries.
ALTER TABLE public.commander_home_members
  DROP CONSTRAINT IF EXISTS commander_home_members_group_id_user_id_key;

DROP INDEX IF EXISTS public.commander_home_members_group_id_user_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS commander_home_members_group_user_unique_active
  ON public.commander_home_members (group_id, user_id)
  WHERE user_id IS NOT NULL;

-- 2) Drop NOT NULL on user_id so roster-only rows can exist.
ALTER TABLE public.commander_home_members
  ALTER COLUMN user_id DROP NOT NULL;

-- 3) Add roster-only columns.
ALTER TABLE public.commander_home_members
  ADD COLUMN IF NOT EXISTS display_name      text,
  ADD COLUMN IF NOT EXISTS phone             text,
  ADD COLUMN IF NOT EXISTS added_by_user_id  uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS is_roster_only    boolean NOT NULL DEFAULT false;

-- 4) Enforce identity: either a real user, or a named roster-only entry.
ALTER TABLE public.commander_home_members
  DROP CONSTRAINT IF EXISTS commander_home_members_identity_check;

ALTER TABLE public.commander_home_members
  ADD CONSTRAINT commander_home_members_identity_check
  CHECK (
    user_id IS NOT NULL
    OR (is_roster_only = true AND display_name IS NOT NULL AND char_length(trim(display_name)) BETWEEN 1 AND 120)
  );

-- 5) Index roster-only rows per group for fast "search my roster" UX.
CREATE INDEX IF NOT EXISTS commander_home_members_roster_by_name
  ON public.commander_home_members (group_id, display_name)
  WHERE is_roster_only = true;

COMMENT ON COLUMN public.commander_home_members.is_roster_only IS
  'Phase 41: true when this row represents a non-Smarter.Poker person the host has added by name (user_id stays NULL, display_name required).';
COMMENT ON COLUMN public.commander_home_members.display_name IS
  'Name shown for this member. Required when is_roster_only = true.';
COMMENT ON COLUMN public.commander_home_members.added_by_user_id IS
  'Host/member who added this roster-only entry.';
