-- Version reserved by scripts/new-migration.mjs.
-- Original-request durable memory: one nonblocking cold actor, exact horizon.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';

-- Bounded cold work depends on the already installed exact context index.
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

-- Project four actor fields without copying retained publicNode payloads.
-- Mixed/malformed arrays retain the original object-filter semantics.
CREATE OR REPLACE FUNCTION public.fn_horse_exploit_actor_increments(p_actions jsonb,p_actor text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $fn$
DECLARE a record; c integer[]:=array_fill(0,ARRAY[15]); ag boolean;
 raises integer:=0; opener text; bettor text; street text:='preflop';
 acted boolean:=false; vp boolean:=false; pf boolean:=false; tb boolean:=false;
 responded boolean:=false; seen boolean:=false;
BEGIN
 IF p_actor IS NULL OR jsonb_typeof(p_actions)<>'array' THEN RETURN '{}'::jsonb; END IF;
 FOR a IN SELECT x.* FROM jsonb_to_recordset(
  CASE WHEN jsonb_path_exists(p_actions,'strict $[*] ? (@.type() != "object")')
   THEN jsonb_path_query_array(p_actions,'$[*] ? (@.type() == "object")')
   ELSE p_actions END
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
 IF NOT seen THEN RETURN '{}'::jsonb; END IF;
 RETURN jsonb_build_object(p_actor,jsonb_build_object(
  'hands',c[1],
  'vpip',c[2],
  'pfr',c[3],
  'rfiOpp',c[4],
  'rfi',c[5],
  'threeBetOpp',c[6],
  'threeBet',c[7],
  'foldTo3BetOpp',c[8],
  'foldTo3Bet',c[9],
  'betCheckedToOpp',c[10],
  'betCheckedTo',c[11],
  'foldToBetOpp',c[12],
  'foldToBet',c[13],
  'riverCallOpp',c[14],
  'riverCall',c[15],
  'fHands',c[1],
  'fPfr',c[3],
  'fRfiOpp',c[4],
  'fRfi',c[5],
  'fThreeBetOpp',c[6],
  'fThreeBet',c[7],
  'fBetCheckedToOpp',c[10],
  'fBetCheckedTo',c[11],
  'fFoldToBetOpp',c[12],
  'fFoldToBet',c[13],
  'fRiverCallOpp',c[14],
  'fRiverCall',c[15]));
END $fn$;


CREATE OR REPLACE FUNCTION public.fn_horse_exploit_profiles_read(p_user_ids text[],p_variant text,p_mode text,p_size text)
RETURNS SETOF public.horse_exploit_profiles LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $fn$
DECLARE uid text; ready boolean; base jsonb; n integer; cold_attempted boolean:=false;
BEGIN
 IF cardinality(p_user_ids)>10 OR cardinality(p_user_ids)<1 OR p_variant NOT IN ('nlh','plo4','plo5','plo6','plo8') OR p_mode NOT IN ('cash','tournament') OR p_size NOT IN ('hu','short','full') THEN
  RAISE EXCEPTION 'invalid opponent memory boundary' USING ERRCODE='22023';
 END IF;
 FOREACH uid IN ARRAY p_user_ids LOOP
  IF uid IS NULL OR uid !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'invalid opponent identity'; END IF;
 END LOOP;
 FOR uid IN SELECT DISTINCT x FROM unnest(p_user_ids)x ORDER BY x LOOP
  SELECT initialized INTO ready FROM public.horse_exploit_profiles WHERE user_id=uid AND variant=p_variant AND mode=p_mode AND size=p_size;
  IF NOT coalesce(ready,false) AND NOT cold_attempted THEN
   -- One full legacy actor per original request. A nonblocking global owner
   -- prevents cross-process/restart cold-start herds; known rows remain usable.
   cold_attempted:=true;
   IF NOT pg_try_advisory_xact_lock(hashtextextended('horse-opponent-legacy-initialization-v1',0)) THEN
    EXIT;
   END IF;
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

REVOKE ALL ON FUNCTION public.fn_horse_exploit_actor_increments(jsonb,text)
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_horse_exploit_profiles_read(text[],text,text,text)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_horse_exploit_profiles_read(text[],text,text,text) TO service_role;
COMMIT;
