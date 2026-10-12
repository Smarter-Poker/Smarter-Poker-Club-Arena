-- 20261010010632_a_suspended_agent_stops_reading_the_club_finances.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (cashier launch audit C6-10, 2026-10-09):
--
-- ca_can_view_club_finances is the gate in front of a club's books: eighteen
-- reads (the financials, the game and player ledgers and their exports, the
-- insurance report, revenue, union invoices, the club chip statement
-- fn_ca_chip_statement and its page, the hand rake breakdown, the union
-- statement of account) and the read policies on commission_rate_audit and
-- rake_rate_audit. It admits a staff role (owner, co-owner, admin, super
-- agent) on its club_members row alone. Since 20261004124327 the cashier
-- calls a member active only through fn_cashier_member_is_active: a
-- membership that is active or approved and, for an agent role, an agents row
-- in that club whose status is active. fn_club_bank_role, and with it every
-- money door, already asks that; this gate did not. So a super agent the club
-- suspended lost the cashier and kept reading the club's books, and so did a
-- staff member whose membership was neither active nor approved (anything
-- but banned or suspended).
--
-- The member branch now also asks fn_cashier_member_is_active. Club
-- ownership, platform admin, the service role and the database's own
-- sessions are unchanged. On production (read 2026-10-09) all 11 staff rows
-- the gate admits are active by that rule, so nobody who reads the books
-- today loses them; the change bites the first time a club suspends a super
-- agent.
--
-- Not changed: the signature, every caller, SECURITY DEFINER, search_path
-- (public) and grants (authenticated and service_role EXECUTE, never anon).
-- Proved on PostgreSQL 17 against production's live gate (md5 fae59a344dc9040e81cda02fb9fee97f,
-- reproduced byte for byte) and production's fn_cashier_member_is_active,
-- called the way a browser session calls it (session user authenticator)
-- (scripts/ci/test-finance-gate-db-postgres.py,
-- tests/fixtures/finance-gate-db/scenario.sql: it fails before and passes
-- after).
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.ca_can_view_club_finances(uuid)'::regprocedure)) = '20d5095763dc302c5cad8fcf1f66a9e9')

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.ca_can_view_club_finances(uuid)'::regprocedure)) IS DISTINCT FROM 'fae59a344dc9040e81cda02fb9fee97f' THEN
    RAISE EXCEPTION 'ca_can_view_club_finances is not the live text this migration was written against (md5 %)',
      md5(pg_get_functiondef('public.ca_can_view_club_finances(uuid)'::regprocedure)) USING ERRCODE = '55000';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.ca_can_view_club_finances(p_club_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    session_user IN ('postgres', 'supabase_admin')
    OR coalesce(auth.role(), '') = 'service_role'
    OR (
      auth.uid() IS NOT NULL
      AND (
        EXISTS (
          SELECT 1 FROM club_members cm
           WHERE cm.club_id = p_club_id
             AND cm.user_id = auth.uid()
             AND coalesce(cm.status, 'active') NOT IN ('banned', 'suspended')
             AND cm.role IN ('owner', 'co_owner', 'admin', 'super_agent')
             AND public.fn_cashier_member_is_active(cm.club_id, cm.user_id)
        )
        OR EXISTS (SELECT 1 FROM clubs c WHERE c.id = p_club_id AND c.owner_id = auth.uid())
        OR EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = auth.uid() AND coalesce(pr.is_admin, false))
      )
    );
$function$;

DO $post$
BEGIN
  IF md5(pg_get_functiondef('public.ca_can_view_club_finances(uuid)'::regprocedure)) IS DISTINCT FROM '20d5095763dc302c5cad8fcf1f66a9e9' THEN
    RAISE EXCEPTION 'ca_can_view_club_finances is not the reviewed text (md5 %)',
      md5(pg_get_functiondef('public.ca_can_view_club_finances(uuid)'::regprocedure)) USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.ca_can_view_club_finances(uuid)'::regprocedure
       AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proconfig @> ARRAY['search_path=public']
  ) OR has_function_privilege('anon', 'public.ca_can_view_club_finances(uuid)'::regprocedure, 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.ca_can_view_club_finances(uuid)'::regprocedure, 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.ca_can_view_club_finances(uuid)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'ca_can_view_club_finances lost its definer posture or its grants' USING ERRCODE = '55000';
  END IF;
END $post$;

COMMIT;
