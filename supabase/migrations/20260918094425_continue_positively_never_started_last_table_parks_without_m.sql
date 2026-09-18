-- Exact positive original no-start continuation; never an abort or compensation.
-- The service caller must stop/join the current exact source dealer under local
-- registry custody. A persisted reserved row is never original no-start evidence.
-- Current protocol-2 lease stays live so an unknown response can replay safely.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
-- Admit all trigger-bearing relations before any catalog mutation. Never wait
-- holding an earlier hot relation while a live writer needs a later one.
DO $admission$
DECLARE v_deadline timestamptz := clock_timestamp()+interval '3 seconds';
BEGIN
 LOOP
  IF clock_timestamp()>=v_deadline THEN
   RAISE EXCEPTION 'F06_CONTINUATION_INSTALL_ADMISSION_BUSY' USING ERRCODE='55P03';
  END IF;
  BEGIN
   PERFORM set_config('lock_timeout',least(1000,greatest(1,ceil(extract(epoch FROM v_deadline-clock_timestamp())*1000)))::text||'ms',true);
   LOCK TABLE public.hand_atomic_commits IN SHARE ROW EXCLUSIVE MODE;
   LOCK TABLE public.hand_history,public.hand_state_snapshots,public.hand_private_state,
    public.table_hole_cards IN SHARE ROW EXCLUSIVE MODE NOWAIT;
   IF clock_timestamp()>=v_deadline THEN
    RAISE EXCEPTION 'F06_CONTINUATION_INSTALL_ADMISSION_BUSY' USING ERRCODE='55P03';
   END IF;
   EXIT;
  EXCEPTION WHEN lock_not_available THEN
   -- The exception subtransaction released every partial relation lock.
   PERFORM pg_sleep(least(0.01,greatest(0,extract(epoch FROM v_deadline-clock_timestamp()))));
  END;
 END LOOP;
END $admission$;
SET LOCAL lock_timeout='1s';


