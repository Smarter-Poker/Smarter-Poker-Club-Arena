-- @live-proof: to_regprocedure('public.fn_cash_game_attach_horse_arrivals(uuid,uuid,timestamptz,uuid[])') IS NOT NULL AND to_regclass('public.cash_game_horse_arrivals') IS NOT NULL AND to_regclass('public.cash_game_horse_releases') IS NOT NULL AND to_regprocedure('public.fn_cash_game_create_horse_arrivals(uuid,uuid,timestamptz,uuid[])') IS NOT NULL AND position('fn_cash_game_horse_arrival_admit' IN pg_get_functiondef('public.fn_ca_horse_roster_seat_guard()'::regprocedure))>0 AND position('horse_arrivals' IN pg_get_functiondef('public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)'::regprocedure))>0
-- Game-scoped ranked horse arrivals. Humans retain ordinary admission.
-- Reservation counts prospective buyers; arrival commits with the funded seat.
-- The existing seeding cycle and final admission guard share this contract.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
CREATE TABLE public.cash_game_horse_arrivals (
 game_id uuid PRIMARY KEY, policy_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 request_id uuid NOT NULL UNIQUE, created_by uuid NOT NULL,
 starts_at timestamptz NOT NULL, ranked_horse_ids uuid[] NOT NULL,
 reservation_epoch bigint NOT NULL DEFAULT 0,
 attachment_observation jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(cardinality(ranked_horse_ids)=20 AND array_position(ranked_horse_ids,NULL) IS NULL));
CREATE TABLE public.cash_game_horse_releases (
 game_id uuid NOT NULL, horse_id uuid NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 20),
 released_at timestamptz NOT NULL, PRIMARY KEY(game_id,horse_id), UNIQUE(game_id,ordinal));
CREATE TABLE public.cash_game_horse_reservations (
 game_id uuid NOT NULL, horse_id uuid NOT NULL, request_id uuid NOT NULL,
 PRIMARY KEY(game_id,horse_id));
CREATE TABLE public.cash_game_horse_release_requests (
 game_id uuid NOT NULL, request_id uuid NOT NULL, horse_ids uuid[] NOT NULL,
 result jsonb NOT NULL, PRIMARY KEY(game_id,request_id));
ALTER TABLE public.cash_game_horse_arrivals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_game_horse_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_game_horse_release_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_game_horse_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_game_horse_arrivals,public.cash_game_horse_releases,public.cash_game_horse_release_requests,public.cash_game_horse_reservations FROM PUBLIC,anon,authenticated,service_role;
-- No foreign keys to hot relations; no direct API writes, even service_role.

