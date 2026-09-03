-- Applied to production via Supabase MCP on 2026-08-20. Mirrored as applied.
--
-- Eight SECURITY DEFINER functions were callable by UNAUTHENTICATED users and
-- mutate data without checking who the caller is. Found by auditing all 683
-- SECURITY DEFINER functions programmatically rather than sampling:
--
--   secdef total 683 | anon-executable 72 | mutating 391
--   mutating with NO auth.uid()/auth.jwt()/current_setting() check: 188
--   of those, anon-executable: 8   <- this set
--
-- The worst is commander_claim_finish_position(p_entry_id, p_tournament_id,
-- p_eliminated_by): it sets status='eliminated', assigns finish_position and
-- clears the player's table and seat, with no authorisation check of any kind.
-- Confirmed reachable with nothing but the PUBLIC anon key that ships in the
-- browser bundle -- a call with a nonsense tournament id came back with the
-- business error "Tournament ... not found" rather than a permission error,
-- which means it executed. With a real tournament id an anonymous caller could
-- bust any player out of any tournament and assign their finishing place.
--
-- IMPORTANT DETAIL: the grant was `=X/postgres`, which is PUBLIC. Revoking
-- from `anon` alone would have changed NOTHING, because anon inherits PUBLIC.
-- That is the difference between this fix and a fix that only looks right.
--
-- No browser code in any repo calls any of the eight. The only real call site
-- is pages/api/cron/club-stats-maintenance.js, which uses
-- SUPABASE_SERVICE_ROLE_KEY, and service_role is unaffected by these grants.
--
-- Verified after: the same anon call now returns 401 / 42501 "permission
-- denied for function", and a service_role call to fn_reconcile_club_table_counts
-- still returns 200.
--
-- FOLLOW-UP for whoever wires up the commander functions (commander_claim_open_seat
-- was created earlier today and has no caller yet): they need an explicit GRANT
-- *and* an authorisation check inside the function body -- the caller must be
-- tournament staff, or the entry's own player. A grant alone re-opens this.

REVOKE EXECUTE ON FUNCTION public.fn_heal_seat_provenance() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_reconcile_club_member_daily_profit(date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_reconcile_club_table_counts() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_refresh_all_club_table_counts() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_sync_club_table_counts() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_sync_union_membership_table_counts() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.commander_claim_finish_position(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.commander_claim_open_seat(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
