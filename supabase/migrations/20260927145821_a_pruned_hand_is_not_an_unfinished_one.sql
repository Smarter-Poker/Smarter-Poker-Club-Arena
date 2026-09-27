-- 20260927145821_a_pruned_hand_is_not_an_unfinished_one.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  A PRUNED HAND IS NOT AN UNFINISHED ONE
-- ===========================================================================
--
-- What was wrong
-- --------------
-- smarter_private.hand_submissions (20260918092329) keeps every original
-- settlement request for ever: hand_submission_immutable refuses UPDATE,
-- DELETE and TRUNCATE. public.sp_prune_hand_history deletes the
-- public.hand_atomic_commits row (and the hand_history row) of every
-- horse-only hand at hand_history_retention_policy.horse_retention_days -
-- eight days, Dan's storage decision of 2026-09-17, unchanged here.
--
-- public.fn_ca_resume_hand_submission, which the engine asks at EVERY table
-- admission (cash checkCrashRecovery, tournament startManagedTableEngine,
-- F06 successor admission), selects the table's lowest submission whose
-- commit row is not the submission's own completed commit. A pruned commit
-- is an empty coordinate, so from the moment the first submission turned
-- eight days old (2026-09-26 22:02 UTC; the table's first row was retained
-- 2026-09-18 22:02) every pruned horse hand looked like an unfinished
-- retained original. The door then walks into the successor handoff and
-- refuses HAND_SUBMISSION_HANDOFF_STATE_CHANGED, because later commits exist
-- at the table - on every ask, for ever. The engine's
-- resumeRetainedHandSubmission (server/src/services/supabase/handHistory.ts)
-- throws retained_hand_submission_readback_failed on that error, so the
-- table cannot be admitted.
--
-- Measured on production 2026-09-27 14:30-15:00 UTC (read-only):
--   * 245,536 submissions with no commit row, at 2,686 tables, all retained
--     2026-09-18 22:02 - 2026-09-19 14:52 (the pruned window), plus 2 from
--     2026-09-22 that are genuinely unsettled last hands;
--   * 84 of those tables are live (71 running cash, 9 waiting cash, 4
--     running tournament tables); every one of them now refuses admission;
--   * PostgREST 500s on /rpc/fn_ca_resume_hand_submission rose from ~800-1,600
--     an hour to 8,392 at 2026-09-27 00:00 and ~16,500 an hour since, ~4 a
--     second of HAND_SUBMISSION_HANDOFF_STATE_CHANGED outside every break;
--   * running cash tables with six seated players and pruned submissions
--     have not committed a hand since the 2026-09-26 23:55 break, while
--     tables without them keep dealing.
-- The engine has not been replaced since 2026-09-26 14:06 (the restart gate
-- has refused since), so tables that never re-admitted are still dealing.
-- The next engine replacement re-admits every table at once.
--
-- The cause is a permanent obligation reading impermanent evidence, the same
-- shape as 20260925210126 (a live table keeps the boundary its movement
-- reads), fixed the same way at both places:
--
-- FIX 1 - the door reads the witness that survives. The handoff below
-- already refuses any submission with a commit at or after its hand
-- (HAND_SUBMISSION_HANDOFF_STATE_CHANGED), so an EMPTY coordinate with a
-- LATER commit on the same table is a hand this door can never continue,
-- whether retention took its commit or it was never settled. It no longer
-- holds admission. Everything else is selected exactly as before:
--   * a DIFFERENT commit at the coordinate (HAND_SUBMISSION_ACCEPTANCE_UNPROVEN);
--   * the submission's own commit with post-commit work pending;
--   * a 'reserved' F06 permit, empty coordinate or not;
--   * an empty coordinate with NO later commit - a retained original that may
--     still be continued, which is what this door exists for.
-- No hand is settled, voided, re-dealt or reconstructed by this change, and
-- the financial handoff (claim, core, acknowledgement, post-commit, permit
-- finish) is byte-for-byte the 20260926091630 body.
--
-- FIX 2 - a live table keeps its last commit. FIX 1 proves an older pruned
-- submission finished only through a later commit on the same table. Retention
-- could still take a live table's LAST commit (a table idle for eight days),
-- after which its last submission would again read as unfinished with no later
-- commit to prove otherwise. sp_prune_hand_history now also keeps the last
-- committed hand of any live table (waiting or running, not deleted), through
-- smarter_private.live_table_last_commit_retained, beside the existing F06
-- boundary guard. One hand per live table (1,336 live tables today), and it
-- releases itself when the table deals its next hand or closes.
--
-- The pruning boundary, the retention days, the F06 guards and the
-- rake-attribution rule of sp_prune_hand_history are unchanged; the clause is
-- inserted by asserted text substitution directly after the F06 boundary
-- guard, which exists exactly once in both known bodies (20260925210126 and
-- 20260926151328).
--
-- Regression: scripts/ci/test-pruned-hand-is-not-unfinished-postgres.py builds
-- a disposable PostgreSQL cluster, installs the 20260926091630 door and the
-- 20260925210126 retention body, reproduces the refusal, applies this file and
-- proves the admission and the retention boundary. Law:
-- tests/a-pruned-hand-is-not-an-unfinished-one.law.test.ts.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $pre$
DECLARE v_def text; v_n integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure
       AND md5(p.prosrc) = '828edb105fa8d69f089430d7945f5fb9'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public"}'
       AND p.prosecdef) THEN
    RAISE EXCEPTION 'PREIMAGE: fn_ca_resume_hand_submission is not the definition of 20260926091630';
  END IF;

  IF (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = 'public.sp_prune_hand_history(integer)'::regprocedure)
     NOT IN ('f0334f1595384bb608a6c99af86b568a', 'f776fcb97431b343e7cb8f469f51aa42') THEN
    RAISE EXCEPTION 'PREIMAGE: sp_prune_hand_history is neither the 20260925210126 nor the 20260926151328 body';
  END IF;

  v_def := pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure);
  v_n := (length(v_def) - length(replace(v_def,
    'AND NOT smarter_private.f06_movement_boundary_retained(hh.table_id,hh.hand_number::bigint)', '')))
    / length('AND NOT smarter_private.f06_movement_boundary_retained(hh.table_id,hh.hand_number::bigint)');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'PREIMAGE: sp_prune_hand_history carries % F06 boundary guard(s), expected 1', v_n;
  END IF;

  IF to_regprocedure('smarter_private.live_table_last_commit_retained(uuid,bigint)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREIMAGE: smarter_private.live_table_last_commit_retained already exists';
  END IF;
END
$pre$;

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
   -- A PRUNED HAND IS NOT AN UNFINISHED ONE (20260927145821). Retention
   -- (sp_prune_hand_history) deletes an eight-day-old hand's commit row, and
   -- this immutable submission outlives it. An EMPTY coordinate with a LATER
   -- commit on the same table is a hand this door can never continue: the
   -- handoff below refuses any commit at or after the hand. Such a row holds
   -- no admission. A different commit at the coordinate, a commit with
   -- pending post-commit work, a 'reserved' permit and an empty coordinate
   -- with no later commit are all selected exactly as before.
   AND NOT (c.table_id IS NULL AND p.state IS DISTINCT FROM 'reserved'
     AND EXISTS(SELECT 1 FROM public.hand_atomic_commits later
       WHERE later.table_id=j.table_id AND later.hand_number>j.hand_number))
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
  -- table. No later hand/permit may have consumed this starting state.
  -- A chair taken AFTER this hand was dealt is not part of it: it was not
  -- dealt in, the hand cannot move its chips, and the committed stacks name
  -- only the hand's own seats. Such a chair must not hold the finished hand
  -- hostage (2026-09-26, 8ec7e81d: a late registrant seated 30 s after the
  -- hand ended froze its table for eight days). A chair that was present at
  -- the deal and is missing from the submission, or a hand player seated
  -- twice, still refuses; an undated deal refuses.
  q:=s.request;
  IF NOT EXISTS(SELECT 1 FROM public.tables WHERE id=s.table_id
      AND NOT COALESCE(is_deleted,false) AND lower(status) IN ('waiting','running')
      -- Cash tables are 'live'; a tournament table keeps NULL until it closes.
      AND (lifecycle='live' OR (tour IS NOT NULL AND lifecycle IS NULL)))
   OR (tour IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=tour AND upper(status)='RUNNING')) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_TABLE_NOT_ADMITTED' USING ERRCODE='55000'; END IF;
  IF jsonb_array_length(q->'p_stacks')=0 OR
   (q->'p_hand_row'->>'started_at') IS NULL
   OR EXISTS(SELECT 1 FROM public.table_seats late WHERE late.table_id=s.table_id AND late.left_at IS NULL
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_stacks') x WHERE (x->>'seat_id')::uuid=late.id)
     AND (late.joined_at<=(q->'p_hand_row'->>'started_at')::timestamptz
       OR late.user_id IN (SELECT (x->>'user_id')::uuid FROM jsonb_array_elements(q->'p_stacks') x)))
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

