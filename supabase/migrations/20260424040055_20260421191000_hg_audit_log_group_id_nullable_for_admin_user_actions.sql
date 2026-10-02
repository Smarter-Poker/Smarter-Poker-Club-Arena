-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424040055 "20260421191000_hg_audit_log_group_id_nullable_for_admin_user_actions"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8b906363884d86763df050fffe808e15 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- commander_home_audit_log.group_id was NOT NULL when all audit events
-- were group-scoped. Admin UI now performs user-level actions that
-- legitimately have no group context (onboarding lookups, GDPR scrub,
-- cross-group user moderation).
--
-- Make group_id nullable. Existing RLS/grants unchanged. Existing
-- group-scoped rows unaffected. Check constraint below enforces
-- "either group_id or target_type='user'" so nullability doesn't
-- get abused for group-scoped events that forgot to set it.

ALTER TABLE public.commander_home_audit_log
  ALTER COLUMN group_id DROP NOT NULL;

ALTER TABLE public.commander_home_audit_log
  ADD CONSTRAINT commander_home_audit_log_group_or_user_scope
  CHECK (group_id IS NOT NULL OR target_type = 'user');
