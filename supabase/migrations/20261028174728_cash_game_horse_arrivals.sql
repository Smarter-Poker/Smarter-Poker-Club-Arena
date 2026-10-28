-- @live-proof: to_regclass('public.cash_game_horse_arrivals') IS NOT NULL AND to_regclass('public.cash_game_horse_releases') IS NOT NULL AND to_regprocedure('public.fn_cash_game_create_horse_arrivals(uuid,uuid,timestamptz,uuid[])') IS NOT NULL AND position('fn_cash_game_horse_arrival_admit' IN pg_get_functiondef('public.fn_ca_horse_roster_seat_guard()'::regprocedure))>0 AND position('horse_arrivals' IN pg_get_functiondef('public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)'::regprocedure))>0
-- Game-scoped ranked horse arrivals. Humans retain ordinary admission.
-- Release means eligibility in the game pool, not a seat or wallet debit.
-- The existing seeding cycle and final admission guard share this contract.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
CREATE TABLE public.cash_game_horse_arrivals (
 game_id uuid PRIMARY KEY, policy_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 request_id uuid NOT NULL UNIQUE, created_by uuid NOT NULL,
 starts_at timestamptz NOT NULL, ranked_horse_ids uuid[] NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(cardinality(ranked_horse_ids)=20 AND array_position(ranked_horse_ids,NULL) IS NULL));
CREATE TABLE public.cash_game_horse_releases (
 game_id uuid NOT NULL, horse_id uuid NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 20),
 released_at timestamptz NOT NULL, PRIMARY KEY(game_id,horse_id), UNIQUE(game_id,ordinal));
CREATE TABLE public.cash_game_horse_release_requests (
 game_id uuid NOT NULL, request_id uuid NOT NULL, horse_ids uuid[] NOT NULL,
 result jsonb NOT NULL, PRIMARY KEY(game_id,request_id));
ALTER TABLE public.cash_game_horse_arrivals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_game_horse_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_game_horse_release_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_game_horse_arrivals,public.cash_game_horse_releases,public.cash_game_horse_release_requests FROM PUBLIC,anon,authenticated,service_role;
-- No foreign keys to hot relations; no direct API writes, even service_role.