CREATE FUNCTION smarter_private.live_table_last_commit_retained(p_table_id uuid, p_hand_number bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.tables tb
     WHERE tb.id = p_table_id
       AND NOT COALESCE(tb.is_deleted, false)
       AND lower(COALESCE(tb.status, '')) IN ('waiting', 'running')
       AND p_hand_number = (
         SELECT max(a.hand_number) FROM public.hand_atomic_commits a
          WHERE a.table_id = p_table_id)
  );
$function$;

COMMENT ON FUNCTION smarter_private.live_table_last_commit_retained(uuid, bigint) IS
  'True for the last committed hand of a live (waiting or running, not deleted) '
  'table. public.fn_ca_resume_hand_submission proves an older submission whose '
  'commit row retention took finished only through a later commit on the same '
  'table, so public.sp_prune_hand_history retains this one. Releases itself '
  'when the table deals its next hand or closes. See migration 20260927145821.';

REVOKE ALL ON FUNCTION smarter_private.live_table_last_commit_retained(uuid, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION smarter_private.live_table_last_commit_retained(uuid, bigint) TO service_role;

DO $prune$
DECLARE
  v_def text;
  v_anchor constant text :=
    'AND NOT smarter_private.f06_movement_boundary_retained(hh.table_id,hh.hand_number::bigint)';
  v_with constant text :=
    'AND NOT smarter_private.f06_movement_boundary_retained(hh.table_id,hh.hand_number::bigint)' || E'\n'
    || E'         -- AND the last committed hand of any live table (20260927145821).\n'
    || E'         -- public.fn_ca_resume_hand_submission, asked at every table\n'
    || E'         -- admission, proves an older submission whose commit row this\n'
    || E'         -- function took finished only through a LATER commit on the same\n'
    || E'         -- table. Keeping the live table''s last commit keeps that proof for\n'
    || E'         -- every older one. One hand per live table; it releases itself when\n'
    || E'         -- the table deals its next hand or closes.\n'
    || E'         AND NOT smarter_private.live_table_last_commit_retained(hh.table_id,hh.hand_number::bigint)';
BEGIN
  v_def := pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure);
  EXECUTE replace(v_def, v_anchor, v_with);
