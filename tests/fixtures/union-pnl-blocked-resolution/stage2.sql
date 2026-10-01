-- STAGE 2: after the migration.
DO $s2$
DECLARE r jsonb; b jsonb; q jsonb; n int; U constant uuid:='fade0000-0000-0000-0000-000000000001';
BEGIN
 -- Authority: only service_role (and the owner) may resolve; nobody browser-side.
 IF has_function_privilege('anon','public.fn_union_pnl_resolve_blocked_cash_week(uuid,timestamptz,timestamptz,text,boolean)','EXECUTE')
  OR has_function_privilege('authenticated','public.fn_union_pnl_resolve_blocked_cash_outcome(uuid,bigint,text)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.fn_union_pnl_resolve_blocked_cash_outcome(uuid,bigint,text)','EXECUTE')
  OR has_table_privilege('service_role','public.union_pnl_cash_outcome_resolutions','INSERT') THEN
  RAISE EXCEPTION 'stage2: resolution authority is wrong'; END IF;

 -- Dry run (default) re-proves every blocked hand and writes nothing.
 b:=public.fn_union_pnl_resolve_blocked_cash_week(U,'2026-09-14 07:00+00','2026-09-21 07:00+00',NULL);
 SELECT count(*) INTO n FROM public.union_pnl_cash_outcome_resolutions;
 IF (b->>'blocked_outcomes')::int<>7 OR (b->>'proven_not_written')::int<>2 OR (b->>'refused')::int<>5 OR n<>0
  OR (SELECT array_agg(x->>'reason' ORDER BY x->>'reason') FROM jsonb_array_elements(b->'refusals') x)
     <>ARRAY['late_credit_is_not_a_direct_add_on','next_hand_does_not_carry_the_late_credit','next_hand_does_not_carry_the_late_credit','outcome_has_other_evidence_defects','starting_stack_not_explained_by_receipts'] THEN
  RAISE EXCEPTION 'stage2: dry run wrong: % (rows %)',b,n; END IF;
 RAISE NOTICE 'PASS dry-run proves A G, refuses B C D E H, writes nothing';

 BEGIN
  PERFORM public.fn_union_pnl_resolve_blocked_cash_week(U,'2026-09-14 07:00+00','2026-09-21 07:00+00','short',true);
  RAISE EXCEPTION 'stage2: applied without a reason';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

 b:=public.fn_union_pnl_resolve_blocked_cash_week(U,'2026-09-14 07:00+00','2026-09-21 07:00+00','Late seat credit after roster snapshot, re-proved from receipts',true);
 IF (b->>'resolved_now')::int<>2 OR (b->>'refused')::int<>5 OR (b->>'late_credit_total')::numeric<>295.80 THEN
  RAISE EXCEPTION 'stage2: apply wrong: %',b; END IF;
 b:=public.fn_union_pnl_resolve_blocked_cash_week(U,'2026-09-14 07:00+00','2026-09-21 07:00+00','Late seat credit after roster snapshot, re-proved from receipts',true);
 IF (b->>'already_resolved')::int<>2 OR (b->>'resolved_now')::int<>0 THEN RAISE EXCEPTION 'stage2: not idempotent: %',b; END IF;
 RAISE NOTICE 'PASS apply resolves exactly the proven hands, idempotently';

 -- The report accepts the resolved hand and still refuses the unprovable four.
 r:=public.fn_union_pnl_evidence_report(U,'2026-09-14 07:00+00','2026-09-21 07:00+00');
 IF r->>'status'<>'blocked' OR r->'issues'<>'[{"reason":"accepted_cash_basis_incomplete","count":5}]'::jsonb
  OR (r->>'accepted_cash_hands_resolved')::int<>2 THEN
  RAISE EXCEPTION 'stage2: report after resolution wrong: issues % resolved %',r->'issues',r->'accepted_cash_hands_resolved'; END IF;
 RAISE NOTICE 'PASS report: resolved 2, unprovable 5 stay blocked';

 -- Hash binding: a receipt that does not match the outcome's evidence is ignored.
 INSERT INTO public.union_pnl_cash_outcome_resolutions(table_id,hand_number,hand_id,outcome_payload_hash,outcome_evidence_md5,resolution_kind,proof,reason)
 SELECT table_id,hand_number,hand_id,payload_hash,md5('forged'),'late_seat_credit_after_roster_snapshot','{"status":"proven"}','forged receipt that binds the wrong evidence'
 FROM public.union_pnl_cash_outcomes WHERE table_id='bbbbbbbb-0000-0000-0000-000000000002' AND hand_number=2000012;
 r:=public.fn_union_pnl_evidence_report(U,'2026-09-14 07:00+00','2026-09-21 07:00+00');
 IF r->'issues'<>'[{"reason":"accepted_cash_basis_incomplete","count":5}]'::jsonb THEN
  RAISE EXCEPTION 'stage2: a mis-bound receipt was accepted: %',r->'issues'; END IF;
 RAISE NOTICE 'PASS mis-bound receipt ignored';

 -- Receipts and outcomes are immutable.
 BEGIN UPDATE public.union_pnl_cash_outcome_resolutions SET reason=reason||'!'; RAISE EXCEPTION 'stage2: receipt mutable';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
 BEGIN DELETE FROM public.union_pnl_cash_outcome_resolutions; RAISE EXCEPTION 'stage2: receipt deletable';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
 BEGIN UPDATE public.union_pnl_cash_outcomes SET evidence=evidence; RAISE EXCEPTION 'stage2: outcome mutable';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
 RAISE NOTICE 'PASS immutability';

 -- A week whose only blocked hand is provable certifies once it is resolved.
 q:=public.fn_union_pnl_close_quality(U,'2026-09-07 07:00+00','2026-09-14 07:00+00');
 IF q->>'status'<>'blocked' THEN RAISE EXCEPTION 'stage2: week 09-07 certified before its receipt: %',q; END IF;
 b:=public.fn_union_pnl_resolve_blocked_cash_week(U,'2026-09-07 07:00+00','2026-09-14 07:00+00','Late seat credit after roster snapshot, re-proved from receipts',true);
 q:=public.fn_union_pnl_close_quality(U,'2026-09-07 07:00+00','2026-09-14 07:00+00');
 IF q->>'status'<>'ready' OR (b->>'resolved_now')::int<>1 THEN RAISE EXCEPTION 'stage2: week 09-07 not certified: % %',q,b; END IF;
 RAISE NOTICE 'PASS close_quality ready once every blocked hand is re-proved';
END $s2$;
SELECT 'ALL PASS' AS result;
