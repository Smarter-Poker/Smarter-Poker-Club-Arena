-- Native qualification prototype ONLY. Not a production migration or admission.
-- The caller supplies a retained original fixture, never current membership.
-- A production owner must select these witnesses from their immutable relations.
CREATE FUNCTION pg_temp.original_retirement_boundary_proof(f jsonb, lo timestamptz, hi timestamptz)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $body$
DECLARE
 a jsonb:=f#>'{prior,after_row}'; b jsonb:=f#>'{next,before_row}';
 z jsonb:=f#>'{next,after_row}'; q jsonb:=f->'qualification';
 r jsonb:=f->'restoration'; s jsonb:=f#>'{retained,original_submission}';
 roster jsonb:=q#>'{row,roster}'; seat jsonb:=q#>'{row,seat}';
 original_stack jsonb:=q#>'{row,stack}'; t timestamptz;
 committed jsonb:=f->'atomic_commit';
BEGIN
 IF f IS NULL OR lo IS NULL OR hi IS NULL OR lo>=hi OR a IS NULL OR b IS NULL OR z IS NULL
 OR q IS NULL OR r IS NULL OR s IS NULL OR roster IS NULL OR seat IS NULL OR original_stack IS NULL OR committed IS NULL THEN
  RETURN jsonb_build_object('ready',false,'reason','missing_original_witness');
 END IF;
 IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR jsonb_typeof(a) IS DISTINCT FROM 'object'
 OR jsonb_typeof(b) IS DISTINCT FROM 'object' OR jsonb_typeof(z) IS DISTINCT FROM 'object'
 OR jsonb_typeof(q) IS DISTINCT FROM 'object' OR jsonb_typeof(r) IS DISTINCT FROM 'object'
 OR jsonb_typeof(s) IS DISTINCT FROM 'object' OR jsonb_typeof(roster) IS DISTINCT FROM 'object'
 OR jsonb_typeof(seat) IS DISTINCT FROM 'object' OR jsonb_typeof(original_stack) IS DISTINCT FROM 'object'
 OR jsonb_typeof(committed) IS DISTINCT FROM 'object' THEN
  RETURN jsonb_build_object('ready',false,'reason','malformed_original_structure');
 END IF;
 IF committed->>'hand_id' IS DISTINCT FROM q->>'submission_id'
 OR committed->>'table_id' IS DISTINCT FROM q->>'table_id'
 OR committed->>'hand_number' IS DISTINCT FROM q->>'hand_number'
 OR committed->'post_commit_completed' IS DISTINCT FROM 'true'::jsonb
 OR committed->>'post_commit_ok' IS DISTINCT FROM 'true'
 OR committed->>'row_md5' IS NULL OR committed->>'row_md5' !~ '^[0-9a-f]{32}$' THEN
  RETURN jsonb_build_object('ready',false,'reason','original_atomic_completion_unproven');
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(q) e WHERE e.value='null'::jsonb)
 OR EXISTS(SELECT 1 FROM jsonb_each(r) e WHERE e.value='null'::jsonb)
 OR EXISTS(SELECT 1 FROM jsonb_each(s) e WHERE e.value='null'::jsonb)
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['id','user_id','tournament_id','club_id']) k
    WHERE nullif(a->>k,'') IS NULL)
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['id','user_id','club_id','table_id','occupancy_id','joined_at']) k
    WHERE nullif(seat->>k,'') IS NULL)
 OR f#>>'{prior,event_id}' IS NULL OR f#>>'{next,event_id}' IS NULL
 OR f#>>'{prior,observed_at}' IS NULL OR f#>>'{next,observed_at}' IS NULL
 OR f#>>'{next,transaction_id}' IS NULL THEN
  RETURN jsonb_build_object('ready',false,'reason','null_original_authority');
 END IF;
 IF NOT(a ?& ARRAY['id','user_id','tournament_id','club_id','prize','bounty_winnings','status','eliminated_at'])
 OR NOT(roster ?& ARRAY['id','user_id','tournament_id','chips','position','prize','status','eliminated_at'])
 OR NOT(seat ?& ARRAY['id','user_id','club_id','table_id','occupancy_id','stack','joined_at'])
 OR NOT(original_stack ?& ARRAY['seat_id','user_id','seat_joined_at','stack_before'])
 OR jsonb_typeof(roster->'chips') IS DISTINCT FROM 'number'
 OR jsonb_typeof(seat->'stack') IS DISTINCT FROM 'number'
 OR jsonb_typeof(original_stack->'stack_before') IS DISTINCT FROM 'number'
 OR NOT(q ?& ARRAY['submission_id','table_id','tournament_id','hand_number','request_hash','qualification_hash'])
 OR NOT(r ?& ARRAY['submission_id','request_hash','qualification_hash','original_generation','successor_generation','transaction_id','restored_at','restored_players'])
 OR NOT(s ?& ARRAY['submission_id','request_hash','table_id','hand_number','lease_generation','stacks','started_at'])
 OR jsonb_typeof(f#>'{retained,expected,rows}') IS DISTINCT FROM 'array'
 OR jsonb_typeof(s->'stacks') IS DISTINCT FROM 'array' THEN
  RETURN jsonb_build_object('ready',false,'reason','missing_original_field');
 END IF;
 t:=(b->>'eliminated_at')::timestamptz;
 -- The interval endpoints may never cross the unrecorded transient state.
 IF t IS NULL OR NOT(lo<t AND greatest((r->>'restored_at')::timestamptz,(f#>>'{next,observed_at}')::timestamptz)<hi)
 OR NOT((f#>>'{prior,observed_at}')::timestamptz<t AND t<(r->>'restored_at')::timestamptz
 AND t<(f#>>'{next,observed_at}')::timestamptz)
 OR (f#>>'{prior,event_id}')::bigint>=(f#>>'{next,event_id}')::bigint THEN
  RETURN jsonb_build_object('ready',false,'reason','boundary_or_chronology_unproven');
 END IF;
 IF a IS DISTINCT FROM z OR (a-ARRAY['status','eliminated_at']) IS DISTINCT FROM (b-ARRAY['status','eliminated_at'])
 OR a->>'status' IS DISTINCT FROM 'playing' OR a->'eliminated_at' IS DISTINCT FROM 'null'::jsonb
 OR b->>'status' IS DISTINCT FROM 'eliminated' OR (a->>'prize')::numeric IS DISTINCT FROM 0
 OR (a->>'bounty_winnings')::numeric IS DISTINCT FROM (roster->>'bounty_winnings')::numeric
 OR (a->>'id',a->>'user_id',a->>'tournament_id') IS DISTINCT FROM
    (roster->>'id',roster->>'user_id',roster->>'tournament_id')
 OR roster->>'status' IS DISTINCT FROM b->>'status' OR roster->>'eliminated_at' IS DISTINCT FROM b->>'eliminated_at'
 OR roster->'position' IS DISTINCT FROM 'null'::jsonb OR (roster->>'prize')::numeric IS DISTINCT FROM 0
 OR (roster->>'chips')::numeric<=0 OR roster->>'chips' IS DISTINCT FROM seat->>'stack'
 OR roster->>'chips' IS DISTINCT FROM original_stack->>'stack_before'
 OR original_stack->>'seat_id' IS DISTINCT FROM seat->>'id'
 OR original_stack->>'user_id' IS DISTINCT FROM a->>'user_id'
 OR original_stack->>'seat_joined_at' IS DISTINCT FROM seat->>'joined_at'
 OR seat->>'user_id' IS DISTINCT FROM a->>'user_id' OR seat->>'club_id' IS DISTINCT FROM a->>'club_id'
 OR seat->>'table_id' IS DISTINCT FROM q->>'table_id' OR seat->>'occupancy_id' IS NULL THEN
  RETURN jsonb_build_object('ready',false,'reason','original_value_or_ownership_changed');
 END IF;
 IF q->>'submission_id' IS DISTINCT FROM r->>'submission_id'
 OR q->>'submission_id' IS DISTINCT FROM s->>'submission_id'
 OR q->>'request_hash' IS DISTINCT FROM s->>'request_hash'
 OR q->>'request_hash' IS DISTINCT FROM r->>'request_hash'
 OR q->>'table_id' IS DISTINCT FROM s->>'table_id' OR q->>'hand_number' IS DISTINCT FROM s->>'hand_number'
 OR q->>'tournament_id' IS DISTINCT FROM a->>'tournament_id'
 OR r->>'original_generation' IS DISTINCT FROM s->>'lease_generation'
 OR r->>'successor_generation' IS NULL OR r->>'successor_generation'=r->>'original_generation'
 OR r->>'transaction_id' IS DISTINCT FROM f#>>'{next,transaction_id}'
 OR q->>'qualification_hash' IS DISTINCT FROM r->>'qualification_hash'
 OR md5((f#>'{retained,expected}')::text) IS DISTINCT FROM r->>'qualification_hash'
 OR (SELECT count(*) FROM jsonb_array_elements(f#>'{retained,expected,rows}') e WHERE e=q->'row')<>1
 OR (SELECT count(*) FROM jsonb_array_elements(s->'stacks') e WHERE e=original_stack)<>1
 OR (r->>'restored_players')::integer IS DISTINCT FROM jsonb_array_length(f#>'{retained,expected,rows}')
 OR NOT((s->>'started_at')::timestamptz<greatest((r->>'restored_at')::timestamptz,(f#>>'{next,observed_at}')::timestamptz))
 OR NOT(t BETWEEN '2026-10-06 15:33:04Z'::timestamptz AND '2026-10-06 15:33:08Z'::timestamptz) THEN
  RETURN jsonb_build_object('ready',false,'reason','original_restoration_not_bound');
 END IF;
 RETURN jsonb_build_object('ready',true,'proof_class','original_tournament_restoration_cycle',
 'financial_admission',false,'original_force_transaction','not_retained',
 'prior_event',f#>'{prior,event_id}','restoration_event',f#>'{next,event_id}',
 'original_row_hash',md5(a::text),'forced_row_hash',md5(b::text),
 'original_qualification_hash',r->>'qualification_hash','from',lo,'until',hi);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
 RETURN jsonb_build_object('ready',false,'reason','malformed_original_witness');
END $body$;
