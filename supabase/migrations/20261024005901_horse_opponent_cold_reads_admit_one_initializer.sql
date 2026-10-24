-- Cold opponent-history reads must not starve dealing or arena access.
-- Production: 40 simultaneous cold RPCs waited on disk, only 4/3214 profiles
-- initialized, and arena access returned 503 or took up to 8842ms. The old
-- guarded UPSERT prevented double counting but did not prevent duplicate scans.
-- Preserve the exact 1024 actual observations, decay, permissions and atomic
-- merge with accepted hands. One database-wide initializer request is admitted
-- without waiting; busy requests fail explicitly through the existing optional
-- reader failure path. Warm profiles and accepted-hand writes remain available.
-- Re-grant the original service-only permission after emergency containment.
-- No hot-table DDL, data rewrite, engine replacement or new schedule.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $preimage$
BEGIN
 IF position('Concurrent initializers may scan' in pg_get_functiondef(
  'public.fn_horse_exploit_profiles_read(text[],text,text,text)'::regprocedure))=0 THEN
  RAISE EXCEPTION 'opponent memory reader preimage changed';
 END IF;
END $preimage$;
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
   -- A fleet cold start must not fan out into concurrent GIN history scans.
   -- Warm reads and accepted-hand recording never take this advisory lock.
   -- Refuse immediately rather than queue or hold a row used by live hands.
   IF NOT pg_try_advisory_xact_lock(hashtextextended('horse-opponent-legacy-initializer',0)) THEN
    RAISE EXCEPTION 'opponent memory initialization busy' USING ERRCODE='55P03';
   END IF;
   -- Another initializer may have committed since the first profile lookup.
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
REVOKE ALL ON FUNCTION public.fn_horse_exploit_profiles_read(text[],text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_horse_exploit_profiles_read(text[],text,text,text) TO service_role;
COMMIT;
