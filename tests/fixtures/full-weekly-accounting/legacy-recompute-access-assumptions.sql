-- Fixture assumption, NOT a captured full production owner/ACL reconstruction.
-- The captured definition records SECURITY DEFINER/configuration but not
-- proowner or proacl. 20260901232323 migration SOURCE explicitly revokes
-- PUBLIC/anon/authenticated; it comments that service_role retains access, but
-- its service assertion covers fn_ca_mint rather than this function.
-- The retirement guard requires these effective rights. They are deliberately
-- supplied for a disposable fixture; fresh protected production ACL readback
-- remains required before installation. Do not relabel this as observed ACL.
REVOKE ALL ON FUNCTION public.fn_rakeback_recompute_all_clubs(date,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rakeback_recompute_all_clubs(date,date) TO service_role;
