-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424023943 "20260421189100_hg_audit_log_deny_all_select_policy"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7e64cffcb0629abd3509c9bef762e7f2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- commander_home_audit_log is admin-only, accessed via SECDEF RPCs that
-- use service_role path. Dropped the old SELECT policy + revoked grants
-- earlier — but the canonical check requires ≥1 policy per table.
-- Add an explicit deny-all SELECT policy so the table semantics are
-- clear: "nothing is selectable under RLS; only SECDEF RPCs / service_role
-- can read." Matches the pattern already used for 3 server-log tables
-- per the canonical check's exemption list.

CREATE POLICY audit_log_deny_all_select
  ON public.commander_home_audit_log
  FOR SELECT
  USING (false);

-- Also add deny-all INSERT/UPDATE/DELETE to make the table fully
-- service-role-only at the RLS layer. Current behavior relies on grants
-- alone; adding policies makes intent explicit.
CREATE POLICY audit_log_deny_all_insert
  ON public.commander_home_audit_log
  FOR INSERT
  WITH CHECK (false);

CREATE POLICY audit_log_deny_all_update
  ON public.commander_home_audit_log
  FOR UPDATE
  USING (false) WITH CHECK (false);

CREATE POLICY audit_log_deny_all_delete
  ON public.commander_home_audit_log
  FOR DELETE
  USING (false);
