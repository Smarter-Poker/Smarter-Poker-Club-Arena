-- PHASE 1 step C (applied to production 2026-08-31 via Supabase MCP
-- apply_migration; this file is the auditable record required by RULE 2).
--
-- fn_award_vip_credit is a SERVER path, and now says so.
--
-- Caught by CI (scripts/ci/check-definer-authorization.mjs) on the PR that
-- committed step B, and it was right: fn_award_vip_credit is SECURITY DEFINER,
-- it WRITES (vip_points_ledger, vip_points_carry, vip_points), and EXECUTE was
-- left on the default grant — so any authenticated browser session could call
-- it through PostgREST and mint itself points, with a source_id of its own
-- choosing. The floor() version it replaced was a trigger body with no
-- callable entry point, so the exposure arrived with the fix.
--
-- Two locks, because either alone is one mistake from open:
--   1. EXECUTE revoked from anon / authenticated / PUBLIC.
--   2. The body refuses anyone but the server. fn_caller_is_engine() is true
--      for the service role and for a NULL request context (pg_cron, psql, a
--      migration) and false for every browser role — the same guard
--      settle_club_rakeback and the seat-exit machinery use.
--
-- The two legitimate callers are unaffected: both are SECURITY DEFINER
-- functions invoked by the engine's service-role connection, and SECURITY
-- DEFINER rewrites current_user, not auth.role(), which is what this guard
-- reads. Verified live after apply: 54 ledger rows in the next four minutes,
-- 11 banked and 43 awarded.

CREATE OR REPLACE FUNCTION public.fn_award_vip_credit(
  p_user_id     uuid,
  p_credit      numeric,
  p_source_type text,
  p_source_id   uuid,
  p_reason      text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ledger_id uuid;
  v_carry     numeric(14,4);
  v_total     numeric(14,4);
  v_pts       bigint;
BEGIN
  -- SERVER ONLY. A browser calling this would be minting its own points.
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'fn_award_vip_credit is a server-side path'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL OR COALESCE(p_credit, 0) <= 0 THEN
    RETURN 0;
  END IF;

  INSERT INTO public.vip_points_ledger (user_id, points, reason, source_type, source_id, credit)
  VALUES (p_user_id, 0, p_reason, p_source_type, p_source_id, round(p_credit, 4))
  ON CONFLICT (user_id, source_type, source_id) DO NOTHING
  RETURNING id INTO v_ledger_id;

  IF v_ledger_id IS NULL THEN
    RETURN 0;
  END IF;

  INSERT INTO public.vip_points_carry (user_id, carry)
  VALUES (p_user_id, 0)
  ON CONFLICT (user_id) DO UPDATE SET carry = public.vip_points_carry.carry
  RETURNING carry INTO v_carry;

  v_total := v_carry + round(p_credit, 4);
  v_pts   := floor(v_total)::bigint;

  UPDATE public.vip_points_carry
     SET carry = v_total - v_pts, updated_at = now()
   WHERE user_id = p_user_id;

  UPDATE public.vip_points_ledger SET points = v_pts WHERE id = v_ledger_id;

  IF v_pts > 0 THEN
    INSERT INTO public.vip_points (user_id, current_points, lifetime_points)
    VALUES (p_user_id, v_pts, v_pts)
    ON CONFLICT (user_id) DO UPDATE SET
      current_points  = public.vip_points.current_points  + v_pts,
      lifetime_points = public.vip_points.lifetime_points + v_pts,
      updated_at = now();
  END IF;

  RETURN v_pts;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_award_vip_credit(uuid, numeric, text, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_award_vip_credit(uuid, numeric, text, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_award_vip_credit(uuid, numeric, text, uuid, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_award_vip_credit(uuid, numeric, text, uuid, text) TO service_role;

DO $$
DECLARE v_user uuid; v_src uuid := gen_random_uuid(); v_pts bigint;
BEGIN
  SELECT id INTO v_user FROM public.profiles LIMIT 1;
  v_pts := public.fn_award_vip_credit(v_user, 1.00, 'zz_probe_c', v_src, 'probe');
  IF v_pts <> 1 THEN RAISE EXCEPTION 'server path broken: awarded %', v_pts; END IF;
  UPDATE public.vip_points
     SET current_points = current_points - 1, lifetime_points = lifetime_points - 1
   WHERE user_id = v_user;
  DELETE FROM public.vip_points_ledger WHERE source_type = 'zz_probe_c';
  IF has_function_privilege('authenticated',
       'public.fn_award_vip_credit(uuid, numeric, text, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can still execute fn_award_vip_credit';
  END IF;
  IF has_function_privilege('anon',
       'public.fn_award_vip_credit(uuid, numeric, text, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can still execute fn_award_vip_credit';
  END IF;
END $$;
