-- Immutable catalog images read from production 2026-10-20 (PostgreSQL 17.6):
-- the per-game thresholds wrapper the six-seat migration patches (md5 guard
-- 7d15c333256cd99733d275e7794962f4) and the pure threshold probe it calls.
-- This fixture does not replace production source.
CREATE OR REPLACE FUNCTION public.fn_cash_cluster_lightning_thresholds_probe(p_cfg jsonb, p_handedness integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_int_re constant text := '^-?[0-9]{1,9}(\.0+)?$';
  v_on      integer;
  v_off     integer;
  v_got_on  boolean := false;
  v_got_off boolean := false;
  v_source  text;
  -- WHICH CONFIGURED VALUES WERE THROWN AWAY, AND THEREFORE WHY THE ANSWER IS
  -- A DEFAULT. Without this a typo is indistinguishable from an empty config:
  -- {"on_threshold": 18.5} answers 18 and reports source 'default', which is
  -- true and useless, because it is also what {} answers. An operator who
  -- fat-fingers a threshold gets no signal at all that it was discarded. A
  -- hysteresis failure already had its own source value; a type failure did
  -- not. This is additive - it takes nothing away from the four sources - and
  -- it is the difference between a silent discard and a reportable one.
  v_rejected jsonb := '[]'::jsonb;
BEGIN
  -- THE MANDATED DEFAULTS, AND THE ONLY PLACE THEY ARE WRITTEN.
  -- Specification: 6-max ON 18 / OFF 12; 9-max and full ring ON 27 / OFF 18.
  -- handedness is the seats at one table. A handedness at or below zero is not
  -- a six-max game, it is a missing value, so it takes the full-ring default
  -- rather than silently landing in the smaller band.
  IF p_handedness IS NULL OR p_handedness <= 0 OR p_handedness > 6 THEN
    v_on := 27; v_off := 18;
  ELSE
    v_on := 18; v_off := 12;
  END IF;

  IF jsonb_typeof(p_cfg) = 'object' THEN
    IF jsonb_typeof(p_cfg -> 'on_threshold') = 'number'
       AND (p_cfg ->> 'on_threshold') ~ v_int_re THEN
      v_on := floor((p_cfg ->> 'on_threshold')::numeric)::integer; v_got_on := true;
    -- Present and unusable is reported. A JSON null is ABSENT, not a typo:
    -- "unset it" is a legitimate thing for a config writer to mean, and
    -- listing it as rejected would cry wolf on every deliberate clear.
    ELSIF p_cfg ? 'on_threshold' AND jsonb_typeof(p_cfg -> 'on_threshold') <> 'null' THEN
      v_rejected := v_rejected || to_jsonb('on_threshold'::text);
    END IF;
    IF jsonb_typeof(p_cfg -> 'off_threshold') = 'number'
       AND (p_cfg ->> 'off_threshold') ~ v_int_re THEN
      v_off := floor((p_cfg ->> 'off_threshold')::numeric)::integer; v_got_off := true;
    ELSIF p_cfg ? 'off_threshold' AND jsonb_typeof(p_cfg -> 'off_threshold') <> 'null' THEN
      v_rejected := v_rejected || to_jsonb('off_threshold'::text);
    END IF;
  END IF;

  -- source IS PER-FIELD NOW. The first cut reported 'ruleset' whenever either
  -- half came from configuration, so an operator who wrote {"on_threshold":
  -- "30", "off_threshold": 5} - a string and a number - was told 'ruleset' for
  -- a pair of 18 and 5, where the 18 was the band default and only the 5 was
  -- theirs. That pair passes the validity guard, so nothing else flagged it.
  v_source := CASE
    WHEN v_got_on AND v_got_off THEN 'ruleset'
    WHEN v_got_on OR  v_got_off THEN 'ruleset_partial'
    ELSE 'default' END;

  -- HYSTERESIS IS A RULE, NOT A CONVENTION. "The OFF threshold provides
  -- hysteresis and prevents rapid ON/OFF oscillation." An OFF at or above the
  -- ON would convert a Cluster every tick, forever, in both directions. A
  -- configuration that says so is refused and the defaults answer instead.
  -- The first cut also tested v_on IS NULL here; both are unconditionally
  -- assigned above and no branch can unset them, so that half was dead, and
  -- reading dead cover as live cover is part of how the blocker survived.
  IF v_on <= v_off OR v_off < 2 THEN
    IF p_handedness IS NULL OR p_handedness <= 0 OR p_handedness > 6 THEN
      v_on := 27; v_off := 18;
    ELSE
      v_on := 18; v_off := 12;
    END IF;
    v_source := 'default_after_invalid_config';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'handedness', p_handedness,
    'band', CASE WHEN p_handedness IS NOT NULL AND p_handedness > 0 AND p_handedness <= 6
                 THEN 'six_max' ELSE 'full_ring' END,
    'on', v_on,
    'off', v_off,
    'source', v_source,
    'rejected', v_rejected);
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_cash_cluster_lightning_thresholds(p_game_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE g record;
BEGIN
  SELECT id, handedness, ruleset_snapshot INTO g FROM public.cash_games WHERE id = p_game_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  RETURN public.fn_cash_cluster_lightning_thresholds_probe(g.ruleset_snapshot -> 'lightning', g.handedness)
         || jsonb_build_object('game_id', g.id);
END;
$function$;
-- Production's actual audience, read from pg_proc on 2026-10-20.
REVOKE ALL ON FUNCTION public.fn_cash_cluster_lightning_thresholds(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_lightning_thresholds(uuid) TO service_role;
-- The installed readiness image is 20261017072701's exact one-predicate change
-- on top of 20261016232120. Its own migration also pins an unrelated control
-- function this boundary does not carry, so the identical text replacement is
-- reproduced here; the boundary script's md5 check proves the result equals
-- production (eeec07e85e652927425c00dc6ccbb50a) byte for byte.
DO $image$
DECLARE
  v_oid oid := 'public.fn_lightning_rollout_readiness(uuid)'::regprocedure;
  v_before text := pg_get_functiondef('public.fn_lightning_rollout_readiness(uuid)'::regprocedure);
  v_old text := $old$AND regexp_replace(pg_get_functiondef(p.oid), v_strip, '', 'g') ~ v_horse);$old$;
  v_new text := $new$AND regexp_replace(pg_get_functiondef(p.oid), v_strip, '', 'g') ~ v_horse
                          AND NOT (p.oid = to_regprocedure('public.fn_lightning_pilot_assignment_set(boolean,uuid,text,uuid[],text)')
                            AND md5(pg_get_functiondef(p.oid)) = '42ad4c77c5fbf91c56ba84401a8acb31'));$new$;
BEGIN
  IF md5(v_before) <> 'd5fe0f2eb62a16f7e4587fdb5bf82caa'
     OR (length(v_before)-length(replace(v_before,v_old,'')))/length(v_old) <> 1 THEN
    RAISE EXCEPTION 'FAIL readiness image predecessor %', md5(v_before);
  END IF;
  EXECUTE replace(v_before,v_old,v_new);
END $image$;
