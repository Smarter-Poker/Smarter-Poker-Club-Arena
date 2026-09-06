-- THE CONSERVATION DELTA IS TELEMETRY, AND IT ANSWERS NO STRANGER.
--
-- check-definer-authorization blocked the push that re-declared
-- fn_tournament_conservation_delta in 20260906015217: SECURITY DEFINER, anon
-- can execute it, and it never asks who is calling. The guard is right, and the
-- exposure is older than my change - it merely became visible when the function
-- was re-declared in a migration the checker reads.
--
-- What an anonymous caller could learn from it: for any tournament id, the
-- exact money position - what was collected, what was paid, what the guarantee
-- bank put in, and by how much the two disagree. That is operator telemetry and
-- nothing on the player side has ever needed it.
--
-- WHO ACTUALLY CALLS IT, checked rather than assumed:
--   - fn_tournament_money_conservation, itself SECURITY DEFINER, so it runs as
--     the owner and does not consult these grants;
--   - the engine (GameServer, TournamentManagerEliminations), which holds the
--     service role key;
--   - no client code in Club Arena or the World Hub;
--   - no RLS policy expression anywhere - checked against pg_policy, because a
--     policy helper evaluates as the QUERYING role and revoking one would deny
--     every SELECT on the tables whose policies call it.
--
-- So the grant goes to service_role and to nobody else. PUBLIC is named
-- explicitly alongside anon and authenticated, because anon inherits whatever
-- PUBLIC holds and revoking anon alone reads as a fix while changing nothing.

BEGIN;

REVOKE ALL ON FUNCTION public.fn_tournament_conservation_delta(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_conservation_delta(uuid)
  TO service_role;

DO $assert$
BEGIN
  IF has_function_privilege('anon', 'public.fn_tournament_conservation_delta(uuid)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'anon can still execute the conservation delta';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_tournament_conservation_delta(uuid)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'service_role cannot execute the conservation delta';
  END IF;
  RAISE NOTICE 'CONSERVATION_DELTA_IS_SERVICE_ROLE_ONLY';
END $assert$;

COMMIT;
