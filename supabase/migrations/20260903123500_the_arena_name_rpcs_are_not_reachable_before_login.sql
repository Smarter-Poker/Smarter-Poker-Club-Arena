-- ============================================================================
-- THE ARENA-NAME RPCs ARE NOT REACHABLE BEFORE LOGIN
--
-- The pre-push guard `check-definer-authorization` refused this branch, and it
-- was right to. Six SECURITY DEFINER functions redefined by 20260903120000 and
-- 20260903121000 are executable by `anon`: they run as the owner, past RLS,
-- for a caller with no account.
--
-- The exposure is not new - these grants predate this work - but the functions
-- are declared in my migrations now, so they are mine to close. None of the
-- six backs an RLS policy (checked against pg_policy first, as the guard's
-- remedy instructs: revoking a policy helper denies every SELECT on the tables
-- whose policies call it).
--
-- TWO CATEGORIES, per the guard's own ordering:
--
-- 1. INTERNAL RESOLVERS. fn_player_display_name and fn_notify_display_name are
--    called by trg_tournament_player_name, fn_notify_credit_request and
--    fn_notify_dispute - all SECURITY DEFINER, so they run as the owner and
--    are unaffected by these grants. No browser calls either one directly.
--    service_role only.
--
-- 2. CLUB SURFACES A LOGGED-IN MEMBER READS. ca_club_activity,
--    ca_club_top_players, ca_promo_vault_records and ca_club_member_downline
--    each authorise internally (ca_can_view_club, ca_club_roster_access,
--    fn_club_scope_ids) - which is why the guard's literal search for
--    auth.uid() missed it - but that check is worthless to a caller who never
--    logged in, and every one of them returns member names and club activity.
--    authenticated only.
--
-- PUBLIC IS NAMED EXPLICITLY in every REVOKE. anon inherits whatever PUBLIC
-- holds, so revoking anon alone reads as a fix and does nothing - the guard
-- says so, and it is the mistake worth not making twice.
--
-- GRANT/REVOKE do not fire pgrst_ddl_watch, so this costs no schema reload.
--
-- ROLLBACK: GRANT EXECUTE ... TO anon, authenticated for the function in
-- question. Do not, without reading the guard's reasoning first.
-- ============================================================================

BEGIN;

-- 1. Internal resolvers -------------------------------------------------------
REVOKE ALL ON FUNCTION public.fn_player_display_name(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_player_display_name(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_notify_display_name(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_notify_display_name(uuid) TO service_role;

-- 2. Club surfaces, for members ----------------------------------------------
REVOKE ALL ON FUNCTION public.ca_club_activity(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_activity(uuid, integer) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ca_club_top_players(uuid, timestamptz, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_top_players(uuid, timestamptz, integer)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ca_promo_vault_records(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_promo_vault_records(uuid, integer)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ca_club_member_downline(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_member_downline(uuid, uuid)
  TO authenticated, service_role;

DO $$
DECLARE v_open text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_open
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
   WHERE p.proname IN ('fn_player_display_name','fn_notify_display_name','ca_club_activity',
                       'ca_club_top_players','ca_promo_vault_records','ca_club_member_downline')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_open IS NOT NULL THEN
    RAISE EXCEPTION 'anon can still execute: %', v_open;
  END IF;

  -- ...and a signed-in member has not lost the four club screens.
  SELECT string_agg(p.proname, ', ') INTO v_open
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
   WHERE p.proname IN ('ca_club_activity','ca_club_top_players','ca_promo_vault_records',
                       'ca_club_member_downline')
     AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_open IS NOT NULL THEN
    RAISE EXCEPTION 'authenticated lost access to: %', v_open;
  END IF;
END $$;

COMMIT;
