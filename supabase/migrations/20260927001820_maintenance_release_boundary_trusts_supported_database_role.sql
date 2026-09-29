-- Supabase native CLI sessions may SET ROLE postgres using temporary login names.
-- Trust that catalog privilege; never a name prefix or a fabricated JWT claim.
-- Browser/authenticator roles cannot SET postgres. Preserve request-role checks,
-- thaw certificate selection, ACLs and ownership. No runtime/financial writes.
-- Install once before the separate online cashier index operation.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='8s';
SET LOCAL search_path=pg_catalog;
DO $preflight$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM pg_proc p
   WHERE p.oid=to_regprocedure('public.fn_active_maintenance_release_boundary()')
    AND md5(pg_get_functiondef(p.oid))='0d9548e27105b7172d83be4f7d10ea47'
    AND p.proowner='postgres'::regrole
    AND p.proacl::text='{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
    AND p.proconfig=ARRAY['search_path=public, auth, pg_temp'] AND p.prosecdef
 ) OR md5(pg_get_functiondef(to_regprocedure('public.fn_entry_purchases_frozen()'))) IS DISTINCT FROM '0b05e2e7905caf71f14c8327a172cea0'
   OR md5(pg_get_functiondef(to_regprocedure('public.fn_platform_frozen()'))) IS DISTINCT FROM 'ec683805e052fceeae74789e82dce4cc'
   OR md5(pg_get_functiondef(to_regprocedure('public.fn_ca_break_window_refuses_migrations(timestamp with time zone)'))) IS DISTINCT FROM 'ec683f08ce7fec269b23dcfd5dc540b1'
   OR md5(pg_get_functiondef(to_regprocedure('public.fn_ca_break_window_ddl_guard()'))) IS DISTINCT FROM '40659a691919fbc55fe90f18827c834a'
 THEN RAISE EXCEPTION 'MAINTENANCE_CLI_CALLER_PREIMAGE_DRIFT' USING ERRCODE='55000';
 END IF;
END
$preflight$;
CREATE OR REPLACE FUNCTION public.fn_active_maintenance_release_boundary()
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  c_required_steps CONSTANT text[] := ARRAY[
    'sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
    'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
    'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at',
    'cluster_break_eligible_since','cluster_move_expires_at',
    'reconnect_presence','reconnect_snapshots'
  ];
  v_request_role text := NULLIF(btrim(COALESCE(auth.role(), '')), '');
  v_trusted_database_actor boolean;
  v_release_target timestamptz;
BEGIN
  -- supabase_auth_admin added 2026-09-10: it is GoTrue's own database role
  -- (the signup triggers run as it), never a browser. Without it every signup
  -- wallet trigger raised 42501 here (signup_errors id 9318).
  SELECT session_user IN ('postgres', 'supabase_admin', 'service_role', 'supabase_auth_admin')
         OR COALESCE(r.rolsuper, false)
         -- Supabase CLI session roles may SET ROLE postgres. Trust that
         -- catalog privilege, never a login-name prefix or a JWT workaround.
         OR pg_catalog.pg_has_role(session_user, 'postgres', 'SET')
    INTO v_trusted_database_actor
    FROM (SELECT session_user AS role_name) s
    LEFT JOIN pg_catalog.pg_roles r ON r.rolname = s.role_name;

  IF v_request_role IS NOT NULL
     AND v_request_role NOT IN ('anon', 'authenticated', 'service_role') THEN
    RAISE EXCEPTION 'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REFUSED'
      USING ERRCODE = '42501';
  END IF;
  IF v_request_role IS NULL AND NOT COALESCE(v_trusted_database_actor, false) THEN
    RAISE EXCEPTION 'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REQUIRED'
      USING ERRCODE = '42501';
  END IF;

  -- PERF (2026-09-10, swarm A): OFFSET 0 is an optimisation fence. Without it
  -- the planner evaluated `shifted ?& c_required_steps` first on every row of
  -- engine_maintenance_thaws (167 rows, 0 of them contract_version 3) on every
  -- money write that reaches fn_platform_frozen: 229 us -> 32 us per call.
  -- Same four quals, same max(); the jsonb quals now only see rows that already
  -- passed contract_version = 3 AND release_target_at > clock_timestamp().
  SELECT max(t.release_target_at) INTO v_release_target
    FROM (SELECT t.release_target_at, t.shifted
            FROM public.engine_maintenance_thaws t
           WHERE t.contract_version = 3
             AND t.release_target_at > clock_timestamp()
          OFFSET 0) t
   WHERE COALESCE((t.shifted->>'complete')::boolean, false)
     AND t.shifted ?& c_required_steps;
  RETURN v_release_target;
END;
$function$
;
COMMIT;