END
$prune$;

DO $post$
DECLARE v_src text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure
       AND md5(p.prosrc) = '1a6fefb7c5eeadfd70f4be08ad00e5a5'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public"}'
       AND p.prosecdef) THEN
    RAISE EXCEPTION 'POSTIMAGE: fn_ca_resume_hand_submission is not the pruned-hand definition with its owner, grants and settings';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = 'public.sp_prune_hand_history(integer)'::regprocedure
     AND pg_get_userbyid(p.proowner) = 'postgres'
     AND p.proconfig::text = '{"search_path=public, pg_temp"}'
     AND NOT p.prosecdef;
  IF v_src IS NULL
     OR (length(v_src) - length(replace(v_src, 'smarter_private.live_table_last_commit_retained(hh.table_id,hh.hand_number::bigint)', '')))
        / length('smarter_private.live_table_last_commit_retained(hh.table_id,hh.hand_number::bigint)') <> 1
     OR position('smarter_private.f06_movement_boundary_retained(hh.table_id,hh.hand_number::bigint)' IN v_src) = 0
     OR position('smarter_private.f06_hand_cards_unresolved(hh.table_id,hh.hand_number::bigint)' IN v_src) = 0
     OR position('hh.created_at<now()-v_window' IN v_src) = 0
     OR position('DELETE FROM public.hand_atomic_commits WHERE hand_id=ANY(v_doomed);' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTIMAGE: sp_prune_hand_history does not carry exactly one live-table guard beside its unchanged guards';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'smarter_private.live_table_last_commit_retained(uuid,bigint)'::regprocedure
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's') THEN
    RAISE EXCEPTION 'POSTIMAGE: smarter_private.live_table_last_commit_retained is missing or not a stable definer';
  END IF;
END
$post$;

COMMIT;
