-- Spin-only prospective correction; Heads-Up, persisted rows, legacy Spin fallback and generic MTT remain byte-for-byte unchanged.
-- Continue the already-approved booked Spin rules in every DB reader.
-- No tournament/seat/wallet rows are rewritten. Generic MTT code is unchanged.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';
DO $preflight$
DECLARE v_oid oid := to_regprocedure('public.fn_resolve_tournament_blinds(text,integer,text,text,numeric)');
BEGIN
  IF v_oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.oid=v_oid
      AND md5(p.prosrc)='b5769b647e5b106caaf51982ac245ee8'
      AND p.proowner='postgres'::regrole
      AND p.prosecdef AND p.proconfig=ARRAY['search_path=public, pg_temp']
      AND p.proacl::text='{postgres=X/postgres}'
  ) THEN
    RAISE EXCEPTION 'Booked Spin blind resolver preflight changed; review current authority'
      USING ERRCODE='55000';
  END IF;
END;
$preflight$;

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
  v_continuation jsonb;
  v_float_round double precision;
  v_float_units double precision;
  v_float_integral double precision;
  v_float_bb double precision;
  v_float_sb double precision;
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
    -- A funded draw freezes its continuation rule. Presence with malformed
    -- values is an error, never permission to substitute a newer local rule.
    IF (v_levels->(v_len-1)) ? 'spinContinuation' THEN
      v_continuation := v_levels->(v_len-1)->'spinContinuation';
      IF jsonb_typeof(v_continuation) IS DISTINCT FROM 'object'
         OR jsonb_typeof(v_continuation->'version') IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_continuation->'anchorLevel') IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_continuation->'anchorBigBlind') IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_continuation->'growth') IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_continuation->'roundBigTo') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'Spin blind continuation is missing its frozen formula'
          USING ERRCODE='55000';
      END IF;
      -- The booked engine formula consumes JavaScript Number values. Keep
      -- IEEE-754 arithmetic through power, division, both rounds and the
      -- final multiplication. Decimal numeric changes 100 * 1.15 / 10.
      BEGIN
        PERFORM (e.value #>> '{}')::double precision
          FROM jsonb_each(v_continuation) e
         WHERE e.key IN ('version','anchorLevel','anchorBigBlind','growth','roundBigTo');
        IF (v_continuation->>'version')::double precision<>1
           OR (v_continuation->>'anchorLevel')::double precision<=0
           OR floor((v_continuation->>'anchorLevel')::double precision)<>(v_continuation->>'anchorLevel')::double precision
           OR (v_continuation->>'anchorBigBlind')::double precision<=0
           OR (v_continuation->>'growth')::double precision<=1
           OR (v_continuation->>'roundBigTo')::double precision<=0 THEN
          RAISE EXCEPTION 'Spin blind continuation is missing its frozen formula' USING ERRCODE='55000';
        END IF;
        v_float_round := (v_continuation->>'roundBigTo')::double precision;
        v_float_units := ((v_continuation->>'anchorBigBlind')::double precision
          * power((v_continuation->>'growth')::double precision,
                  v_index::double precision+1-(v_continuation->>'anchorLevel')::double precision))
          / v_float_round;
        -- PostgreSQL round(float8) rounds ties to even. JavaScript rounds
        -- positive ties upward. Adding 0.5 first also changes near-half
        -- values, so compare the fractional part without shifting it.
        v_float_integral := floor(v_float_units);
        IF v_float_units-v_float_integral >= 0.5::double precision THEN
          v_float_integral := v_float_integral+1::double precision;
        END IF;
        v_float_bb := v_float_integral*v_float_round;
        v_float_units := v_float_bb/2::double precision;
        v_float_sb := floor(v_float_units);
        IF v_float_units-v_float_sb >= 0.5::double precision THEN
          v_float_sb := v_float_sb+1::double precision;
        END IF;
      EXCEPTION WHEN numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Spin blind continuation is missing its finite frozen formula'
          USING ERRCODE='55000';
      END;
      IF v_float_bb <= 0 OR v_float_bb IN ('Infinity'::double precision,'-Infinity'::double precision,'NaN'::double precision)
         OR v_float_sb IN ('Infinity'::double precision,'-Infinity'::double precision,'NaN'::double precision) THEN
        RAISE EXCEPTION 'Spin blind continuation overflowed its stored formula'
          USING ERRCODE='55000';
      END IF;
      RETURN jsonb_build_object(
        'small_blind',v_float_sb,'big_blind',v_float_bb,'ante',0,
        'level_index',v_index,'source','spin_receipt_overflow','blind_capped',false
      );
    END IF;
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

-- Explicitly preserve the installed internal-only execution boundary.
REVOKE ALL ON FUNCTION public.fn_resolve_tournament_blinds(text,integer,text,text,numeric)
  FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid='public.fn_resolve_tournament_blinds(text,integer,text,text,numeric)'::regprocedure
      AND md5(p.prosrc)='4f83c09a69eecc766a1f3984feeb9823'
      AND p.proowner='postgres'::regrole
      AND p.prosecdef AND p.proconfig=ARRAY['search_path=public, pg_temp']
      AND p.proacl::text='{postgres=X/postgres}'
  ) THEN
    RAISE EXCEPTION 'Short-format blind resolver postflight failed' USING ERRCODE='55000';
  END IF;
END;
$postflight$;
COMMIT;
