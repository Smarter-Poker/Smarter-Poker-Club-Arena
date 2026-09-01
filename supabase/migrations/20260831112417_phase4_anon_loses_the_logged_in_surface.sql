-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831112417; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 4, SECOND PASS: anon loses the surface that needs a login anyway
--
-- Thirteen SECURITY DEFINER functions were still EXECUTE-able by `anon` even
-- though every one of them belongs to a logged-in flow. Ten CONSULT
-- auth.uid(), which is NULL for anon — so for those this revoke is provably a
-- no-op that removes a door rather than a capability:
--
--   fn_cancel_club_join_request, fn_create_club_atomic, fn_join_club_atomic,
--   fn_preview_club_join, fn_get_club_entry_flags,
--   fn_get_club_creation_eligibility, fn_get_player_search_preferences,
--   fn_set_player_search_preferences, fn_search_players,
--   fn_track_club_entry_event
--
-- THREE DO NOT consult auth.uid(), and one of those is the real finding of
-- this pass:
--
--   fn_nit_evictions  RETURNS TABLE(user_id uuid, vpip numeric,
--                                   required integer, hands integer)
--
-- An unauthenticated caller could enumerate PER-PLAYER VPIP STATISTICS —
-- who is being watched for nit eviction, how loose they play, over how many
-- hands. That is player behavioural data handed to someone with no account.
-- fn_nit_check exposes the same judgement in aggregate, and
-- fn_spin_reserve_owner returns a reserve's owner uuid.
--
-- All thirteen keep `authenticated`: they are used by real logged-in club and
-- admin surfaces (verified by name in club-arena/src and the World Hub).
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  sig text;
  targets text[] := ARRAY[
    'fn_cancel_club_join_request','fn_create_club_atomic','fn_join_club_atomic',
    'fn_preview_club_join','fn_get_club_entry_flags','fn_get_club_creation_eligibility',
    'fn_get_player_search_preferences','fn_set_player_search_preferences',
    'fn_search_players','fn_track_club_entry_event',
    'fn_nit_check','fn_nit_evictions','fn_spin_reserve_owner'];
BEGIN
  FOR sig IN
    SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY (targets)
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', sig);
  END LOOP;
END $$;

DO $$
DECLARE v_now int; v_leak int; v_helpers int;
BEGIN
  -- The VPIP leak is closed to anon and still open to a logged-in club admin.
  SELECT count(*) INTO v_leak
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('fn_nit_evictions','fn_nit_check')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_leak > 0 THEN RAISE EXCEPTION 'nit statistics are still readable by anon'; END IF;

  SELECT count(*) INTO v_leak
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('fn_nit_evictions','fn_nit_check')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_leak < 2 THEN RAISE EXCEPTION 'the logged-in nit surface was broken'; END IF;

  -- Policy helpers and the pre-login surface must still be intact.
  SELECT count(*) INTO v_helpers
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_can_view_post','fn_club_chat_is_silenced','fn_home_is_group_staff',
                       'fn_my_club_ids','fn_table_chat_is_silenced','is_admin')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_helpers < 6 THEN RAISE EXCEPTION 'a policy helper lost anon EXECUTE — RLS reads would break'; END IF;

  IF NOT (has_function_privilege('anon','public.check_username_available(text)','EXECUTE')
          AND has_function_privilege('anon','public.get_public_profile_by_username(text)','EXECUTE')) THEN
    RAISE EXCEPTION 'the anonymous signup/profile surface was revoked by mistake';
  END IF;

  SELECT count(*) INTO v_now
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege('anon',p.oid,'EXECUTE');
  RAISE NOTICE 'anon-executable SECURITY DEFINER functions now: %', v_now;
END $$;