DO $preimage$ BEGIN
 IF md5(pg_get_functiondef('public.fn_f06_finish_hand(uuid,uuid,uuid,text,uuid)'::regprocedure))<>'d5700b1c4e4663c5b9e12915a75d269b' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_f06_finish_hand(uuid,uuid,uuid,text,uuid)'::regprocedure) THEN RAISE EXCEPTION 'F06_CONTINUATION_PREIMAGE_CHANGED public.fn_f06_finish_hand(uuid,uuid,uuid,text,uuid)'; END IF;
 IF md5(pg_get_functiondef('public.fn_f06_finish_original_no_start(uuid,uuid,uuid,bigint,uuid,bigint,uuid,uuid,uuid,bigint)'::regprocedure))<>'b51620d2a1ec9cb32c74b2ac9d1c64a2' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_f06_finish_original_no_start(uuid,uuid,uuid,bigint,uuid,bigint,uuid,uuid,uuid,bigint)'::regprocedure) THEN RAISE EXCEPTION 'F06_CONTINUATION_PREIMAGE_CHANGED public.fn_f06_finish_original_no_start(uuid,uuid,uuid,bigint,uuid,bigint,uuid,uuid,uuid,bigint)'; END IF;
 IF md5(pg_get_functiondef('smarter_private.f06_cancelled_preparation_writer_guard()'::regprocedure))<>'cd947083b57a48ed45b7590dbec66be3' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_cancelled_preparation_writer_guard()'::regprocedure) THEN RAISE EXCEPTION 'F06_CONTINUATION_PREIMAGE_CHANGED smarter_private.f06_cancelled_preparation_writer_guard()'; END IF;
 IF md5(pg_get_functiondef('smarter_private.f06_immutable_identity()'::regprocedure))<>'7695bc107f6575c01836bb3a130d73f1' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_immutable_identity()'::regprocedure) THEN RAISE EXCEPTION 'F06_CONTINUATION_PREIMAGE_CHANGED smarter_private.f06_immutable_identity()'; END IF;
 IF md5(pg_get_functiondef('smarter_private.f06_prefix(uuid,uuid,uuid[],uuid[])'::regprocedure))<>'dae9d5b5f71a68362f202dfdf89c8fae' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_prefix(uuid,uuid,uuid[],uuid[])'::regprocedure) THEN RAISE EXCEPTION 'F06_CONTINUATION_PREIMAGE_CHANGED smarter_private.f06_prefix(uuid,uuid,uuid[],uuid[])'; END IF;
 IF md5(pg_get_functiondef('smarter_private.f06_try_lane(uuid)'::regprocedure))<>'78a3a191b9991b0a3a343db39de335aa' OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_try_lane(uuid)'::regprocedure) THEN RAISE EXCEPTION 'F06_CONTINUATION_PREIMAGE_CHANGED smarter_private.f06_try_lane(uuid)'; END IF;
 IF md5(pg_get_functiondef('public.fn_stamp_seat_occupancy()'::regprocedure))<>'4d2645a24bd3b88d7ffc51097b37d640' OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.table_seats'::regclass AND tgname='zzz_stamp_seat_occupancy' AND tgenabled='O' AND tgfoid='public.fn_stamp_seat_occupancy()'::regprocedure AND pg_get_triggerdef(oid)='CREATE TRIGGER zzz_stamp_seat_occupancy BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_seat_occupancy()') THEN RAISE EXCEPTION 'F06_CONTINUATION_OCCUPANCY_AUTHORITY_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['hand_atomic_commits','hand_history','hand_state_snapshots','hand_private_state','table_hole_cards']) AS r(name)
 WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=('public.'||r.name)::regclass
 AND t.tgname='a00_f06_cancelled_preparation' AND t.tgenabled='O'
 AND pg_get_triggerdef(t.oid)='CREATE TRIGGER a00_f06_cancelled_preparation BEFORE INSERT OR UPDATE ON public.'||r.name||' FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_cancelled_preparation_writer_guard()'))
 THEN RAISE EXCEPTION 'F06_CONTINUATION_RAW_WRITER_BINDING_CHANGED'; END IF;
END $preimage$;
CREATE TABLE smarter_private.f06_no_start_continuations (
 receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), break_id uuid NOT NULL UNIQUE,
 permit_id uuid NOT NULL UNIQUE, tournament_id uuid NOT NULL, table_id uuid NOT NULL,
 lifecycle bigint NOT NULL, hand_number bigint NOT NULL, original_generation uuid NOT NULL,
 current_generation uuid NOT NULL, park jsonb NOT NULL, permit jsonb NOT NULL,
 roster jsonb NOT NULL, prior_committed jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(table_id,hand_number)
);
ALTER TABLE smarter_private.f06_no_start_continuations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.f06_no_start_continuations FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.f06_no_start_continuation_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'F06_CONTINUATION_IMMUTABLE' USING ERRCODE='55000'; END $$;
CREATE TRIGGER f06_no_start_continuation_immutable BEFORE UPDATE OR DELETE
 ON smarter_private.f06_no_start_continuations FOR EACH ROW
 EXECUTE FUNCTION smarter_private.f06_no_start_continuation_immutable();
CREATE TRIGGER f06_no_start_continuation_no_truncate BEFORE TRUNCATE
 ON smarter_private.f06_no_start_continuations FOR EACH STATEMENT
 EXECUTE FUNCTION smarter_private.f06_no_start_continuation_immutable();
