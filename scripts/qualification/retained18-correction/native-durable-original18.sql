DO $proof$
DECLARE s record;a public.hand_atomic_commits;p smarter_private.f06_hand_permits;x jsonb;expected_atomic text;n integer:=0;seats integer:=0;
BEGIN
 FOR s IN SELECT j.*,b.handoff_md5,b.result_md5,b.request_md5 FROM smarter_private.hand_submissions j JOIN native_original_assert.originals b USING(submission_id) LOOP
  IF md5(s.request::text) IS DISTINCT FROM s.request_md5
   OR (SELECT md5(to_jsonb(h)::text) FROM smarter_private.hand_submission_handoffs h WHERE h.submission_id=s.submission_id) IS DISTINCT FROM s.handoff_md5
   OR (SELECT md5(to_jsonb(r)::text) FROM smarter_private.hand_submission_handoff_results r WHERE r.submission_id=s.submission_id) IS DISTINCT FROM s.result_md5 THEN RAISE EXCEPTION 'ORIGINAL_FULLROW_CHANGED';END IF;
  SELECT * INTO a FROM public.hand_atomic_commits WHERE table_id=s.table_id AND hand_number=s.hand_number;
  expected_atomic:=encode(extensions.digest(convert_to(jsonb_build_object(
   'table_id',s.table_id,'hand_number',s.hand_number,
   'stacks',(SELECT jsonb_agg(v ORDER BY v->>'user_id') FROM jsonb_array_elements(s.request->'p_stacks') v),
   'rake',(s.request->>'p_rake')::numeric,'bbj',(s.request->>'p_bbj')::numeric,
   'ref',s.request->>'p_ref','inflow',(s.request->>'p_inflow')::numeric,'hand_row',s.request->'p_hand_row',
   'units',(SELECT coalesce(jsonb_agg(v ORDER BY v::text),'[]'::jsonb) FROM jsonb_array_elements(s.request->'p_units') v)
   )::text,'UTF8'),'sha256'),'hex');

  SELECT * INTO p FROM smarter_private.f06_hand_permits WHERE table_id=s.table_id AND hand_number=s.hand_number;
  IF a.hand_id IS DISTINCT FROM s.submission_id OR a.payload_hash IS DISTINCT FROM expected_atomic
   OR a.post_commit_request_hash IS DISTINCT FROM encode(extensions.digest(convert_to((s.request->'p_post_commit_obligations')::text,'UTF8'),'sha256'),'hex')
   OR a.post_commit_payload_hash IS DISTINCT FROM encode(extensions.digest(convert_to(a.post_commit_payload::text,'UTF8'),'sha256'),'hex')
   OR a.post_commit_payload->'accepted_hand_facts' IS DISTINCT FROM s.request#>'{p_hand_row,_accepted_post_commit_facts}'
   OR a.post_commit_completed_at IS NULL OR a.post_commit_result->>'ok' IS DISTINCT FROM 'true'
   OR a.stack_result->>'success' IS DISTINCT FROM 'true'
   OR a.stack_result->>'conservation_checked' IS DISTINCT FROM 'true'
   OR p.state IS DISTINCT FROM 'accepted' OR p.generation IS DISTINCT FROM s.lease_generation
   OR p.evidence_id IS DISTINCT FROM s.submission_id
   OR (SELECT count(*) FROM public.hand_history h WHERE h.id=s.submission_id AND h.table_id=s.table_id AND h.hand_number=s.hand_number) IS DISTINCT FROM 1::bigint
   OR NOT EXISTS(SELECT FROM smarter_private.hand_submission_correction_results r WHERE r.submission_id=s.submission_id AND r.result->>'success'='true' AND r.result->>'commit_hash'=a.payload_hash)
   THEN RAISE EXCEPTION 'ATOMIC_ORIGINAL_BINDING_REFUSED hand% flags%',s.hand_number,jsonb_build_object('atomic_id',a.hand_id=s.submission_id,'request_hash',a.post_commit_request_hash=encode(extensions.digest(convert_to((s.request->'p_post_commit_obligations')::text,'UTF8'),'sha256'),'hex'),'post',a.post_commit_result->>'ok','stack_success',a.stack_result->>'success','conservation',a.stack_result->>'conservation_checked','permit',p.state,'permit_evidence',p.evidence_id=s.submission_id,'history_count',(SELECT count(*) FROM public.hand_history h WHERE h.id=s.submission_id),'result_hash',(SELECT r.result->>'commit_hash'=a.payload_hash FROM smarter_private.hand_submission_correction_results r WHERE r.submission_id=s.submission_id)); END IF;
  IF EXISTS(SELECT FROM public.hand_history hh CROSS JOIN LATERAL jsonb_each(s.request->'p_hand_row') kv JOIN pg_attribute att ON att.attrelid='public.hand_history'::regclass AND att.attname=kv.key AND att.attnum>0 AND NOT att.attisdropped WHERE hh.id=s.submission_id AND (to_jsonb(hh)->kv.key) IS DISTINCT FROM (to_jsonb(jsonb_populate_record(NULL::public.hand_history,s.request->'p_hand_row'))->kv.key)) THEN RAISE EXCEPTION 'ORIGINAL_NAMED_HISTORY_PROVENANCE_MISMATCH';END IF;
  IF (SELECT sum((v->>'stack')::numeric-(v->>'stack_before')::numeric) FROM jsonb_array_elements(s.request->'p_stacks')v)
   +coalesce((s.request->>'p_rake')::numeric,0)+coalesce((s.request->>'p_bbj')::numeric,0)-coalesce((s.request->>'p_inflow')::numeric,0) IS DISTINCT FROM 0::numeric THEN RAISE EXCEPTION 'ORIGINAL30_CONSERVATION';END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(s.request->'p_stacks') LOOP
   IF NOT EXISTS(SELECT FROM public.table_seats t WHERE t.id=(x->>'seat_id')::uuid AND t.user_id=(x->>'user_id')::uuid AND t.joined_at=(x->>'seat_joined_at')::timestamptz AND t.stack=(x->>'stack')::numeric)
    OR NOT EXISTS(SELECT FROM public.tournament_players t WHERE t.tournament_id=(s.request#>>'{p_hand_row,tournament_id}')::uuid AND t.user_id=(x->>'user_id')::uuid AND t.chips=(x->>'stack')::numeric) OR (a.stack_result->'written'->>(x->>'user_id'))::numeric IS DISTINCT FROM (x->>'stack')::numeric THEN RAISE EXCEPTION 'ORIGINAL_STACK_OWNERSHIP_OR_FINAL_VALUE';END IF;seats:=seats+1;
  END LOOP;n:=n+1;
 END LOOP;
 IF n<>30 OR seats<>248 OR EXISTS(SELECT FROM smarter_private.hand_submission_dispatch) THEN RAISE EXCEPTION 'ACTUAL30_DURABLE_CARDINALITY';END IF;
 IF native_original_assert.financial_sets() IS DISTINCT FROM (SELECT sets FROM native_original_assert.before_financial) THEN RAISE EXCEPTION 'UNEXPECTED_MONETARY_FOOTPRINT';END IF;
 RAISE NOTICE 'PASS actual30 full original hashes, atomic/request/F06/history/postcommit binding, 248 exact seat/roster stacks, conservation and unchanged monetary sets';
END $proof$;
