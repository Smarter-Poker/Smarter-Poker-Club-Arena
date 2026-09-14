-- 20260914102150_mystery_options_commit_with_tournament_creation
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-14 10:21:51 UTC.
--
-- The creator ignored mystery options; the client configured the committed event
-- in a second request and silently accepted defaults after refusal. Scheduled
-- and recurring constructors dropped these options too. Validate explicit
-- creation metadata, persist it within the original authenticated transaction,
-- and verify the row after all triggers. A common row guard also refuses a
-- settings write that loses a concurrent race to inventory activation.
-- Preserves default 50/50 allocation, authority, entry funding and payout formulas.
-- Private PostgreSQL 17 reproduced the old failure and passed 12 groups for
-- exact terms, rollback, authorization, existing guards and real row-lock races.
-- This fixture uses explicit auth/delegated-create stand-ins, not financial proof.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_creation_document(p_config jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $function$
DECLARE
  v_profile text:=coalesce(p_config->>'mysteryBountyProfile','classic');
  v_activation text:=coalesce(p_config->>'mysteryBountyActivation','at_the_money');
  v_value jsonb:=coalesce(p_config->'mysteryBountyActivationValue','null'::jsonb);
  v_pool jsonb:=coalesce(nullif(p_config->'mysteryBountyPoolPercent','null'::jsonb),'50'::jsonb);
  v_top jsonb:=coalesce(nullif(p_config->'mysteryBountyTopPercent','null'::jsonb),'20'::jsonb);
BEGIN
  IF p_config IS NULL OR jsonb_typeof(p_config)<>'object' THEN
    RAISE EXCEPTION 'Invalid mystery bounty configuration' USING ERRCODE='22023';
  END IF;
  IF v_profile NOT IN ('balanced','classic','jackpot') THEN
    RAISE EXCEPTION 'Invalid mystery bounty profile' USING ERRCODE='22023';
  END IF;
  IF v_activation NOT IN ('at_the_money','percent_field','player_count') THEN
    RAISE EXCEPTION 'Invalid mystery bounty activation' USING ERRCODE='22023';
  END IF;
  IF v_activation<>'at_the_money' THEN
    IF jsonb_typeof(v_value)<>'number' THEN
      RAISE EXCEPTION 'Invalid mystery bounty activation value' USING ERRCODE='22023';
    END IF;
    IF v_activation='percent_field' AND ((v_value#>>'{}')::numeric<=0 OR (v_value#>>'{}')::numeric>100) THEN
      RAISE EXCEPTION 'Invalid mystery bounty activation percentage' USING ERRCODE='22023';
    END IF;
    IF v_activation='player_count' AND ((v_value#>>'{}')::numeric<2
       OR (v_value#>>'{}')::numeric>9007199254740991
       OR trunc((v_value#>>'{}')::numeric)<>(v_value#>>'{}')::numeric) THEN
      RAISE EXCEPTION 'Invalid mystery bounty activation player count' USING ERRCODE='22023';
    END IF;
  ELSE
    v_value:='null'::jsonb;
  END IF;
  IF jsonb_typeof(v_pool)<>'number' OR jsonb_typeof(v_top)<>'number' THEN
    RAISE EXCEPTION 'Invalid mystery bounty percentage type' USING ERRCODE='22023';
  END IF;
  IF (v_pool#>>'{}')::numeric<0 OR (v_pool#>>'{}')::numeric>100
     OR trunc((v_pool#>>'{}')::numeric*100)<>(v_pool#>>'{}')::numeric*100
     OR (v_top#>>'{}')::numeric<=0 OR (v_top#>>'{}')::numeric>100 THEN
    RAISE EXCEPTION 'Invalid mystery bounty percentage range' USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object('mystery_bounty_profile',v_profile,
    'mystery_bounty_activation',v_activation,'mystery_bounty_activation_value',v_value,
    'mystery_bounty_pool_percent',v_pool,'mystery_bounty_regular_pool_percent',100-(v_pool#>>'{}')::numeric,
    'mystery_bounty_top_percent',v_top);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_creation_document(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_creation_document(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_guard_tournament_mystery_creation_contract()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $function$
DECLARE v_expected jsonb; v_actual jsonb;
BEGIN
  IF TG_OP='UPDATE' AND coalesce(OLD.is_mystery_bounty,false)
     AND OLD.mystery_bounty_stage IS DISTINCT FROM 'pending'
     AND ROW(NEW.is_mystery_bounty,NEW.mystery_bounty_profile,NEW.mystery_bounty_activation,NEW.mystery_bounty_activation_value,
       NEW.mystery_bounty_pool_percent,NEW.mystery_bounty_regular_pool_percent,NEW.mystery_bounty_top_percent)
     IS DISTINCT FROM ROW(OLD.is_mystery_bounty,OLD.mystery_bounty_profile,OLD.mystery_bounty_activation,OLD.mystery_bounty_activation_value,
       OLD.mystery_bounty_pool_percent,OLD.mystery_bounty_regular_pool_percent,OLD.mystery_bounty_top_percent) THEN
    RAISE EXCEPTION 'Mystery bounty terms cannot change after activation' USING ERRCODE='55000';
  END IF;
  IF NOT coalesce(NEW.is_mystery_bounty,false) THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND coalesce(OLD.is_mystery_bounty,false)
     AND ROW(NEW.mystery_bounty_profile,NEW.mystery_bounty_activation,NEW.mystery_bounty_activation_value,
       NEW.mystery_bounty_pool_percent,NEW.mystery_bounty_regular_pool_percent,NEW.mystery_bounty_top_percent)
     IS NOT DISTINCT FROM ROW(OLD.mystery_bounty_profile,OLD.mystery_bounty_activation,OLD.mystery_bounty_activation_value,
       OLD.mystery_bounty_pool_percent,OLD.mystery_bounty_regular_pool_percent,OLD.mystery_bounty_top_percent)
    THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.mystery_bounty_stage IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'Mystery bounty terms cannot change after activation' USING ERRCODE='55000';
  END IF;
  v_expected:=public.fn_mystery_bounty_creation_document(jsonb_build_object(
    'mysteryBountyProfile',NEW.mystery_bounty_profile,'mysteryBountyActivation',NEW.mystery_bounty_activation,
    'mysteryBountyActivationValue',NEW.mystery_bounty_activation_value,
    'mysteryBountyPoolPercent',NEW.mystery_bounty_pool_percent,'mysteryBountyTopPercent',NEW.mystery_bounty_top_percent));
  IF NEW.mystery_bounty_regular_pool_percent IS DISTINCT FROM
     (v_expected->>'mystery_bounty_regular_pool_percent')::numeric THEN
    RAISE EXCEPTION 'Mystery bounty pool percentages must total 100' USING ERRCODE='22023';
  END IF;
  v_actual:=jsonb_build_object('mystery_bounty_profile',NEW.mystery_bounty_profile,
    'mystery_bounty_activation',NEW.mystery_bounty_activation,
    'mystery_bounty_activation_value',NEW.mystery_bounty_activation_value,
    'mystery_bounty_pool_percent',NEW.mystery_bounty_pool_percent,
    'mystery_bounty_regular_pool_percent',NEW.mystery_bounty_regular_pool_percent,
    'mystery_bounty_top_percent',NEW.mystery_bounty_top_percent);
  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'Invalid canonical mystery bounty configuration' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_guard_tournament_mystery_creation_contract() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS tournaments_mystery_creation_contract ON public.tournaments;
CREATE TRIGGER tournaments_mystery_creation_contract
BEFORE INSERT OR UPDATE OF is_mystery_bounty,mystery_bounty_profile,mystery_bounty_activation,
  mystery_bounty_activation_value,mystery_bounty_pool_percent,mystery_bounty_regular_pool_percent,mystery_bounty_top_percent
ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.fn_guard_tournament_mystery_creation_contract();
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)
VALUES('tournaments','tournaments_mystery_creation_contract',
 'Validate newly published mystery bounty choices and preserve their funded inventory after activation; unchanged historical terms and all payout formulas remain intact.')
ON CONFLICT(table_name,trigger_name) DO UPDATE SET note=excluded.note;

DO $migration$
DECLARE v_source text;
BEGIN
  SELECT md5(prosrc) INTO v_source FROM pg_proc WHERE oid='public.fn_create_tournament(uuid,jsonb)'::regprocedure;
  IF v_source='876158c293c3fe31d6857ba00ee33938' THEN RETURN; END IF;
  IF v_source IS DISTINCT FROM 'b6335e81d6629f8971d2fa378aebe6b1' THEN
    RAISE EXCEPTION 'Unreviewed tournament creator source: %',v_source;
  END IF;
  EXECUTE $creator$CREATE OR REPLACE FUNCTION public.fn_create_tournament(p_club_id uuid, p_config jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_res jsonb;
  v_pct smallint;
  v_id  uuid;
  v_saved_pct smallint;
  v_mystery jsonb;
  v_persisted jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','not_authenticated');
  END IF;
  IF NOT public.fn_can_create_games(p_club_id,v_uid) THEN
    RETURN jsonb_build_object('success',false,'error','not_authorised');
  END IF;

  -- Preserve the existing 10% fallback for absent or invalid input. Only
  -- input decoding is recoverable: a failed contract write must roll back
  -- the delegated create in the same database transaction.
  BEGIN
    v_pct := CASE WHEN (p_config->>'payoutPercent')::int IN (10,15,20)
                  THEN (p_config->>'payoutPercent')::smallint ELSE 10 END;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    v_pct := 10;
  END;

  IF p_config->>'type'='mystery_bounty' THEN
    v_mystery:=public.fn_mystery_bounty_creation_document(p_config);
  END IF;

  v_res := public.fn_create_tournament_governed_legacy(p_club_id,p_config);
  IF v_res->'success' = 'false'::jsonb THEN
    RETURN v_res;
  END IF;
  IF v_res->'success' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Tournament creation returned an unconfirmed receipt';
  END IF;

  -- The governed creator returns tournament_id. A missing, malformed or
  -- cross-club receipt cannot be accepted as a successful creation.
  v_id := NULLIF(v_res->>'tournament_id','')::uuid;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Tournament creation returned no tournament_id';
  END IF;
  UPDATE public.tournaments SET payout_percent = v_pct
   WHERE id = v_id AND club_id = p_club_id
   RETURNING payout_percent INTO v_saved_pct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament creation receipt does not identify its club event';
  END IF;

  IF v_saved_pct IS DISTINCT FROM v_pct THEN
    RAISE EXCEPTION 'Tournament payout depth was not persisted';
  END IF;

  IF v_mystery IS NOT NULL THEN
    UPDATE public.tournaments
       SET mystery_bounty_profile=v_mystery->>'mystery_bounty_profile',
           mystery_bounty_activation=v_mystery->>'mystery_bounty_activation',
           mystery_bounty_activation_value=(v_mystery->>'mystery_bounty_activation_value')::numeric,
           mystery_bounty_pool_percent=(v_mystery->>'mystery_bounty_pool_percent')::numeric,
           mystery_bounty_regular_pool_percent=(v_mystery->>'mystery_bounty_regular_pool_percent')::numeric,
           mystery_bounty_top_percent=(v_mystery->>'mystery_bounty_top_percent')::numeric
     WHERE id=v_id AND club_id=p_club_id AND is_mystery_bounty;
    IF NOT FOUND THEN RAISE EXCEPTION 'Mystery creation receipt does not identify its club event'; END IF;
    -- Read after all triggers, rather than trusting an UPDATE's pre-AFTER image.
    SELECT jsonb_build_object('mystery_bounty_profile',t.mystery_bounty_profile,
       'mystery_bounty_activation',t.mystery_bounty_activation,
       'mystery_bounty_activation_value',t.mystery_bounty_activation_value,
       'mystery_bounty_pool_percent',t.mystery_bounty_pool_percent,
       'mystery_bounty_regular_pool_percent',t.mystery_bounty_regular_pool_percent,
       'mystery_bounty_top_percent',t.mystery_bounty_top_percent)
      INTO v_persisted FROM public.tournaments t WHERE t.id=v_id AND t.club_id=p_club_id AND t.is_mystery_bounty;
    IF v_persisted IS DISTINCT FROM v_mystery THEN
      RAISE EXCEPTION 'Mystery bounty creation terms were not persisted';
    END IF;
    v_res:=v_res||jsonb_build_object('mystery_config',v_persisted);
  END IF;

  RETURN v_res;
END $function$
$creator$;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_create_tournament(uuid,jsonb)'::regprocedure)
     IS DISTINCT FROM '876158c293c3fe31d6857ba00ee33938' THEN RAISE EXCEPTION 'Mystery creator postimage did not match'; END IF;
END;
$migration$;
REVOKE ALL ON FUNCTION public.fn_create_tournament(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_create_tournament(uuid,jsonb) TO authenticated,service_role;

COMMIT;
