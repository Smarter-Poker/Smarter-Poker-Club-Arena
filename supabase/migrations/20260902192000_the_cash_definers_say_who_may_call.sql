-- ═══════════════════════════════════════════════════════════════════════════════
--  THE CASH DEFINERS SAY WHO MAY CALL THEM (2026-09-02, Lane D)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- scripts/ci/check-definer-authorization.mjs read the two Lane D migrations
-- that (re)declare these functions and found three SECURITY DEFINER writers
-- whose files carry no grant statement at all:
--
--   fn_cashout_seats_for_closing_table   (20260902174500_...)
--   fn_ca_settle_hand_stacks_absolute    (20260902185000_..., mirrored)
--   credit_club_wallet_rake              (20260902185000_..., mirrored)
--
-- The checker is right to ask, and it cannot see production. Production was
-- checked live before this file was written: all three already have EXECUTE
-- for service_role ONLY (anon false, authenticated false); CREATE OR REPLACE
-- preserves grants, so the two migrations changed nothing about who may call
-- them. This file states the grants in the repo so the rule is carried by the
-- files that declare the functions, exactly as the checker asks.
--
-- fn_ca_settle_hand_stacks_absolute is the one to read twice: its body gates on
-- `current_user IN ('postgres', 'service_role')`, which inside a SECURITY
-- DEFINER body is the OWNER for every caller and so refuses nobody. The grant
-- is the only thing keeping a browser off the engine's absolute stack write.
-- That is worth a body fix (auth.role(), per fn_caller_is_engine), but the
-- body belongs to Lane F today and a mirror must not edit it; the grant is
-- pinned here and the body fix is noted in the changelog.
--
-- GRANT / REVOKE are not in pgrst_ddl_watch's list (CLAUDE.md section 2,
-- rule 5): this file causes no PostgREST reload.

BEGIN;

REVOKE ALL ON FUNCTION public.fn_cashout_seats_for_closing_table(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cashout_seats_for_closing_table(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.fn_ca_settle_hand_stacks_absolute(uuid, bigint, jsonb, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_settle_hand_stacks_absolute(uuid, bigint, jsonb, numeric, numeric) TO service_role;

REVOKE ALL ON FUNCTION public.credit_club_wallet_rake(uuid, numeric, numeric, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_club_wallet_rake(uuid, numeric, numeric, uuid, integer) TO service_role;

-- The other two mirrored bodies are not SECURITY DEFINER, but they move money
-- and are engine-only in production; say so here as well.
REVOKE ALL ON FUNCTION public.resolve_pending_addon(uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_pending_addon(uuid, numeric) TO service_role;

REVOKE ALL ON FUNCTION public.fn_add_chips(uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_add_chips(uuid, uuid, numeric) TO service_role;

-- player_leave_table (C5, redeclared by 20260902174500_...) is the cron
-- eviction's cash-out; engine-only in production too.
REVOKE ALL ON FUNCTION public.player_leave_table(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.player_leave_table(uuid, uuid) TO service_role;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT unnest(ARRAY[
      'public.fn_cashout_seats_for_closing_table(uuid, text)',
      'public.fn_ca_settle_hand_stacks_absolute(uuid, bigint, jsonb, numeric, numeric)',
      'public.credit_club_wallet_rake(uuid, numeric, numeric, uuid, integer)',
      'public.resolve_pending_addon(uuid, numeric)',
      'public.fn_add_chips(uuid, uuid, numeric)',
      'public.player_leave_table(uuid, uuid)']) AS sig LOOP
    IF has_function_privilege('anon', r.sig, 'EXECUTE')
       OR has_function_privilege('authenticated', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'post-apply: a browser role can still EXECUTE %', r.sig;
    END IF;
    IF NOT has_function_privilege('service_role', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'post-apply: service_role lost EXECUTE on %', r.sig;
    END IF;
  END LOOP;
  RAISE NOTICE 'the_cash_definers_say_who_may_call: six cash money functions are service_role-only';
END $$;

COMMIT;
