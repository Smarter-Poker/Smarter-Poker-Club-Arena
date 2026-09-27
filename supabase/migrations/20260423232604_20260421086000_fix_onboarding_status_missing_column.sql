-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260423232604 "20260421086000_fix_onboarding_status_missing_column"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 974615dc908358c9866c39e5621f8da4 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG fix: fn_get_home_games_onboarding_status's SELECT INTO was missing
-- jurisdiction_region, but later references v_profile.jurisdiction_region
-- in the return object. plpgsql_check caught it; would fail at runtime on
-- every call. One-liner fix.

CREATE OR REPLACE FUNCTION public.fn_get_home_games_onboarding_status(
  p_caller_user_id uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_profile RECORD;
  v_tos_v   text;
  v_priv_v  text;
  v_cg_v    text;
  v_money_v text;
  v_min_age int;
  v_needs jsonb := '[]'::jsonb;
  v_has_tos   boolean := false;
  v_has_priv  boolean := false;
  v_has_cg    boolean := false;
  v_has_money boolean := false;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;

  SELECT id, over_18_attested_at, jurisdiction_country,
         jurisdiction_region, jurisdiction_acknowledged_at,
         home_games_onboarded_at
    INTO v_profile
    FROM public.profiles WHERE id = p_caller_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_NOT_FOUND'; END IF;

  SELECT value INTO v_tos_v   FROM public.platform_policies WHERE key = 'home_games.tos.version';
  SELECT value INTO v_priv_v  FROM public.platform_policies WHERE key = 'home_games.privacy.version';
  SELECT value INTO v_cg_v    FROM public.platform_policies WHERE key = 'home_games.community_guidelines.version';
  SELECT value INTO v_money_v FROM public.platform_policies WHERE key = 'home_games.money_policy.version';
  SELECT value::int INTO v_min_age FROM public.platform_policies WHERE key = 'home_games.minimum_age';
  IF v_min_age IS NULL THEN v_min_age := 18; END IF;

  SELECT EXISTS (SELECT 1 FROM public.user_tos_acceptances
                  WHERE user_id=p_caller_user_id AND policy_key='home_games.tos'
                    AND policy_version = v_tos_v) INTO v_has_tos;
  SELECT EXISTS (SELECT 1 FROM public.user_tos_acceptances
                  WHERE user_id=p_caller_user_id AND policy_key='home_games.privacy'
                    AND policy_version = v_priv_v) INTO v_has_priv;
  SELECT EXISTS (SELECT 1 FROM public.user_tos_acceptances
                  WHERE user_id=p_caller_user_id AND policy_key='home_games.community_guidelines'
                    AND policy_version = v_cg_v) INTO v_has_cg;
  SELECT EXISTS (SELECT 1 FROM public.user_tos_acceptances
                  WHERE user_id=p_caller_user_id AND policy_key='home_games.money_policy'
                    AND policy_version = v_money_v) INTO v_has_money;

  IF v_profile.over_18_attested_at IS NULL THEN
    v_needs := v_needs || jsonb_build_array('over_18_attestation');
  END IF;
  IF v_profile.jurisdiction_acknowledged_at IS NULL THEN
    v_needs := v_needs || jsonb_build_array('jurisdiction_acknowledgement');
  END IF;
  IF NOT v_has_tos   THEN v_needs := v_needs || jsonb_build_array('tos_acceptance');                  END IF;
  IF NOT v_has_priv  THEN v_needs := v_needs || jsonb_build_array('privacy_acceptance');              END IF;
  IF NOT v_has_cg    THEN v_needs := v_needs || jsonb_build_array('community_guidelines_acceptance'); END IF;
  IF NOT v_has_money THEN v_needs := v_needs || jsonb_build_array('money_policy_acknowledgement');    END IF;

  IF jsonb_array_length(v_needs) = 0 AND v_profile.home_games_onboarded_at IS NULL THEN
    UPDATE public.profiles SET home_games_onboarded_at = now() WHERE id = p_caller_user_id;
  END IF;

  RETURN jsonb_build_object(
    'success',     true,
    'onboarded',   (jsonb_array_length(v_needs) = 0),
    'needs',       v_needs,
    'versions',    jsonb_build_object(
                     'tos',                  v_tos_v,
                     'privacy',              v_priv_v,
                     'community_guidelines', v_cg_v,
                     'money_policy',         v_money_v
                   ),
    'minimum_age', v_min_age,
    'current_attestations', jsonb_build_object(
       'over_18_at',           v_profile.over_18_attested_at,
       'jurisdiction_country', v_profile.jurisdiction_country,
       'jurisdiction_region',  v_profile.jurisdiction_region,
       'jurisdiction_ack_at',  v_profile.jurisdiction_acknowledged_at
    )
  );
END;
$function$;