CREATE FUNCTION smarter_private.f06_no_start_prior_committed_stacks(p_permit uuid,p_expected jsonb,p_roster jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE h smarter_private.f06_hand_permits; a public.hand_atomic_commits; history public.hand_history;
 s jsonb; r jsonb; payload jsonb; submitted jsonb; actual jsonb; n integer;
BEGIN
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE permit_id=p_permit;
 IF NOT FOUND OR h.state<>'never_started' OR h.evidence_id IS NULL
 OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' OR jsonb_typeof(p_roster) IS DISTINCT FROM 'array' THEN
 RAISE EXCEPTION 'F06_MIXED_PRIOR_IDENTITY' USING ERRCODE='55000'; END IF;
 SELECT * INTO a FROM public.hand_atomic_commits WHERE table_id=h.table_id
 AND hand_number=(p_expected->>'hand_number')::bigint FOR SHARE;
 IF NOT FOUND OR a.hand_number>=h.hand_number OR a.hand_id IS DISTINCT FROM (p_expected->>'atomic_hand_id')::uuid
 OR a.payload_hash !~ '^[0-9a-f]{64}$' OR a.payload_hash IS NULL
 OR a.post_commit_completed_at IS NULL OR NOT isfinite(a.post_commit_completed_at)
 OR a.post_commit_completed_at<a.committed_at
 OR a.post_commit_result->'ok' IS DISTINCT FROM 'true'::jsonb
 OR a.post_commit_result->>'hand_id' IS DISTINCT FROM a.hand_id::text
 OR (a.post_commit_result->>'hand_number')::bigint IS DISTINCT FROM a.hand_number THEN
 RAISE EXCEPTION 'F06_MIXED_PRIOR_INCOMPLETE' USING ERRCODE='55000'; END IF;
 SELECT * INTO history FROM public.hand_history WHERE id=a.hand_id AND table_id=a.table_id AND hand_number=a.hand_number FOR SHARE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=h.table_id
 AND (hand_number>a.hand_number OR committed_at>a.committed_at))
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=h.table_id AND hand_number>a.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=h.table_id AND hand_number>a.hand_number)
 -- Completed historical snapshots do not establish accepted settlement or no-start.
 -- Only active custody must be absent; use the existing live-table partial index.
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id AND NOT is_complete) THEN
 RAISE EXCEPTION 'F06_MIXED_PRIOR_NOT_LAST_BOUNDARY' USING ERRCODE='55000'; END IF;
 payload:=a.post_commit_payload;
 IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR payload->>'version' IS DISTINCT FROM '1'
 OR jsonb_typeof(payload->'accepted_hand_facts') IS DISTINCT FROM 'object'
 OR encode(extensions.digest(convert_to(payload::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM a.post_commit_payload_hash THEN
 RAISE EXCEPTION 'F06_MIXED_PRIOR_POSTCOMMIT_SEAL' USING ERRCODE='55000'; END IF;
 submitted:=payload-'accepted_hand_facts';
 IF jsonb_typeof(submitted->'pending_addons')='object' THEN
 IF jsonb_typeof(submitted#>'{pending_addons,ids}') IS DISTINCT FROM 'array' THEN
 RAISE EXCEPTION 'F06_MIXED_PRIOR_POSTCOMMIT_SEAL' USING ERRCODE='55000'; END IF;
 submitted:=submitted#-'{pending_addons,ids}'; END IF;
 IF encode(extensions.digest(convert_to(submitted::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM a.post_commit_request_hash THEN
 RAISE EXCEPTION 'F06_MIXED_PRIOR_POSTCOMMIT_SEAL' USING ERRCODE='55000'; END IF;
 s:=a.stack_result; n:=jsonb_array_length(s#>'{request,stacks}');
 IF n NOT BETWEEN 2 AND 10 OR jsonb_array_length(p_roster) NOT BETWEEN 2 AND n THEN
 RAISE EXCEPTION 'F06_CONTINUATION_ROSTER_SIZE' USING ERRCODE='55000'; END IF;
 IF s->'success' IS DISTINCT FROM 'true'::jsonb OR s->>'mode' IS DISTINCT FROM 'delta'
 OR s->>'table_id' IS DISTINCT FROM h.table_id::text OR s->>'tournament_id' IS DISTINCT FROM h.tournament_id::text
 OR (s->>'hand_number')::bigint IS DISTINCT FROM a.hand_number
 -- The stack receipt and canonical atomic receipt have different identity domains.
 OR NULLIF(s->>'hand_id','') IS NULL OR s->>'hand_id' IS DISTINCT FROM p_expected->>'stack_hand_id'
 OR s->'conservation_checked' IS DISTINCT FROM 'true'::jsonb OR s->'tournament_players_synced' IS DISTINCT FROM 'true'::jsonb
 OR s->'rebased' IS DISTINCT FROM '{}'::jsonb OR s->'departed' IS DISTINCT FROM '[]'::jsonb
 OR (s->>'players')::integer IS DISTINCT FROM n OR (s->>'tournament_player_count')::integer IS DISTINCT FROM n
 OR (s->>'net_deltas')::numeric IS DISTINCT FROM 0 OR (s->>'inflow')::numeric IS DISTINCT FROM 0
 OR (s->>'rake')::numeric IS DISTINCT FROM 0 OR (s->>'bbj')::numeric IS DISTINCT FROM 0
 OR jsonb_typeof(s#>'{request,stacks}') IS DISTINCT FROM 'array'
 OR jsonb_typeof(s->'written') IS DISTINCT FROM 'object'
 OR jsonb_typeof(s->'tournament_player_chips') IS DISTINCT FROM 'array'
 OR jsonb_array_length(s#>'{request,stacks}') IS DISTINCT FROM n
 OR jsonb_array_length(s->'tournament_player_chips') IS DISTINCT FROM n
 OR (SELECT count(*) FROM jsonb_object_keys(s->'written'))<>n
 OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(s#>'{request,stacks}') x)<>n
 OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(s->'tournament_player_chips') x)<>n THEN
 RAISE EXCEPTION 'F06_MIXED_PRIOR_STACK_RECEIPT' USING ERRCODE='55000'; END IF;
 -- Every original positive stack has exactly its current seat. A zero stack
 -- is admitted only by the exact canonical vacate receipt and eliminated row.
 FOR r IN SELECT value FROM jsonb_array_elements(s#>'{request,stacks}') LOOP
 IF (r->>'stack')::numeric>0 THEN
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_roster) x WHERE x->>'user_id'=r->>'user_id'
 AND x->>'seat_id'=r->>'seat_id' AND (x->>'joined_at')::timestamptz=(r->>'seat_joined_at')::timestamptz
 AND (x->>'stack')::numeric=(r->>'stack')::numeric) THEN
 RAISE EXCEPTION 'F06_CONTINUATION_POSITIVE_SEAT_CHANGED' USING ERRCODE='55000'; END IF;
 ELSIF (r->>'stack')::numeric=0 THEN
 IF NOT EXISTS(SELECT 1 FROM public.table_seats z JOIN public.tournament_players p
 ON p.tournament_id=h.tournament_id AND p.user_id=z.user_id
 WHERE z.id=(r->>'seat_id')::uuid AND z.table_id=h.table_id AND z.user_id=(r->>'user_id')::uuid
 AND z.joined_at=(r->>'seat_joined_at')::timestamptz AND z.stack=0
 AND z.left_at=(s->>'tournament_zero_stack_vacated_at')::timestamptz
 AND lower(z.status)='left' AND p.status='eliminated' AND p.chips=0
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(s->'tournament_zero_stack_seat_generations') v
 WHERE v->>'seat_id'=z.id::text AND v->>'user_id'=z.user_id::text
 AND (v->>'seat_number')::integer=z.seat_number AND (v->>'joined_at')::timestamptz=z.joined_at))
 OR (s->'written'->>(r->>'user_id'))::numeric IS DISTINCT FROM 0
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'tournament_player_chips') x WHERE x->>'user_id'=r->>'user_id' AND (x->>'chips')::numeric=0) THEN
 RAISE EXCEPTION 'F06_CONTINUATION_ZERO_VACATE_CHANGED' USING ERRCODE='55000'; END IF;
 ELSE RAISE EXCEPTION 'F06_CONTINUATION_INVALID_STACK' USING ERRCODE='55000'; END IF;
 END LOOP;
 FOR r IN SELECT value FROM jsonb_array_elements(p_roster) LOOP
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s#>'{request,stacks}') x
 WHERE x->>'user_id'=r->>'user_id' AND x->>'seat_id'=r->>'seat_id'
 AND (x->>'seat_joined_at')::timestamptz=(r->>'joined_at')::timestamptz
 AND (x->>'stack')::numeric=(r->>'stack')::numeric)
 OR (s->'written'->>(r->>'user_id'))::numeric IS DISTINCT FROM (r->>'stack')::numeric
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'tournament_player_chips') x
 WHERE x->>'user_id'=r->>'user_id' AND (x->>'chips')::numeric=(r->>'chips')::numeric) THEN
 RAISE EXCEPTION 'F06_MIXED_PRIOR_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 END LOOP;
 actual:=jsonb_build_object('hand_number',a.hand_number,'atomic_hand_id',a.hand_id,
 'stack_hand_id',s->>'hand_id','atomic_hash',md5(to_jsonb(a)::text),'history_hash',md5(to_jsonb(history)::text),
 'payload_hash',a.payload_hash,'post_commit_payload_hash',a.post_commit_payload_hash,
 'post_commit_request_hash',a.post_commit_request_hash,'post_commit_completed_at',a.post_commit_completed_at);
 IF actual IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'F06_MIXED_PRIOR_EXPECTED_CHANGED' USING ERRCODE='55000'; END IF;
 RETURN actual;
END $function$;
CREATE OR REPLACE FUNCTION smarter_private.f06_immutable_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'F06_HISTORY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_operations' AND (to_jsonb(OLD)->>'state')='withdrawn_before_manifest' THEN
 RAISE EXCEPTION 'F06_WITHDRAWAL_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_hand_permits' AND (to_jsonb(NEW)->>'state')='aborted_unsettled' AND NOT EXISTS(
 SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts a WHERE a.receipt_id=(to_jsonb(NEW)->>'evidence_id')::uuid
 AND a.permit_id=(to_jsonb(NEW)->>'permit_id')::uuid AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'generation')::uuid AND a.hand_number=(to_jsonb(NEW)->>'hand_number')::bigint) AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_generation_abort_hands a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'evidence_id')::uuid AND a.permit_id=(to_jsonb(NEW)->>'permit_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'generation')::uuid AND a.hand_number=(to_jsonb(NEW)->>'hand_number')::bigint) AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_mixed_abort_hands a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'evidence_id')::uuid AND a.permit_id=(to_jsonb(NEW)->>'permit_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'generation')::uuid AND a.hand_number=(to_jsonb(NEW)->>'hand_number')::bigint) THEN
 RAISE EXCEPTION 'F06_ABORT_RECEIPT_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_operations' AND (to_jsonb(NEW)->>'state')='withdrawn_before_manifest' AND NOT EXISTS(
 SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts a WHERE a.receipt_id=(to_jsonb(NEW)->>'abort_receipt_id')::uuid
 AND a.break_id=(to_jsonb(NEW)->>'break_id')::uuid AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid
 AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid AND a.generation=(to_jsonb(NEW)->>'origin_generation')::uuid) AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_generation_abort_hands a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'abort_receipt_id')::uuid AND a.break_id=(to_jsonb(NEW)->>'break_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'origin_generation')::uuid) AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_mixed_abort_hands a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'abort_receipt_id')::uuid AND a.break_id=(to_jsonb(NEW)->>'break_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'origin_generation')::uuid) AND NOT EXISTS(
 SELECT 1 FROM smarter_private.f06_no_start_continuations a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'abort_receipt_id')::uuid
 AND a.break_id=(to_jsonb(NEW)->>'break_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid
 AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid
 AND a.original_generation=(to_jsonb(NEW)->>'origin_generation')::uuid
 AND a.park=(to_jsonb(OLD))
 AND (to_jsonb(NEW)-'state'-'abort_receipt_id')=(to_jsonb(OLD)-'state'-'abort_receipt_id')) THEN
 RAISE EXCEPTION 'F06_ABORT_RECEIPT_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_hand_permits' AND ((to_jsonb(OLD)-'state'-'evidence_id') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'evidence_id') OR to_jsonb(OLD)->>'state'<>'reserved') THEN
 RAISE EXCEPTION 'F06_HAND_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_members' OR
 (TG_TABLE_NAME='f06_attempts' AND ((to_jsonb(OLD)-'state'-'receipt') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'receipt') OR to_jsonb(OLD)->>'state'<>'active')) OR
 (TG_TABLE_NAME='f06_operations' AND ((to_jsonb(OLD)-'state'-'manifest'-'revision'-'custody_id'-'custody_generation'-'cleanup_kind'-'close_receipt'-'abort_receipt_id') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'manifest'-'revision'-'custody_id'-'custody_generation'-'cleanup_kind'-'close_receipt'-'abort_receipt_id') OR (to_jsonb(OLD)->'manifest'<>'null'::jsonb AND to_jsonb(OLD)->'manifest' IS DISTINCT FROM to_jsonb(NEW)->'manifest') OR (to_jsonb(OLD)->'close_receipt'<>'null'::jsonb AND to_jsonb(OLD)->'close_receipt' IS DISTINCT FROM to_jsonb(NEW)->'close_receipt'))) THEN
 RAISE EXCEPTION 'F06_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$
