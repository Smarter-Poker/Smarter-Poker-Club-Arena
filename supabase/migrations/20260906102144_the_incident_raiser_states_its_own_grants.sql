-- THE INCIDENT RAISER STATES ITS OWN GRANTS.
--
-- check-definer-authorization blocked the push carrying 20260906095606:
-- fn_ca_raise_drift_incident is SECURITY DEFINER, it writes, and it never asks
-- who is calling.
--
-- PRODUCTION IS NOT EXPOSED, checked before writing anything:
--
--   anon           EXECUTE  false
--   authenticated  EXECUTE  false
--   service_role   EXECUTE  true
--
-- CREATE OR REPLACE FUNCTION preserves an existing function's grants, so
-- re-declaring the body to add the rotated-key fold changed nothing about who
-- may call it. The checker reads the migration, finds a definer writer with no
-- grant statement beside it, and says so.
--
-- IT IS RIGHT FOR THE CASE NOBODY TESTS - the same argument as the rake door in
-- 20260906091137. Replayed onto an empty database (a branch, a restore
-- rehearsal, disaster recovery) there is no function to inherit from, so
-- CREATE OR REPLACE creates one with Postgres's default of EXECUTE to PUBLIC.
-- On that database any signed-in browser could file drift incidents directly:
-- inventing criticals, inventing amounts, and paging on them. The grants here
-- are true because of history, and history does not survive a restore.
--
-- WHO CALLS IT, read rather than assumed: 40-odd detector functions in this
-- schema, every one SECURITY DEFINER and therefore running as the owner rather
-- than through these grants, plus the two financial_alerts triggers. No RLS
-- policy expression anywhere - checked against pg_policy, because a policy
-- helper evaluates as the QUERYING role and revoking one would deny every
-- SELECT on the tables it guards.
--
-- GRANT and REVOKE are not in pgrst_ddl_watch's list, so no schema-cache
-- reload (CLAUDE.md section 2 rule 5).

BEGIN;

REVOKE ALL ON FUNCTION public.fn_ca_raise_drift_incident(
  text, text, text, text, numeric, numeric, numeric, text, text, uuid, uuid,
  uuid, uuid, uuid, uuid, text, uuid[], uuid[], text, boolean, jsonb
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_ca_raise_drift_incident(
  text, text, text, text, numeric, numeric, numeric, text, text, uuid, uuid,
  uuid, uuid, uuid, uuid, text, uuid[], uuid[], text, boolean, jsonb
) TO service_role;

DO $assert$
DECLARE
  v_sig text := 'public.fn_ca_raise_drift_incident(text,text,text,text,numeric,'
             || 'numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,'
             || 'uuid[],uuid[],text,boolean,jsonb)';
BEGIN
  IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can still file drift incidents';
  END IF;
  IF has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can still file drift incidents';
  END IF;
  IF NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot file drift incidents - every detector would go silent';
  END IF;
  RAISE NOTICE 'INCIDENT_RAISER_IS_SERVICE_ROLE_ONLY';
END $assert$;

COMMIT;
