-- Reserved 2026-09-14 05:33:55 UTC. Automatic learner intake has no durable
-- producer. Discover bounded retained atomic-hand rosters, freeze novel actors
-- and admit at most32 against the ORIGINAL parent window per step. No hand,
-- wallet, projection-outbox or policy writer is modified. Periodic overlap
-- does not establish complete observation-time coverage or causal authority.
-- UNAPPLIED: native/throughput/security verification required before promotion.
BEGIN;
SET LOCAL lock_timeout='2s';
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_admit_horse_observation_capture(uuid,bigint,bigint)'::regprocedure)
    IS DISTINCT FROM '750a6371fcb52ec3b0b8b4c5d597de91' THEN
    RAISE EXCEPTION 'HORSE_DISCOVERY_ADMISSION_PREIMAGE_CHANGED';
  END IF;
END
$guard$;
CREATE TABLE public.horse_observation_discovery_epochs (
  epoch_key text PRIMARY KEY CHECK(epoch_key ~ '^[a-f0-9]{64}$'),
  from_ms bigint NOT NULL CHECK(from_ms>=0), through_ms bigint NOT NULL UNIQUE,
  cursor_ms bigint NOT NULL, slice_through_ms bigint NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','discovered','gap')),
  segments integer NOT NULL DEFAULT 0 CHECK(segments BETWEEN 0 AND 2048),
  actors integer NOT NULL DEFAULT 0 CHECK(actors BETWEEN 0 AND 8192),
  evidence_bytes integer NOT NULL DEFAULT 0 CHECK(evidence_bytes BETWEEN 0 AND 2097152),
  failures integer NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 6),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
  previous_through_ms bigint, skipped_epochs integer NOT NULL DEFAULT 0 CHECK(skipped_epochs>=0),
  reason text,
  CHECK(through_ms>from_ms AND through_ms-from_ms<=21600000 AND through_ms<=9007199254740991),
  CHECK(cursor_ms BETWEEN from_ms AND through_ms AND slice_through_ms BETWEEN cursor_ms AND through_ms),
  CHECK(state='pending' OR finished_at IS NOT NULL),
  CHECK(state<>'discovered' OR (cursor_ms=through_ms AND slice_through_ms=through_ms))
);
CREATE UNIQUE INDEX horse_discovery_one_pending ON public.horse_observation_discovery_epochs((state)) WHERE state='pending';
CREATE INDEX horse_discovery_retention ON public.horse_observation_discovery_epochs(finished_at,epoch_key) WHERE state='discovered';
CREATE TABLE public.horse_observation_discovery_segments (
  epoch_key text NOT NULL REFERENCES public.horse_observation_discovery_epochs(epoch_key),
  from_ms bigint NOT NULL, through_ms bigint NOT NULL CHECK(through_ms>from_ms),
  snapshot_id text NOT NULL CHECK(octet_length(snapshot_id)<=8192),
  read_at_ms bigint NOT NULL, source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
  hands integer NOT NULL CHECK(hands BETWEEN 0 AND 512),
  source_actors integer NOT NULL CHECK(source_actors BETWEEN 0 AND 5120),
  actor_digest text NOT NULL CHECK(actor_digest ~ '^[a-f0-9]{64}$'),
  novel_actors uuid[] NOT NULL CHECK(cardinality(novel_actors)<=5120),
  admitted_actors integer NOT NULL DEFAULT 0 CHECK(admitted_actors BETWEEN 0 AND cardinality(novel_actors)),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(epoch_key,from_ms)
);
CREATE TABLE public.horse_observation_discovery_members (
  epoch_key text NOT NULL REFERENCES public.horse_observation_discovery_epochs(epoch_key),
  actor_id uuid NOT NULL,
  request_key text NOT NULL CHECK(request_key ~ '^[a-f0-9]{64}$'),
  source_from_ms bigint NOT NULL, admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(epoch_key,actor_id)
);
ALTER TABLE public.horse_observation_discovery_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.horse_observation_discovery_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.horse_observation_discovery_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.horse_observation_discovery_epochs,public.horse_observation_discovery_segments,public.horse_observation_discovery_members FROM PUBLIC,anon,authenticated,service_role;

