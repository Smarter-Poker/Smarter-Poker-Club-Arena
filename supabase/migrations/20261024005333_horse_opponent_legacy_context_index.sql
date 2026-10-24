-- Version reserved by scripts/reserve-migration-version.sh.
-- Fix observed SQLSTATE 57014 in original-request legacy opponent initialization.
-- The accepted player index has 56k+ lifetime hands for active horses: batching
-- or paging it still misses the entire 1500ms budget in rare game contexts.
-- One compact GIN intersects actor UUID and exact context before heap/action
-- reads. Only userId values are indexed, not other roster fields. Its builtin
-- jsonb_path_query_array expression is immutable; no extension/helper is needed.
-- Future accepted hands are recorded=true and do not grow this legacy index.
-- The maintained applier runs this supported nonblocking preamble separately.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hand_history_horse_legacy_context
 ON public.hand_history USING gin
 ((jsonb_path_query_array(players,'$[*].userId')) jsonb_path_ops,
  (ARRAY[game_variant,CASE WHEN tournament_id IS NULL THEN 'cash' ELSE 'tournament' END,CASE WHEN coalesce(horse_exploit_dealt_count,jsonb_array_length(players))<=2 THEN 'hu' WHEN coalesce(horse_exploit_dealt_count,jsonb_array_length(players))<=5 THEN 'short' ELSE 'full' END]) array_ops)
 WHERE NOT horse_exploit_recorded;

BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';

-- IF NOT EXISTS is not evidence that an existing index has the right shape or
-- completed its concurrent build. Refuse before replacing the function if a
-- previous interrupted build or same-name unrelated index is present.
DO $index_guard$
DECLARE actual_definition text; valid boolean; ready boolean;
BEGIN
 SELECT pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready
 INTO actual_definition,valid,ready FROM pg_index i
 WHERE i.indexrelid=to_regclass('public.idx_hand_history_horse_legacy_context')
  AND i.indrelid='public.hand_history'::regclass;
 IF valid IS DISTINCT FROM true OR ready IS DISTINCT FROM true
  OR regexp_replace(actual_definition,'\s+','','g') IS DISTINCT FROM
   regexp_replace($expected$CREATE INDEX idx_hand_history_horse_legacy_context ON public.hand_history USING gin (jsonb_path_query_array(players, '$[*]."userId"'::jsonpath) jsonb_path_ops, (ARRAY[game_variant,
CASE
    WHEN (tournament_id IS NULL) THEN 'cash'::text
    ELSE 'tournament'::text
END,
CASE
    WHEN (COALESCE((horse_exploit_dealt_count)::integer, jsonb_array_length(players)) <= 2) THEN 'hu'::text
    WHEN (COALESCE((horse_exploit_dealt_count)::integer, jsonb_array_length(players)) <= 5) THEN 'short'::text
    ELSE 'full'::text
END])) WHERE (NOT horse_exploit_recorded)$expected$,'\s+','','g') THEN
  RAISE EXCEPTION 'horse legacy context index missing, invalid or definition differs';
 END IF;
END $index_guard$;

