-- 20260922022319_a_superseded_original_hands_off_its_retained_hand
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-22 02:23:19 UTC.
--
-- WHAT FROZE. On 2026-09-18 between 23:08:14 and 23:12:25 UTC engine process
-- 1-3846b8bb retained the exact settlement request of 69 finished tournament
-- hands (51 Spin, 10 SNG, 8 MTT) through fn_ca_retain_hand_submission, then
-- its own in-process lease proof expired before it dispatched them:
-- financial_alerts carries "atomic hand commit refused (lease_proof_expired)"
-- for each one. The request was never sent, so the database holds no atomic
-- receipt, no failure row, no handoff and no f06_hand_dispatch row for any of
-- them. The same process then claimed every one of those tournament leases
-- again under a NEW generation (23:14:08 to 23:14:33) and has heartbeated it
-- ever since. Each new manager asks fn_ca_resume_hand_submission to continue
-- its table and is refused with original_failure_or_handoff_unproven, about
-- 950 refusals in 30 minutes on 2026-09-22. The refusal can never change:
-- only a DATABASE rollback writes smarter_private.hand_submission_failures,
-- and f06_retained_submission_guard forbids a no-start disposition for a
-- retained hand, so no path could ever finish these hands. Their seats (horses
-- among them) stay occupied and new Spins and SNGs cannot fill.
--
-- THE PROOF THIS ADMITS. A successor that verified, under FOR KEY SHARE, that
-- the scope lease holds ITS protocol-2 generation, and that this generation is
-- not the original's, may continue the original once through the existing
-- handoff. That is airtight for these reasons, each read from the installed
-- catalog on 2026-09-22 and pinned below so the migration refuses if any moved:
--  1. The only writer of public.hand_atomic_commits is the owner-only
--     fn_ca_commit_hand_settlement_before_lease_generation, reached only
--     through the exact-generation core, reached only through the twelve-
--     argument public door. That door takes this hand's submission lock
--     (assert_retained_hand_submission) before its lease check and holds it to
--     the end of its transaction. The resume reads the receipt after taking
--     the same lock, so a settlement in flight is waited for and then seen.
--  2. The exact-generation core refuses any generation the lease row does not
--     hold, reading it FOR KEY SHARE. The only writers that change a protocol-2
--     generation (claim_tournament_lease_v2, claim_table_lease_v2) take FOR
--     UPDATE first, and releases DELETE, so the successor's own FOR KEY SHARE
--     keeps the original out for the whole handoff transaction.
--  3. hand_atomic_commits is unique on (table_id,hand_number), hand_number and
--     hand_id, and the core replays an existing receipt with the same payload
--     hash (it excludes the lease identity) without touching a stack. So an
--     original that ever held the lease again could only replay this receipt.
--  4. The handoff settles the retained request byte for byte, only while every
--     seat still holds its recorded stack_before and no later hand, receipt or
--     permit exists, and the one financial claim stays single use.
-- The same-generation caller is still refused: it is the original owner and
-- owns fn_ca_commit_hand_submission. Every other refusal is unchanged.
--
-- THE SECOND DEFECT ON THE SAME PATH. The handoff admitted only
-- tables.lifecycle='live'. Production tournament tables never carry 'live'
-- (199,656 NULL, 65,874 closed, 0 live on 2026-09-22); only cash tables do.
-- The qualification fixture inserted its tournament table as 'live', so a
-- tournament handoff was never admitted in production even with a failure
-- row. A tournament table is now admitted while its lifecycle is NULL; cash
-- still requires 'live'; opening, breaking and closed are still refused.
--
-- The handoff result now records which proof admitted it
-- (handoff_evidence: canonical_failure or superseded_generation).
-- No data or money changes on install. This is not a sweep: nothing runs until
-- a current lease holder admits that table through its own start.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock_shared(530090,1);
DO $$ BEGIN IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'HAND_SUBMISSION_SUCCESSOR_INSTALL_FROZEN'; END IF; END $$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_resume_hand_submission(uuid,text,uuid)') AND md5(pg_get_functiondef(oid))='553f5e192dadc1a6ada9bf855d68e223' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_SUCCESSOR_DRIFT: %','public.fn_ca_resume_hand_submission(uuid,text,uuid)'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)') AND md5(pg_get_functiondef(oid))='c5f1e51d639f29e6650ae4560af5fb24' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_SUCCESSOR_DRIFT: %','public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)') AND md5(pg_get_functiondef(oid))='c555fb7b83c889312995bc0038c1b275' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_SUCCESSOR_DRIFT: %','public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)') AND md5(pg_get_functiondef(oid))='b49192e78f472d7a931bcf20de46a702' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_SUCCESSOR_DRIFT: %','public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.assert_retained_hand_submission(jsonb)') AND md5(pg_get_functiondef(oid))='6a3ab631fdab87ae9bcd353907de80b6' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_SUCCESSOR_DRIFT: %','smarter_private.assert_retained_hand_submission(jsonb)'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)') AND md5(pg_get_functiondef(oid))='1d5fdcf284efb107c4f5e2a3be364fb0' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_SUCCESSOR_DRIFT: %','public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.claim_table_lease_v2(uuid,text,text,uuid,integer)') AND md5(pg_get_functiondef(oid))='2c6a2555d927c8dbbad47b8ac7b60552' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_SUCCESSOR_DRIFT: %','public.claim_table_lease_v2(uuid,text,text,uuid,integer)'; END IF; END $pin$;
DO $writers$ BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE prosrc ~* 'insert\s+into\s+(public\.)?hand_atomic_commits')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'::regprocedure AND prosrc ~* 'insert\s+into\s+(public\.)?hand_atomic_commits') THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_SUCCESSOR_DRIFT: %','hand receipt writer'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.hand_atomic_commits'::regclass AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (table_id, hand_number)') THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_SUCCESSOR_DRIFT: %','hand receipt identity'; END IF;
END $writers$;
CREATE OR REPLACE FUNCTION public.fn_ca_resume_hand_submission(p_table_id uuid,p_instance_id text,p_lease_generation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE s smarter_private.hand_submissions; h smarter_private.f06_hand_permits;
 a public.hand_atomic_commits; q jsonb; r jsonb; post jsonb; finished jsonb;
 tour uuid; locked_tour uuid; holder text; generation uuid; protocol integer; beat timestamptz;
 users uuid[]; code text; message text; claimed boolean:=false; evidence text;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'HAND_SUBMISSION_ENGINE_ONLY' USING ERRCODE='42501'; END IF;
 SELECT j.* INTO s FROM smarter_private.hand_submissions j
 LEFT JOIN public.hand_atomic_commits c ON c.table_id=j.table_id AND c.hand_number=j.hand_number
 LEFT JOIN smarter_private.f06_hand_permits p ON p.table_id=j.table_id AND p.hand_number=j.hand_number
 WHERE j.table_id=p_table_id AND (c.hand_id IS DISTINCT FROM j.submission_id OR c.post_commit_completed_at IS NULL
   OR c.post_commit_result->>'ok' IS DISTINCT FROM 'true' OR p.state='reserved')
 ORDER BY j.hand_number LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;
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
  -- whole table. No later hand/permit may have consumed this starting state.
  q:=s.request;
  IF NOT EXISTS(SELECT 1 FROM public.tables WHERE id=s.table_id
      AND NOT COALESCE(is_deleted,false) AND lower(status) IN ('waiting','running')
      -- Cash tables are 'live'; a tournament table keeps NULL until it closes.
      AND (lifecycle='live' OR (tour IS NOT NULL AND lifecycle IS NULL)))
   OR (tour IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=tour AND upper(status)='RUNNING')) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_TABLE_NOT_ADMITTED' USING ERRCODE='55000'; END IF;
  IF jsonb_array_length(q->'p_stacks')=0 OR
   (SELECT count(*) FROM public.table_seats WHERE table_id=s.table_id AND left_at IS NULL)<>jsonb_array_length(q->'p_stacks')
   OR (SELECT count(DISTINCT x->>'seat_id') FROM jsonb_array_elements(q->'p_stacks') x)<>jsonb_array_length(q->'p_stacks')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_stacks') x WHERE NOT EXISTS(
     SELECT 1 FROM public.table_seats seat WHERE seat.table_id=s.table_id AND seat.id=(x->>'seat_id')::uuid
       AND seat.user_id=(x->>'user_id')::uuid AND seat.joined_at=(x->>'seat_joined_at')::timestamptz
       AND seat.left_at IS NULL AND seat.stack=(x->>'stack_before')::numeric))
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
   RETURN r||jsonb_build_object('found',true,'completed',false,'reason','accepted_postcommit_pending'); END IF;
  IF tour IS NOT NULL THEN
   finished:=public.fn_f06_finish_hand(tour,p_lease_generation,h.permit_id,'accepted',s.submission_id);
   IF finished->>'ok' IS DISTINCT FROM 'true' OR finished->>'state' IS DISTINCT FROM 'accepted'
    OR finished->>'evidence_id' IS DISTINCT FROM s.submission_id::text THEN
    RAISE EXCEPTION 'HAND_SUBMISSION_PERMIT_COMPLETION_UNPROVEN' USING ERRCODE='55000'; END IF;
  END IF;
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
  RETURN r||jsonb_build_object('found',true,'completed',false,'reason','accepted_postcommit_pending','sqlstate',code,'error',message);
 END;
 RETURN r||jsonb_build_object('found',true,'completed',true,'hand_number',s.hand_number::text,
   'financial_handoff',claimed,'permit_id',h.permit_id,'post_commit_completed',true);
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_resume_hand_submission(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_resume_hand_submission(uuid,text,uuid) TO service_role;
DO $installed$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure
  AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog, public']
  AND proacl::text='{postgres=X/postgres,service_role=X/postgres}'
  AND prosrc LIKE '%superseded_generation%' AND prosrc NOT LIKE '%lifecycle=''live'' AND lower(status)%') THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_SUCCESSOR_INSTALL_UNPROVEN'; END IF;
END $installed$;
COMMIT;
