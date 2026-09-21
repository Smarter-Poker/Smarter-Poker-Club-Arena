-- This migration only REVOKEs and GRANTs, so it creates no object for the
-- liveness check to look up. These are what a reader would run to see it is live.
-- @live-proof: NOT has_function_privilege('authenticated','public.fn_ca_incident_escalation_tick()','EXECUTE') AND NOT has_function_privilege('anon','public.fn_ca_incident_escalation_tick()','EXECUTE')
-- @live-proof: NOT has_function_privilege('authenticated','public.fn_ca_resolve_cleared_incidents()','EXECUTE') AND NOT has_function_privilege('anon','public.fn_ca_resolve_cleared_incidents()','EXECUTE')
-- @live-proof: has_function_privilege('service_role','public.fn_ca_incident_escalation_tick()','EXECUTE') AND has_function_privilege('service_role','public.fn_ca_resolve_cleared_incidents()','EXECUTE')

-- THE BOARD'S TWO WRITERS ARE NOT REACHABLE FROM A BROWSER
--
-- check-definer-authorization refused the previous migration, correctly:
-- fn_ca_incident_escalation_tick and fn_ca_resolve_cleared_incidents are
-- SECURITY DEFINER, they write, a browser role could execute them, and neither
-- calls auth.uid(), auth.role() or auth.jwt() - so neither can know who is
-- asking. They were already in that state; CREATE OR REPLACE preserves an ACL,
-- so replacing their bodies neither created nor fixed the exposure. It simply
-- put them in front of the gate.
--
-- Remedy 1 applies: nobody in a browser should call either. Both are board
-- hygiene run by pg_cron (jobs 162 and 357). PUBLIC is named as well as the
-- roles, because revoking a role while PUBLIC still holds EXECUTE reads as a
-- fix and does nothing.
--
-- GRANT/REVOKE is not in pgrst_ddl_watch, so this reloads no schema cache
-- (CLAUDE.md section 2 rule 5).
BEGIN;
SET LOCAL lock_timeout = '5s';

REVOKE ALL ON FUNCTION public.fn_ca_incident_escalation_tick()   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_resolve_cleared_incidents()  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_incident_escalation_tick()  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_resolve_cleared_incidents() TO service_role;

DO $check$
DECLARE v_open int;
BEGIN
  SELECT count(*) INTO v_open
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_ca_incident_escalation_tick','fn_ca_resolve_cleared_incidents')
     AND (has_function_privilege('anon', p.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_open <> 0 THEN
    RAISE EXCEPTION 'BOARD_WRITER_STILL_REACHABLE_FROM_A_BROWSER: %', v_open;
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_ca_incident_escalation_tick()', 'EXECUTE')
  OR NOT has_function_privilege('service_role', 'public.fn_ca_resolve_cleared_incidents()', 'EXECUTE') THEN
    RAISE EXCEPTION 'BOARD_WRITER_NOT_REACHABLE_BY_ITS_OWN_CRON';
  END IF;
END $check$;
COMMIT;
