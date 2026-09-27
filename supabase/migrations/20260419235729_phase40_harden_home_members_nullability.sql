-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419235729 "phase40_harden_home_members_nullability"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 9497561955794ac829207b4663cf8306 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 40 / Bugs E3, E4: commander_home_members.group_id and user_id must
-- be NOT NULL. A member row without a group or without a user is meaningless
-- and creates an attack surface (ghost rows bypassing RLS, floating data).
-- Audit just confirmed no existing rows have NULL in either column.

ALTER TABLE commander_home_members
  ALTER COLUMN group_id SET NOT NULL;

ALTER TABLE commander_home_members
  ALTER COLUMN user_id SET NOT NULL;

COMMENT ON COLUMN commander_home_members.group_id IS
  'Phase 40: NOT NULL. A member row must belong to a group. '
  'FK to commander_home_groups ON DELETE CASCADE.';

COMMENT ON COLUMN commander_home_members.user_id IS
  'Phase 40: NOT NULL. A member row must belong to a real profile. '
  'FK to profiles ON DELETE CASCADE.';