;
CREATE OR REPLACE FUNCTION smarter_private.f06_cancelled_preparation_writer_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE t uuid;
BEGIN
 -- Resolve the table even before BEGIN is visible; an absent permit cannot
 -- let an already-started writer cross cancellation's exclusive lane.
 SELECT tournament_id INTO t FROM public.tables WHERE id=NEW.table_id;
 IF t IS NOT NULL THEN
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
 OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
 RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_prepared_hand_cancellations
 WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_no_start_continuations
 WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number) THEN
 RAISE EXCEPTION 'F06_CANCELLED_PREPARATION_FENCED' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END $function$
;
CREATE FUNCTION public.fn_f06_continue_no_start_last_table(
 p_tournament_id uuid,p_lease_generation uuid,p_table_id uuid,p_lifecycle bigint,
 p_break_id uuid,p_park_custody_id uuid,p_park_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE h smarter_private.f06_hand_permits; o smarter_private.f06_operations;
 receipt smarter_private.f06_no_start_continuations; a public.hand_atomic_commits;
 history public.hand_history; users uuid[]; roster jsonb; prior jsonb;
BEGIN
 IF p_table_id IS NULL OR p_lifecycle IS NULL OR p_lifecycle<1 OR p_break_id IS NULL
 OR p_park_custody_id IS NULL OR p_park_revision IS NULL OR p_park_revision<1 THEN
 RAISE EXCEPTION 'F06_CONTINUATION_IDENTITY' USING ERRCODE='22023'; END IF;
 -- The authenticated current manager owns both original and successor calls.
 -- Its exact source dealer must have positively stopped/joined under registry
 -- custody. The durable original never-started witness is never reconstructed.
 SELECT array_agg(user_id ORDER BY user_id) INTO users FROM public.table_seats
 WHERE table_id=p_table_id AND left_at IS NULL;
 PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,COALESCE(users,'{}'),ARRAY[p_table_id]);
 SELECT * INTO receipt FROM smarter_private.f06_no_start_continuations WHERE break_id=p_break_id;
 IF FOUND THEN
 IF (receipt.tournament_id,receipt.current_generation,receipt.table_id,receipt.lifecycle,
 (receipt.park->>'custody_id')::uuid,(receipt.park->>'revision')::bigint) IS DISTINCT FROM
 (p_tournament_id,p_lease_generation,p_table_id,p_lifecycle,p_park_custody_id,p_park_revision) THEN
 RAISE EXCEPTION 'F06_CONTINUATION_CHANGED_REPLAY' USING ERRCODE='22023'; END IF;
 ELSE
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN: continuation refused' USING ERRCODE='55000'; END IF;
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=p_break_id FOR UPDATE;
 IF NOT FOUND OR (o.tournament_id,o.source_table_id,o.lifecycle,o.state,o.custody_id,o.revision)
 IS DISTINCT FROM (p_tournament_id,p_table_id,p_lifecycle,'park_requested'::text,p_park_custody_id,p_park_revision)
 OR o.origin_generation IS DISTINCT FROM o.custody_generation OR o.custody_generation IS NULL
 OR o.manifest IS NOT NULL OR o.close_receipt IS NOT NULL OR o.cleanup_kind IS NOT NULL
 OR o.abort_receipt_id IS NOT NULL
 OR EXISTS(SELECT 1 FROM smarter_private.f06_members WHERE break_id=o.break_id)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts WHERE break_id=o.break_id)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE tournament_id=p_tournament_id
 AND break_id<>p_break_id AND state NOT IN ('acknowledged','withdrawn_before_manifest')) THEN
 RAISE EXCEPTION 'F06_CONTINUATION_EXACT_PREMANIFEST_PARK' USING ERRCODE='55000'; END IF;
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE table_id=p_table_id
 ORDER BY hand_number DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND OR (h.tournament_id,h.lifecycle,h.generation,h.state,h.evidence_id) IS DISTINCT FROM
 (p_tournament_id,p_lifecycle,o.origin_generation,'never_started'::text,o.custody_id)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE tournament_id=p_tournament_id AND state='reserved') THEN
 RAISE EXCEPTION 'F06_CONTINUATION_POSITIVE_ORIGINAL_REQUIRED' USING ERRCODE='55000'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||h.permit_id::text,0)) THEN
 RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='40001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=p_tournament_id AND status='RUNNING'
 AND format_contract IN ('mtt-v1','mtt-v2','sng-v1','spin-v1'))
 OR (SELECT count(*) FROM public.tables WHERE tournament_id=p_tournament_id AND lower(status)<>'closed'
 AND NOT COALESCE(is_deleted,false))<>1
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=p_table_id AND tournament_id=p_tournament_id
 AND f06_lifecycle=p_lifecycle AND lower(status) IN ('waiting','running') AND NOT COALESCE(is_deleted,false)) THEN
 RAISE EXCEPTION 'F06_CONTINUATION_LAST_TABLE_REQUIRED' USING ERRCODE='55000'; END IF;
 -- The prefix's exclusive tournament lane serializes every real admission.
 -- Recheck the complete roster rather than trusting an earlier count or hint.
 IF EXISTS(SELECT 1 FROM public.table_seats s LEFT JOIN public.tournament_players p
 ON p.tournament_id=p_tournament_id AND p.user_id=s.user_id AND p.table_id=s.table_id
 AND p.seat_number=s.seat_number AND p.status='playing'
 WHERE s.table_id=p_table_id AND s.left_at IS NULL AND (p.id IS NULL OR s.occupancy_id IS NULL
 OR s.joined_at IS NULL OR s.terminal_closed_at IS NOT NULL OR s.stack IS DISTINCT FROM p.chips::numeric
 OR s.stack IS NULL OR s.stack<=0 OR s.stack::text IN ('NaN','Infinity','-Infinity')))
 OR EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=p_tournament_id AND p.status='playing'
 AND NOT EXISTS(SELECT 1 FROM public.table_seats s WHERE s.table_id=p_table_id AND s.table_id=p.table_id
 AND s.user_id=p.user_id AND s.seat_number=p.seat_number AND s.left_at IS NULL)) THEN
 RAISE EXCEPTION 'F06_CONTINUATION_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(jsonb_build_object('seat_id',s.id,'occupancy_id',s.occupancy_id,'registration_id',p.id,
 'user_id',s.user_id,'joined_at',s.joined_at,'table_id',s.table_id,'seat_number',s.seat_number,'stack',s.stack,'chips',p.chips) ORDER BY s.user_id)
 INTO roster FROM public.table_seats s JOIN public.tournament_players p
 ON p.tournament_id=p_tournament_id AND p.user_id=s.user_id AND p.table_id=s.table_id AND p.seat_number=s.seat_number AND p.status='playing'
 WHERE s.table_id=p_table_id AND s.left_at IS NULL;
 IF jsonb_array_length(roster) NOT BETWEEN 2 AND 10 OR roster IS NULL
 OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(roster) x)<>jsonb_array_length(roster)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=p_table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=p_table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=p_table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.table_hole_cards WHERE table_id=p_table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=p_table_id AND NOT is_complete)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch WHERE permit_id=h.permit_id) THEN
 RAISE EXCEPTION 'F06_CONTINUATION_STARTED_OR_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT * INTO a FROM public.hand_atomic_commits WHERE table_id=p_table_id ORDER BY hand_number DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'F06_CONTINUATION_PRIOR_COMMIT_REQUIRED' USING ERRCODE='55000'; END IF;
 SELECT * INTO history FROM public.hand_history WHERE id=a.hand_id AND table_id=p_table_id AND hand_number=a.hand_number;
 IF NOT FOUND THEN RAISE EXCEPTION 'F06_CONTINUATION_PRIOR_HISTORY_REQUIRED' USING ERRCODE='55000'; END IF;
 prior:=jsonb_build_object('hand_number',a.hand_number,'atomic_hand_id',a.hand_id,
 'stack_hand_id',a.stack_result->>'hand_id','atomic_hash',md5(to_jsonb(a)::text),'history_hash',md5(to_jsonb(history)::text),
 'payload_hash',a.payload_hash,'post_commit_payload_hash',a.post_commit_payload_hash,
 'post_commit_request_hash',a.post_commit_request_hash,'post_commit_completed_at',a.post_commit_completed_at);
 prior:=smarter_private.f06_no_start_prior_committed_stacks(h.permit_id,prior,roster);
 INSERT INTO smarter_private.f06_no_start_continuations
 (break_id,permit_id,tournament_id,table_id,lifecycle,hand_number,original_generation,current_generation,park,permit,roster,prior_committed)
 VALUES(o.break_id,h.permit_id,p_tournament_id,p_table_id,p_lifecycle,h.hand_number,h.generation,p_lease_generation,to_jsonb(o),to_jsonb(h),roster,prior)
 RETURNING * INTO receipt;
 -- The legacy column names the disposition receipt. The immutable hand outcome
 -- remains never_started; this is neither an abort nor a chip compensation.
 UPDATE smarter_private.f06_operations SET state='withdrawn_before_manifest',abort_receipt_id=receipt.receipt_id WHERE break_id=o.break_id;
 END IF;
 RETURN jsonb_build_object('ok',true,'state','continued_never_started','receipt_id',receipt.receipt_id,
 'tournament_id',receipt.tournament_id,'table_id',receipt.table_id,'lifecycle',receipt.lifecycle::text,
 'break_id',receipt.break_id,'park_custody_id',receipt.park->>'custody_id','park_revision',receipt.park->>'revision',
 'lease_generation',receipt.current_generation,'original_generation',receipt.original_generation,
 'permit_id',receipt.permit_id,'hand_number',receipt.hand_number::text,'credit',0);
END $function$;
REVOKE ALL ON FUNCTION smarter_private.f06_no_start_continuation_immutable(),
 smarter_private.f06_no_start_prior_committed_stacks(uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_f06_continue_no_start_last_table(uuid,uuid,uuid,bigint,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_continue_no_start_last_table(uuid,uuid,uuid,bigint,uuid,uuid,bigint) TO service_role;

COMMIT;
