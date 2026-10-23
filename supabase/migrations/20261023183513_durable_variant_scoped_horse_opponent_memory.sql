-- @install-window: daily-maintenance
-- Durable public-action opponent memory. No cards, balances or scheduled repairs.
BEGIN;
SET LOCAL lock_timeout = '1s';
CREATE TABLE public.horse_exploit_profiles (
 user_id text NOT NULL, variant text NOT NULL CHECK (variant IN ('nlh','plo4','plo5','plo6','plo8')),
 mode text NOT NULL CHECK (mode IN ('cash','tournament')), size text NOT NULL CHECK(size IN ('hu','short','full')),
 counters jsonb NOT NULL DEFAULT '{"hands": 0, "vpip": 0, "pfr": 0, "rfiOpp": 0, "rfi": 0, "threeBetOpp": 0, "threeBet": 0, "foldTo3BetOpp": 0, "foldTo3Bet": 0, "betCheckedToOpp": 0, "betCheckedTo": 0, "foldToBetOpp": 0, "foldToBet": 0, "riverCallOpp": 0, "riverCall": 0, "fHands": 0, "fPfr": 0, "fRfiOpp": 0, "fRfi": 0, "fThreeBetOpp": 0, "fThreeBet": 0, "fBetCheckedToOpp": 0, "fBetCheckedTo": 0, "fFoldToBetOpp": 0, "fFoldToBet": 0, "fRiverCallOpp": 0, "fRiverCall": 0}'::jsonb,
 observed_hands bigint NOT NULL DEFAULT 0 CHECK(observed_hands>=0),
 initialized boolean NOT NULL DEFAULT false,
 legacy_hands integer NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,variant,mode,size)
);
ALTER TABLE public.horse_exploit_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.horse_exploit_profiles FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.horse_exploit_profiles TO service_role;
-- Old rows are distinguishable from every row accepted after installation,
-- including transactions that began before this migration. No timestamp guess.
ALTER TABLE public.hand_history ADD COLUMN horse_exploit_recorded boolean NOT NULL DEFAULT false;

CREATE FUNCTION public.fn_horse_exploit_add(p_base jsonb,p_delta jsonb,p_hands bigint DEFAULT 1)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public AS $fn$
 SELECT jsonb_object_agg(f,coalesce((p_base->>f)::double precision,0)*
 power(power(0.5::double precision,1.0/(CASE WHEN left(f,1)='f' AND f NOT IN ('foldToBet','foldToBetOpp','foldTo3Bet','foldTo3BetOpp') THEN 8 ELSE 30 END)),p_hands::double precision)
 +coalesce((p_delta->>f)::double precision,0)) FROM jsonb_object_keys('{"hands": 0, "vpip": 0, "pfr": 0, "rfiOpp": 0, "rfi": 0, "threeBetOpp": 0, "threeBet": 0, "foldTo3BetOpp": 0, "foldTo3Bet": 0, "betCheckedToOpp": 0, "betCheckedTo": 0, "foldToBetOpp": 0, "foldToBet": 0, "riverCallOpp": 0, "riverCall": 0, "fHands": 0, "fPfr": 0, "fRfiOpp": 0, "fRfi": 0, "fThreeBetOpp": 0, "fThreeBet": 0, "fBetCheckedToOpp": 0, "fBetCheckedTo": 0, "fFoldToBetOpp": 0, "fFoldToBet": 0, "fRiverCallOpp": 0, "fRiverCall": 0}'::jsonb) f
$fn$;