CREATE OR REPLACE FUNCTION public.fn_horse_exploit_profiles_read(p_user_ids text[],p_variant text,p_mode text,p_size text)
RETURNS SETOF public.horse_exploit_profiles LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $fn$
DECLARE uid text; ready boolean; base jsonb; n integer;
BEGIN
 IF cardinality(p_user_ids)>10 OR cardinality(p_user_ids)<1 OR p_variant NOT IN ('nlh','plo4','plo5','plo6','plo8') OR p_mode NOT IN ('cash','tournament') OR p_size NOT IN ('hu','short','full') THEN
  RAISE EXCEPTION 'invalid opponent memory boundary' USING ERRCODE='22023';
 END IF;
 FOREACH uid IN ARRAY p_user_ids LOOP
  IF uid IS NULL OR uid !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'invalid opponent identity'; END IF;
 END LOOP;
 FOR uid IN SELECT DISTINCT x FROM unnest(p_user_ids)x ORDER BY x LOOP
  SELECT initialized INTO ready FROM public.horse_exploit_profiles WHERE user_id=uid AND variant=p_variant AND mode=p_mode AND size=p_size;
  IF NOT coalesce(ready,false) THEN
   -- Concurrent initializers may scan, but only the first initialization
   -- can win the guarded upsert below. No live row lock spans the scan.
   SELECT initialized INTO ready FROM public.horse_exploit_profiles WHERE user_id=uid AND variant=p_variant AND mode=p_mode AND size=p_size;
   IF NOT coalesce(ready,false) THEN
    base:='{"hands": 0, "vpip": 0, "pfr": 0, "rfiOpp": 0, "rfi": 0, "threeBetOpp": 0, "threeBet": 0, "foldTo3BetOpp": 0, "foldTo3Bet": 0, "betCheckedToOpp": 0, "betCheckedTo": 0, "foldToBetOpp": 0, "foldToBet": 0, "riverCallOpp": 0, "riverCall": 0, "fHands": 0, "fPfr": 0, "fRfiOpp": 0, "fRfi": 0, "fThreeBetOpp": 0, "fThreeBet": 0, "fBetCheckedToOpp": 0, "fBetCheckedTo": 0, "fFoldToBetOpp": 0, "fFoldToBet": 0, "fRiverCallOpp": 0, "fRiverCall": 0}'::jsonb; n:=0;
    -- Per-player horizon, no wall-clock expiry or floor-wide hand cap. The
    -- 1024-hand legacy tail bounds the omitted 30-hand decay below 2^-34;
    -- future profiles persist without truncation. Lifetime stats stay intact.
    -- Compute the exact same decayed sum in one bounded relational pass.
    -- Rebuilding a 27-field JSON object for every historical hand exceeded
    -- the 1500ms read budget on the hosted Linux runner. Preserve all 1024
    -- actual observations and both decay rates, but serialize JSON once.
    WITH recent AS MATERIALIZED (
     SELECT id,created_at,actions FROM public.hand_history
      WHERE NOT horse_exploit_recorded AND game_variant=p_variant
       AND (tournament_id IS NOT NULL)=(p_mode='tournament')
       AND (CASE WHEN coalesce(horse_exploit_dealt_count,jsonb_array_length(players))<=2 THEN 'hu' WHEN coalesce(horse_exploit_dealt_count,jsonb_array_length(players))<=5 THEN 'short' ELSE 'full' END)=p_size
       AND jsonb_path_query_array(players,'$[*].userId') @> jsonb_build_array(uid)
       AND ARRAY[game_variant,CASE WHEN tournament_id IS NULL THEN 'cash' ELSE 'tournament' END,CASE WHEN coalesce(horse_exploit_dealt_count,jsonb_array_length(players))<=2 THEN 'hu' WHEN coalesce(horse_exploit_dealt_count,jsonb_array_length(players))<=5 THEN 'short' ELSE 'full' END] @> ARRAY[p_variant,p_mode,p_size]
       AND players @> jsonb_build_array(jsonb_build_object('userId',uid))
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(actions) a
        WHERE a->>'userId'=uid AND a->>'action' IN ('fold','check','call','bet','raise','all_in'))
      ORDER BY created_at DESC,id DESC LIMIT 1024
    ), observations AS MATERIALIZED (
     SELECT public.fn_horse_exploit_increments(actions,uid)->uid AS inc,
      row_number() OVER(ORDER BY created_at DESC,id DESC)-1 AS age
     FROM recent
    ), weighted AS (
     SELECT f,sum(v::double precision * power(0.5::double precision,
      age::double precision/(CASE WHEN left(f,1)='f' AND f NOT IN ('foldToBet','foldToBetOpp','foldTo3Bet','foldTo3BetOpp') THEN 8 ELSE 30 END))) AS amount
     FROM observations obs CROSS JOIN LATERAL jsonb_each_text(obs.inc) fields(f,v)
     GROUP BY f
    )
    SELECT coalesce(jsonb_object_agg(f,amount),base),
      (SELECT count(*)::integer FROM observations obs WHERE obs.inc IS NOT NULL)
     INTO base,n FROM weighted;
    -- Concurrent accepted hands accumulated in counters during the scan.
    -- Discount historical mass by their count and combine under this UPDATE's
    -- short row lock. No GREATEST merge of decaying counters, no lost update.
    INSERT INTO public.horse_exploit_profiles(user_id,variant,mode,size,counters,initialized,legacy_hands)
     VALUES(uid,p_variant,p_mode,p_size,base,true,n)
    ON CONFLICT(user_id,variant,mode,size) DO UPDATE SET
     counters=public.fn_horse_exploit_add(base,horse_exploit_profiles.counters,horse_exploit_profiles.observed_hands),
     initialized=true,legacy_hands=n,updated_at=clock_timestamp()
     WHERE NOT horse_exploit_profiles.initialized;
   END IF;
  END IF;
 END LOOP;
 RETURN QUERY SELECT * FROM public.horse_exploit_profiles WHERE user_id=ANY(p_user_ids) AND variant=p_variant AND mode=p_mode AND size=p_size ORDER BY user_id;
END $fn$;

REVOKE ALL ON FUNCTION public.fn_horse_exploit_profiles_read(text[],text,text,text)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_horse_exploit_profiles_read(text[],text,text,text) TO service_role;
COMMIT;
