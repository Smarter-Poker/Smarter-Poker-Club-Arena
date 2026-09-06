-- THE RAKE DOOR STATES ITS OWN GRANTS, SO A REPLAY CANNOT OPEN IT.
--
-- check-definer-authorization blocked the push carrying 20260906023024:
-- atomic_distribute_rake is SECURITY DEFINER, it writes, and it never calls
-- auth.uid(), auth.role() or auth.jwt(), so it cannot know who is asking.
--
-- PRODUCTION IS NOT EXPOSED, and I checked before writing anything:
--
--   anon           EXECUTE  false
--   authenticated  EXECUTE  false
--   service_role   EXECUTE  true
--
-- CREATE OR REPLACE FUNCTION preserves the grants an existing function already
-- has, so re-declaring the body in 20260906023024 changed nothing about who may
-- call it. The checker cannot see that: it reads the migration, finds a definer
-- writer declared with no grant statement beside it, and says so.
--
-- IT IS RIGHT ANYWAY, FOR THE CASE NOBODY TESTS. Replayed onto an empty
-- database - a branch, a restore rehearsal, a disaster recovery - there is no
-- existing function to inherit from, so CREATE OR REPLACE creates a fresh one
-- with Postgres's default of EXECUTE to PUBLIC. On that database every
-- authenticated browser could call the rake door directly and move chips into a
-- club treasury and a jackpot pool. The grants are only true here because of
-- history, and history does not survive a restore.
--
-- So the door states its own terms. On production this is a no-op that asserts
-- what is already true; on any fresh replay it is the difference between a
-- closed door and an open one. GRANT and REVOKE are not in pgrst_ddl_watch's
-- list, so this costs no schema-cache reload (CLAUDE.md section 2 rule 5).
--
-- WHO CALLS IT, read rather than assumed: the engine (GameServer,
-- ServerTableEngineSettlement, ServerTableEngineHandEvents, rakeAllocation) and
-- the World Hub's LobbyManager, all on the service role key; eight other
-- database functions, every one SECURITY DEFINER and therefore running as the
-- owner rather than through these grants; no RLS policy expression anywhere -
-- checked against pg_policy, because a policy helper evaluates as the QUERYING
-- role and revoking one would deny every SELECT on the tables it guards. The
-- three mentions in Club Arena's src/ are comments, and one of them already
-- says "RLS: service_role writes" - a belief the grants happened to match and
-- did not enforce.

BEGIN;

REVOKE ALL ON FUNCTION public.atomic_distribute_rake(
  uuid, uuid, uuid, integer, numeric, numeric, numeric, integer, jsonb, uuid, jsonb, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.atomic_distribute_rake(
  uuid, uuid, uuid, integer, numeric, numeric, numeric, integer, jsonb, uuid, jsonb, text
) TO service_role;

DO $assert$
DECLARE
  v_sig text := 'public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)';
BEGIN
  IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can still execute the rake door';
  END IF;
  IF has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can still execute the rake door';
  END IF;
  IF NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute the rake door - the engine would stop raking';
  END IF;
  RAISE NOTICE 'RAKE_DOOR_IS_SERVICE_ROLE_ONLY';
END $assert$;

COMMIT;
