DO $wallet_positive$
DECLARE a jsonb;b jsonb;
BEGIN
 SELECT jsonb_agg(to_jsonb(f)ORDER BY ledger_id) INTO a FROM public.fn_union_pnl_original_flow_evidence('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z')f;
 SELECT jsonb_agg(to_jsonb(f)ORDER BY ledger_id) INTO b FROM smarter_private.union_pnl_original_flow_evidence_window('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z','2026-10-19 07:00Z','2026-10-26 07:00Z')f;
 IF a IS DISTINCT FROM b OR jsonb_array_length(a)<>84 OR EXISTS(SELECT FROM jsonb_array_elements(a)f WHERE f->'valid'<>'true'::jsonb OR f->>'kind'<>'cash_return' OR (f->>'buyins')::numeric<>0)
 OR (SELECT sum((f->>'cashouts')::numeric)FROM jsonb_array_elements(a)f)<>33465.32 THEN RAISE EXCEPTION 'wallet jackpot full/window original receipt proof differs';END IF;
 IF (SELECT sum(amount) FROM public.fn_union_pnl_week_bbj_stack_awards('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z')) IS DISTINCT FROM 33465.32::numeric THEN RAISE EXCEPTION 'wallet jackpot award amount differs';END IF;
 IF EXISTS(WITH flow AS(SELECT club_id,user_id,sum(cashouts) amount FROM public.fn_union_pnl_original_flow_evidence('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z')GROUP BY club_id,user_id),award AS(SELECT club_id,user_id,sum(amount) amount FROM public.fn_union_pnl_week_bbj_stack_awards('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z')GROUP BY club_id,user_id)SELECT FROM flow f FULL JOIN award a USING(club_id,user_id)WHERE f.amount IS DISTINCT FROM a.amount) THEN RAISE EXCEPTION 'wallet jackpot per player profit bridge differs';END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true OR position('count(*)=43' IN pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure))=0 THEN RAISE EXCEPTION 'wallet jackpot forty original plus three qualified sources not bound';END IF;
 IF EXISTS(SELECT FROM wallet_jackpot_original_metadata m JOIN pg_proc p ON p.oid=to_regprocedure(m.signature)WHERE m.attributes IS DISTINCT FROM jsonb_build_array(p.proowner,p.provolatile,p.prosecdef,p.proisstrict,p.proconfig,p.proacl::text))THEN RAISE EXCEPTION 'wallet jackpot reader authority metadata changed';END IF;
 RAISE NOTICE 'PASS captured84 wallet awards33465.32 full/window parity per-player profit bridge and43-source authority metadata';