CREATE FUNCTION public.fn_cash_game_horse_arrival_snapshot(p_game_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.cash_game_horse_arrivals%ROWTYPE; ids uuid[]; n integer;
 last_release timestamptz; due timestamptz; capacity integer:=0; now_at timestamptz:=clock_timestamp(); live boolean;
BEGIN
 SELECT * INTO p FROM public.cash_game_horse_arrivals WHERE game_id=p_game_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('game_id',p_game_id,'configured',false); END IF;
 SELECT coalesce(array_agg(horse_id ORDER BY ordinal),'{}'::uuid[]),count(*),max(released_at)
 INTO ids,n,last_release FROM public.cash_game_horse_releases WHERE game_id=p_game_id;
 SELECT enabled AND closed_at IS NULL INTO live FROM public.cash_games WHERE id=p_game_id;
 IF n<4 THEN
   due:=greatest(p.starts_at,last_release);
   IF live AND now_at>=due THEN capacity:=4-n; END IF;
 ELSIF n<20 THEN
   due:=greatest(p.starts_at+make_interval(secs=>600*(n-3)),last_release+interval '10 minutes');
   IF live AND now_at>=due THEN capacity:=1; END IF;
 ELSE due:=NULL; END IF;
 RETURN jsonb_build_object('version',1,'game_id',p_game_id,'configured',true,
 'policy_id',p.policy_id,'starts_at',p.starts_at,'initial_count',4,'interval_seconds',600,'max_horses',20,
 'released_ids',ids,'ranked_horse_ids',p.ranked_horse_ids,
 'ranked_unreleased_ids',ARRAY(SELECT x FROM unnest(p.ranked_horse_ids) x WHERE NOT x=ANY(ids)),
 'new_identity_capacity',capacity,'next_allowed_at',due,'server_now',now_at);
END $$;
REVOKE ALL ON FUNCTION public.fn_cash_game_horse_arrival_snapshot(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_cash_game_horse_arrival_snapshots(p_game_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'ENGINE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF coalesce(cardinality(p_game_ids),0)>100 THEN RAISE EXCEPTION 'ARRIVAL_BATCH_TOO_LARGE'; END IF;
 RETURN jsonb_build_object('version',1,'complete',true,'games',coalesce(
 (SELECT jsonb_agg(public.fn_cash_game_horse_arrival_snapshot(x))
 FROM (SELECT DISTINCT unnest(p_game_ids) x) s),'[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.fn_cash_game_horse_arrival_snapshots(uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_horse_arrival_snapshots(uuid[]) TO service_role;

CREATE FUNCTION public.fn_cash_game_horse_arrival_release(p_game_id uuid,p_horse_ids uuid[],p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.cash_game_horse_arrivals%ROWTYPE; snap jsonb; old_request public.cash_game_horse_release_requests%ROWTYPE;
 h uuid; n integer; requested integer; result jsonb; now_at timestamptz;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'ENGINE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'ARRIVAL_REQUEST_REQUIRED'; END IF;
 SELECT * INTO p FROM public.cash_game_horse_arrivals WHERE game_id=p_game_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ARRIVAL_POLICY_MISSING'; END IF;
 SELECT * INTO old_request FROM public.cash_game_horse_release_requests WHERE game_id=p_game_id AND request_id=p_request_id;
 IF FOUND THEN
  IF old_request.horse_ids IS DISTINCT FROM p_horse_ids THEN RAISE EXCEPTION 'ARRIVAL_REQUEST_MISMATCH'; END IF;
  RETURN old_request.result || jsonb_build_object('game',public.fn_cash_game_horse_arrival_snapshot(p_game_id),'replayed',true);
 END IF;
 requested:=coalesce(cardinality(p_horse_ids),0);
 IF requested<1 OR requested>4 OR array_position(p_horse_ids,NULL) IS NOT NULL
 OR (SELECT count(DISTINCT x) FROM unnest(p_horse_ids) x)<>requested THEN RAISE EXCEPTION 'ARRIVAL_IDS_INVALID'; END IF;
 IF NOT p_horse_ids <@ p.ranked_horse_ids THEN RAISE EXCEPTION 'HORSE_NOT_ON_GAME_ROSTER' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM public.cash_game_horse_releases WHERE game_id=p_game_id AND horse_id=ANY(p_horse_ids))
 THEN RAISE EXCEPTION 'ARRIVAL_ALREADY_RELEASED'; END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN'; END IF;
 snap:=public.fn_cash_game_horse_arrival_snapshot(p_game_id);
 IF requested>(snap->>'new_identity_capacity')::integer THEN RAISE EXCEPTION 'HORSE_ARRIVAL_NOT_DUE'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(p_horse_ids) x WHERE NOT EXISTS(
 SELECT 1 FROM public.profiles h JOIN public.ca_horse_active_roster r ON r.horse_id=h.id
 JOIN public.ca_horse_fleet_register f ON f.horse_id=h.id AND f.retired_at IS NULL
 WHERE h.id=x AND h.is_horse AND coalesce(h.status,'active')='active' AND coalesce(h.horse_status,'available')<>'disabled'))
 THEN RAISE EXCEPTION 'HORSE_NO_LONGER_ELIGIBLE'; END IF;
 SELECT count(*) INTO n FROM public.cash_game_horse_releases WHERE game_id=p_game_id;
 now_at:=clock_timestamp();
 FOREACH h IN ARRAY p_horse_ids LOOP
  n:=n+1; INSERT INTO public.cash_game_horse_releases VALUES(p_game_id,h,n,now_at);
 END LOOP;
 result:=jsonb_build_object('version',1,'game',public.fn_cash_game_horse_arrival_snapshot(p_game_id),'released_now',p_horse_ids,'replayed',false);
 INSERT INTO public.cash_game_horse_release_requests VALUES(p_game_id,p_request_id,p_horse_ids,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.fn_cash_game_horse_arrival_release(uuid,uuid[],uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_horse_arrival_release(uuid,uuid[],uuid) TO service_role;

CREATE FUNCTION public.fn_cash_game_horse_arrival_admit(p_game_id uuid,p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_game_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_user_id AND is_horse) THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.cash_game_horse_arrivals WHERE game_id=p_game_id) THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.cash_game_horse_releases WHERE game_id=p_game_id AND horse_id=p_user_id)
 THEN RAISE EXCEPTION 'HORSE_NOT_RELEASED_FOR_GAME' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.fn_cash_game_horse_arrival_admit(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Extend the existing trigger function, not a new writer-blocking hot trigger.
DO $patch$
DECLARE original text; anchor text:='  -- Diamond cash is a distinct asset, never inferred from a caller''s club id.';
BEGIN
 SELECT pg_get_functiondef('public.fn_ca_horse_roster_seat_guard()'::regprocedure) INTO original;
 IF position(anchor IN original)=0 THEN RAISE EXCEPTION 'ARRIVAL_SEAT_GUARD_SOURCE_DRIFT'; END IF;
 EXECUTE replace(original,anchor,'  PERFORM public.fn_cash_game_horse_arrival_admit((SELECT cluster_id FROM public.tables WHERE id=NEW.table_id),NEW.user_id);'||chr(10)||anchor);
END $patch$;
DO $patch$
DECLARE original text; anchor text:='  RETURN v_table_id;';
BEGIN
 SELECT pg_get_functiondef('public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)'::regprocedure) INTO original;
 IF position(anchor IN original)=0 THEN RAISE EXCEPTION 'ARRIVAL_OPEN_TABLE_SOURCE_DRIFT'; END IF;
 EXECUTE replace(original,anchor,'  IF g.ruleset_snapshot ? ''horse_arrivals'' THEN
 UPDATE public.tables SET settings=coalesce(settings,''{}''::jsonb)||jsonb_build_object(''horse_arrivals'',g.ruleset_snapshot->''horse_arrivals'') WHERE id=v_table_id;
 END IF;
'||anchor);
END $patch$;

CREATE FUNCTION public.fn_cash_game_create_horse_arrivals(p_request_id uuid,p_club_id uuid,p_starts_at timestamptz,p_ranked_horse_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=auth.uid(); p public.cash_game_horse_arrivals%ROWTYPE; created jsonb; game uuid; marker jsonb;
BEGIN
 IF actor IS NULL OR NOT public.fn_caller_session_is_live() THEN RAISE EXCEPTION 'LIVE_SESSION_REQUIRED' USING ERRCODE='28000'; END IF;
 IF p_club_id IS DISTINCT FROM 'fade0000-0000-0000-0000-000000000001'::uuid OR NOT public.fn_can_create_games(p_club_id,actor)
 THEN RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE='42501'; END IF;
 IF p_request_id IS NULL OR p_starts_at IS DISTINCT FROM '2026-10-28 20:00:00+00'::timestamptz
 OR coalesce(cardinality(p_ranked_horse_ids),0)<>20 OR array_position(p_ranked_horse_ids,NULL) IS NOT NULL
 OR (SELECT count(DISTINCT x) FROM unnest(p_ranked_horse_ids) x)<>20 THEN RAISE EXCEPTION 'ARRIVAL_INTENT_INVALID'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('horse-arrival-create:'||p_request_id::text,0));
 SELECT * INTO p FROM public.cash_game_horse_arrivals WHERE request_id=p_request_id;
 IF FOUND THEN
  IF p.created_by<>actor OR p.starts_at<>p_starts_at OR p.ranked_horse_ids IS DISTINCT FROM p_ranked_horse_ids THEN RAISE EXCEPTION 'ARRIVAL_REQUEST_MISMATCH'; END IF;
  RETURN jsonb_build_object('ok',true,'game_id',p.game_id,'replayed',true);
 END IF;
 IF EXISTS(SELECT 1 FROM unnest(p_ranked_horse_ids) x WHERE NOT EXISTS(
 SELECT 1 FROM public.profiles h JOIN public.ca_horse_active_roster r ON r.horse_id=h.id
 JOIN public.ca_horse_fleet_register f ON f.horse_id=h.id AND f.retired_at IS NULL
 WHERE h.id=x AND h.is_horse AND coalesce(h.status,'active')='active' AND coalesce(h.horse_status,'available')<>'disabled'))
 THEN RAISE EXCEPTION 'HORSE_NO_LONGER_ELIGIBLE'; END IF;
 -- The original creator still owns session, operating-access, duplicate,
 -- maintenance, ruleset and Lightning conversion safeguards.
 created:=public.fn_cash_game_create(p_club_id,'madness','plo5',2,5,6,'{}'::jsonb,NULL,true);
 game:=(created->>'game_id')::uuid;
 IF game IS NULL THEN RAISE EXCEPTION 'ARRIVAL_CREATE_NO_GAME'; END IF;
 INSERT INTO public.cash_game_horse_arrivals(game_id,request_id,created_by,starts_at,ranked_horse_ids)
 VALUES(game,p_request_id,actor,p_starts_at,p_ranked_horse_ids) RETURNING * INTO p;
 marker:=jsonb_build_object('version',1,'policy_id',p.policy_id);
 UPDATE public.cash_games SET ruleset_snapshot=ruleset_snapshot||jsonb_build_object('horse_arrivals',marker) WHERE id=game;
 UPDATE public.tables SET settings=coalesce(settings,'{}'::jsonb)||jsonb_build_object('horse_arrivals',marker) WHERE cluster_id=game;
 RETURN created||jsonb_build_object('horse_arrivals',marker,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.fn_cash_game_create_horse_arrivals(uuid,uuid,timestamptz,uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_create_horse_arrivals(uuid,uuid,timestamptz,uuid[]) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
