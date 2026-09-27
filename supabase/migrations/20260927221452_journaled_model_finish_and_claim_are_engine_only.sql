-- The journaled model sweep is engine-only: the isolated adaptive journal
-- worker claims a coordinate and finishes it with a private report. No browser
-- session has any business completing a sweep lease, and neither function can
-- tell who is asking - both are SECURITY DEFINER writers that never consult
-- auth.uid(), auth.role() or auth.jwt(), because the engine is the only
-- intended caller.
--
-- Production already holds exactly these grants, so this changes no live
-- privilege today. It is written down because CREATE OR REPLACE preserves
-- whatever ACL a function already has: the pair would come back PUBLIC
-- EXECUTE if it were ever created fresh on a rebuilt database, and silence in
-- the migration is what would let that through unnoticed. PUBLIC is named
-- alongside the browser roles, since revoking a role while PUBLIC still holds
-- EXECUTE reads as a fix and does nothing.

REVOKE ALL ON FUNCTION public.fn_finish_horse_journaled_model(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_finish_horse_journaled_model(uuid, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_claim_horse_journaled_model(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_horse_journaled_model(uuid)
  TO service_role;
