-- fn_safe_jsonb_array(text) body_md5 f7d50c875a67fb5a84ae4f1c32bdf941
CREATE OR REPLACE FUNCTION public.fn_safe_jsonb_array(p_text text)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v jsonb;
BEGIN
  IF p_text IS NULL OR btrim(p_text) = '' THEN
    RETURN '[]'::jsonb;
  END IF;
  BEGIN
    v := p_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN '[]'::jsonb;
  END;
  IF v IS NULL OR jsonb_typeof(v) <> 'array' THEN
    RETURN '[]'::jsonb;
  END IF;
  RETURN v;
END;
$function$;

-- fn_resolve_tournament_blinds(text,integer,text,text,numeric) body_md5 b5769b647e5b106caaf51982ac245ee8
CREATE OR REPLACE FUNCTION public.fn_resolve_tournament_blinds(p_blind_structure text, p_current_level integer, p_variant text, p_tournament_type text, p_total_chips numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_levels jsonb;
  v_len integer;
  v_index integer;
  v_level jsonb;
  v_last_index integer;
  v_last jsonb;
  v_is_spin boolean;
  v_tail_count integer;
  v_tail_first numeric;
  v_tail_last numeric;
  v_ratio numeric := 1.4;
  v_factor numeric;
  v_sb numeric;
  v_bb numeric;
  v_ante numeric;
  v_max_bb numeric;
  v_scale numeric;
  v_capped boolean := false;
BEGIN
  v_levels := public.fn_safe_jsonb_array(p_blind_structure);
  v_len := jsonb_array_length(v_levels);
  IF v_len=0 THEN
    RAISE EXCEPTION 'Tournament blind structure is missing' USING ERRCODE='55000';
  END IF;
  v_index := GREATEST(COALESCE(p_current_level,0),0);

  -- A persisted level is authoritative and is never chip-capped in the engine.
  IF v_index<v_len THEN
    v_level := v_levels->v_index;
    v_sb := COALESCE(
      CASE WHEN COALESCE(v_level->>'smallBlind','') ~ '^[0-9]+([.][0-9]+)?$'
           THEN (v_level->>'smallBlind')::numeric END,
      CASE WHEN COALESCE(v_level->>'small_blind','') ~ '^[0-9]+([.][0-9]+)?$'
           THEN (v_level->>'small_blind')::numeric END
    );
    v_bb := COALESCE(
      CASE WHEN COALESCE(v_level->>'bigBlind','') ~ '^[0-9]+([.][0-9]+)?$'
           THEN (v_level->>'bigBlind')::numeric END,
      CASE WHEN COALESCE(v_level->>'big_blind','') ~ '^[0-9]+([.][0-9]+)?$'
           THEN (v_level->>'big_blind')::numeric END
    );
    v_ante := COALESCE(
      CASE WHEN COALESCE(v_level->>'ante','') ~ '^[0-9]+([.][0-9]+)?$'
           THEN (v_level->>'ante')::numeric END,
      0
    );
    RETURN jsonb_build_object(
      'small_blind',v_sb,'big_blind',v_bb,'ante',v_ante,
      'level_index',v_index,'source','persisted','blind_capped',false
    );
  END IF;

  v_is_spin := lower(COALESCE(p_variant,''))='spin'
            OR upper(COALESCE(p_tournament_type,''))='SPIN';
  IF v_is_spin THEN
    -- spinBlindsForLevel(index+1), including canonical values when a legacy
    -- persisted array is shorter than today's ten-row Spin ladder.
    v_bb := CASE v_index
      WHEN 0 THEN 20 WHEN 1 THEN 30 WHEN 2 THEN 40 WHEN 3 THEN 60
      WHEN 4 THEN 80 WHEN 5 THEN 100 WHEN 6 THEN 120 WHEN 7 THEN 150
      WHEN 8 THEN 180 WHEN 9 THEN 210
      ELSE round((210::numeric*power(1.4::numeric,v_index-9))/10)*10
    END;
    v_sb := round(v_bb/2);
    RETURN jsonb_build_object(
      'small_blind',v_sb,'big_blind',v_bb,'ante',0,
      'level_index',v_index,'source','spin_overflow','blind_capped',false
    );
  END IF;

  -- Ignore trailing break rows when choosing the overflow anchor.
  v_last_index := v_len-1;
  WHILE v_last_index>0
    AND lower(COALESCE(v_levels->v_last_index->>'isBreak','false'))='true'
  LOOP
    v_last_index := v_last_index-1;
  END LOOP;
  v_last := v_levels->v_last_index;

  -- Geometric mean of the last five positive advertised big-blind steps.
  WITH clean AS (
    SELECT e.ordinality::integer AS ord,
           COALESCE(
             CASE WHEN COALESCE(e.value->>'bigBlind','') ~ '^[0-9]+([.][0-9]+)?$'
                  THEN (e.value->>'bigBlind')::numeric END,
             CASE WHEN COALESCE(e.value->>'big_blind','') ~ '^[0-9]+([.][0-9]+)?$'
                  THEN (e.value->>'big_blind')::numeric END
           ) AS bb
      FROM jsonb_array_elements(v_levels) WITH ORDINALITY AS e(value,ordinality)
  ), tail AS (
    SELECT ord,bb FROM clean WHERE bb>0 ORDER BY ord DESC LIMIT 5
  )
  SELECT count(*)::integer,
         (array_agg(bb ORDER BY ord))[1],
         (array_agg(bb ORDER BY ord DESC))[1]
    INTO v_tail_count,v_tail_first,v_tail_last
    FROM tail;
  IF v_tail_count>=2 AND v_tail_first>0 AND v_tail_last>v_tail_first THEN
    v_ratio := power(v_tail_last/v_tail_first,1::numeric/(v_tail_count-1));
    IF v_ratio<=1 THEN v_ratio := 1.4; END IF;
  END IF;
  v_ratio := LEAST(1.6,GREATEST(1.15,v_ratio));
  v_factor := power(
    v_ratio,
    LEAST(GREATEST(1,v_index-v_len+1),40)
  );

  v_sb := LEAST(COALESCE(
    CASE WHEN COALESCE(v_last->>'smallBlind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'smallBlind')::numeric END,
    CASE WHEN COALESCE(v_last->>'small_blind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'small_blind')::numeric END,
    0
  )*v_factor,10000000);
  v_bb := LEAST(COALESCE(
    CASE WHEN COALESCE(v_last->>'bigBlind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'bigBlind')::numeric END,
    CASE WHEN COALESCE(v_last->>'big_blind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'big_blind')::numeric END,
    0
  )*v_factor,10000000);
  v_ante := LEAST(COALESCE(
    CASE WHEN COALESCE(v_last->>'ante','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'ante')::numeric END,
    0
  )*v_factor,10000000);

  -- Match capLevelToTournamentChips for generic overflow. The database wrapper
  -- supplies the exact durable chip issuance total; NULL means cap nothing.
  IF p_total_chips>0 THEN
    v_max_bb := p_total_chips/20;
    IF v_bb>v_max_bb AND v_max_bb>=2 THEN
      v_scale := v_max_bb/v_bb;
      v_bb := GREATEST(2,floor(v_bb*v_scale));
      v_sb := GREATEST(1,floor(v_sb*v_scale));
      v_ante := CASE WHEN v_ante>0 THEN GREATEST(1,floor(v_ante*v_scale)) ELSE 0 END;
      v_capped := true;
    END IF;
  END IF;

  /* A CAPPED LEVEL IS STILL A BLIND LEVEL (2026-09-09). Both ceilings above
     are applied to smallBlind, bigBlind and ante independently, so a deep
     overflow clamps all three to the same number and the level leaves here
     with SB = BB = ante. That is not a blind level: it makes
     fn_ensure_late_registration_capacity refuse the event a table for ever
     (v_sb>=v_bb), and the engine deals from this same answer. Enforce the
     invariant after the clamps instead of trusting it to survive them. */
  IF v_bb IS NULL OR v_bb < 2 THEN
    v_bb := 2;
    v_capped := true;
  END IF;
  IF v_sb IS NULL OR v_sb >= v_bb THEN
    v_sb := GREATEST(1, floor(v_bb / 2));
    v_capped := true;
  END IF;
  IF v_ante IS NULL OR v_ante < 0 THEN
    v_ante := 0;
  END IF;

  RETURN jsonb_build_object(
    'small_blind',v_sb,'big_blind',v_bb,'ante',v_ante,
    'level_index',v_index,'source','mtt_overflow',
    'overflow_ratio',v_ratio,'blind_capped',v_capped
  );
END;
$function$;
