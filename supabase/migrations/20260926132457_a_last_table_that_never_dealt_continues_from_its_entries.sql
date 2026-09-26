-- A LAST TABLE THAT NEVER DEALT CONTINUES FROM ITS ENTRIES (2026-09-26)
--
-- fn_f06_continue_no_start_last_table withdraws a positively never-started
-- park on an event's last table so the table deals again. It proved the
-- chairs against the table's last committed hand and refused
-- F06_CONTINUATION_PRIOR_COMMIT_REQUIRED when there was none. A last table
-- whose park landed before its first hand therefore could never continue:
--
--   e9c07fe8 "3 Chip Deep Stack Spin PLO4" (spin-v1), table ea6124e9: three
--     players at 1,000 (starting chips 1,000), never dealt since 09-18 05:52;
--     park f03313e2 park_requested, custody = origin generation, the one
--     permit never_started. The engine re-resumes it every ~15 s and is
--     refused every time (engine log, 13:25Z: 120 refusals in 5 minutes).
--   114c6069 "PLO4 Heads-Up 10" (sng-v1), table f44931c2: two players at
--     1,000 (starting 1,000), never dealt since 09-23 00:11; park eae81526,
--     same shape.
--
-- Change: when the table has no committed hand at all, the boundary is its
-- entries. smarter_private.f06_no_start_first_hand_stacks proves that the
-- table never dealt (no commit, history, private state, hole cards or
-- snapshot of any number, and no other permit) and that every chair holds
-- exactly the event's starting chips on a playing registration with no
-- rebuy, add-on or elimination, every entrant seated, and no purchase
-- receipt beyond entry. Anything else refuses. The prior-commit branch is
-- byte-identical. No chip, seat, wallet or ledger row is written; the
-- continuation still only withdraws the park and records its receipt.
--
-- @live-proof: (SELECT md5(prosrc)='88273d46745a000fc1b7b006427b8d89' AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_f06_continue_no_start_last_table(uuid,uuid,uuid,bigint,uuid,uuid,bigint)'::regprocedure)
-- @live-proof: (SELECT md5(prosrc)='1551a861f77ffe209049fb6c92eaa82f' AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_no_start_first_hand_stacks(uuid,jsonb)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_f06_continue_no_start_last_table(uuid,uuid,uuid,bigint,uuid,uuid,bigint)'::regprocedure
       AND md5(p.prosrc) = '974e426ede5bd86fa3410fc98f5461f9'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private"}'
       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'F06_FIRST_HAND_CONTINUATION_PREIMAGE_DRIFT: fn_f06_continue_no_start_last_table';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'smarter_private.f06_no_start_prior_committed_stacks(uuid,jsonb,jsonb)'::regprocedure
       AND md5(p.prosrc) = 'a3dc8a8721c6c0f466aa4ee3a164bc64'
       AND p.proacl::text = '{postgres=X/postgres}') THEN
    RAISE EXCEPTION 'F06_FIRST_HAND_CONTINUATION_PREIMAGE_DRIFT: f06_no_start_prior_committed_stacks';
  END IF;
  IF to_regprocedure('smarter_private.f06_no_start_first_hand_stacks(uuid,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'F06_FIRST_HAND_CONTINUATION_PREIMAGE_DRIFT: f06_no_start_first_hand_stacks already exists';
  END IF;
END
$pre$;

CREATE FUNCTION smarter_private.f06_no_start_first_hand_stacks(p_permit uuid, p_roster jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $first_hand$
DECLARE h smarter_private.f06_hand_permits; t public.tournaments; r jsonb; n integer;
BEGIN
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE permit_id=p_permit;
 IF NOT FOUND OR h.state<>'never_started' OR h.evidence_id IS NULL OR jsonb_typeof(p_roster) IS DISTINCT FROM 'array' THEN
 RAISE EXCEPTION 'F06_MIXED_PRIOR_IDENTITY' USING ERRCODE='55000'; END IF;
 -- The table never dealt: no hand of any number was committed, recorded,
 -- dealt, held privately or snapshotted on it, and no other permit exists.
 IF EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=h.table_id)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=h.table_id)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=h.table_id)
 OR EXISTS(SELECT 1 FROM public.table_hole_cards WHERE table_id=h.table_id)
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=h.table_id AND permit_id<>h.permit_id) THEN
 RAISE EXCEPTION 'F06_CONTINUATION_FIRST_HAND_DEALT' USING ERRCODE='55000'; END IF;
 SELECT * INTO t FROM public.tournaments WHERE id=h.tournament_id;
 IF NOT FOUND OR t.starting_chips IS NULL OR t.starting_chips<=0 THEN
 RAISE EXCEPTION 'F06_CONTINUATION_FIRST_HAND_ENTRY_UNPROVEN' USING ERRCODE='55000'; END IF;
 n:=jsonb_array_length(p_roster);
 -- Every chair holds exactly the entry the event grants, on a registration
 -- that bought nothing more and lost nothing; every entrant is in a chair.
 FOR r IN SELECT value FROM jsonb_array_elements(p_roster) LOOP
 IF (r->>'stack')::numeric IS DISTINCT FROM t.starting_chips::numeric OR (r->>'chips')::numeric IS DISTINCT FROM t.starting_chips::numeric
 OR NOT EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.id=(r->>'registration_id')::uuid AND p.tournament_id=h.tournament_id
 AND p.user_id=(r->>'user_id')::uuid AND p.status='playing' AND COALESCE(p.rebuys,0)=0 AND NOT COALESCE(p.add_on,false) AND p.eliminated_at IS NULL) THEN
 RAISE EXCEPTION 'F06_CONTINUATION_FIRST_HAND_STACK_CHANGED' USING ERRCODE='55000'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.tournament_players WHERE tournament_id=h.tournament_id)<>n
 OR EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=h.tournament_id AND f.operation<>'entry') THEN
 RAISE EXCEPTION 'F06_CONTINUATION_FIRST_HAND_STACK_CHANGED' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('first_hand',true,'permit_id',h.permit_id,'hand_number',h.hand_number,
 'starting_chips',t.starting_chips,'players',n,'roster_md5',md5(p_roster::text));
