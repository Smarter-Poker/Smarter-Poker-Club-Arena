-- 20261025042223_horse_capture_drains_in_order.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT WAS WRONG (read from production, 2026-10-24 and 2026-10-25)
--
-- The horse opponent-observation capture queue was losing about 60% of what
-- it was asked to capture. Sources are readable for 24 hours only, so a lost
-- window is lost for good. Measured: 256 of 256 capture slots occupied, 161 of
-- them part-done, 64 requests expired to source_expired in one afternoon,
-- every discovery epoch since 2026-10-17 created with skipped_epochs=2, and 45
-- of the 65 retained epochs ending as source_expired gaps. One serial consumer
-- recorded 86-226 slices an hour against 13-95 new requests, with the journal
-- queue empty (unfinished 0) the whole time.
--
-- Four lines produced it:
--
--  1. fn_claim_horse_observation_capture ordered by available_at. Every
--     successful slice resets available_at, so the claim round-robined one
--     slice at a time across all ~255 open requests. None finished and freed
--     its slot, the oldest expired part-done, and with 256 slots occupied
--     discovery refused new work.
--  2. After a success, fn_finish_horse_observation_capture set the next slice
--     three times as wide (last_ms+2*(last_ms-first_ms)). For an active horse
--     that overshot the 512-hand budget, the read refused, and the slice was
--     halved ("source_budget_refined"): about half of all reads were spent
--     finding out a slice was too wide.
--  3. A read that timed out (5 s client timeout) came back source_unavailable
--     and was retried at the SAME width, timing out again until it expired.
--  4. fn_discover_horse_observation_requests started every new epoch at the
--     newest 5-hour boundary, skipping the windows in between whenever the
--     previous epoch took longer than one boundary.
--
-- THE FIX
--
--  1. Claims take the oldest request first: ORDER BY created_at, request_key.
--     A request drains to completion and frees its slot before the next one
--     starts.
--  2. A slice ends at a hand boundary inside the budget. The new
--     fn_horse_capture_hand_budget_through reads the snapshot's own overflow
--     precheck (the per-player index rows whose hand still exists, at most
--     513, oldest first) and returns the millisecond that holds the 512th
--     hand, or the one before the 513th when they share it. The claim ends
--     the slice there, so a success is not followed by a refine. Where a
--     request's previous slice shows hands dense enough that 512 would pass
--     7 MiB of the 8 MiB source budget (median 16 KB a hand measured), the
--     claim uses the proportionally smaller hand count. The snapshot precheck
--     itself now calls the same function and returns the boundary on its
--     refusal as budgetThroughMs; the refusal condition (more than 512 such
--     rows) is unchanged.
--  3. After a success the next slice is the rest of the request; the claim
--     ends it at the boundary. A source_unavailable (timeout) is refined
--     narrower at once, the same way source_budget_exceeded is: to the
--     512-hand boundary, or the boundary of half its hands, or half its time.
--  4. Discovery resumes each new epoch at the boundary after the previous
--     epoch's end. Only a window whose start would be within an hour of the
--     24-hour source horizon is stepped over, still counted in skipped_epochs.
--     No backfill job: the next epoch is simply the next window.
--
-- Unchanged: every signature, SECURITY DEFINER / INVOKER mode, volatility,
-- search_path and lock_timeout setting and grant (asserted after); the
-- 256-slot capacity; the 24-hour horizon; the receipts, witness and
-- acknowledgement shapes the engine validates. CREATE OR REPLACE only, no
-- table DDL, no hot-table lock. The engine half (the TS mirror of the next
-- slice, and the journal loop that ran one slice per 1 s pause even with the
-- journal empty) ships in the same pull request.
--
-- Each replaced function is rebuilt from its installed body with only the
-- anchored edits above; the md5(prosrc) of every base body is guarded below
-- and recorded beside it. One transaction. This migration creates a function
-- (fn_horse_capture_hand_budget_through), which is its own live proof.
--
-- Pinned by tests/horse-capture-drains-in-order.law.test.ts.

BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

