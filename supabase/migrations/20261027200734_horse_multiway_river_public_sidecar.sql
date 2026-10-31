-- @live-proof: to_regprocedure('public.fn_horse_multiway_river_nodes_v1(uuid,text,integer,timestamptz,jsonb)') IS NOT NULL AND (SELECT md5(pg_get_functiondef('public.fn_horse_multiway_river_nodes_v1(uuid,text,integer,timestamptz,jsonb)'::regprocedure))='eb122b43bfd7680a96adb796cd0c1221') AND has_function_privilege('service_role','public.fn_horse_multiway_river_nodes_v1(uuid,text,integer,timestamptz,jsonb)','EXECUTE') AND NOT has_function_privilege('anon','public.fn_horse_multiway_river_nodes_v1(uuid,text,integer,timestamptz,jsonb)','EXECUTE') AND NOT has_function_privilege('authenticated','public.fn_horse_multiway_river_nodes_v1(uuid,text,integer,timestamptz,jsonb)','EXECUTE')
-- Reserved by scripts/reserve-migration-version.sh. Additive public-only reader.
-- v3 remains unchanged for existing engines. This batch enriches at most four public nodes per hand from its
-- already validated original-observer hands, bound to the exact projected
-- action arrays. No private holdings, player arrays, table scans or writes.
BEGIN;
SET LOCAL lock_timeout = '1s';
CREATE FUNCTION public.fn_horse_multiway_river_nodes_v1(
  p_observer uuid, p_variant text, p_dealt_count integer,
  p_before timestamptz, p_hands jsonb
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
SET statement_timeout = '5s'
AS $function$
DECLARE
  requested jsonb; stored jsonb; projected jsonb; nodes jsonb;
  output jsonb := '[]'::jsonb; v_hand_id uuid; node_count integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE='42501';
  END IF;
  IF p_observer IS NULL OR p_variant IS NULL OR p_variant NOT IN ('nlh','plo4','plo5','plo6')
    OR p_dealt_count IS NULL OR p_dealt_count NOT BETWEEN 3 AND 10
    OR p_before IS NULL OR NOT isfinite(p_before)
    OR jsonb_typeof(p_hands) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_hands)>64 OR octet_length(p_hands::text)>262144
  THEN RAISE EXCEPTION 'invalid river sidecar request' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p JOIN public.ca_horse_fleet_register r ON r.horse_id=p.id
    WHERE p.id=p_observer AND p.is_horse IS TRUE AND p.status IS DISTINCT FROM 'deleted'
      AND p.horse_status IS DISTINCT FROM 'disabled' AND r.retired_at IS NULL)
  THEN RETURN NULL; END IF;
  IF (SELECT count(DISTINCT value->>'handId') FROM jsonb_array_elements(p_hands)) <> jsonb_array_length(p_hands)
  THEN RAISE EXCEPTION 'duplicate hand identity' USING ERRCODE='22023'; END IF;
  FOR requested IN SELECT value FROM jsonb_array_elements(p_hands) LOOP
    IF jsonb_typeof(requested) IS DISTINCT FROM 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(requested))<>3
      OR NOT requested ?& ARRAY['handId','actions','binding']
      OR coalesce(requested->>'binding','') !~ '^[a-f0-9]{64}$'
      OR jsonb_typeof(requested->'actions') IS DISTINCT FROM 'array'
      OR jsonb_array_length(requested->'actions')>256
    THEN RAISE EXCEPTION 'invalid hand binding' USING ERRCODE='22023'; END IF;
    v_hand_id := (requested->>'handId')::uuid;
    stored := NULL;
    SELECT h.actions INTO stored FROM public.ca_hand_facts f
    JOIN public.hand_history h ON h.id=f.hand_id
    WHERE f.hand_id=v_hand_id AND f.user_id=p_observer AND f.tournament_id IS NULL
      AND f.game_variant=p_variant AND f.players_dealt=p_dealt_count
      AND f.seat BETWEEN 1 AND 10 AND f.played_at<=p_before
      AND f.played_at>=p_before-interval '8 days'
      AND h.game_variant=p_variant AND h.tournament_id IS NULL
      AND f.table_id=h.table_id AND f.played_at=h.ended_at
      AND f.position IN ('BTN','SB','BB','UTG','UTG+1','UTG+2','UTG+3','MP','LJ','HJ','CO')
      AND h.hand_number>=1000000 AND h.big_blind>0
      AND jsonb_typeof(h.actions)='array'
      AND jsonb_array_length(h.actions)<=256;
    IF stored IS NULL THEN
      output := output || jsonb_build_array(jsonb_build_object('handId',v_hand_id,'binding',requested->'binding','status','unavailable','reason','original_context_unavailable'));
      CONTINUE;
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'seat',a.value->'seat','userId',a.value->'userId','action',a.value->'action',
      'amount',a.value->'amount','stage',a.value->'stage','timestamp',a.value->'timestamp'
    ) || CASE WHEN a.value ? 'isFullRaise' THEN jsonb_build_object('isFullRaise',a.value->'isFullRaise') ELSE '{}'::jsonb END ORDER BY a.ordinality),'[]'::jsonb)
    INTO projected FROM jsonb_array_elements(stored) WITH ORDINALITY a(value,ordinality)
    WHERE a.value->>'action' IN ('fold','check','call','bet','raise','all_in','sb','bb','blind','ante','straddle','post','kill_blind','return')
      AND a.value->>'stage' IN ('preflop','flop','turn','river');
    IF projected IS DISTINCT FROM requested->'actions' THEN
      output := output || jsonb_build_array(jsonb_build_object('handId',v_hand_id,'binding',requested->'binding','status','unavailable','reason','action_binding_mismatch'));
      CONTINUE;
    END IF;
    WITH projected_nodes AS (
      SELECT a.value,row_number() OVER (ORDER BY a.ordinality)-1 AS ordinal
      FROM jsonb_array_elements(stored) WITH ORDINALITY a(value,ordinality)
      WHERE a.value->>'action' IN ('fold','check','call','bet','raise','all_in','sb','bb','blind','ante','straddle','post','kill_blind','return')
        AND a.value->>'stage' IN ('preflop','flop','turn','river')
    ), river AS (
      SELECT * FROM projected_nodes WHERE value->>'stage'='river'
        AND value->>'action' IN ('fold','check','call','bet','raise','all_in') ORDER BY ordinal LIMIT 4
    ) SELECT count(*),coalesce(jsonb_agg(jsonb_build_object('ordinal',ordinal,'node',(
      SELECT jsonb_object_agg(k, CASE
        WHEN k='seats' THEN CASE WHEN jsonb_typeof(value->'publicNode'->k)='array' THEN
          CASE WHEN jsonb_array_length(value->'publicNode'->k) BETWEEN 3 AND 10 AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(value->'publicNode'->k) s WHERE
              CASE WHEN jsonb_typeof(s)='array' THEN jsonb_array_length(s)<>7 OR EXISTS
                (SELECT 1 FROM jsonb_array_elements(s) x WHERE jsonb_typeof(x)<>'number') ELSE true END
          ) THEN value->'publicNode'->k ELSE NULL END ELSE NULL END
        WHEN k IN ('boards','legalActions') THEN CASE WHEN jsonb_typeof(value->'publicNode'->k)='array' THEN
          CASE WHEN jsonb_array_length(value->'publicNode'->k)<=6 AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(value->'publicNode'->k) x WHERE jsonb_typeof(x)<>'string' OR length(x#>>'{}')>12
          ) THEN value->'publicNode'->k ELSE NULL END ELSE NULL END
        WHEN k IN ('allInOrFold','bombPot','wagersCapped') THEN CASE WHEN jsonb_typeof(value->'publicNode'->k)='boolean' THEN value->'publicNode'->k ELSE NULL END
        WHEN k IN ('status','variant','mode','asset','street','anteType','structure') THEN CASE WHEN jsonb_typeof(value->'publicNode'->k)='string' AND length(value->'publicNode'->>k)<=16 THEN value->'publicNode'->k ELSE NULL END
        ELSE CASE WHEN jsonb_typeof(value->'publicNode'->k) IN ('number','null') THEN value->'publicNode'->k ELSE NULL END
      END) FROM unnest(ARRAY[
        'version','status','variant','mode','asset','chipUnit','street','dealerSeat','actorSeat',
        'smallBlind','bigBlind','ante','anteType','allInOrFold','bombPot','boardCount','boards',
        'pot','currentBet','toCall','structure','minRaiseTo','maxRaiseTo','fixedBetSize','wagersCapped','legalActions','seats'
      ]) k
    )) ORDER BY ordinal),'[]'::jsonb) INTO node_count,nodes FROM river;
    IF node_count=3 THEN nodes:=nodes-2; node_count:=2; END IF;
    IF node_count NOT IN (2,4) OR octet_length(nodes::text)>16384 THEN
      output := output || jsonb_build_array(jsonb_build_object('handId',v_hand_id,'binding',requested->'binding','status','unavailable','reason','incomplete_or_bounded_nodes'));
    ELSE
      output := output || jsonb_build_array(jsonb_build_object('handId',v_hand_id,'binding',requested->'binding','status','captured','nodes',nodes));
    END IF;
  END LOOP;
  IF octet_length(output::text)>262144 THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','batch_byte_bound');
  END IF;
  RETURN jsonb_build_object('version',1,'status','captured','hands',output,'definitionMd5',
    md5(pg_get_functiondef('public.fn_horse_multiway_river_nodes_v1(uuid,text,integer,timestamptz,jsonb)'::regprocedure)));
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_horse_multiway_river_nodes_v1(uuid,text,integer,timestamptz,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_multiway_river_nodes_v1(uuid,text,integer,timestamptz,jsonb) TO service_role;
COMMIT;
