-- 20260926231546_cash_table_hand_submission_void_door.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  A CASH-TABLE HAND SUBMISSION THAT CAN NEVER RESUME GETS A VOID DOOR
-- ===========================================================================
--
-- Incident: three-cash-tables-permanent-crash-loop-retained-hand-submission-unproven
-- (Production Alerts board, Smarter-Poker-Club-Arena#5070). PR #5174 fixed one
-- of the three tables (3c00d4d0): a confirmed lease release left its dead
-- generation cached, so every restart re-requested the SAME generation and
-- fn_ca_resume_hand_submission's own-generation guard refused it forever.
-- That table is now live-confirmed recovered (0 crash-recovery events in the
-- last 15 minutes, read 2026-09-26T23:0xZ, vs. 131/15min on each of the other
-- two read at the same moment).
--
-- The other two, 6c9ee4b6 and 71d90586, are a DIFFERENT and deeper case,
-- confirmed live by direct read of their current fn_ca_resume_hand_submission
-- candidate (the query below, unmodified, run read-only against production):
--   6c9ee4b6 candidate = submission a76d9941-9d25-45de-a7c3-fc2764825057,
--     hand 13637742, retained 2026-09-22T15:05:32Z
--   71d90586 candidate = submission 3a1bfac4-80cd-4e24-b2ef-574c650247fc,
--     hand 13892489, retained 2026-09-22T20:12:03Z
-- Both are cash tables (tournament_id IS NULL). Prior runs on this board
-- (2026-09-26T18:1xZ-21:1xZ comments) read fn_ca_resume_hand_submission's
-- handoff branch in full and found each one fails a DIFFERENT state-changed
-- check for a reason that cannot un-happen: 6c9ee4b6's submission was dealt
-- to seats that no longer match the live table (two extra seats taken before
-- the recorded started_at that the submission's own p_stacks never counted);
-- 71d90586's has a seat whose live stack has since moved (198.85 -> 450.00,
-- a rebuy taken while the table sat frozen) so the live table_seats row no
-- longer matches what the retained request captured. Neither condition is
-- transient. `fn_ca_resume_hand_submission` is correct to refuse both - a
-- blind replay onto a table whose seats have moved on is exactly what that
-- guard exists to prevent - but nothing exists to say "this specific attempt
-- is abandoned, stop asking" and let the table deal its NEXT hand. So every
-- restart re-selects the same oldest unresolved submission (this candidate
-- query, unmodified, always returns the SAME row until that changes: no
-- newer submission can be legitimately created for a table whose engine
-- can't get past this one), refuses it, and (per PR #5174's own diagnosis)
-- that refusal exception is what feeds `watchdog_kill_rebuild` on a repeating
-- cycle - not a lease-generation problem this time, since the two candidates
-- above already have generations distinct from `s.lease_generation`.
--
-- No zombie-selection bug: a broader read of every retained submission for
-- both tables (4299 rows on 71d90586 alone, back to 2026-09-18) confirmed
-- every one OTHER than the two candidates above already carries its OWN
-- completed hand_atomic_commits row (same hand_id, post_commit_completed_at
-- set) and is correctly skipped by the existing WHERE clause already. The
-- candidate-selection predicate itself is not the defect here.
--
-- THE FIX. A hand that was never atomically committed under ANY submission
-- moved zero chips - the atomic commit is the one write that would have
-- moved them, and it never ran. Voiding such a submission credits nothing,
-- debits nothing, and reads no wallet: it only tells
-- fn_ca_resume_hand_submission's candidate query to stop selecting a request
-- that can provably never be safely replayed, so the table can deal its next
-- hand from the table_seats it actually holds right now. This is cash-only:
-- a tournament hand already has F06's own abort lane
-- (fn_f06_abort_abandoned_generation and siblings); a cash table has none,
-- which is the actual gap.
--
-- fn_ca_void_unsettled_cash_submission(p_table_id, p_hand_number,
-- p_receipt_id, p_reason) is service_role-only, refuses a tournament table,
-- refuses outright if ANY hand_atomic_commits row already exists for that
-- (table_id, hand_number) under any hand_id (the one hard guarantee: this
-- door never touches a hand that settled), takes the exact same
-- 'hand:submission:<table>:<hand_number>' advisory lock
-- fn_ca_resume_hand_submission takes before it would attempt a commit (so
-- the two can never race each other), and is receipt-idempotent
-- (smarter_private.hand_submission_voids.receipt_id UNIQUE) so a retried
-- call after a network blip never double-processes. It writes no stack, no
-- wallet, no chip_ledger row - there is nothing to reconcile because nothing
-- ever moved.
--
-- fn_ca_resume_hand_submission's candidate SELECT gains one clause, byte for
-- byte the rest of the live 828edb10 body: `AND NOT EXISTS (SELECT 1 FROM
-- smarter_private.hand_submission_voids v WHERE v.submission_id =
-- j.submission_id)`.
--
-- Hardening: fn_ca_stuck_cash_hand_submission_check() (its own new pg_cron
-- job, 10-minute cadence, independent of the existing hourly
-- fn_ca_settlement_correctness_check so this migration cannot collide with
-- concurrent edits to that shared function) raises a critical
-- operational_alert_events/financial_alerts row through the existing
-- fn_ca_raise_drift_incident path for any cash-table submission that has sat
-- retained over 10 minutes with no commit and no void - the exact condition
-- that ran undetected on these two tables for four days before this fleet's
-- board caught it by its downstream crash-storm symptom instead.
--
-- Regression test: server/src/engine/CashSubmissionVoidDoorStopsReselection.test.ts
-- (new). Law: tests/a-voided-cash-submission-never-moves-a-chip.law.test.ts
-- pins that fn_ca_void_unsettled_cash_submission's body contains no INSERT
-- into chip_ledger, chip_transactions, or any *_wallet*/*_balance* table, and
-- that it refuses when a hand_atomic_commits row already exists.
--
-- What this does NOT do: it does not itself unstick 6c9ee4b6 or 71d90586.
-- Voiding their two stuck submissions is a live corrective action against
-- production data (calling the new RPC for those two specific rows) and is
-- deliberately left OUT of this migration - a schema/function migration
-- and a live data action are different things, and the board's live-proof
-- discipline asks for the function to exist and be proven safe before it is
-- exercised against the real stuck rows. The board's next run calls
-- fn_ca_void_unsettled_cash_submission for both once this is live, and
-- verifies both tables resume dealing.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure
       AND md5(p.prosrc) = '828edb105fa8d69f089430d7945f5fb9'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public"}'
       AND p.prosecdef
       AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'PREIMAGE: fn_ca_resume_hand_submission is not the definition of 20260926091630 (828edb10)';
  END IF;
END
$pre$;

CREATE TABLE smarter_private.hand_submission_voids (
  submission_id uuid PRIMARY KEY,
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  receipt_id uuid NOT NULL UNIQUE,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 40),
  voided_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX hand_submission_voids_table_hand_idx
  ON smarter_private.hand_submission_voids (table_id, hand_number);
COMMENT ON TABLE smarter_private.hand_submission_voids IS
  'Cash-table hand submissions provably abandoned (no hand_atomic_commits row exists for their hand_number, so no chip ever moved) that fn_ca_resume_hand_submission must stop selecting as resume candidates. Written only by fn_ca_void_unsettled_cash_submission. No wallet/ledger linkage by design - nothing here ever moved money.';

CREATE FUNCTION public.fn_ca_void_unsettled_cash_submission(
  p_table_id uuid, p_hand_number bigint, p_receipt_id uuid, p_reason text
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE
  s smarter_private.hand_submissions;
  existing smarter_private.hand_submission_voids;
  tour uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'HAND_SUBMISSION_VOID_ENGINE_ONLY' USING ERRCODE='42501';
  END IF;
  IF p_table_id IS NULL OR p_hand_number IS NULL OR p_receipt_id IS NULL
     OR length(btrim(COALESCE(p_reason,''))) < 40 THEN
    RAISE EXCEPTION 'HAND_SUBMISSION_VOID_IDENTITY_REQUIRED' USING ERRCODE='22023';
  END IF;

  -- Idempotent replay: the same receipt returns its stored outcome instead
  -- of re-deriving it, so a retried call after a network blip never
  -- double-processes.
  SELECT * INTO existing FROM smarter_private.hand_submission_voids WHERE receipt_id = p_receipt_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'submission_id', existing.submission_id,
      'receipt_id', p_receipt_id, 'voided_at', existing.voided_at);
  END IF;

  -- Same lock key fn_ca_resume_hand_submission takes before it would ever
  -- attempt a commit for this hand, so the two can never race each other.
  PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||p_table_id::text||':'||p_hand_number::text,0));

  SELECT * INTO s FROM smarter_private.hand_submissions WHERE table_id = p_table_id AND hand_number = p_hand_number;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HAND_SUBMISSION_VOID_NOT_FOUND' USING ERRCODE='55000';
  END IF;

  SELECT tournament_id INTO tour FROM public.tables WHERE id = p_table_id;
  IF tour IS NOT NULL THEN
    -- Tournament hands have their own abort lane: fn_f06_abort_abandoned_generation
    -- and siblings. This door is cash-only; a cash table has no such fallback.
    RAISE EXCEPTION 'HAND_SUBMISSION_VOID_CASH_ONLY' USING ERRCODE='55000';
  END IF;

  -- The one guarantee that makes this safe with no wallet write: a hand this
  -- door can void was never atomically committed under ANY submission, so no
  -- chip ever moved for it. If a commit exists - under this submission_id or
  -- a successor's - this door refuses; the caller must never be able to void
  -- a settled hand.
  IF EXISTS (SELECT 1 FROM public.hand_atomic_commits WHERE table_id = p_table_id AND hand_number = p_hand_number) THEN
    RAISE EXCEPTION 'HAND_SUBMISSION_VOID_ALREADY_SETTLED' USING ERRCODE='55000';
  END IF;

  INSERT INTO smarter_private.hand_submission_voids(submission_id, table_id, hand_number, receipt_id, reason)
  VALUES (s.submission_id, p_table_id, p_hand_number, p_receipt_id, p_reason);

  RETURN jsonb_build_object('ok', true, 'replayed', false, 'submission_id', s.submission_id,
    'receipt_id', p_receipt_id, 'voided_at', clock_timestamp());
END
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_void_unsettled_cash_submission(uuid,bigint,uuid,text) FROM PUBLIC, anon, authenticated;

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
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'HAND_SUBMISSION_ENGINE_ONLY' USING ERRCODE='42501'; END IF;
 SELECT j.* INTO s FROM smarter_private.hand_submissions j
 LEFT JOIN public.hand_atomic_commits c ON c.table_id=j.table_id AND c.hand_number=j.hand_number
 LEFT JOIN smarter_private.f06_hand_permits p ON p.table_id=j.table_id AND p.hand_number=j.hand_number
 WHERE j.table_id=p_table_id AND (c.hand_id IS DISTINCT FROM j.submission_id OR c.post_commit_completed_at IS NULL
   OR c.post_commit_result->>'ok' IS DISTINCT FROM 'true' OR p.state='reserved')
   -- A void is proof-carrying: fn_ca_void_unsettled_cash_submission only
   -- ever wrote this row because no hand_atomic_commits existed for this
   -- hand_number, so this submission can never be a genuine resume target.
   AND NOT EXISTS (SELECT 1 FROM smarter_private.hand_submission_voids v WHERE v.submission_id = j.submission_id)
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

CREATE FUNCTION public.fn_ca_stuck_cash_hand_submission_check()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN
    SELECT j.table_id, j.hand_number, j.submission_id, j.retained_at
    FROM smarter_private.hand_submissions j
    JOIN public.tables t ON t.id = j.table_id AND t.tournament_id IS NULL
    LEFT JOIN public.hand_atomic_commits c ON c.table_id=j.table_id AND c.hand_number=j.hand_number
    WHERE (c.hand_id IS DISTINCT FROM j.submission_id OR c.post_commit_completed_at IS NULL
        OR c.post_commit_result->>'ok' IS DISTINCT FROM 'true')
      AND NOT EXISTS (SELECT 1 FROM smarter_private.hand_submission_voids v WHERE v.submission_id = j.submission_id)
      AND j.retained_at < now() - interval '10 minutes'
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_stuck_cash_hand_submission_check', 'settlement_error', 'critical',
      'stuck-cash-submission:' || r.submission_id::text,
      0, NULL, NULL, 'settlement', 'hand_submission', r.submission_id, NULL, NULL, r.table_id, NULL, NULL, NULL, NULL, NULL,
      'a cash table hand submission has sat retained for over 10 minutes with no matching atomic commit and no void - '
        || 'the table will refuse this submission and crash-loop on every restart trying to resume it until it is '
        || 'voided via fn_ca_void_unsettled_cash_submission',
      NULL, jsonb_build_object('submission_id', r.submission_id, 'hand_number', r.hand_number, 'retained_at', r.retained_at));
    n := n + 1;
  END LOOP;
  RETURN n;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_stuck_cash_hand_submission_check() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('ca-stuck-cash-hand-submission-10m', '*/10 * * * *',
  $$SELECT public.fn_ca_stuck_cash_hand_submission_check();$$);

COMMIT;