CREATE FUNCTION public.fn_cash_game_horse_arrival_snapshot(p_game_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.cash_game_horse_arrivals%ROWTYPE; ids uuid[]; reserved uuid[]; n integer;
 last_release timestamptz; due timestamptz; capacity integer:=0; now_at timestamptz:=clock_timestamp(); live boolean;
BEGIN
 SELECT * INTO p FROM public.cash_game_horse_arrivals WHERE game_id=p_game_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('game_id',p_game_id,'configured',false); END IF;
 SELECT coalesce(array_agg(horse_id ORDER BY ordinal),'{}'::uuid[]),count(*),max(released_at)
 INTO ids,n,last_release FROM public.cash_game_horse_releases WHERE game_id=p_game_id;
 SELECT coalesce(array_agg(horse_id ORDER BY array_position(p.ranked_horse_ids,horse_id)),'{}'::uuid[]) INTO reserved FROM public.cash_game_horse_reservations WHERE game_id=p_game_id;
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
 'released_ids',ids,'reserved_ids',reserved,'reservation_epoch',p.reservation_epoch,'ranked_horse_ids',p.ranked_horse_ids,
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

CREATE FUNCTION public.fn_cash_game_horse_arrival_reserve(p_game_id uuid,p_horse_ids uuid[],p_request_id uuid,p_expected_epoch bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.cash_game_horse_arrivals%ROWTYPE; snap jsonb; old_request public.cash_game_horse_release_requests%ROWTYPE;
 requested integer; result jsonb; reserved uuid[];
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
 IF p_expected_epoch IS DISTINCT FROM p.reservation_epoch THEN RAISE EXCEPTION 'ARRIVAL_RESERVATION_STALE'; END IF;
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
 SELECT coalesce(array_agg(horse_id ORDER BY array_position(p.ranked_horse_ids,horse_id)),'{}'::uuid[]) INTO reserved FROM public.cash_game_horse_reservations WHERE game_id=p_game_id;
 IF reserved IS DISTINCT FROM p_horse_ids THEN
  DELETE FROM public.cash_game_horse_reservations WHERE game_id=p_game_id;
  INSERT INTO public.cash_game_horse_reservations(game_id,horse_id,request_id)
   SELECT p_game_id,x,p_request_id FROM unnest(p_horse_ids) x;
  UPDATE public.cash_game_horse_arrivals SET reservation_epoch=reservation_epoch+1 WHERE game_id=p_game_id;
 END IF;
 result:=jsonb_build_object('version',1,'game',public.fn_cash_game_horse_arrival_snapshot(p_game_id),'reserved_now',p_horse_ids,'replayed',false);
 INSERT INTO public.cash_game_horse_release_requests VALUES(p_game_id,p_request_id,p_horse_ids,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.fn_cash_game_horse_arrival_reserve(uuid,uuid[],uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_horse_arrival_reserve(uuid,uuid[],uuid,bigint) TO service_role;

CREATE FUNCTION public.fn_cash_game_horse_arrival_admit(p_game_id uuid,p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.cash_game_horse_arrivals%ROWTYPE; snap jsonb; n integer;
BEGIN
 IF p_game_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_user_id AND is_horse) THEN RETURN; END IF;
 IF p_game_id='68c3d744-dba6-4de2-9db3-8c1beb711963'::uuid THEN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('horse-arrival-attach:'||p_game_id::text,0));
 END IF;
 -- Existing game/table ownership locks are acquired by the ordinary entry
 -- before this cold policy lock. Never acquire a game/table writer lock here.
 SELECT * INTO p FROM public.cash_game_horse_arrivals WHERE game_id=p_game_id FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM public.cash_game_horse_releases WHERE game_id=p_game_id AND horse_id=p_user_id) THEN RETURN; END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.cash_game_horse_reservations WHERE game_id=p_game_id AND horse_id=p_user_id)
 THEN RAISE EXCEPTION 'HORSE_NOT_RESERVED_FOR_GAME' USING ERRCODE='42501'; END IF;
 snap:=public.fn_cash_game_horse_arrival_snapshot(p_game_id);
 IF (snap->>'new_identity_capacity')::integer<1 THEN RAISE EXCEPTION 'HORSE_ARRIVAL_NOT_DUE'; END IF;
 SELECT count(*) INTO n FROM public.cash_game_horse_releases WHERE game_id=p_game_id;
 INSERT INTO public.cash_game_horse_releases VALUES(p_game_id,p_user_id,n+1,clock_timestamp());
 DELETE FROM public.cash_game_horse_reservations WHERE game_id=p_game_id AND horse_id=p_user_id;
 UPDATE public.cash_game_horse_arrivals SET reservation_epoch=reservation_epoch+1 WHERE game_id=p_game_id;
 -- A later guard, wallet refusal or transaction rollback rolls back this
 -- receipt too. Only the normal successful entry consumes the arrival.
END $$;
REVOKE ALL ON FUNCTION public.fn_cash_game_horse_arrival_admit(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Extend the existing trigger function, not a new writer-blocking hot trigger.
DO $patch$
DECLARE original text; anchor text:='  -- Diamond cash is a distinct asset, never inferred from a caller''s club id.';
BEGIN
 SELECT pg_get_functiondef('public.fn_ca_horse_roster_seat_guard()'::regprocedure) INTO original;
 IF md5(original)<>'b9889f2126961d526b195b21ea40bb4b' THEN RAISE EXCEPTION 'ARRIVAL_SEAT_GUARD_SOURCE_DRIFT'; END IF;
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
-- Attach the owner-selected roster to the existing funded game.
-- Preserve current seats; enforce the policy on new entries only.
CREATE FUNCTION public.fn_cash_game_attach_horse_arrivals(p_request_id uuid,p_game_id uuid,p_starts_at timestamptz,p_ranked_horse_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp SET lock_timeout='1s' SET statement_timeout='8s' AS $$
DECLARE actor uuid:=auth.uid(); p public.cash_game_horse_arrivals%ROWTYPE;
 g public.cash_games%ROWTYPE; marker jsonb; observation jsonb; selected_count integer;
BEGIN
 IF actor IS NULL OR NOT public.fn_caller_session_is_live() THEN RAISE EXCEPTION 'LIVE_SESSION_REQUIRED' USING ERRCODE='28000'; END IF;
 IF p_game_id IS DISTINCT FROM '68c3d744-dba6-4de2-9db3-8c1beb711963'::uuid
 OR p_request_id IS DISTINCT FROM '9e8059e6-40ae-462b-b02f-53ad4b514ac9'::uuid
 OR p_starts_at IS DISTINCT FROM '2026-10-28 20:00:00+00'::timestamptz
 OR coalesce(cardinality(p_ranked_horse_ids),0)<>20 OR array_position(p_ranked_horse_ids,NULL) IS NOT NULL
 OR (SELECT count(DISTINCT x) FROM unnest(p_ranked_horse_ids) x)<>20 THEN RAISE EXCEPTION 'ARRIVAL_INTENT_INVALID'; END IF;
 IF NOT public.fn_can_create_games('fade0000-0000-0000-0000-000000000001',actor) THEN RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE='42501'; END IF;
 IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN RAISE EXCEPTION 'ARRIVAL_ATTACHMENT_BUSY' USING ERRCODE='55P03'; END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN'; END IF;
 -- Every new horse entry to this exact target shares this lock, including
 -- entries that observed no policy. Refuse a busy attach; never queue a
 -- writer behind ongoing play or take game/table locks in a waiting cycle.
 IF NOT pg_try_advisory_xact_lock(hashtextextended('horse-arrival-attach:'||p_game_id::text,0)) THEN RAISE EXCEPTION 'ARRIVAL_ATTACHMENT_BUSY' USING ERRCODE='55P03'; END IF;
 SELECT * INTO g FROM public.cash_games WHERE id=p_game_id FOR UPDATE NOWAIT;
 IF NOT FOUND OR g.club_id IS DISTINCT FROM 'fade0000-0000-0000-0000-000000000001'::uuid
 OR g.union_id IS DISTINCT FROM 'fade0000-0000-0000-0000-000000000001'::uuid
 OR g.variant IS DISTINCT FROM 'plo5' OR g.sb IS DISTINCT FROM 2 OR g.bb IS DISTINCT FROM 5
 OR g.handedness IS DISTINCT FROM 6 OR g.template_name IS DISTINCT FROM 'classic'
 OR g.name IS DISTINCT FROM 'CHET''S GAME' OR g.must_move IS DISTINCT FROM true
 OR g.cluster_mode IS DISTINCT FROM 'must_move' OR g.lightning_enabled IS DISTINCT FROM false
 OR g.state IS DISTINCT FROM 'live' OR jsonb_typeof(g.ruleset_snapshot) IS DISTINCT FROM 'object'
 OR g.enabled IS DISTINCT FROM true OR g.closed_at IS NOT NULL THEN RAISE EXCEPTION 'ARRIVAL_TARGET_CHANGED'; END IF;
 PERFORM t.id FROM public.tables t WHERE t.cluster_id=p_game_id ORDER BY t.id FOR UPDATE NOWAIT;
 IF NOT EXISTS(SELECT 1 FROM public.tables t WHERE t.cluster_id=p_game_id AND coalesce(t.is_deleted,false)=false AND t.status IN ('waiting','running')) THEN RAISE EXCEPTION 'ARRIVAL_NO_ACTIVE_TABLE'; END IF;
 SELECT * INTO p FROM public.cash_game_horse_arrivals WHERE request_id=p_request_id OR game_id=p_game_id;
 IF FOUND THEN
  IF p.game_id<>p_game_id OR p.request_id<>p_request_id OR p.created_by<>actor OR p.starts_at<>p_starts_at OR p.ranked_horse_ids IS DISTINCT FROM p_ranked_horse_ids OR p.attachment_observation='{}'::jsonb THEN RAISE EXCEPTION 'ARRIVAL_REQUEST_MISMATCH'; END IF;
  RETURN jsonb_build_object('ok',true,'game_id',p.game_id,'horse_arrivals',jsonb_build_object('version',1,'policy_id',p.policy_id),'attachment_observation',p.attachment_observation,'replayed',true);
 END IF;
 IF g.ruleset_snapshot ? 'horse_arrivals' OR EXISTS(SELECT 1 FROM public.tables t WHERE t.cluster_id=p_game_id AND t.settings ? 'horse_arrivals') THEN RAISE EXCEPTION 'ARRIVAL_POLICY_SOURCE_MISMATCH'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(p_ranked_horse_ids) x WHERE NOT EXISTS(
 SELECT 1 FROM public.profiles h JOIN public.ca_horse_active_roster r ON r.horse_id=h.id
 JOIN public.ca_horse_fleet_register f ON f.horse_id=h.id AND f.retired_at IS NULL
 WHERE h.id=x AND h.is_horse AND coalesce(h.status,'active')='active' AND coalesce(h.horse_status,'available')<>'disabled')) THEN RAISE EXCEPTION 'HORSE_NO_LONGER_ELIGIBLE'; END IF;
 SELECT count(DISTINCT s.user_id) INTO selected_count FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id JOIN public.profiles h ON h.id=s.user_id
 WHERE t.cluster_id=p_game_id AND s.left_at IS NULL AND h.is_horse AND s.user_id=ANY(p_ranked_horse_ids);
 IF selected_count>4 THEN RAISE EXCEPTION 'ARRIVAL_EXISTING_SELECTED_EXCEED_INITIAL'; END IF;
 IF EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id JOIN public.profiles h ON h.id=s.user_id WHERE t.cluster_id=p_game_id AND s.left_at IS NULL AND h.is_horse AND s.user_id=ANY(p_ranked_horse_ids) AND (s.joined_at IS NULL OR s.joined_at>clock_timestamp())) THEN RAISE EXCEPTION 'ARRIVAL_EXISTING_ADMISSION_TIME_INVALID'; END IF;
 SELECT jsonb_build_object('mode','future_entries_only','attached_at',clock_timestamp(),'initial_selected_observed',selected_count,
 'preexisting_off_roster_seated_ids',coalesce(jsonb_agg(DISTINCT s.user_id) FILTER(WHERE h.is_horse AND NOT s.user_id=ANY(p_ranked_horse_ids)),'[]'::jsonb),
 'original_initial_four_verified',false) INTO observation FROM public.tables t LEFT JOIN public.table_seats s ON s.table_id=t.id AND s.left_at IS NULL LEFT JOIN public.profiles h ON h.id=s.user_id WHERE t.cluster_id=p_game_id;
 INSERT INTO public.cash_game_horse_arrivals(game_id,request_id,created_by,starts_at,ranked_horse_ids,attachment_observation)
 VALUES(p_game_id,p_request_id,actor,p_starts_at,p_ranked_horse_ids,observation) RETURNING * INTO p;
 -- These are observations of actual current selected seats, not new seating
 -- actions, backdated reservations, or release receipts for off-roster seats.
 INSERT INTO public.cash_game_horse_releases(game_id,horse_id,ordinal,released_at)
 SELECT p_game_id,x.user_id,row_number() OVER(ORDER BY x.joined_at,x.user_id)::integer,x.joined_at FROM (
 SELECT s.user_id,min(s.joined_at) AS joined_at FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id JOIN public.profiles h ON h.id=s.user_id
 WHERE t.cluster_id=p_game_id AND s.left_at IS NULL AND h.is_horse AND s.user_id=ANY(p_ranked_horse_ids) GROUP BY s.user_id) x;
 marker:=jsonb_build_object('version',1,'policy_id',p.policy_id);
 UPDATE public.cash_games SET ruleset_snapshot=ruleset_snapshot||jsonb_build_object('horse_arrivals',marker) WHERE id=p_game_id;
 UPDATE public.tables SET settings=coalesce(settings,'{}'::jsonb)||jsonb_build_object('horse_arrivals',marker) WHERE cluster_id=p_game_id;
 RETURN jsonb_build_object('ok',true,'game_id',p.game_id,'horse_arrivals',marker,'attachment_observation',observation,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.fn_cash_game_attach_horse_arrivals(uuid,uuid,timestamptz,uuid[]) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_attach_horse_arrivals(uuid,uuid,timestamptz,uuid[]) TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