END $first_hand$;
REVOKE ALL ON FUNCTION smarter_private.f06_no_start_first_hand_stacks(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_f06_continue_no_start_last_table(p_tournament_id uuid, p_lease_generation uuid, p_table_id uuid, p_lifecycle bigint, p_break_id uuid, p_park_custody_id uuid, p_park_revision bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $continuation$
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
 IF NOT FOUND THEN
 -- A last table that never committed a hand has no prior boundary to prove
 -- its chairs against. Its boundary is its entries: the table never dealt,
 -- and every chair holds exactly the entry its registration was granted.
 prior:=smarter_private.f06_no_start_first_hand_stacks(h.permit_id,roster);
 ELSE
 SELECT * INTO history FROM public.hand_history WHERE id=a.hand_id AND table_id=p_table_id AND hand_number=a.hand_number;
 IF NOT FOUND THEN RAISE EXCEPTION 'F06_CONTINUATION_PRIOR_HISTORY_REQUIRED' USING ERRCODE='55000'; END IF;
 prior:=jsonb_build_object('hand_number',a.hand_number,'atomic_hand_id',a.hand_id,
 'stack_hand_id',a.stack_result->>'hand_id','atomic_hash',md5(to_jsonb(a)::text),'history_hash',md5(to_jsonb(history)::text),
 'payload_hash',a.payload_hash,'post_commit_payload_hash',a.post_commit_payload_hash,
 'post_commit_request_hash',a.post_commit_request_hash,'post_commit_completed_at',a.post_commit_completed_at);
 prior:=smarter_private.f06_no_start_prior_committed_stacks(h.permit_id,prior,roster);
 END IF;
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
END $continuation$;
REVOKE ALL ON FUNCTION public.fn_f06_continue_no_start_last_table(uuid,uuid,uuid,bigint,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_continue_no_start_last_table(uuid,uuid,uuid,bigint,uuid,uuid,bigint) TO service_role;

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_f06_continue_no_start_last_table(uuid,uuid,uuid,bigint,uuid,uuid,bigint)'::regprocedure
       AND md5(p.prosrc) = '88273d46745a000fc1b7b006427b8d89'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private"}'
       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'F06_FIRST_HAND_CONTINUATION_POSTIMAGE: fn_f06_continue_no_start_last_table';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'smarter_private.f06_no_start_first_hand_stacks(uuid,jsonb)'::regprocedure
       AND md5(p.prosrc) = '1551a861f77ffe209049fb6c92eaa82f'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private"}'
       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'F06_FIRST_HAND_CONTINUATION_POSTIMAGE: f06_no_start_first_hand_stacks';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'smarter_private.f06_no_start_prior_committed_stacks(uuid,jsonb,jsonb)'::regprocedure
       AND md5(p.prosrc) = 'a3dc8a8721c6c0f466aa4ee3a164bc64') THEN
    RAISE EXCEPTION 'F06_FIRST_HAND_CONTINUATION_POSTIMAGE: the prior-commit proof changed';
  END IF;
END
$post$;

COMMIT;