-- Pre-image guard. Each function this replaces must hold exactly the body
-- measured on production (md5(prosrc), read 2026-10-25 through
-- pg_get_functiondef), or this migration already applied (its own post-image).
-- Anything else is a body this migration did not measure, and it refuses.
DO $horse_capture_drains_in_order_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM (VALUES
    ('public.fn_claim_horse_observation_capture(uuid)','fe2b696a91799229417765107f1781e4','dc550cf72b59ffd1ec885520c28c9e1d'),
    ('public.fn_finish_horse_observation_capture(text,uuid,text,text)','c4851c48d6be944246e135c5c7142b7f','2e1419931681fa5391340b5478032882'),
    ('public.fn_discover_horse_observation_requests()','105a4349232226552dd175535f6bb167','ee32a5b8c75d02b896ea370f10a0b164'),
    ('public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint)','e1ce00018f43c4517b6b5dc52f762734','868b47cd0f748c7ab3cdd597c001c841')
  ) expected(sig,pre,post)
    LEFT JOIN pg_proc p ON p.oid = to_regprocedure(expected.sig)
    WHERE p.oid IS NULL OR md5(p.prosrc) NOT IN (expected.pre, expected.post)) THEN
    RAISE EXCEPTION 'HORSE_CAPTURE_DRAINS_IN_ORDER_PREIMAGE_CHANGED: a replaced function body is not the one this migration measured; nothing was installed';
  END IF;
END
$horse_capture_drains_in_order_guard$;

-- New: where a slice of one player's hands ends inside the hand budget.
CREATE OR REPLACE FUNCTION public.fn_horse_capture_hand_budget_through(p_actor uuid, p_from_ms bigint, p_through_ms bigint, p_hands integer)
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  -- HORSE CAPTURE DRAINS IN ORDER (2026-10-25). Where a slice of this
  -- player's hands ends so that it holds at most p_hands of them (NULL: half
  -- of the hands in the slice; never more than 512). It reads the same two
  -- indexes with the same predicate as the snapshot's overflow precheck: up
  -- to 513 per-player index rows whose hand still exists, oldest first.
  --   the slice holds <= the limit: p_through_ms (nothing to narrow);
  --   otherwise: the millisecond of the limit-th hand, or the millisecond
  --     before the next hand when the two share it. Every hand at or before
  --     the answer is one of the first `limit`, and the next one is always
  --     after it, so (p_from_ms, answer] holds at most `limit` hands;
  --   p_from_ms: too many hands share one millisecond to split there.
  WITH ordered AS MATERIALIZED (
    SELECT i.created_at FROM public.ca_hand_player_idx i
     WHERE i.user_id = p_actor
       AND i.created_at > to_timestamp(p_from_ms::double precision / 1000)
       AND i.created_at <= to_timestamp(p_through_ms::double precision / 1000)
       AND EXISTS (SELECT 1 FROM public.hand_history h
                    WHERE h.created_at = i.created_at AND h.id = i.hand_id)
     ORDER BY i.created_at
     LIMIT 513
  ), ranked AS MATERIALIZED (
    SELECT o.created_at, row_number() OVER (ORDER BY o.created_at) AS n FROM ordered o
  ), budget AS (
    SELECT count(*)::integer AS total,
           least(512, coalesce(p_hands, count(*)::integer / 2)) AS hands
      FROM ranked
  )
  SELECT CASE
    WHEN p_actor IS NULL OR p_from_ms IS NULL OR p_through_ms IS NULL OR p_through_ms <= p_from_ms
      THEN p_through_ms
    WHEN b.hands < 1 OR b.total <= b.hands THEN p_through_ms
    ELSE greatest(p_from_ms, least(
      ceil(extract(epoch FROM (SELECT r.created_at FROM ranked r WHERE r.n = b.hands)) * 1000)::bigint,
      ceil(extract(epoch FROM (SELECT r.created_at FROM ranked r WHERE r.n = b.hands + 1)) * 1000)::bigint - 1))
  END FROM budget b;
$function$;

