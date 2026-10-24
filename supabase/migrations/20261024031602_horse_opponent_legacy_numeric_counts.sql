-- Version reserved by scripts/new-migration.mjs as 20261024031602.
-- Inherited Linux qualification exceeded the unchanged 1500ms full-ten-player
-- read budget. Avoid serializing and immediately parsing 27 JSON fields for
-- every historical observation. The private parser returns its identical 15
-- integer counters; only the final weighted result is serialized. Preserve all
-- 1024 observations, actor/context eligibility, both decay rates, concurrency,
-- service-only reader access and the original accepted-hand parser/API.
-- No original migration replay, hand/seat/wallet writes or context truncation.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';

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

CREATE FUNCTION public.fn_horse_exploit_actor_counts(p_actions jsonb,p_actor text)
RETURNS integer[] LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $fn$
DECLARE a record; c integer[]:=array_fill(0,ARRAY[15]); ag boolean;
 raises integer:=0; opener text; bettor text; street text:='preflop';
 acted boolean:=false; vp boolean:=false; pf boolean:=false; tb boolean:=false;
 responded boolean:=false; seen boolean:=false;
BEGIN
 IF p_actor IS NULL OR jsonb_typeof(p_actions)<>'array' THEN RETURN NULL; END IF;
 FOR a IN SELECT x.* FROM jsonb_to_recordset(
  jsonb_path_query_array(p_actions,'$[*] ? (@.type() == "object")')
 ) x("userId" text,action text,stage text,"isFullRaise" text) LOOP
  IF a."userId" IS NULL OR a."userId"='' OR a.action NOT IN ('fold','check','call','bet','raise','all_in') THEN CONTINUE; END IF;
  ag:=a.action IN ('bet','raise') OR (a.action='all_in' AND a."isFullRaise"='true');
  IF a."userId"<>p_actor THEN
   IF a.stage='preflop' AND ag THEN
    IF raises=0 THEN opener:=a."userId"; END IF; raises:=raises+1;
   ELSIF a.stage IN ('flop','turn','river') THEN
    IF a.stage IS DISTINCT FROM street THEN street:=a.stage; bettor:=NULL; END IF;
    IF ag THEN bettor:=a."userId"; END IF;
   END IF;
   CONTINUE;
  END IF;
  seen:=true; c[1]:=1;
  IF a.stage='preflop' THEN
   IF NOT acted THEN
    acted:=true;
    IF raises=0 THEN c[4]:=c[4]+1; IF ag THEN c[5]:=c[5]+1; END IF; END IF;
   END IF;
   IF raises=1 AND opener IS DISTINCT FROM p_actor AND NOT tb THEN
    tb:=true; c[6]:=c[6]+1; IF ag THEN c[7]:=c[7]+1; END IF;
   END IF;
   IF raises>=2 AND opener=p_actor AND NOT responded THEN
    responded:=true; c[8]:=c[8]+1; IF a.action='fold' THEN c[9]:=c[9]+1; END IF;
   END IF;
   IF a.action IN ('call','bet','raise','all_in') AND NOT vp THEN vp:=true; c[2]:=1; END IF;
   IF ag THEN
    IF NOT pf THEN pf:=true; c[3]:=1; END IF;
    IF raises=0 THEN opener:=p_actor; END IF; raises:=raises+1;
   END IF;
  ELSIF a.stage IN ('flop','turn','river') THEN
   IF a.stage IS DISTINCT FROM street THEN street:=a.stage; bettor:=NULL; END IF;
   IF bettor IS NULL THEN
    IF a.action<>'fold' THEN c[10]:=c[10]+1; IF ag THEN c[11]:=c[11]+1; END IF; END IF;
   ELSIF bettor<>p_actor THEN
    c[12]:=c[12]+1; IF a.action='fold' THEN c[13]:=c[13]+1; END IF;
    IF a.stage='river' THEN c[14]:=c[14]+1; IF a.action<>'fold' THEN c[15]:=c[15]+1; END IF; END IF;
   END IF;
   IF ag THEN bettor:=p_actor; END IF;
  END IF;
 END LOOP;
 IF NOT seen THEN RETURN NULL; END IF;
 RETURN c;
END $fn$;

REVOKE ALL ON FUNCTION public.fn_horse_exploit_actor_counts(jsonb,text) FROM PUBLIC,anon,authenticated,service_role;

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
     SELECT public.fn_horse_exploit_actor_counts(actions,uid) AS inc,
      row_number() OVER(ORDER BY created_at DESC,id DESC)-1 AS age
     FROM recent
    ), decayed AS MATERIALIZED (
     -- The two rates depend only on observation age, never on counter name.
     -- Evaluate them once per observation instead of once per JSON field.
     SELECT inc,power(0.5::double precision,age::double precision/8) AS fast_weight,
      power(0.5::double precision,age::double precision/30) AS slow_weight
     FROM observations
    ), weighted AS (
     SELECT f,sum(v::double precision *
      (CASE WHEN fast THEN fast_weight ELSE slow_weight END)) AS amount
     FROM decayed obs CROSS JOIN LATERAL (VALUES
      ('hands',obs.inc[1],false),
      ('vpip',obs.inc[2],false),
      ('pfr',obs.inc[3],false),
      ('rfiOpp',obs.inc[4],false),
      ('rfi',obs.inc[5],false),
      ('threeBetOpp',obs.inc[6],false),
      ('threeBet',obs.inc[7],false),
      ('foldTo3BetOpp',obs.inc[8],false),
      ('foldTo3Bet',obs.inc[9],false),
      ('betCheckedToOpp',obs.inc[10],false),
      ('betCheckedTo',obs.inc[11],false),
      ('foldToBetOpp',obs.inc[12],false),
      ('foldToBet',obs.inc[13],false),
      ('riverCallOpp',obs.inc[14],false),
      ('riverCall',obs.inc[15],false),
      ('fHands',obs.inc[1],true),
      ('fPfr',obs.inc[3],true),
      ('fRfiOpp',obs.inc[4],true),
      ('fRfi',obs.inc[5],true),
      ('fThreeBetOpp',obs.inc[6],true),
      ('fThreeBet',obs.inc[7],true),
      ('fBetCheckedToOpp',obs.inc[10],true),
      ('fBetCheckedTo',obs.inc[11],true),
      ('fFoldToBetOpp',obs.inc[12],true),
      ('fFoldToBet',obs.inc[13],true),
      ('fRiverCallOpp',obs.inc[14],true),
      ('fRiverCall',obs.inc[15],true)
     ) fields(f,v,fast) WHERE obs.inc IS NOT NULL
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
