-- Two independently retained original tournament hands were omitted from the
-- first57 manifest. Their two retired positive custodies remain unpaid:104->208
-- and1031->1021 in their immutable originals, with both surviving opponents'
-- exact pre-hand stacks still held. This admits only those original receipts.
-- No wallet/profile/roster/seat write, new hand, lease or replay is made here.
-- Existing native successor restores inside its original atomic hand transaction.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $preimage$
BEGIN
 IF md5(pg_get_functiondef('smarter_private.restore_retired_original_tournament_hand(uuid,text,uuid)'::regprocedure)) IS DISTINCT FROM 'a529e0bd2972a5b87eff0afa5fce7988'
 OR md5(pg_get_functiondef('public.fn_ca_guard_seat_creation()'::regprocedure)) IS DISTINCT FROM '34016ee7fb4957fe0d46dfb78c8fd5b7'
 OR md5(pg_get_functiondef('public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure)) IS DISTINCT FROM '992019226ea1c06a3514a9087ac70be5'
 OR NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261007000711')
 OR (SELECT md5(jsonb_agg(to_jsonb(q) ORDER BY submission_id)::text) FROM smarter_private.retirement_original_hand_qualification q) IS DISTINCT FROM '26488d98acd8612f16aec0bd06e99bcd'
 OR (SELECT count(*) FROM smarter_private.retirement_original_hand_qualification)<>57
 OR (SELECT sum(jsonb_array_length(expected->'rows')) FROM smarter_private.retirement_original_hand_qualification)<>66
 THEN RAISE EXCEPTION 'ADDITIONAL_TOURNAMENT_NATIVE_PREDECESSOR_REQUIRED' USING ERRCODE='55000'; END IF;
END $preimage$;
INSERT INTO smarter_private.retirement_original_hand_qualification
SELECT (x->>'submission_id')::uuid,x->>'request_hash',(x->>'table_id')::uuid,
 (x->>'tournament_id')::uuid,(x->>'hand_number')::bigint,x
FROM jsonb_array_elements($qualified$[{"submission_id":"13b3d759-2915-4f10-974a-28649a3ece9e","request_hash":"ae511fc2941ce94217ba61a33f080c93a699018ec78d0b3a742684a6353b4a92","table_id":"0096b115-9f82-4228-9ae3-4bffaa906730","tournament_id":"e7bfa31d-29f6-4fe6-8afb-d09d271e6aea","hand_number":26113761,"rows":[{"user_id":"00000000-0000-0000-0000-000000000030","stack":{"stack":208,"seat_id":"c8e52a00-df52-4da1-a372-01e3c45ae9c4","user_id":"00000000-0000-0000-0000-000000000030","stack_before":104,"seat_joined_at":"2026-10-06T15:20:25.438753+00:00"},"roster":{"id":"9f842941-49e1-4390-ab6e-aaf07929d76c","user_id":"00000000-0000-0000-0000-000000000030","tournament_id":"e7bfa31d-29f6-4fe6-8afb-d09d271e6aea","status":"eliminated","chips":104,"position":null,"prize":0,"table_id":"0096b115-9f82-4228-9ae3-4bffaa906730","seat_number":3,"rebuys":0,"add_on":false,"eliminated_at":"2026-10-06T15:33:04.9274+00:00","current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"rebuy_prompt_until":null,"elimination_sequence":null},"seat":{"id":"c8e52a00-df52-4da1-a372-01e3c45ae9c4","table_id":"0096b115-9f82-4228-9ae3-4bffaa906730","user_id":"00000000-0000-0000-0000-000000000030","club_id":"a41434bb-8d0c-400a-8f0d-e8b3d65afed4","seat_number":3,"joined_at":"2026-10-06T15:20:25.438753+00:00","occupancy_id":"1a0ccfa0-0c95-4f57-933a-98684a1cd63b","stack":104,"left_at":"2026-10-06T15:33:04.811305+00:00","status":"left","is_sitting_out":true,"is_away":false,"leave_pending":false,"active_game_scope":null,"active_parent_key":null}}]},{"submission_id":"54aed95a-98de-4d12-a8b5-fb7da2c1b59f","request_hash":"3c1ee68a68a910240f7bd8c27651b75c874627eaa80276012a6aa76cba71480f","table_id":"476d692b-c304-4e15-88b9-f04834493207","tournament_id":"8daa531c-f7b4-49fc-94b4-6d7aab76ecfb","hand_number":26114184,"rows":[{"user_id":"face0000-0000-0000-0000-000000000008","stack":{"stack":1021,"seat_id":"8df78154-f4f4-4abd-a803-72120c21dab6","user_id":"face0000-0000-0000-0000-000000000008","stack_before":1031,"seat_joined_at":"2026-10-06T15:30:04.906754+00:00"},"roster":{"id":"cfcb7131-970e-4bd0-a30f-87593ab86f98","user_id":"face0000-0000-0000-0000-000000000008","tournament_id":"8daa531c-f7b4-49fc-94b4-6d7aab76ecfb","status":"eliminated","chips":1031,"position":null,"prize":0,"table_id":"476d692b-c304-4e15-88b9-f04834493207","seat_number":3,"rebuys":0,"add_on":false,"eliminated_at":"2026-10-06T15:33:06.739754+00:00","current_bounty":0,"bounty_winnings":0,"bounties_collected":0,"rebuy_prompt_until":null,"elimination_sequence":null},"seat":{"id":"8df78154-f4f4-4abd-a803-72120c21dab6","table_id":"476d692b-c304-4e15-88b9-f04834493207","user_id":"face0000-0000-0000-0000-000000000008","club_id":"a0000000-0000-0000-0000-000000000001","seat_number":3,"joined_at":"2026-10-06T15:30:04.906754+00:00","occupancy_id":"05183f4d-6861-406a-a052-53fe75a4842b","stack":1031,"left_at":"2026-10-06T15:33:04.814958+00:00","status":"left","is_sitting_out":true,"is_away":false,"leave_pending":false,"active_game_scope":null,"active_parent_key":null}}]}]$qualified$::jsonb)x;
DO $authority$
DECLARE c smarter_private.retirement_original_hand_qualification;s smarter_private.hand_submissions;
 item jsonb;stack_item jsonb;roster public.tournament_players;seat public.table_seats;projected jsonb;
BEGIN
 FOR c IN SELECT * FROM smarter_private.retirement_original_hand_qualification
 WHERE submission_id IN('13b3d759-2915-4f10-974a-28649a3ece9e'::uuid,'54aed95a-98de-4d12-a8b5-fb7da2c1b59f'::uuid) LOOP
 SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=c.submission_id FOR UPDATE;
 IF s.submission_id IS NULL OR s.request_hash IS DISTINCT FROM c.request_hash
 OR (s.table_id,s.hand_number) IS DISTINCT FROM(c.table_id,c.hand_number)
 OR NOT EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits p WHERE p.table_id=c.table_id
 AND p.hand_number=c.hand_number AND p.tournament_id=c.tournament_id AND p.generation=s.lease_generation AND p.state='reserved')
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=c.table_id AND a.hand_number>=c.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history h WHERE h.table_id=c.table_id AND h.hand_number>=c.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits p WHERE p.table_id=c.table_id AND p.hand_number>c.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs h WHERE h.submission_id=c.submission_id)
 OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals d WHERE d.table_id=c.table_id AND d.hand_number=c.hand_number)
 OR NOT EXISTS(SELECT 1 FROM public.tables t JOIN public.tournaments e ON e.id=t.tournament_id
 WHERE t.id=c.table_id AND e.id=c.tournament_id AND e.status='RUNNING' AND t.lifecycle IS NULL
 AND lower(t.status) IN('running','waiting') AND NOT coalesce(t.is_deleted,false))
 THEN RAISE EXCEPTION 'ADDITIONAL_TOURNAMENT_ORIGINAL_CHANGED' USING ERRCODE='55000';END IF;
 FOR stack_item IN SELECT value FROM jsonb_array_elements(s.request->'p_stacks') LOOP
 SELECT * INTO roster FROM public.tournament_players WHERE tournament_id=c.tournament_id AND user_id=(stack_item->>'user_id')::uuid FOR UPDATE;
 SELECT * INTO seat FROM public.table_seats WHERE id=(stack_item->>'seat_id')::uuid FOR UPDATE;
 IF roster.id IS NULL OR roster.chips IS DISTINCT FROM (stack_item->>'stack_before')::numeric
 OR seat.id IS NULL OR seat.table_id IS DISTINCT FROM c.table_id OR seat.user_id IS DISTINCT FROM (stack_item->>'user_id')::uuid
 OR seat.joined_at IS DISTINCT FROM (stack_item->>'seat_joined_at')::timestamptz
 OR seat.stack IS DISTINCT FROM (stack_item->>'stack_before')::numeric
 OR (NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.expected->'rows')x WHERE x->>'user_id'=stack_item->>'user_id')
 AND (roster.status IS DISTINCT FROM 'playing' OR seat.left_at IS NOT NULL))
 THEN RAISE EXCEPTION 'ADDITIONAL_TOURNAMENT_DEALT_CUSTODY_CHANGED' USING ERRCODE='55000';END IF;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(c.expected->'rows') LOOP
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.request->'p_stacks')x WHERE x=item->'stack')
 THEN RAISE EXCEPTION 'ADDITIONAL_TOURNAMENT_PAYLOAD_CHANGED' USING ERRCODE='55000';END IF;
 SELECT * INTO roster FROM public.tournament_players WHERE id=(item#>>'{roster,id}')::uuid FOR UPDATE;
 SELECT * INTO seat FROM public.table_seats WHERE id=(item#>>'{seat,id}')::uuid FOR UPDATE;
 SELECT jsonb_object_agg(key,value) INTO projected FROM jsonb_each(to_jsonb(roster))
 WHERE key=ANY(ARRAY['id','user_id','tournament_id','status','chips','position','prize','table_id','seat_number','rebuys','add_on','eliminated_at','current_bounty','bounty_winnings','bounties_collected','rebuy_prompt_until','elimination_sequence']);
 IF projected IS DISTINCT FROM item->'roster'
 THEN RAISE EXCEPTION 'ADDITIONAL_TOURNAMENT_ROSTER_CHANGED' USING ERRCODE='55000';END IF;
 SELECT jsonb_object_agg(key,value) INTO projected FROM jsonb_each(to_jsonb(seat))
 WHERE key=ANY(ARRAY['id','table_id','user_id','club_id','seat_number','joined_at','occupancy_id','stack','left_at','status','is_sitting_out','is_away','leave_pending','active_game_scope','active_parent_key']);
 IF projected IS DISTINCT FROM item->'seat'
 OR NOT EXISTS(SELECT 1 FROM smarter_private.patterned_identity_retirements r JOIN public.profiles p ON p.id=r.old_id
 WHERE r.old_id=roster.user_id AND r.cohort='horse' AND r.retired_at IS NOT NULL AND r.replacement_horse_id IS NULL
 AND p.status='deleted' AND p.horse_status='disabled')
 OR EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=c.tournament_id AND f.user_id=roster.user_id AND f.observed_at>=(s.request#>>'{p_hand_row,started_at}')::timestamptz)
 OR EXISTS(SELECT 1 FROM public.tournament_payouts p WHERE p.tournament_id=c.tournament_id AND p.user_id=roster.user_id)
 OR EXISTS(SELECT 1 FROM public.tournament_seat_move_receipts m WHERE m.tournament_id=c.tournament_id AND m.user_id=roster.user_id AND m.moved_at>=roster.eliminated_at)
 THEN RAISE EXCEPTION 'ADDITIONAL_TOURNAMENT_OWNERSHIP_CHANGED' USING ERRCODE='55000';END IF;
 END LOOP;
 END LOOP;
 IF (SELECT count(*) FROM smarter_private.retirement_original_hand_qualification)<>59
 OR (SELECT sum(jsonb_array_length(expected->'rows')) FROM smarter_private.retirement_original_hand_qualification)<>68
 THEN RAISE EXCEPTION 'ADDITIONAL_TOURNAMENT_CARDINALITY_CHANGED' USING ERRCODE='55000';END IF;
END $authority$;
-- @live-proof: (SELECT count(*)=59 AND sum(jsonb_array_length(expected->'rows'))=68 FROM smarter_private.retirement_original_hand_qualification)
-- @live-proof: (SELECT md5(jsonb_agg(to_jsonb(q) ORDER BY submission_id)::text)='26488d98acd8612f16aec0bd06e99bcd' FROM smarter_private.retirement_original_hand_qualification q WHERE submission_id NOT IN('13b3d759-2915-4f10-974a-28649a3ece9e'::uuid,'54aed95a-98de-4d12-a8b5-fb7da2c1b59f'::uuid))
-- @live-proof: md5(pg_get_functiondef('smarter_private.restore_retired_original_tournament_hand(uuid,text,uuid)'::regprocedure))='a529e0bd2972a5b87eff0afa5fce7988'
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_guard_seat_creation()'::regprocedure))='34016ee7fb4957fe0d46dfb78c8fd5b7'
COMMIT;
