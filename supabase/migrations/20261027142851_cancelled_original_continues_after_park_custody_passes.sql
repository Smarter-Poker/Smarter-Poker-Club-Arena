-- Spin 0d4abad2: successor inherited park64ba2068 after original cancelled permit f292eb6f. Accept its exact immutable cancellation witness as well as the older generation-abort witness. Preserve all lease, table, roster, stack and started-hand fences.
-- Functions only; no schedules, money or player state changes.
-- @live-proof: (SELECT md5(prosrc) = '02f09cb7ea48547dba423294f95b9cc5' FROM pg_proc WHERE oid = 'public.fn_f06_continue_no_start_last_table(uuid,uuid,uuid,bigint,uuid,uuid,bigint)'::regprocedure)
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '10s';
DO $pre$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_f06_continue_no_start_last_table(uuid,uuid,uuid,bigint,uuid,uuid,bigint)'::regprocedure)
 IS DISTINCT FROM 'd1a7cf0f6bd6be49950d118972cc6c64' THEN RAISE EXCEPTION 'DIGEST_SPIN_PREIMAGE_DRIFT'; END IF;
END $pre$;
CREATE OR REPLACE FUNCTION public.fn_f06_continue_no_start_last_table(p_tournament_id uuid, p_lease_generation uuid, p_table_id uuid, p_lifecycle bigint, p_break_id uuid, p_park_custody_id uuid, p_park_revision bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
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
 OR o.custody_generation IS NULL
 -- A PARK THE ABANDONED-GENERATION DOOR LEFT (2026-09-27). The door closes a
 -- dead generation's never-started hand as never_started and leaves that
 -- generation's own pre-manifest park for the successor. On the event's last
 -- open table this continuation is the only exit. The park's custody may name
 -- a successor generation that has itself since died (41eb379e: 3871b71a
 -- claimed it at 16:25, then engine e6b9dc5d adopted the event as f798e8e0 and
 -- the park still names 3871b71a), so the caller is not required to be that
 -- generation. The caller is the event's LIVE lease holder (f06_prefix above
 -- fences every other generation), it is not the origin the door closed, and
 -- no other generation holds a lease; the door's receipt must name this park.
 OR (o.origin_generation IS DISTINCT FROM o.custody_generation
     AND NOT (p_lease_generation IS DISTINCT FROM o.origin_generation
              AND NOT EXISTS(SELECT 1 FROM public.engine_tournament_leases l
                              WHERE l.tournament_id=p_tournament_id
                                AND l.lease_generation IS DISTINCT FROM p_lease_generation)
              AND (EXISTS(SELECT 1 FROM smarter_private.f06_generation_aborts g
                          WHERE g.tournament_id=p_tournament_id AND g.generation=o.origin_generation
                            AND g.outcome='aborted_unsettled'
                            AND g.expected->'foreign_parks_left' ? o.break_id::text)
                   OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits ch
                JOIN smarter_private.f06_prepared_hand_cancellations c ON
                  (c.permit_id,c.tournament_id,c.generation,c.table_id,c.lifecycle,c.hand_number,c.custody_id) =
                  (ch.permit_id,ch.tournament_id,ch.generation,ch.table_id,ch.lifecycle,ch.hand_number,ch.custody_id)
                WHERE ch.table_id=o.source_table_id AND ch.tournament_id=o.tournament_id
                  AND ch.lifecycle=o.lifecycle AND ch.generation=o.origin_generation
                  AND ch.state='never_started' AND ch.evidence_id=ch.permit_id
                  AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits later
                                  WHERE later.table_id=ch.table_id AND later.hand_number>ch.hand_number)))))
 OR o.manifest IS NOT NULL OR o.close_receipt IS NOT NULL OR o.cleanup_kind IS NOT NULL
 OR o.abort_receipt_id IS NOT NULL
 OR EXISTS(SELECT 1 FROM smarter_private.f06_members WHERE break_id=o.break_id)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts WHERE break_id=o.break_id)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE tournament_id=p_tournament_id
 AND break_id<>p_break_id AND state NOT IN ('acknowledged','withdrawn_before_manifest')) THEN
 RAISE EXCEPTION 'F06_CONTINUATION_EXACT_PREMANIFEST_PARK' USING ERRCODE='55000'; END IF;
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE table_id=p_table_id
 ORDER BY hand_number DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND OR (h.tournament_id,h.lifecycle,h.generation,h.state) IS DISTINCT FROM
 (p_tournament_id,p_lifecycle,o.origin_generation,'never_started'::text)
 -- Its never-started witness is the original's own cancellation (evidence =
 -- the park's custody) or, for a park the door left, the door's receipt that
 -- names this permit as never started and this park as left.
 OR NOT (h.evidence_id IS NOT DISTINCT FROM o.custody_id
         OR (h.evidence_id=h.permit_id AND EXISTS(
              SELECT 1 FROM smarter_private.f06_prepared_hand_cancellations c
               WHERE (c.permit_id,c.tournament_id,c.generation,c.table_id,c.lifecycle,c.hand_number,c.custody_id) =
                     (h.permit_id,h.tournament_id,h.generation,h.table_id,h.lifecycle,h.hand_number,h.custody_id)))
         OR (o.origin_generation IS DISTINCT FROM o.custody_generation
             AND EXISTS(SELECT 1 FROM smarter_private.f06_generation_aborts g
                         WHERE g.receipt_id=h.evidence_id AND g.tournament_id=p_tournament_id
                           AND g.generation=h.generation AND g.outcome='aborted_unsettled'
                           AND g.expected->'foreign_parks_left' ? o.break_id::text
                           AND EXISTS(SELECT 1 FROM jsonb_array_elements(g.expected->'never_started') ns
                                       WHERE ns#>>'{permit,permit_id}'=h.permit_id::text))))
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE tournament_id=p_tournament_id AND state='reserved') THEN
 RAISE EXCEPTION 'F06_CONTINUATION_POSITIVE_ORIGINAL_REQUIRED' USING ERRCODE='55000'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||h.permit_id::text,0)) THEN
 RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='55P03'; END IF;
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
END $function$
;
;

DO $post$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_f06_continue_no_start_last_table(uuid,uuid,uuid,bigint,uuid,uuid,bigint)'::regprocedure)
 IS DISTINCT FROM '02f09cb7ea48547dba423294f95b9cc5' THEN RAISE EXCEPTION 'DIGEST_SPIN_POSTIMAGE_DRIFT'; END IF;
END $post$;
COMMIT;