REVOKE ALL ON FUNCTION public.fn_horse_capture_hand_budget_through(uuid, bigint, bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_capture_hand_budget_through(uuid, bigint, bigint, integer) TO service_role;

-- fn_claim_horse_observation_capture: rebuilt from the installed body, md5(prosrc) fe2b696a91799229417765107f1781e4
CREATE OR REPLACE FUNCTION public.fn_claim_horse_observation_capture(p_lease_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
 SET lock_timeout TO '2s'
AS $function$
DECLARE r public.horse_observation_capture_work%ROWTYPE; first_ms bigint; last_ms bigint; gap_reason text; budget_ms bigint; hand_cap integer;
BEGIN
  IF p_lease_token IS NULL THEN RAISE EXCEPTION 'HORSE_CAPTURE_INVALID_TOKEN'; END IF;
  SELECT * INTO r FROM public.horse_observation_capture_work w
    WHERE w.state NOT IN ('admitted','captured') AND ((w.state='queued' AND w.available_at<=clock_timestamp())
       OR (w.state='leased' AND w.lease_until<=clock_timestamp())
       OR (w.state='gap' AND w.reason='source_budget_exceeded' AND w.available_at<=clock_timestamp()
           AND coalesce(w.slice_through_ms,w.through_ms)-coalesce(w.cursor_ms,w.from_ms)>1))
    -- HORSE CAPTURE DRAINS IN ORDER (2026-10-25): the oldest request first.
    -- Ordering by available_at round-robined one slice at a time across
    -- every open request (each success resets it), so the oldest expired
    -- part-done at 24 h while all 256 slots stayed full.
    ORDER BY w.created_at,w.request_key LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('version',1,'status','idle'); END IF;
  IF EXISTS(SELECT 1 FROM public.horse_observation_capture_receipts s
    WHERE s.request_key=r.request_key AND s.lease_token=p_lease_token) THEN
    RAISE EXCEPTION 'HORSE_CAPTURE_TOKEN_REUSED';
  END IF;
  first_ms:=coalesce(r.cursor_ms,r.from_ms); last_ms:=coalesce(r.slice_through_ms,r.through_ms);
  IF first_ms<floor(extract(epoch FROM clock_timestamp())*1000)::bigint-86400000 THEN gap_reason:='source_expired';
  ELSIF r.segments>=2048 AND first_ms<r.through_ms THEN gap_reason:='segment_budget_exceeded';
  END IF;
  IF gap_reason IS NOT NULL THEN
    UPDATE public.horse_observation_capture_work SET state='gap',reason=gap_reason,lease_token=NULL,lease_until=NULL WHERE request_key=r.request_key;
    RETURN jsonb_build_object('version',1,'status','gap','requestKey',r.request_key,'reason',gap_reason);
  END IF;
  IF first_ms>=last_ms THEN RAISE EXCEPTION 'HORSE_CAPTURE_INVALID_CURSOR'; END IF;
  -- The slice ends at the hand boundary inside the budget: 512 hands, or
  -- fewer when this request's previous slice shows its hands are dense
  -- enough that 512 of them would pass 7 MiB of the 8 MiB source budget
  -- (measured 2026-10-25: median 16 KB a hand, so 512 hands sit at the
  -- limit). It can only narrow the slice; with no boundary it is left for
  -- the read to refuse.
  SELECT least(512,greatest(32,floor(7340032::numeric*(s.source_witness::jsonb->>6)::bigint
      /(s.source_witness::jsonb->>7)::bigint)::integer)) INTO hand_cap
    FROM public.horse_observation_capture_receipts s
   WHERE s.request_key=r.request_key AND s.through_ms=first_ms AND s.source_witness IS NOT NULL
     AND (s.source_witness::jsonb->>6)::bigint>=32 AND (s.source_witness::jsonb->>7)::bigint>0
   ORDER BY s.from_ms DESC LIMIT 1;
  budget_ms:=public.fn_horse_capture_hand_budget_through(r.actor_id,first_ms,last_ms,coalesce(hand_cap,512));
  IF budget_ms>first_ms AND budget_ms<last_ms THEN last_ms:=budget_ms; END IF;
  UPDATE public.horse_observation_capture_work SET state='leased',lease_token=p_lease_token,
    lease_until=clock_timestamp()+interval '30 seconds',attempts=least(attempts+1,1000000),
    cursor_ms=first_ms,slice_through_ms=last_ms WHERE request_key=r.request_key;
  RETURN jsonb_build_object('version',1,'status','claimed','requestKey',r.request_key,
    'sourceWitnessVersion',1,'actorId',r.actor_id,'fromMs',r.from_ms,'throughMs',r.through_ms,'sliceFromMs',first_ms,
    'sliceThroughMs',last_ms,'leaseToken',p_lease_token);
END;
$function$;

-- fn_finish_horse_observation_capture: rebuilt from the installed body, md5(prosrc) c4851c48d6be944246e135c5c7142b7f
CREATE OR REPLACE FUNCTION public.fn_finish_horse_observation_capture(p_request_key text, p_lease_token uuid, p_payload text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
 SET lock_timeout TO '2s'
AS $function$
DECLARE r public.horse_observation_capture_work%ROWTYPE; prior public.horse_observation_capture_receipts%ROWTYPE;
  b jsonb; queued jsonb; actor_key text; fingerprint text; v_reason text; first_ms bigint; last_ms bigint;
  next_ms bigint; n integer; total bigint; new_state text; ack jsonb; budget_ms bigint;
BEGIN
  IF p_request_key IS NULL OR p_request_key !~ '^[a-f0-9]{64}$' OR p_lease_token IS NULL
     OR octet_length(p_payload)>16777216 THEN RAISE EXCEPTION 'HORSE_CAPTURE_INVALID_FINISH'; END IF;
  SELECT * INTO r FROM public.horse_observation_capture_work w WHERE w.request_key=p_request_key FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('version',1,'status','lease_lost','requestKey',p_request_key); END IF;
  IF p_payload IS NOT NULL THEN
    fingerprint:=encode(sha256(convert_to(p_payload,'UTF8')),'hex');
    SELECT * INTO prior FROM public.horse_observation_capture_receipts s
      WHERE s.request_key=p_request_key AND s.lease_token=p_lease_token;
    IF FOUND THEN
      IF prior.payload_digest IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'HORSE_CAPTURE_BATCH_CONFLICT'; END IF;
      RETURN prior.acknowledgment;
    END IF;
  END IF;
  IF r.lease_token IS DISTINCT FROM p_lease_token THEN
    RETURN jsonb_build_object('version',1,'status','lease_lost','requestKey',p_request_key);
  END IF;
  first_ms:=coalesce(r.cursor_ms,r.from_ms); last_ms:=coalesce(r.slice_through_ms,r.through_ms);
  IF p_payload IS NOT NULL THEN
    b:=p_payload::jsonb;
    actor_key:=encode(sha256(convert_to(format('["adaptive-actor-v1","%s"]',r.actor_id),'UTF8')),'hex');
    -- Exact pre-upgrade receipts remain replayable without another enqueue.
    IF r.state='admitted' AND r.segments=0 THEN
      IF r.batch_digest IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'HORSE_CAPTURE_BATCH_CONFLICT'; END IF;
      RETURN jsonb_build_object('version',1,'status','admitted','requestKey',p_request_key,
        'batchKey',r.batch_key,'batchDigest',r.batch_digest,'observations',r.observations);
    END IF;
    IF jsonb_typeof(b) IS DISTINCT FROM 'array' OR jsonb_array_length(b)<>8
      OR b->0 IS DISTINCT FROM '1'::jsonb OR b->>2 IS DISTINCT FROM actor_key
      OR b->>3 IS DISTINCT FROM first_ms::text OR b->>4 IS DISTINCT FROM last_ms::text THEN
      RAISE EXCEPTION 'HORSE_CAPTURE_SCOPE_MISMATCH';
    END IF;
  END IF;
  IF r.state<>'leased' OR r.lease_until<=clock_timestamp() THEN
    RETURN jsonb_build_object('version',1,'status','lease_lost','requestKey',p_request_key);
  END IF;
  IF p_payload IS NOT NULL THEN
    IF r.segments>=2048 THEN RAISE EXCEPTION 'HORSE_CAPTURE_SEGMENT_BUDGET'; END IF;
    queued:=public.fn_queue_horse_adaptive_batch(p_payload);
    IF queued->>'status'='durable' AND queued->>'batchDigest'=fingerprint
      AND queued->>'batchKey'=b->>1 AND (queued->>'observations')::integer=jsonb_array_length(b->7) THEN
      n:=r.segments+1; total:=r.captured_observations+(queued->>'observations')::integer;
      -- HORSE CAPTURE DRAINS IN ORDER (2026-10-25): the next slice is the rest
      -- of the request and the claim ends it at the 512-hand boundary. The old
      -- 3x growth overshot the budget and was then halved, wasting about half
      -- of every read.
      next_ms:=r.through_ms;
      new_state:=CASE WHEN last_ms<r.through_ms THEN 'queued' WHEN n=1 THEN 'admitted' ELSE 'captured' END;
      ack:=jsonb_build_object('version',1,'status',CASE WHEN new_state='queued' THEN 'continued' ELSE new_state END,
        'requestKey',p_request_key,'batchKey',queued->>'batchKey','batchDigest',fingerprint,'observations',queued->'observations',
        'sliceFromMs',first_ms,'sliceThroughMs',last_ms,'nextFromMs',last_ms,'nextThroughMs',next_ms,
        'segments',n,'capturedObservations',total);
      INSERT INTO public.horse_observation_capture_receipts(request_key,lease_token,from_ms,through_ms,payload_digest,acknowledgment)
        VALUES(p_request_key,p_lease_token,first_ms,last_ms,fingerprint,ack);
      UPDATE public.horse_observation_capture_work SET state=new_state,cursor_ms=last_ms,slice_through_ms=next_ms,
        segments=n,captured_observations=total,
        batch_key=CASE WHEN new_state='admitted' THEN queued->>'batchKey' ELSE NULL END,
        batch_digest=CASE WHEN new_state='admitted' THEN fingerprint ELSE NULL END,
        observations=CASE WHEN new_state='admitted' THEN (queued->>'observations')::integer ELSE NULL END,
        admitted_at=CASE WHEN new_state IN ('admitted','captured') THEN clock_timestamp() ELSE NULL END,
        lease_until=NULL,reason=NULL,available_at=clock_timestamp() WHERE request_key=p_request_key;
      RETURN ack;
    END IF;
    v_reason:=CASE WHEN queued->>'reason' IN ('queue_full','capacity_busy') THEN queued->>'reason' ELSE 'queue_unavailable' END;
  ELSE v_reason:=CASE WHEN p_reason IN ('source_budget_exceeded','invalid_source') THEN p_reason ELSE 'source_unavailable' END;
  END IF;
  -- HORSE CAPTURE DRAINS IN ORDER (2026-10-25): a refused
  -- (source_budget_exceeded) or timed-out / unreadable (source_unavailable)
  -- read is retried narrower at once. Retrying a slice that timed out at the
  -- same size only repeated the timeout until the request expired. The slice
  -- ends at the 512-hand boundary when it is over the hand budget, otherwise
  -- at the boundary of half its hands (a byte, action or time budget), and is
  -- halved in time only when its hands cannot be split.
  IF v_reason IN ('source_budget_exceeded','source_unavailable') AND last_ms-first_ms>1 THEN
    next_ms:=first_ms+(last_ms-first_ms)/2;
    budget_ms:=public.fn_horse_capture_hand_budget_through(r.actor_id,first_ms,last_ms,512);
    IF NOT (budget_ms>first_ms AND budget_ms<last_ms) THEN
      budget_ms:=public.fn_horse_capture_hand_budget_through(r.actor_id,first_ms,last_ms,NULL);
    END IF;
    IF budget_ms>first_ms AND budget_ms<last_ms THEN next_ms:=budget_ms; END IF;
    UPDATE public.horse_observation_capture_work SET state='queued',slice_through_ms=next_ms,lease_until=NULL,
      reason=CASE WHEN v_reason='source_budget_exceeded' THEN 'source_budget_refined' ELSE 'source_unavailable_refined' END,
      available_at=clock_timestamp() WHERE request_key=p_request_key;
    RETURN jsonb_build_object('version',1,'status','refined','requestKey',p_request_key,
      'nextFromMs',first_ms,'nextThroughMs',next_ms);
  END IF;
  IF v_reason IN ('source_budget_exceeded','invalid_source') THEN
    UPDATE public.horse_observation_capture_work SET state='gap',reason=v_reason,lease_until=NULL WHERE request_key=p_request_key;
    RETURN jsonb_build_object('version',1,'status','gap','requestKey',p_request_key,'reason',v_reason);
  END IF;
  UPDATE public.horse_observation_capture_work SET state='queued',reason=v_reason,lease_until=NULL,
    available_at=clock_timestamp()+make_interval(secs=>least(60,power(2,least(r.attempts,6))::integer)) WHERE request_key=p_request_key;
  RETURN jsonb_build_object('version',1,'status','deferred','requestKey',p_request_key,'reason',v_reason);
END;
$function$;

-- fn_discover_horse_observation_requests: rebuilt from the installed body, md5(prosrc) 105a4349232226552dd175535f6bb167
CREATE OR REPLACE FUNCTION public.fn_discover_horse_observation_requests()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
 SET lock_timeout TO '2s'
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
    -- HORSE CAPTURE DRAINS IN ORDER (2026-10-25): a new epoch resumes at the
    -- boundary after the previous epoch's end, not at the newest boundary, so
    -- no readable window is skipped. A window whose start would be within an
    -- hour of the 24 h source horizon is stepped over (still counted in
    -- skipped_epochs): the earliest end kept is the first boundary at or
    -- after at_ms-61200000, whose start is at least 23 h old at most.
    IF previous_end IS NOT NULL THEN
      end_ms:=least(end_ms,greatest(previous_end+18000000,((at_ms-61200000+60000+17999999)/18000000)*18000000-60000));
      start_ms:=end_ms-21600000;
    END IF;
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
    SELECT count(*) INTO occupied FROM (SELECT 1 FROM public.horse_observation_capture_work WHERE state NOT IN ('admitted','captured') AND (state<>'gap' OR (reason='source_budget_exceeded' AND coalesce(slice_through_ms,through_ms)-coalesce(cursor_ms,from_ms)>1)) LIMIT 257) q;
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
  SELECT count(*) INTO occupied FROM (SELECT 1 FROM public.horse_observation_capture_work WHERE state NOT IN ('admitted','captured') AND (state<>'gap' OR (reason='source_budget_exceeded' AND coalesce(slice_through_ms,through_ms)-coalesce(cursor_ms,from_ms)>1)) LIMIT 257) q;
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

-- fn_horse_committed_observation_snapshot: rebuilt from the installed body, md5(prosrc) e1ce00018f43c4517b6b5dc52f762734
CREATE OR REPLACE FUNCTION public.fn_horse_committed_observation_snapshot(p_actor uuid, p_from_ms bigint, p_through_ms bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_at timestamptz := statement_timestamp();
  v_now_ms bigint := floor(extract(epoch FROM v_at) * 1000)::bigint;
  v_from timestamptz;
  v_through timestamptz;
  v_rows jsonb;
  v_count integer;
  v_actions bigint;
  v_bytes bigint;
  v_invalid boolean;
  v_missing_receipt boolean;
  v_budget bigint;
BEGIN
  -- Six-hour source windows within the latest day. The deployed horse-only
  -- prune has a one-day minimum; this does not promise historical retention
  -- or that actions in hands which have not committed are already visible.
  IF p_actor IS NULL OR p_from_ms IS NULL OR p_through_ms IS NULL
     OR p_from_ms < v_now_ms - 86400000 OR p_through_ms > v_now_ms
     OR p_through_ms <= p_from_ms OR p_through_ms - p_from_ms > 21600000 THEN
    RETURN jsonb_build_object('version',1,'status','unavailable','reason','invalid_window');
  END IF;
  v_from := to_timestamp(p_from_ms::double precision / 1000);
  v_through := to_timestamp(p_through_ms::double precision / 1000);

  -- 2026-10-22 (second pass): an overflowing window is refused before any
  -- history row is read. Each ca_hand_player_idx row is written from the
  -- hand's own roster with the hand's own created_at, so 513 index rows whose
  -- (created_at, id) still exist in hand_history prove more than 512 hands
  -- in this window. That answer comes from two indexes (the per-player time
  -- index and idx_hand_history_time_identity) instead of 513 random heap
  -- reads plus roster rechecks: 1.6-3.7 s -> well under 1 s on production.
  -- It can only refuse, never admit: a window under the budget still goes
  -- through the full roster-qualified read below, and a refusal only makes
  -- the capture worker refine to a smaller slice that is read exactly.
  --
  -- 2026-10-25 (HORSE CAPTURE DRAINS IN ORDER): the same 513 index rows, read
  -- oldest first, also say where the budget ends. The refusal carries
  -- budgetThroughMs, the boundary of the 512th hand, so the capture slice is
  -- ended exactly there instead of halved. The refusal condition is
  -- unchanged: more than 512 such rows in the window.
  v_budget := public.fn_horse_capture_hand_budget_through(p_actor, p_from_ms, p_through_ms, 512);
  IF v_budget < p_through_ms THEN
    RETURN jsonb_build_object(
      'version',1,'status','unavailable','reason','hand_budget_exceeded',
      'actor',p_actor,'fromMs',p_from_ms,'throughMs',p_through_ms,
      'readAtMs',v_now_ms,'snapshotId',pg_current_snapshot()::text,
      'coverage','retained_committed_roster_rows','acceptance','atomic_hand_receipts',
      'handCount',513,'actionCount',NULL,'sourceBytes',NULL,'hands','[]'::jsonb,
      'budgetThroughMs',CASE WHEN v_budget > p_from_ms THEN v_budget END);
  END IF;

  -- 2026-10-22: candidates are FOUND through the per-player time index and
  -- the pending projection outbox, and QUALIFIED by the canonical roster on
  -- the history row itself. The roster GIN alone cannot bound time: for a
  -- busy horse it matched ~38,000 hands across retention to keep 513, read
  -- ~37,000 random heap pages and held hand_history for up to 8 seconds.
  --
  -- Completeness in this one snapshot: a committed hand writes its history
  -- row and its hand_projection_outbox row in one transaction; the projector
  -- writes ca_hand_player_idx (same created_at) and deletes the outbox row in
  -- one transaction. So every visible hand is reachable through the outbox
  -- or through the index, never neither. A voided stat fact removes one
  -- index row while the roster keeps the player; those hands are re-added.
  -- The roster containment and window are rechecked on the history row, so
  -- the index can only narrow the search, never decide membership.
  WITH found AS MATERIALIZED (
    SELECT i.hand_id FROM public.ca_hand_player_idx i
     WHERE i.user_id = p_actor AND i.created_at > v_from AND i.created_at <= v_through
    UNION
    SELECT o.hand_id FROM public.hand_projection_outbox o
    UNION
    SELECT r.hand_id FROM public.ca_hand_fact_revisions r
     WHERE r.user_id = p_actor AND r.kind = 'void'
  ), candidates AS MATERIALIZED (
    -- One primary-key probe per found hand. The roster test is wrapped in
    -- IS TRUE so the planner cannot turn it back into the roster GIN scan
    -- this replaces. A 513th row proves overflow; it is never silently
    -- dropped. No action payload is read until the bounded set is known.
    SELECT h.id, h.created_at, h.table_id, h.hand_number
      FROM found f
     CROSS JOIN LATERAL (
       SELECT h.id, h.created_at, h.table_id, h.hand_number
         FROM public.hand_history h
        WHERE h.id = f.hand_id
          AND h.created_at > v_from
          AND h.created_at <= v_through
          AND (h.players @> jsonb_build_array(jsonb_build_object('userId',p_actor::text))) IS TRUE
     ) h
     LIMIT 513
  ), measured AS MATERIALIZED (
    SELECT c.id, c.created_at, c.table_id, c.hand_number, h.actions,
           a.payload_hash AS acceptance_hash,
           a.hand_id IS NULL AS missing_receipt,
           octet_length(h.actions::text) AS bytes,
           CASE WHEN jsonb_typeof(h.actions)='array'
                THEN jsonb_array_length(h.actions) ELSE 0 END AS action_count,
           CASE WHEN jsonb_typeof(h.actions)='array'
                THEN jsonb_array_length(h.actions) > 4096 ELSE true END AS invalid
      FROM candidates c
      JOIN public.hand_history h ON h.id = c.id
      LEFT JOIN public.hand_atomic_commits a
        ON a.hand_id=c.id AND a.table_id=c.table_id AND a.hand_number=c.hand_number
  ), totals AS (
    SELECT count(*)::integer AS n, coalesce(sum(bytes),0)::bigint AS bytes,
           coalesce(sum(action_count),0)::bigint AS actions,
           coalesce(bool_or(invalid OR bytes > 1048576),false) AS invalid,
           coalesce(bool_or(missing_receipt),false) AS missing_receipt
      FROM measured
  )
  SELECT t.n, t.bytes, t.invalid, t.missing_receipt, t.actions,
         CASE WHEN t.n <= 512 AND t.bytes <= 8388608 AND t.actions <= 20000 AND NOT t.invalid AND NOT t.missing_receipt THEN
           (SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id',m.id,
               'acceptance',jsonb_build_object('kind','atomic_hand_receipt','tableId',m.table_id,
                 'handNumber',m.hand_number,'payloadHash',m.acceptance_hash),
               'createdAt',to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               -- Exclude showdown, hole cards, outcomes, names and arbitrary
               -- action fields before crossing the service boundary. Ordinals
               -- and non-betting entries stay intact for public-line replay.
               'actions',(SELECT coalesce(jsonb_agg(
                   CASE WHEN jsonb_typeof(a.value)='object' THEN
                     (SELECT coalesce(jsonb_object_agg(f.key,f.value),'{}'::jsonb)
                        FROM jsonb_each(a.value) f
                       WHERE f.key IN ('userId','action','stage','timestamp',
                                       'publicNode','origin','observationIdentity'))
                   ELSE a.value END ORDER BY a.ordinality),'[]'::jsonb)
                   FROM jsonb_array_elements(m.actions) WITH ORDINALITY a(value,ordinality))
             ) ORDER BY m.created_at,m.id),'[]'::jsonb) FROM measured m)
         ELSE '[]'::jsonb END
    INTO v_count,v_bytes,v_invalid,v_missing_receipt,v_actions,v_rows FROM totals t;

  RETURN jsonb_build_object(
    'version',1,
    'status',CASE WHEN v_count > 512 OR v_bytes > 8388608 OR v_actions > 20000 OR v_invalid OR v_missing_receipt
                  THEN 'unavailable' ELSE 'snapshot' END,
    'reason',CASE WHEN v_count > 512 THEN 'hand_budget_exceeded'
                  WHEN v_bytes > 8388608 THEN 'byte_budget_exceeded'
                  WHEN v_actions > 20000 THEN 'action_budget_exceeded'
                  WHEN v_invalid THEN 'invalid_or_oversized_hand'
                  WHEN v_missing_receipt THEN 'atomic_receipt_missing' ELSE NULL END,
    'actor',p_actor,'fromMs',p_from_ms,'throughMs',p_through_ms,
    'readAtMs',v_now_ms,'snapshotId',pg_current_snapshot()::text,
    'coverage','retained_committed_roster_rows','acceptance','atomic_hand_receipts',
    'handCount',v_count,'actionCount',v_actions,'sourceBytes',v_bytes,'hands',v_rows
  );
END
$function$;

-- Grants restated exactly as installed (read 2026-10-25: service_role only).
REVOKE ALL ON FUNCTION public.fn_claim_horse_observation_capture(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_horse_observation_capture(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_finish_horse_observation_capture(text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_finish_horse_observation_capture(text, uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_discover_horse_observation_requests() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_discover_horse_observation_requests() TO service_role;
REVOKE ALL ON FUNCTION public.fn_horse_committed_observation_snapshot(uuid, bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_committed_observation_snapshot(uuid, bigint, bigint) TO service_role;

-- Post-image: each body is the one written above, and each function kept its
-- security mode, volatility, settings and grants exactly.
DO $horse_capture_drains_in_order_post$
DECLARE bad text;
BEGIN
  SELECT string_agg(expected.sig, ', ') INTO bad FROM (VALUES
    ('public.fn_claim_horse_observation_capture(uuid)','dc550cf72b59ffd1ec885520c28c9e1d',true,'v',ARRAY['search_path=pg_catalog, public, pg_temp','lock_timeout=2s']::text[]),
    ('public.fn_finish_horse_observation_capture(text,uuid,text,text)','2e1419931681fa5391340b5478032882',true,'v',ARRAY['search_path=pg_catalog, public, pg_temp','lock_timeout=2s']::text[]),
    ('public.fn_discover_horse_observation_requests()','ee32a5b8c75d02b896ea370f10a0b164',true,'v',ARRAY['search_path=pg_catalog, public, pg_temp','lock_timeout=2s']::text[]),
    ('public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint)','868b47cd0f748c7ab3cdd597c001c841',false,'s',ARRAY['search_path=pg_catalog, public, pg_temp']::text[]),
    ('public.fn_horse_capture_hand_budget_through(uuid,bigint,bigint,integer)','ff39c3189f1b33df8200864e1b4a9921',false,'s',ARRAY['search_path=pg_catalog, public, pg_temp']::text[])
  ) expected(sig,body,secdef,volatility,config)
    LEFT JOIN pg_proc p ON p.oid = to_regprocedure(expected.sig)
   WHERE p.oid IS NULL OR md5(p.prosrc) <> expected.body OR p.prosecdef <> expected.secdef
      OR p.provolatile::text <> expected.volatility OR p.proconfig IS DISTINCT FROM expected.config
      OR NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
      OR has_function_privilege('anon', p.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
      OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'HORSE_CAPTURE_DRAINS_IN_ORDER_POSTIMAGE: % lost its body, security mode, volatility, settings or grants', bad;
  END IF;
END
$horse_capture_drains_in_order_post$;

COMMIT;
