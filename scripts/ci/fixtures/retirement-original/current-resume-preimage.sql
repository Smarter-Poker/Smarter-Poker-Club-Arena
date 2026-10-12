-- Exact public resume preimage captured read-only 2026-10-07; not executed as a financial owner by this helper qualifier.
CREATE OR REPLACE FUNCTION public.fn_ca_resume_hand_submission(p_table_id uuid, p_instance_id text, p_lease_generation uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE s smarter_private.hand_submissions; h smarter_private.f06_hand_permits;
 a public.hand_atomic_commits; q jsonb; r jsonb; post jsonb; finished jsonb;
 tour uuid; locked_tour uuid; holder text; generation uuid; protocol integer; beat timestamptz;
 users uuid[]; code text; message text; claimed boolean:=false; evidence text;
 mark bigint; lo bigint; hi bigint; window_rows integer; windows integer:=0;
 retirement_restored boolean:=false;
 retired_cash_restored boolean:=false;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'HAND_SUBMISSION_ENGINE_ONLY' USING ERRCODE='42501'; END IF;
 -- THE READ STARTS AT THE TABLE'S SETTLED MARK, A BOUNDED WINDOW AT A TIME
 -- (2026-10-02). This read walked EVERY submission the table ever retained
 -- (23,405 rows on one cash table, a heap fetch each in a 33 GB relation) to
 -- answer "nothing unfinished": 1.8 s warm, past the 8 s statement timeout
 -- cold, 15,085 timeouts in 12 hours, and each one refused the table's start.
 -- A finished submission stays finished (disposals and submissions are
 -- immutable; a completed post-commit is never reopened; a permit is
 -- reserved only for a new, higher hand), and only the current lease
 -- generation can retain, after this start, a higher hand number. So every
 -- hand at or below the mark is settled for ever, and the walk resumes above
 -- it. Windows of 200 hands are read until two seconds of this statement
 -- have passed (a cold hand costs ~2 random reads: 2,500 timed out at 5 s on
 -- 2026-10-02 09:25 and a 500 window started late still passed 8 s at 10:20);
 -- a table with more unread history keeps its progress and answers pending,
 -- which every caller already retries.
 SELECT m.settled_through INTO mark FROM smarter_private.hand_submission_resume_marks m
  WHERE m.table_id=p_table_id;
 lo:=COALESCE(mark,-1);
 LOOP
  SELECT max(w.hand_number),count(*) INTO hi,window_rows FROM (SELECT j.hand_number
    FROM smarter_private.hand_submissions j WHERE j.table_id=p_table_id AND j.hand_number>lo
    ORDER BY j.hand_number LIMIT 200) w;
  s:=NULL;
  EXIT WHEN window_rows=0;
  SELECT j.* INTO s FROM smarter_private.hand_submissions j
  LEFT JOIN public.hand_atomic_commits c ON c.table_id=j.table_id AND c.hand_number=j.hand_number
  LEFT JOIN smarter_private.f06_hand_permits p ON p.table_id=j.table_id AND p.hand_number=j.hand_number
  WHERE j.table_id=p_table_id AND j.hand_number>lo AND j.hand_number<=hi
  AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals dd
    WHERE dd.table_id=j.table_id AND dd.hand_number=j.hand_number)
  AND (c.hand_id IS DISTINCT FROM j.submission_id OR c.post_commit_completed_at IS NULL
    OR c.post_commit_result->>'ok' IS DISTINCT FROM 'true' OR p.state='reserved')
  ORDER BY j.hand_number LIMIT 1;
  EXIT WHEN FOUND;
  lo:=hi; windows:=windows+1;
  EXIT WHEN window_rows<200;
  IF clock_timestamp()-statement_timestamp()>interval '2 seconds' THEN
   INSERT INTO smarter_private.hand_submission_resume_marks(table_id,settled_through,marked_at)
    VALUES(p_table_id,lo,clock_timestamp())
   ON CONFLICT(table_id) DO UPDATE SET settled_through=greatest(hand_submission_resume_marks.settled_through,EXCLUDED.settled_through),marked_at=EXCLUDED.marked_at;
   RETURN jsonb_build_object('found',true,'completed',false,'reason','resume_scan_continues','settled_through',lo::text);
  END IF;
 END LOOP;
 IF lo>COALESCE(mark,-1) THEN
  INSERT INTO smarter_private.hand_submission_resume_marks(table_id,settled_through,marked_at)
   VALUES(p_table_id,lo,clock_timestamp())
  ON CONFLICT(table_id) DO UPDATE SET settled_through=greatest(hand_submission_resume_marks.settled_through,EXCLUDED.settled_through),marked_at=EXCLUDED.marked_at;
 END IF;
 IF s.submission_id IS NULL THEN RETURN jsonb_build_object('found',false); END IF;
 -- This is startup continuation, not an in-flight original settlement. Keep
 -- both financial handoff and accepted postcommit behind the existing freeze
 -- boundary, before any lease or lifecycle lane. Refusal spends no claim.
 IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_MAINTENANCE_BUSY' USING ERRCODE='55P03'; END IF;
 IF public.fn_platform_frozen() THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 SELECT tournament_id INTO tour FROM public.tables WHERE id=p_table_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'HAND_SUBMISSION_TABLE_MISSING' USING ERRCODE='55000'; END IF;
 IF tour IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM smarter_private.retirement_original_hand_qualification c WHERE c.submission_id=s.submission_id) THEN
   PERFORM public.fn_ca_lock_settlement_lane_for_tournament(tour,p_table_id);
  END IF;
  SELECT array_agg((x->>'user_id')::uuid ORDER BY x->>'user_id') INTO users FROM jsonb_array_elements(s.request->'p_stacks') x;
  PERFORM smarter_private.f06_prefix(tour,p_lease_generation,users,ARRAY[p_table_id]);
  SELECT instance_id,lease_generation,protocol_version,heartbeat_at INTO holder,generation,protocol,beat
   FROM public.engine_tournament_leases WHERE tournament_id=tour FOR KEY SHARE;
 ELSE
  SELECT instance_id,lease_generation,protocol_version,heartbeat_at INTO holder,generation,protocol,beat
   FROM public.engine_table_leases WHERE table_id=p_table_id FOR KEY SHARE;
  PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||s.table_id::text||':'||s.hand_number::text,0));
  PERFORM 1 FROM public.tables WHERE id=p_table_id FOR UPDATE;
  PERFORM 1 FROM public.table_seats WHERE table_id=p_table_id ORDER BY id FOR UPDATE;
 END IF;
 IF holder IS DISTINCT FROM p_instance_id OR generation IS DISTINCT FROM p_lease_generation OR protocol IS DISTINCT FROM 2
 OR beat IS NULL OR beat<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_LEASE_UNPROVEN' USING ERRCODE='55000'; END IF;
 SELECT tournament_id INTO locked_tour FROM public.tables WHERE id=p_table_id;
 IF locked_tour IS DISTINCT FROM tour THEN RAISE EXCEPTION 'HAND_SUBMISSION_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 -- A HAND THIS CASH TABLE HAS ALREADY DEALT PAST IS DISPOSED AT ITS DOOR
 -- (2026-09-29). A later committed hand consumed the before-stacks this
 -- request names, so nobody can ever apply it; the receipted, zero-credit
 -- disposal is written here, under this caller's proven lease and the
 -- table's locks, and the next unfinished request is read. A tournament
 -- table's dead hands stay with the F06 abort doors.
 IF tour IS NULL AND EXISTS(SELECT 1 FROM public.hand_atomic_commits
   WHERE table_id=p_table_id AND hand_number>s.hand_number)
  AND smarter_private.hand_submission_dispose_dealt_past(p_table_id,s.hand_number)>0 THEN
  -- The next unfinished request, read above the hands just disposed and
  -- inside the window already proven: everything at or below lo is settled.
  SELECT j.* INTO s FROM smarter_private.hand_submissions j
  LEFT JOIN public.hand_atomic_commits c ON c.table_id=j.table_id AND c.hand_number=j.hand_number
  LEFT JOIN smarter_private.f06_hand_permits p ON p.table_id=j.table_id AND p.hand_number=j.hand_number
  WHERE j.table_id=p_table_id AND j.hand_number>lo AND j.hand_number<=hi
  AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals dd
    WHERE dd.table_id=j.table_id AND dd.hand_number=j.hand_number)
  AND (c.hand_id IS DISTINCT FROM j.submission_id OR c.post_commit_completed_at IS NULL
    OR c.post_commit_result->>'ok' IS DISTINCT FROM 'true' OR p.state='reserved')
  ORDER BY j.hand_number LIMIT 1;
  IF NOT FOUND AND window_rows>=200 THEN
   RETURN jsonb_build_object('found',true,'completed',false,'reason','resume_scan_continues','settled_through',lo::text); END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||s.table_id::text||':'||s.hand_number::text,0));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||s.table_id::text||':'||s.hand_number::text,0));
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE table_id=s.table_id AND hand_number=s.hand_number;
 IF tour IS NOT NULL THEN
  IF h.permit_id IS NULL OR h.tournament_id IS DISTINCT FROM tour OR h.generation IS DISTINCT FROM s.lease_generation
   OR h.state NOT IN('reserved','accepted') THEN RAISE EXCEPTION 'HAND_SUBMISSION_ORIGINAL_PERMIT_REQUIRED' USING ERRCODE='55000'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||h.permit_id::text,0)) THEN
   RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='40001'; END IF;
 END IF;
 SELECT * INTO a FROM public.hand_atomic_commits WHERE table_id=s.table_id AND hand_number=s.hand_number;
 IF FOUND THEN
  IF a.hand_id IS DISTINCT FROM s.submission_id OR a.post_commit_payload IS NULL THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_ACCEPTANCE_UNPROVEN' USING ERRCODE='55000'; END IF;
  r:=a.stack_result||jsonb_build_object('success',true,'atomic_hand_commit',true,'history_id',a.hand_id,
    'commit_hash',a.payload_hash,'post_commit_obligations',true,'post_commit_payload_hash',a.post_commit_payload_hash);
 ELSE
  IF EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs WHERE submission_id=s.submission_id) THEN
   RETURN jsonb_build_object('found',true,'completed',false,'submission_id',s.submission_id,'reason','successor_financial_claim_spent'); END IF;
  -- The original generation owns its own door; it is never its own successor.
  IF s.lease_generation=p_lease_generation THEN
   RETURN jsonb_build_object('found',true,'completed',false,'submission_id',s.submission_id,'reason','original_failure_or_handoff_unproven'); END IF;
  -- A canonical failure row is one proof that the original cannot settle this
  -- hand. The other is read here: the scope lease holds this caller's
  -- generation, not the original's, and this transaction has held that row
  -- FOR KEY SHARE since it was verified, so no takeover or release can move
  -- it until this transaction ends. Every settlement of this hand holds this
  -- hand's submission lock (taken above) from before its own lease check to
  -- its end, and the atomic receipt read under that lock found nothing. So the
  -- original never settled this hand, cannot settle it while its generation is
  -- not the lease, and if it ever holds the lease again it can only replay the
  -- payload-identical receipt this one handoff writes.
  IF generation IS DISTINCT FROM p_lease_generation OR generation IS NOT DISTINCT FROM s.lease_generation THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_LEASE_UNPROVEN' USING ERRCODE='55000'; END IF;
  evidence:=CASE WHEN EXISTS(SELECT 1 FROM smarter_private.hand_submission_failures f
   WHERE f.submission_id=s.submission_id AND f.request_hash=s.request_hash)
   THEN 'canonical_failure' ELSE 'superseded_generation' END;
  -- The original exact generations and before-stacks must still occupy the
  -- table. No later hand/permit may have consumed this starting state.
  -- A chair taken AFTER this hand was dealt is not part of it: it was not
  -- dealt in, the hand cannot move its chips, and the committed stacks name
  -- only the hand's own seats. Such a chair must not hold the finished hand
  -- hostage (2026-09-26, 8ec7e81d: a late registrant seated 30 s after the
  -- hand ended froze its table for eight days). A chair that was present at
  -- the deal and is missing from the submission is admitted only when the
  -- hand declares no inflow, the hand's own record never names its player,
  -- and every player the record names is in the submission (2026-09-29,
  -- 6c9ee4b6: two horses seated 43 s and 18 s before the deal, not dealt in,
  -- froze the table for six days). The settlement still refuses any
  -- non-conserving stack set, so a dealt player left out of the stacks can
  -- never settle. A hand player seated twice still refuses; an undated deal
  -- refuses.
  q:=s.request;
  retirement_restored:=smarter_private.restore_retired_original_tournament_hand(s.submission_id,p_instance_id,p_lease_generation);
  retired_cash_restored:=smarter_private.adopt_retired_cash_original_hand(s.submission_id,p_instance_id,p_lease_generation);
  IF NOT EXISTS(SELECT 1 FROM public.tables WHERE id=s.table_id
      AND NOT COALESCE(is_deleted,false) AND lower(status) IN ('waiting','running')
      -- Cash tables are 'live', or 'breaking' while the table is being closed
      -- (2026-09-29, 499aa67a): the original commit never refused a breaking
      -- cash table, so its successor must not either. A tournament table keeps
      -- NULL until it closes; 'closed' still refuses everywhere.
      AND (lifecycle='live' OR (tour IS NULL AND lifecycle='breaking') OR (tour IS NOT NULL AND lifecycle IS NULL)))
   OR (tour IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=tour AND upper(status)='RUNNING')) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_TABLE_NOT_ADMITTED' USING ERRCODE='55000'; END IF;
  IF jsonb_array_length(q->'p_stacks')=0 OR
   (q->'p_hand_row'->>'started_at') IS NULL
   OR EXISTS(SELECT 1 FROM public.table_seats late WHERE late.table_id=s.table_id AND late.left_at IS NULL
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_stacks') x WHERE (x->>'seat_id')::uuid=late.id)
     AND ((late.joined_at<=(q->'p_hand_row'->>'started_at')::timestamptz
         AND (strpos((q->'p_hand_row')::text,late.user_id::text)>0
           OR COALESCE((q->>'p_inflow')::numeric,0)<>0
           OR jsonb_typeof(q->'p_hand_row'->'players') IS DISTINCT FROM 'array'
           OR EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_hand_row'->'players') hp
             WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_stacks') x WHERE x->>'user_id'=hp->>'userId'))))
       OR late.user_id IN (SELECT (x->>'user_id')::uuid FROM jsonb_array_elements(q->'p_stacks') x)))
   OR (SELECT count(DISTINCT x->>'seat_id') FROM jsonb_array_elements(q->'p_stacks') x)<>jsonb_array_length(q->'p_stacks')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_stacks') x WHERE NOT EXISTS(
     SELECT 1 FROM smarter_private.retired_cash_hand_custody r
      WHERE r.submission_id=s.submission_id AND r.request_hash=s.request_hash AND r.state='held'
       AND r.transaction_id=txid_current() AND r.user_id=(x->>'user_id')::uuid
       AND r.seat_id=(x->>'seat_id')::uuid AND r.occupancy_id=(x->>'occupancy_id')::uuid
       AND r.seat_joined_at=(x->>'seat_joined_at')::timestamptz
       AND r.stack_before=(x->>'stack_before')::numeric AND r.stack_after=(x->>'stack')::numeric)
    AND NOT EXISTS(
     SELECT 1 FROM public.table_seats seat WHERE seat.table_id=s.table_id AND seat.id=(x->>'seat_id')::uuid
       AND seat.user_id=(x->>'user_id')::uuid AND seat.joined_at=(x->>'seat_joined_at')::timestamptz
       AND seat.left_at IS NULL AND (seat.stack=(x->>'stack_before')::numeric
       -- AN ADD-ON CREDITED WHILE THE HAND WAITED (2026-10-02). A tournament
       -- chair may hold exactly the event's addon_chips more than the hand
       -- dealt from, only when its registration bought the add-on. The
       -- settlement runs in delta mode (every element carries stack_before),
       -- so that credit is preserved, not overwritten.
       OR (tour IS NOT NULL AND EXISTS(SELECT 1 FROM public.tournament_players tp
         JOIN public.tournaments ev ON ev.id=tp.tournament_id
         WHERE tp.tournament_id=tour AND tp.user_id=seat.user_id AND tp.add_on IS TRUE
           AND COALESCE(ev.addon_chips,0)>0
           AND seat.stack=(x->>'stack_before')::numeric+ev.addon_chips)))))
   OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=s.table_id AND hand_number>=s.hand_number)
   OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=s.table_id AND hand_number>=s.hand_number)
   OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=s.table_id AND hand_number>s.hand_number) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_HANDOFF_STATE_CHANGED' USING ERRCODE='55000'; END IF;
  -- A wait for another lane may outlast the heartbeat or cross the existing
  -- announced freeze clock. Recheck immediately before the irreversible claim.
  IF public.fn_platform_frozen() THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
  IF tour IS NULL THEN
   SELECT heartbeat_at INTO beat FROM public.engine_table_leases WHERE table_id=s.table_id;
  ELSE
   SELECT heartbeat_at INTO beat FROM public.engine_tournament_leases WHERE tournament_id=tour;
  END IF;
  IF beat IS NULL OR beat<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_LEASE_UNPROVEN' USING ERRCODE='55000'; END IF;
  INSERT INTO smarter_private.hand_submission_handoffs(submission_id,original_generation,instance_id,lease_generation,request_hash,transaction_id)
   VALUES(s.submission_id,s.lease_generation,p_instance_id,p_lease_generation,s.request_hash,txid_current());
  claimed:=true;
  BEGIN
   INSERT INTO smarter_private.hand_submission_dispatch VALUES(txid_current(),s.submission_id,s.request_hash,p_instance_id,p_lease_generation);
   r:=public.fn_ca_commit_hand_settlement(s.table_id,s.hand_number,q->'p_stacks',
    (q->>'p_rake')::numeric,(q->>'p_bbj')::numeric,q->>'p_ref',(q->>'p_inflow')::numeric,
    q->'p_hand_row',q->'p_units',p_instance_id,p_lease_generation,q->'p_post_commit_obligations');
  EXCEPTION WHEN OTHERS THEN
   GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
   r:=jsonb_build_object('success',false,'atomic_hand_commit',false,'reason','successor_authority_refused','sqlstate',code,'error',message);
  END;
  -- Metadata restoration is valid only if the SAME original hand commits.
  -- A returned or thrown financial refusal rolls back the entire call,
  -- including every restored row, receipt and handoff claim.
  IF (retirement_restored OR retired_cash_restored) AND (r->>'success' IS DISTINCT FROM 'true' OR r->>'atomic_hand_commit' IS DISTINCT FROM 'true') THEN
   RAISE EXCEPTION 'RETIREMENT_ORIGINAL_HAND_NOT_COMMITTED: %',r USING ERRCODE='P0404';
  END IF;
  -- A lock/freeze/lease admission refusal is not the one financial attempt.
  -- Raise outside the caught subtransaction so its claim also rolls back.
  IF r->>'success' IS DISTINCT FROM 'true' AND (
    r->>'sqlstate' IN ('55P03','40001','40P01')
    OR r->>'reason' IN ('hand_lease_lost','hand_lease_stale','hand_lease_scope_changed','invalid_hand_lease_authority')
    OR (r->>'sqlstate'='42501' AND r->>'error'='F06_LEASE_FENCED')
    OR public.fn_platform_frozen()) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_ADMISSION_CHANGED: %',r USING ERRCODE='40001';
  END IF;
  DELETE FROM smarter_private.hand_submission_dispatch WHERE transaction_id=txid_current() AND submission_id=s.submission_id;
  INSERT INTO smarter_private.hand_submission_handoff_results VALUES(s.submission_id,r||jsonb_build_object('handoff_evidence',evidence));
  IF r->>'success' IS DISTINCT FROM 'true' OR r->>'atomic_hand_commit' IS DISTINCT FROM 'true' THEN
   RETURN jsonb_build_object('found',true,'completed',false,'submission_id',s.submission_id,'reason','successor_financial_refused','outcome',r); END IF;
 END IF;
 r:=smarter_private.acknowledge_hand_submission(s.submission_id,r);
 -- A later current owner may replay this branch after acknowledgment loss.
 -- It never spends or recreates the one-time financial claim.
 BEGIN
  post:=public.fn_ca_process_hand_post_commit_obligations(s.submission_id);
  IF post->>'ok' IS DISTINCT FROM 'true' OR NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits
    WHERE table_id=s.table_id AND hand_number=s.hand_number AND hand_id=s.submission_id
    AND post_commit_completed_at IS NOT NULL AND post_commit_result->>'ok'='true') THEN
   IF retired_cash_restored THEN
    RAISE EXCEPTION 'RETIRED_CASH_ORIGINAL_POSTCOMMIT_NOT_COMPLETED' USING ERRCODE='P0404';
   END IF;
   RETURN r||jsonb_build_object('found',true,'completed',false,'reason','accepted_postcommit_pending'); END IF;
  IF tour IS NOT NULL THEN
   finished:=public.fn_f06_finish_hand(tour,p_lease_generation,h.permit_id,'accepted',s.submission_id);
   IF finished->>'ok' IS DISTINCT FROM 'true' OR finished->>'state' IS DISTINCT FROM 'accepted'
    OR finished->>'evidence_id' IS DISTINCT FROM s.submission_id::text THEN
    RAISE EXCEPTION 'HAND_SUBMISSION_PERMIT_COMPLETION_UNPROVEN' USING ERRCODE='55000'; END IF;
  END IF;
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
  IF retired_cash_restored THEN
   RAISE EXCEPTION 'RETIRED_CASH_ORIGINAL_POSTCOMMIT_REFUSED: % %',code,message USING ERRCODE='P0404';
  END IF;
  RETURN r||jsonb_build_object('found',true,'completed',false,'reason','accepted_postcommit_pending','sqlstate',code,'error',message);
 END;
 IF retired_cash_restored AND EXISTS(SELECT 1 FROM smarter_private.retired_cash_hand_custody c
  WHERE c.submission_id=s.submission_id AND (c.state IS DISTINCT FROM 'consumed'
   OR c.accepted_time_bank IS DISTINCT FROM c.original_time_bank OR c.settlement_id IS NULL)) THEN
  RAISE EXCEPTION 'RETIRED_CASH_ORIGINAL_CUSTODY_NOT_CONSUMED' USING ERRCODE='P0404';
 END IF;
 RETURN r||jsonb_build_object('found',true,'completed',true,'hand_number',s.hand_number::text,
   'financial_handoff',claimed,'permit_id',h.permit_id,'post_commit_completed',true);
END $function$
;
