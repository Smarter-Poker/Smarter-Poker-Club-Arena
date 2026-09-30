/*
 * THE TOURNAMENT LEASE DOORS STATE THAT ONLY THE ENGINE OPENS THEM (2026-09-27).
 *
 * Ships beside 20260927231300 (a stale lease yields to its named successor).
 * claim_tournament_lease_v2 is SECURITY DEFINER and it writes, so
 * check-definer-authorization asks the question it asks of every such
 * function: can a browser role reach it, and if so does the body ever consult
 * auth.uid() / auth.role() / auth.jwt()? It does not - lease ownership is
 * proven from the instance id and the generation, never from a JWT - so the
 * only correct answer is the first remedy that check names: nobody in a
 * browser should call it.
 *
 * Production already agrees. The live ACL of all four lease doors is
 * {postgres=X/postgres,service_role=X/postgres} - CREATE OR REPLACE preserves
 * grants, so the replacement in 20260927231300 changed nothing. What was
 * missing is that the migrations never SAID so, and silence on a
 * SECURITY DEFINER function reads as open: a later CREATE (rather than
 * REPLACE) of any of these names would hand EXECUTE straight back to PUBLIC
 * and nothing would notice.
 *
 * So this states it, for the whole lease protocol rather than the one door
 * that happened to change tonight. Idempotent and a no-op against the live
 * grants; PUBLIC is named alongside the roles, because revoking a role while
 * PUBLIC still holds EXECUTE reads as a fix and does nothing.
 */
REVOKE ALL ON FUNCTION public.claim_tournament_lease_v2(uuid, text, text, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_tournament_lease_v2(uuid, text, text, uuid, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.heartbeat_tournament_leases_v4(text, jsonb, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heartbeat_tournament_leases_v4(text, jsonb, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.release_tournament_leases_v2(text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_tournament_leases_v2(text, jsonb)
  TO service_role;

REVOKE ALL ON FUNCTION public.claim_tournament_lease(uuid, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_tournament_lease(uuid, text, text, integer)
  TO service_role;