-- Private formatting helper; only the definer below may expose scoped state.
CREATE FUNCTION public.fn_horse_discovery_state(p_key text,p_status text,p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO pg_catalog,public,pg_temp
AS $function$
  SELECT jsonb_build_object('version',1,'status',p_status,'epochKey',e.epoch_key,
    'fromMs',e.from_ms,'throughMs',e.through_ms,'cursorMs',e.cursor_ms,'sliceThroughMs',e.slice_through_ms,
    'state',e.state,'segments',e.segments,'actors',e.actors,'skippedEpochs',e.skipped_epochs,
    'reason',p_reason,'sourceCoverage','not_established',
    'retainedGaps',(SELECT count(*) FROM (SELECT 1 FROM public.horse_observation_discovery_epochs WHERE state='gap' LIMIT 129) g))
  FROM public.horse_observation_discovery_epochs e WHERE e.epoch_key=p_key;
$function$;
REVOKE ALL ON FUNCTION public.fn_horse_discovery_state(text,text,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_discover_horse_observation_requests()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp SET lock_timeout TO '2s'
AS $function$
DECLARE e public.horse_observation_discovery_epochs%ROWTYPE;
  s public.horse_observation_discovery_segments%ROWTYPE;
  at_ms bigint:=floor(extract(epoch FROM statement_timestamp())*1000)::bigint;
  end_ms bigint; start_ms bigint; previous_end bigint; key text; width bigint;
  n integer; bytes bigint; bad boolean; missing boolean; actor_ids uuid[]; novel uuid[];
  source_hash text; actor_hash text; snapshot text; source_read_ms bigint; ack jsonb; v_actor uuid; request text;
  processed integer:=0; inserted integer; total integer; occupied integer; evidence_size integer;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('horse-discovery-step-v1',0)) THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','discovery_busy');
  END IF;
  SELECT * INTO e FROM public.horse_observation_discovery_epochs WHERE state='pending' FOR UPDATE;
  IF NOT FOUND THEN
    end_ms:=(at_ms/18000000)*18000000-60000; start_ms:=end_ms-21600000;
    SELECT through_ms INTO previous_end FROM public.horse_observation_discovery_epochs ORDER BY through_ms DESC LIMIT 1;
    SELECT count(*) INTO n FROM (SELECT 1 FROM public.horse_observation_discovery_epochs WHERE state='gap' LIMIT 129) q;
    IF previous_end IS NOT NULL AND end_ms<=previous_end THEN
      RETURN jsonb_build_object('version',1,'status','idle','retainedGaps',n);
    END IF;
    IF n>=128 THEN RETURN jsonb_build_object('version',1,'status','unavailable','reason','gap_budget_exceeded'); END IF;
    SELECT count(*) INTO n FROM (SELECT 1 FROM public.horse_observation_discovery_epochs LIMIT 513) q;
    IF n>=512 THEN RETURN jsonb_build_object('version',1,'status','unavailable','reason','retention_backlog'); END IF;
    key:=encode(sha256(convert_to(concat_ws('|','horse-discovery-v1',start_ms::text,end_ms::text),'UTF8')),'hex');
    INSERT INTO public.horse_observation_discovery_epochs(epoch_key,from_ms,through_ms,cursor_ms,slice_through_ms,previous_through_ms,skipped_epochs)
      VALUES(key,start_ms,end_ms,start_ms,end_ms,previous_end,
        CASE WHEN previous_end IS NULL THEN 0 ELSE greatest(0,(end_ms-previous_end)/18000000-1)::integer END)
      RETURNING * INTO e;
  END IF;
  IF e.available_at>clock_timestamp() THEN RETURN public.fn_horse_discovery_state(e.epoch_key,'deferred','backoff'); END IF;
  IF e.from_ms<at_ms-86400000 THEN
    UPDATE public.horse_observation_discovery_epochs SET state='gap',reason='source_expired',finished_at=clock_timestamp() WHERE epoch_key=e.epoch_key;
    RETURN public.fn_horse_discovery_state(e.epoch_key,'gap','source_expired');
  END IF;
  SELECT * INTO s FROM public.horse_observation_discovery_segments WHERE epoch_key=e.epoch_key AND from_ms=e.cursor_ms;
  IF NOT FOUND THEN
    IF e.segments>=2048 THEN
      UPDATE public.horse_observation_discovery_epochs SET state='gap',reason='segment_budget_exceeded',finished_at=clock_timestamp() WHERE epoch_key=e.epoch_key;
      RETURN public.fn_horse_discovery_state(e.epoch_key,'gap','segment_budget_exceeded');
    END IF;
    -- Refuse discovery pressure before a source read when acquisition is full.
    SELECT count(*) INTO occupied FROM (SELECT 1 FROM public.horse_observation_capture_work WHERE state NOT IN ('admitted','captured') LIMIT 257) q;
    IF occupied>=256 THEN
      UPDATE public.horse_observation_discovery_epochs SET available_at=clock_timestamp()+interval '30 seconds',reason='capture_queue_full' WHERE epoch_key=e.epoch_key;
      RETURN public.fn_horse_discovery_state(e.epoch_key,'deferred','capture_queue_full');
    END IF;
    -- One bounded statement binds source rows, atomic receipts and actors.
    -- Private roster fields never leave this query or enter its digest.
    WITH candidates AS MATERIALIZED (
      SELECT h.id,h.created_at,h.table_id,h.hand_number,h.players FROM public.hand_history h
      WHERE h.created_at>to_timestamp(e.cursor_ms::double precision/1000)
        AND h.created_at<=to_timestamp(e.slice_through_ms::double precision/1000) LIMIT 513
    ), measured AS MATERIALIZED (
      SELECT c.*,a.payload_hash,a.hand_id IS NULL AS missing_receipt,
        octet_length(c.players::text) roster_bytes,
        CASE WHEN jsonb_typeof(c.players)='array' THEN jsonb_array_length(c.players) NOT BETWEEN 1 AND 10 ELSE true END invalid_roster
      FROM candidates c LEFT JOIN public.hand_atomic_commits a ON a.hand_id=c.id AND a.table_id=c.table_id AND a.hand_number=c.hand_number
    ), totals AS MATERIALIZED (SELECT count(*) n,coalesce(sum(roster_bytes),0) bytes FROM measured), roster AS MATERIALIZED (
      SELECT m.id,p.value->>'userId' actor,
        jsonb_typeof(p.value) IS DISTINCT FROM 'object' OR coalesce(p.value->>'userId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' invalid_actor
      FROM measured m CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN NOT m.invalid_roster AND m.roster_bytes<=1048576 AND (SELECT t.n<=512 AND t.bytes<=8388608 FROM totals t) THEN m.players ELSE '[]'::jsonb END) p
    ), valid_actors AS MATERIALIZED (
      SELECT DISTINCT actor::uuid actor FROM roster WHERE NOT invalid_actor
    ), manifest AS (
      SELECT m.id,m.created_at,m.table_id,m.hand_number,m.payload_hash,
        (SELECT jsonb_agg(r.actor ORDER BY r.actor) FROM roster r WHERE r.id=m.id AND NOT r.invalid_actor) actors
      FROM measured m
    ) SELECT count(*)::integer,coalesce(sum(roster_bytes),0),
      coalesce(bool_or(invalid_roster OR roster_bytes>1048576 OR hand_number<1000000),false) OR EXISTS(SELECT 1 FROM roster WHERE invalid_actor)
        OR EXISTS(SELECT 1 FROM roster GROUP BY id,actor HAVING count(*)>1),
      coalesce(bool_or(missing_receipt OR payload_hash IS NULL OR payload_hash !~ '^[a-f0-9]{64}$'),false),
      (SELECT coalesce(array_agg(actor ORDER BY actor),ARRAY[]::uuid[]) FROM valid_actors),
      encode(sha256(convert_to(jsonb_build_array('horse-discovery-source-v1',e.cursor_ms,e.slice_through_ms,(SELECT coalesce(jsonb_agg(jsonb_build_array(id,
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),table_id,hand_number,payload_hash,actors)
        ORDER BY created_at,id),'[]'::jsonb) FROM manifest))::text,'UTF8')),'hex'),pg_current_snapshot()::text,
      floor(extract(epoch FROM clock_timestamp())*1000)::bigint
      INTO n,bytes,bad,missing,actor_ids,source_hash,snapshot,source_read_ms FROM measured;
    IF n>512 OR bytes>8388608 THEN
      width:=e.slice_through_ms-e.cursor_ms;
      IF width<=1 THEN
        UPDATE public.horse_observation_discovery_epochs SET state='gap',reason='indivisible_source_budget',finished_at=clock_timestamp() WHERE epoch_key=e.epoch_key;
        RETURN public.fn_horse_discovery_state(e.epoch_key,'gap','indivisible_source_budget');
      END IF;
      UPDATE public.horse_observation_discovery_epochs SET slice_through_ms=e.cursor_ms+width/2,reason='source_budget_exceeded',failures=0 WHERE epoch_key=e.epoch_key;
      RETURN public.fn_horse_discovery_state(e.epoch_key,'refined','source_budget_exceeded');
    END IF;
    IF octet_length(snapshot)>8192 THEN
      UPDATE public.horse_observation_discovery_epochs SET available_at=clock_timestamp()+interval '30 seconds',reason='snapshot_budget_exceeded' WHERE epoch_key=e.epoch_key;
      RETURN public.fn_horse_discovery_state(e.epoch_key,'deferred','snapshot_budget_exceeded');
    END IF;
    IF bad OR missing THEN
      UPDATE public.horse_observation_discovery_epochs SET failures=least(6,failures+1),available_at=clock_timestamp()+make_interval(secs=>least(60,2^least(6,failures+1))::integer),
        reason=CASE WHEN missing THEN 'atomic_receipt_missing' ELSE 'invalid_roster' END WHERE epoch_key=e.epoch_key;
      RETURN public.fn_horse_discovery_state(e.epoch_key,'deferred',CASE WHEN missing THEN 'atomic_receipt_missing' ELSE 'invalid_roster' END);
    END IF;
    SELECT coalesce(array_agg(a ORDER BY a),ARRAY[]::uuid[]) INTO novel FROM unnest(actor_ids) a
      WHERE NOT EXISTS(SELECT 1 FROM public.horse_observation_discovery_members m WHERE m.epoch_key=e.epoch_key AND m.actor_id=a);
    IF e.actors+cardinality(novel)>8192 THEN
      UPDATE public.horse_observation_discovery_epochs SET state='gap',reason='actor_budget_exceeded',finished_at=clock_timestamp() WHERE epoch_key=e.epoch_key;
      RETURN public.fn_horse_discovery_state(e.epoch_key,'gap','actor_budget_exceeded');
    END IF;
    actor_hash:=encode(sha256(convert_to(to_jsonb(actor_ids)::text,'UTF8')),'hex');
    -- Conservative logical evidence budget: snapshot bytes, frozen novel UUIDs
    -- and 512 bytes fixed allowance per segment. This excludes PostgreSQL
    -- indexes/MVCC overhead; epoch/member counts bound those independently.
    evidence_size:=octet_length(snapshot)+cardinality(novel)*16+512;
    IF e.evidence_bytes+evidence_size>2097152 THEN
      UPDATE public.horse_observation_discovery_epochs SET state='gap',reason='evidence_budget_exceeded',finished_at=clock_timestamp() WHERE epoch_key=e.epoch_key;
      RETURN public.fn_horse_discovery_state(e.epoch_key,'gap','evidence_budget_exceeded');
    END IF;
    INSERT INTO public.horse_observation_discovery_segments(epoch_key,from_ms,through_ms,snapshot_id,read_at_ms,source_digest,hands,source_actors,actor_digest,novel_actors)
      VALUES(e.epoch_key,e.cursor_ms,e.slice_through_ms,snapshot,source_read_ms,source_hash,n,cardinality(actor_ids),actor_hash,novel) RETURNING * INTO s;
    UPDATE public.horse_observation_discovery_epochs SET segments=segments+1,evidence_bytes=evidence_bytes+evidence_size,failures=0,reason=NULL WHERE epoch_key=e.epoch_key;
    -- Source snapshot and actor admission are separate bounded steps.
    RETURN public.fn_horse_discovery_state(e.epoch_key,'source_recorded');
  END IF;
  -- Claim the same capacity reservation used by the canonical admission RPC.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('horse-source-capacity-v1',0)) THEN
    RETURN public.fn_horse_discovery_state(e.epoch_key,'deferred','capacity_busy');
  END IF;
  SELECT count(*) INTO occupied FROM (SELECT 1 FROM public.horse_observation_capture_work WHERE state NOT IN ('admitted','captured') LIMIT 257) q;
  total:=s.admitted_actors;
  WHILE total<cardinality(s.novel_actors) AND processed<32 LOOP
    v_actor:=s.novel_actors[total+1];
    request:=encode(sha256(convert_to(concat_ws('|','horse-source-request-v1',v_actor::text,e.from_ms::text,e.through_ms::text),'UTF8')),'hex');
    IF occupied>=256 AND NOT EXISTS(SELECT 1 FROM public.horse_observation_capture_work WHERE request_key=request) THEN EXIT; END IF;
    ack:=public.fn_admit_horse_observation_capture(v_actor,e.from_ms,e.through_ms);
    IF ack->>'status' IS DISTINCT FROM 'durable' OR ack->>'requestKey' IS DISTINCT FROM request THEN
      RAISE EXCEPTION 'HORSE_DISCOVERY_ADMISSION_UNCONFIRMED';
    END IF;
    INSERT INTO public.horse_observation_discovery_members(epoch_key,actor_id,request_key,source_from_ms)
      VALUES(e.epoch_key,v_actor,request,s.from_ms) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS inserted=ROW_COUNT;
    IF inserted=0 AND NOT EXISTS(SELECT 1 FROM public.horse_observation_discovery_members WHERE epoch_key=e.epoch_key AND actor_id=v_actor AND request_key=request) THEN
      RAISE EXCEPTION 'HORSE_DISCOVERY_MEMBER_CONFLICT';
    END IF;
    UPDATE public.horse_observation_discovery_epochs SET actors=actors+inserted WHERE epoch_key=e.epoch_key;
    total:=total+1;processed:=processed+1;
    -- Conservative capacity accounting; an exact pre-existing request may
    -- use no new slot, but this bound can only defer remaining admissions.
    occupied:=occupied+1;
  END LOOP;
  UPDATE public.horse_observation_discovery_segments SET admitted_actors=total WHERE epoch_key=e.epoch_key AND from_ms=s.from_ms;
  IF total<cardinality(s.novel_actors) THEN
    IF processed=0 THEN UPDATE public.horse_observation_discovery_epochs SET available_at=clock_timestamp()+interval '30 seconds',reason='capture_queue_full' WHERE epoch_key=e.epoch_key; END IF;
    RETURN public.fn_horse_discovery_state(e.epoch_key,CASE WHEN processed=0 THEN 'deferred' ELSE 'admitted' END,CASE WHEN processed=0 THEN 'capture_queue_full' ELSE NULL END);
  END IF;
  width:=s.through_ms-s.from_ms;
  UPDATE public.horse_observation_discovery_epochs SET cursor_ms=s.through_ms,slice_through_ms=least(through_ms,s.through_ms+width*2),
    state=CASE WHEN s.through_ms=through_ms THEN 'discovered' ELSE 'pending' END,
    finished_at=CASE WHEN s.through_ms=through_ms THEN clock_timestamp() ELSE NULL END,
    available_at=clock_timestamp(),failures=0,reason=NULL WHERE epoch_key=e.epoch_key;
  RETURN public.fn_horse_discovery_state(e.epoch_key,CASE WHEN s.through_ms=e.through_ms THEN 'discovered' ELSE 'advanced' END);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_discover_horse_observation_requests() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_discover_horse_observation_requests() TO service_role;

