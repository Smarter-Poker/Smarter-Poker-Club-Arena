-- ═══════════════════════════════════════════════════════════════════════════
--  THE AUDIT GUARDS STATE THEIR OWN GRANTS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The two guards re-emitted by 20260901190748 were already service-role-only in
-- production - the autorevoke event trigger strips PUBLIC and anon from every
-- new SECURITY DEFINER function - and the migration file did not say so.
-- check-definer-authorization reads the FILE, and it is right to: an intention
-- that lives only in a trigger is one the next reader cannot see.
--
-- Applied to production as 20260901192009. The state it sets was already true;
-- this makes the file and the database agree line for line. 20260901190748
-- carries the same statements inline for a database built from scratch.
REVOKE ALL ON FUNCTION public.fn_club_arena_global_wallet_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_arena_global_wallet_check() TO service_role;

REVOKE ALL ON FUNCTION public.fn_union_overload_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_overload_check() TO service_role;
