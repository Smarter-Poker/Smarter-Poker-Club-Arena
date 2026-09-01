-- ═══════════════════════════════════════════════════════════════════════════
-- DEFINER LOCKDOWN, PHASE 1 (2026-09-01 security sweep)
--
-- The Supabase security advisors report 579 SECURITY DEFINER functions
-- executable by `authenticated` and 27 by `anon`. Each is safe only by its
-- own internal discipline - the class that produced the 2026-08-27 incident
-- (a member rewriting club member_count through an unguarded definer).
--
-- This phase revokes browser execute ONLY on functions whose server-side
-- nature is unambiguous from their semantics: minting, correction posting,
-- estate-wide cascades/sweeps/recomputes, data loaders, an emergency lever,
-- and cron machinery. Each was verified absent from every browser rpc()
-- call site in Club Arena src/ and World Hub src/+pages/ (api excluded -
-- API routes use the service role, which keeps its grant), absent from all
-- RLS policies, views, and computed-column usage. service_role and postgres
-- retain execute, so the engine, API routes, pg_cron and agents via MCP are
-- untouched. ROLLBACK for any one function:
--   GRANT EXECUTE ON FUNCTION <sig> TO anon, authenticated;
--
-- NOT touched: PostGIS st_estimatedextent (extension-owned, cannot ALTER;
-- read-only estimator, accepted residual on every PostGIS Supabase project).
-- See docs/security/2026-09-01-definer-sweep.md for the remaining-work plan.
-- ═══════════════════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION public.fn_ca_mint(text, text, uuid, numeric, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_post_correction(text, uuid, text, uuid, numeric, text, uuid, bigint, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_union_settlement_cascade_all(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_union_integrity_sweep_all(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_rakeback_recompute_all_clubs(date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_club_rake_rollup_catchup(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_replace_licensed_poy_rankings(integer, jsonb, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_anonymize_hg_user_content(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.verify_home_games_health_core() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_emergency_block_deep_stack_horse_membership() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_enqueue_hand_daily_missions() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_require_explicit_club_membership_source() FROM PUBLIC, anon, authenticated;

-- Assert the lockdown landed and nothing legitimate broke shape.
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname IN ('fn_ca_mint','fn_ca_post_correction','fn_union_settlement_cascade_all',
                       'fn_union_integrity_sweep_all','fn_rakeback_recompute_all_clubs',
                       'fn_club_rake_rollup_catchup','fn_replace_licensed_poy_rankings',
                       'fn_anonymize_hg_user_content','verify_home_games_health_core',
                       'fn_emergency_block_deep_stack_horse_membership')
     AND (has_function_privilege('anon', p.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad > 0 THEN RAISE EXCEPTION 'lockdown incomplete: % functions still browser-executable', v_bad; END IF;
  SELECT count(*) INTO v_bad FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_mint'
     AND has_function_privilege('service_role', p.oid, 'EXECUTE');
  IF v_bad = 0 THEN RAISE EXCEPTION 'service_role lost execute - engine paths would break, aborting'; END IF;
END $$;