END $wallet_positive$;
DO $wallet_negative$
DECLARE test record;bad bigint;passed int:=0;
BEGIN
 FOR test IN SELECT * FROM(VALUES
 ('duplicate recipient conserving event total',$q$INSERT INTO bbj_payout_recipients SELECT gen_random_uuid(),payout_id,user_id,amount,created_at FROM bbj_payout_recipients WHERE payout_id='b114c635-a1dc-4a6e-b392-6a954a13068e' AND user_id='023a16c3-4ddb-427f-a9f8-cd7b1d9072f1';UPDATE bbj_payouts SET total_amount=total_amount+26.56 WHERE id='b114c635-a1dc-4a6e-b392-6a954a13068e';UPDATE chip_ledger SET amount=amount+26.56 WHERE id='4d3a6c12-5197-424a-9c09-e6c192b79bc9'$q$,1),
 ('duplicate wallet journal',$q$INSERT INTO chip_transactions SELECT (jsonb_populate_record(NULL::chip_transactions,to_jsonb(t)||jsonb_build_object('id',gen_random_uuid()))).* FROM chip_transactions t WHERE to_user_id='023a16c3-4ddb-427f-a9f8-cd7b1d9072f1' AND amount=26.56 AND transaction_type='bbj_payout'$q$,1),
 ('duplicate pool debit',$q$INSERT INTO chip_ledger SELECT (jsonb_populate_record(NULL::chip_ledger,to_jsonb(l)||jsonb_build_object('id',gen_random_uuid()))).* FROM chip_ledger l WHERE id='4d3a6c12-5197-424a-9c09-e6c192b79bc9'$q$,6),
 ('missing wallet key',$q$DELETE FROM wallet_credit_idempotency WHERE key='bbj:b114c635-a1dc-4a6e-b392-6a954a13068e:023a16c3-4ddb-427f-a9f8-cd7b1d9072f1'$q$,1),
 ('wrong wallet amount',$q$UPDATE wallet_credit_idempotency SET amount=amount+.01 WHERE key='bbj:b114c635-a1dc-4a6e-b392-6a954a13068e:023a16c3-4ddb-427f-a9f8-cd7b1d9072f1'$q$,1),
 ('missing wallet journal',$q$DELETE FROM chip_transactions WHERE to_user_id='023a16c3-4ddb-427f-a9f8-cd7b1d9072f1' AND amount=26.56 AND transaction_type='bbj_payout'$q$,1),
 ('missing pool debit',$q$DELETE FROM chip_ledger WHERE id='4d3a6c12-5197-424a-9c09-e6c192b79bc9'$q$,6),
 ('wrong payout total',$q$UPDATE bbj_payouts SET total_amount=total_amount+.01 WHERE id='b114c635-a1dc-4a6e-b392-6a954a13068e'$q$,6),
 ('wrong recipient amount',$q$UPDATE bbj_payout_recipients SET amount=amount+.01 WHERE payout_id='b114c635-a1dc-4a6e-b392-6a954a13068e' AND user_id='023a16c3-4ddb-427f-a9f8-cd7b1d9072f1'$q$,6),
 ('wrong pool union',$q$UPDATE bbj_pools SET union_id='ffffffff-ffff-ffff-ffff-ffffffffffff' WHERE id='f9806a7f-e7a2-47d2-a676-36336e3a5337'$q$,84),
 ('malformed payout key',$q$UPDATE union_pnl_original_flows SET ledger_snapshot=jsonb_set(ledger_snapshot,'{idempotency_key}','"bbj:invalid:invalid"') WHERE ledger_id='83845a38-c6eb-4568-bb34-e0d92d0832af'$q$,1),
 ('wrong credited club',$q$UPDATE union_pnl_original_flows SET ledger_snapshot=jsonb_set(ledger_snapshot,'{club_id}','"ffffffff-ffff-ffff-ffff-ffffffffffff"') WHERE ledger_id='83845a38-c6eb-4568-bb34-e0d92d0832af'$q$,1),
 ('wrong source asset',$q$UPDATE union_pnl_original_flows SET game_scope=jsonb_set(game_scope,'{asset}','"ticket"') WHERE ledger_id='83845a38-c6eb-4568-bb34-e0d92d0832af'$q$,1),
 ('unknown category',$q$UPDATE union_pnl_original_flows SET ledger_snapshot=jsonb_set(ledger_snapshot,'{category}','"unknown_bonus"') WHERE ledger_id='83845a38-c6eb-4568-bb34-e0d92d0832af'$q$,1),
 ('unposted pool debit',$q$UPDATE chip_ledger SET status='pending' WHERE id='4d3a6c12-5197-424a-9c09-e6c192b79bc9'$q$,6),
 ('wrong payout table',$q$UPDATE bbj_payouts SET table_id='ffffffff-ffff-ffff-ffff-ffffffffffff' WHERE id='b114c635-a1dc-4a6e-b392-6a954a13068e'$q$,6),
 ('mismatched claim time',$q$UPDATE wallet_credit_idempotency SET created_at=created_at+interval '1 second' WHERE key='bbj:b114c635-a1dc-4a6e-b392-6a954a13068e:023a16c3-4ddb-427f-a9f8-cd7b1d9072f1'$q$,1),
 ('wrong pool amount',$q$UPDATE chip_ledger SET amount=amount+.01 WHERE id='4d3a6c12-5197-424a-9c09-e6c192b79bc9'$q$,6),
 ('missing recipient',$q$DELETE FROM bbj_payout_recipients WHERE payout_id='b114c635-a1dc-4a6e-b392-6a954a13068e' AND user_id='023a16c3-4ddb-427f-a9f8-cd7b1d9072f1'$q$,6),
 ('wrong source account',$q$UPDATE union_pnl_original_flows SET ledger_snapshot=jsonb_set(ledger_snapshot,'{from_type}','"club_treasury"') WHERE ledger_id='83845a38-c6eb-4568-bb34-e0d92d0832af'$q$,1)
 )x(name,mutation,expected_bad) LOOP
  BEGIN
   EXECUTE test.mutation;
   SELECT count(*)FILTER(WHERE NOT valid)INTO bad FROM public.fn_union_pnl_original_flow_evidence('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z');
   IF bad IS DISTINCT FROM test.expected_bad::bigint THEN RAISE EXCEPTION 'wallet jackpot negative % expected% got%',test.name,test.expected_bad,bad;END IF;
   RAISE EXCEPTION USING ERRCODE='ZX001',MESSAGE='revert native negative';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN passed:=passed+1;END;
 END LOOP;
 RAISE NOTICE 'PASS wallet jackpot % missing/wrong/unknown receipt refusals; no category-only admission',passed;
END $wallet_negative$;
DO $wallet_money$BEGIN
 IF EXISTS(SELECT FROM wallet_jackpot_original_money m WHERE m.ledger IS DISTINCT FROM md5((SELECT jsonb_agg(to_jsonb(l)ORDER BY id)::text FROM chip_ledger l))OR m.payouts IS DISTINCT FROM md5((SELECT jsonb_agg(to_jsonb(b)ORDER BY id)::text FROM bbj_payouts b))OR m.pools IS DISTINCT FROM md5((SELECT jsonb_agg(to_jsonb(b)ORDER BY id)::text FROM bbj_pools b)))THEN RAISE EXCEPTION 'wallet jackpot reader changed original money';END IF;
END $wallet_money$;