CREATE FUNCTION public.fn_horse_exploit_increments(p_actions jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,public AS $fn$
DECLARE a jsonb; r jsonb; result jsonb:='{}'; id text; act text; st text; ag boolean;
 raises integer:=0; opener text; bettor text; street text:='preflop';
 acted jsonb:='{}'; vp jsonb:='{}'; pf jsonb:='{}'; tb jsonb:='{}'; responded boolean:=false;
 field text; value integer; k text; v jsonb;
BEGIN
 IF jsonb_typeof(p_actions)<>'array' THEN RETURN result; END IF;
 FOR a IN SELECT x FROM jsonb_array_elements(p_actions) x LOOP
  id:=a->>'userId'; act:=a->>'action'; st:=a->>'stage';
  IF id IS NULL OR id='' OR act NOT IN ('fold','check','call','bet','raise','all_in') THEN CONTINUE; END IF;
  r:=coalesce(result->id,'{"hands": 0, "vpip": 0, "pfr": 0, "rfiOpp": 0, "rfi": 0, "threeBetOpp": 0, "threeBet": 0, "foldTo3BetOpp": 0, "foldTo3Bet": 0, "betCheckedToOpp": 0, "betCheckedTo": 0, "foldToBetOpp": 0, "foldToBet": 0, "riverCallOpp": 0, "riverCall": 0, "fHands": 0, "fPfr": 0, "fRfiOpp": 0, "fRfi": 0, "fThreeBetOpp": 0, "fThreeBet": 0, "fBetCheckedToOpp": 0, "fBetCheckedTo": 0, "fFoldToBetOpp": 0, "fFoldToBet": 0, "fRiverCallOpp": 0, "fRiverCall": 0}'::jsonb);
  r:=jsonb_set(r,'{hands}','1');
  ag:=act IN ('bet','raise') OR (act='all_in' AND a->>'isFullRaise'='true');
  IF st='preflop' THEN
   IF NOT acted ? id THEN
    acted:=acted||jsonb_build_object(id,true);
    IF raises=0 THEN
     r:=jsonb_set(r,'{rfiOpp}',to_jsonb((r->>'rfiOpp')::integer+1));
     IF ag THEN r:=jsonb_set(r,'{rfi}',to_jsonb((r->>'rfi')::integer+1)); END IF;
    END IF;
   END IF;
   IF raises=1 AND opener IS DISTINCT FROM id AND NOT tb ? id THEN
    tb:=tb||jsonb_build_object(id,true);
    r:=jsonb_set(r,'{threeBetOpp}',to_jsonb((r->>'threeBetOpp')::integer+1));
    IF ag THEN r:=jsonb_set(r,'{threeBet}',to_jsonb((r->>'threeBet')::integer+1)); END IF;
   END IF;
   IF raises>=2 AND opener=id AND NOT responded THEN
    responded:=true;
    r:=jsonb_set(r,'{foldTo3BetOpp}',to_jsonb((r->>'foldTo3BetOpp')::integer+1));
    IF act='fold' THEN r:=jsonb_set(r,'{foldTo3Bet}',to_jsonb((r->>'foldTo3Bet')::integer+1)); END IF;
   END IF;
   IF act IN ('call','bet','raise','all_in') AND NOT vp ? id THEN
    vp:=vp||jsonb_build_object(id,true); r:=jsonb_set(r,'{vpip}','1');
   END IF;
   IF ag THEN
    IF NOT pf ? id THEN pf:=pf||jsonb_build_object(id,true); r:=jsonb_set(r,'{pfr}','1'); END IF;
    IF raises=0 THEN opener:=id; END IF; raises:=raises+1;
   END IF;
  ELSIF st IN ('flop','turn','river') THEN
   IF st IS DISTINCT FROM street THEN street:=st; bettor:=NULL; END IF;
   IF bettor IS NULL THEN
    IF act<>'fold' THEN
     r:=jsonb_set(r,'{betCheckedToOpp}',to_jsonb((r->>'betCheckedToOpp')::integer+1));
     IF ag THEN r:=jsonb_set(r,'{betCheckedTo}',to_jsonb((r->>'betCheckedTo')::integer+1)); END IF;
    END IF;
   ELSIF bettor<>id THEN
    r:=jsonb_set(r,'{foldToBetOpp}',to_jsonb((r->>'foldToBetOpp')::integer+1));
    IF act='fold' THEN r:=jsonb_set(r,'{foldToBet}',to_jsonb((r->>'foldToBet')::integer+1)); END IF;
    IF st='river' THEN
     r:=jsonb_set(r,'{riverCallOpp}',to_jsonb((r->>'riverCallOpp')::integer+1));
     IF act<>'fold' THEN r:=jsonb_set(r,'{riverCall}',to_jsonb((r->>'riverCall')::integer+1)); END IF;
    END IF;
   END IF;
   IF ag THEN bettor:=id; END IF;
  END IF;
  result:=jsonb_set(result,ARRAY[id],r);
 END LOOP;
 FOR k,v IN SELECT * FROM jsonb_each(result) LOOP
  r:=v;
  r:=jsonb_set(r,'{fHands}',r->'hands');
  r:=jsonb_set(r,'{fPfr}',r->'pfr');
  r:=jsonb_set(r,'{fRfiOpp}',r->'rfiOpp');
  r:=jsonb_set(r,'{fRfi}',r->'rfi');
  r:=jsonb_set(r,'{fThreeBetOpp}',r->'threeBetOpp');
  r:=jsonb_set(r,'{fThreeBet}',r->'threeBet');
  r:=jsonb_set(r,'{fBetCheckedToOpp}',r->'betCheckedToOpp');
  r:=jsonb_set(r,'{fBetCheckedTo}',r->'betCheckedTo');
  r:=jsonb_set(r,'{fFoldToBetOpp}',r->'foldToBetOpp');
  r:=jsonb_set(r,'{fFoldToBet}',r->'foldToBet');
  r:=jsonb_set(r,'{fRiverCallOpp}',r->'riverCallOpp');
  r:=jsonb_set(r,'{fRiverCall}',r->'riverCall');
  result:=jsonb_set(result,ARRAY[k],r);
 END LOOP;
 RETURN result;
END $fn$;

CREATE FUNCTION public.fn_horse_exploit_accept_hand() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_mode text; v_size text; actor record;
BEGIN
 IF NEW.game_variant IS NULL OR NEW.game_variant NOT IN ('nlh','plo4','plo5','plo6','plo8') THEN RETURN NEW; END IF;
 v_mode:=CASE WHEN NEW.tournament_id IS NULL THEN 'cash' ELSE 'tournament' END;
 v_size:=CASE WHEN jsonb_array_length(NEW.players)<=2 THEN 'hu' WHEN jsonb_array_length(NEW.players)<=5 THEN 'short' ELSE 'full' END;
 -- Sorted lock acquisition protects simultaneous multi-table players.
 FOR actor IN SELECT * FROM jsonb_each(public.fn_horse_exploit_increments(NEW.actions)) ORDER BY key LOOP
  INSERT INTO public.horse_exploit_profiles(user_id,variant,mode,size,counters,observed_hands)
   VALUES(actor.key,NEW.game_variant,v_mode,v_size,actor.value,1)
  ON CONFLICT(user_id,variant,mode,size) DO UPDATE SET
   counters=public.fn_horse_exploit_add(horse_exploit_profiles.counters,excluded.counters),
   observed_hands=horse_exploit_profiles.observed_hands+1,updated_at=clock_timestamp();
 END LOOP;
 RETURN NEW;
END $fn$;
CREATE FUNCTION public.fn_horse_exploit_mark_hand() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN NEW.horse_exploit_recorded:=coalesce(NEW.game_variant IN ('nlh','plo4','plo5','plo6','plo8'),false); RETURN NEW; END $fn$;
CREATE TRIGGER horse_exploit_mark_hand BEFORE INSERT ON public.hand_history
 FOR EACH ROW EXECUTE FUNCTION public.fn_horse_exploit_mark_hand();
CREATE TRIGGER horse_exploit_accept_hand AFTER INSERT ON public.hand_history
 FOR EACH ROW EXECUTE FUNCTION public.fn_horse_exploit_accept_hand();

CREATE FUNCTION public.fn_horse_exploit_profiles_read(p_user_ids text[],p_variant text,p_mode text,p_size text)
RETURNS SETOF public.horse_exploit_profiles LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $fn$
DECLARE uid text; ready boolean; base jsonb; inc jsonb; h record; n integer;
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
    FOR h IN SELECT * FROM (
     SELECT id,created_at,actions FROM public.hand_history
      WHERE NOT horse_exploit_recorded AND game_variant=p_variant
       AND (tournament_id IS NOT NULL)=(p_mode='tournament')
       AND (CASE WHEN jsonb_array_length(players)<=2 THEN 'hu' WHEN jsonb_array_length(players)<=5 THEN 'short' ELSE 'full' END)=p_size
       AND players @> jsonb_build_array(jsonb_build_object('userId',uid))
      ORDER BY created_at DESC,id DESC LIMIT 1024
    ) recent ORDER BY created_at,id LOOP
     inc:=public.fn_horse_exploit_increments(h.actions)->uid;
     IF inc IS NOT NULL THEN base:=public.fn_horse_exploit_add(base,inc); n:=n+1; END IF;
    END LOOP;
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
REVOKE ALL ON FUNCTION public.fn_horse_exploit_add(jsonb,jsonb,bigint),public.fn_horse_exploit_increments(jsonb),public.fn_horse_exploit_accept_hand(),public.fn_horse_exploit_mark_hand(),public.fn_horse_exploit_profiles_read(text[],text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_exploit_add(jsonb,jsonb,bigint),public.fn_horse_exploit_increments(jsonb),public.fn_horse_exploit_profiles_read(text[],text,text,text) TO service_role;
COMMIT;