CREATE FUNCTION public.fn_prune_horse_observation_discovery()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp SET lock_timeout TO '2s'
AS $function$
DECLARE key text; members integer:=0; segments integer:=0; epochs integer:=0;
BEGIN
  SELECT epoch_key INTO key FROM public.horse_observation_discovery_epochs
    WHERE state='discovered' AND finished_at<clock_timestamp()-interval '32 days'
    ORDER BY finished_at,epoch_key LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
    WITH doomed AS (SELECT ctid FROM public.horse_observation_discovery_members WHERE epoch_key=key ORDER BY actor_id LIMIT 512 FOR UPDATE SKIP LOCKED)
    DELETE FROM public.horse_observation_discovery_members WHERE ctid IN(SELECT ctid FROM doomed);
    GET DIAGNOSTICS members=ROW_COUNT;
    WITH doomed AS (SELECT ctid FROM public.horse_observation_discovery_segments WHERE epoch_key=key ORDER BY from_ms LIMIT 128 FOR UPDATE SKIP LOCKED)
    DELETE FROM public.horse_observation_discovery_segments WHERE ctid IN(SELECT ctid FROM doomed);
    GET DIAGNOSTICS segments=ROW_COUNT;
    IF NOT EXISTS(SELECT 1 FROM public.horse_observation_discovery_members WHERE epoch_key=key)
      AND NOT EXISTS(SELECT 1 FROM public.horse_observation_discovery_segments WHERE epoch_key=key) THEN
      DELETE FROM public.horse_observation_discovery_epochs WHERE epoch_key=key;epochs:=1;
    END IF;
  END IF;
  RETURN jsonb_build_object('version',1,'status','pruned','epochs',epochs,'members',members,'segments',segments);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_prune_horse_observation_discovery() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_prune_horse_observation_discovery() TO service_role;
COMMIT;
