DO $test$BEGIN
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status' IS DISTINCT FROM 'proven' THEN RAISE EXCEPTION 'real original escrow baseline unproved';END IF;
 BEGIN
 UPDATE cash_funding_application_receipts SET applied=applied+1 WHERE funding_receipt_id='f6cd3e20-e3a4-46e0-b4a4-5327794102fc';
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: application amount';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: application amount';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS application amount';END;
 BEGIN
 UPDATE cash_funding_application_receipts SET refunded=1 WHERE funding_receipt_id='f6cd3e20-e3a4-46e0-b4a4-5327794102fc';
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: application refund';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: application refund';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS application refund';END;
 BEGIN
 UPDATE cash_funding_application_receipts SET applied_at='2026-10-10 18:23:19.4+00' WHERE funding_receipt_id='f6cd3e20-e3a4-46e0-b4a4-5327794102fc';
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: application before hand accepted';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: application before hand accepted';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS application before hand accepted';END;
 BEGIN
 UPDATE cash_funding_application_receipts SET applied_at='2026-10-10 18:24:00+00' WHERE funding_receipt_id='f6cd3e20-e3a4-46e0-b4a4-5327794102fc';
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: application after completion';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: application after completion';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS application after completion';END;
 BEGIN
 UPDATE cash_funding_application_receipts SET applied_occupancy_id='00000000-0000-0000-0000-000000000099' WHERE funding_receipt_id='f6cd3e20-e3a4-46e0-b4a4-5327794102fc';
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: application wrong occupancy';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: application wrong occupancy';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS application wrong occupancy';END;
 BEGIN
 UPDATE cash_funding_application_receipts SET pending_addon_id='00000000-0000-0000-0000-000000000099' WHERE funding_receipt_id='f6cd3e20-e3a4-46e0-b4a4-5327794102fc';
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: application wrong pending identity';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: application wrong pending identity';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS application wrong pending identity';END;
 BEGIN
 UPDATE cash_funding_application_receipts SET transaction_id=NULL WHERE funding_receipt_id='f6cd3e20-e3a4-46e0-b4a4-5327794102fc';
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: application NULL transaction';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: application NULL transaction';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS application NULL transaction';END;
 BEGIN
 UPDATE cash_participant_funding_receipts SET user_id='00000000-0000-0000-0000-000000000099' WHERE id='f6cd3e20-e3a4-46e0-b4a4-5327794102fc';
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: funding wrong wallet owner';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: funding wrong wallet owner';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS funding wrong wallet owner';END;
 BEGIN
 UPDATE cash_participant_funding_receipts SET table_id='00000000-0000-0000-0000-000000000099' WHERE id='f6cd3e20-e3a4-46e0-b4a4-5327794102fc';
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: funding wrong table';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: funding wrong table';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS funding wrong table';END;
 BEGIN
 UPDATE cash_participant_funding_receipts SET seat_id='00000000-0000-0000-0000-000000000099' WHERE id='f6cd3e20-e3a4-46e0-b4a4-5327794102fc';
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: funding wrong seat';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: funding wrong seat';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS funding wrong seat';END;
 BEGIN
 UPDATE cash_participant_funding_receipts SET occupancy_id='00000000-0000-0000-0000-000000000099' WHERE id='f6cd3e20-e3a4-46e0-b4a4-5327794102fc';
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: funding wrong occupancy';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: funding wrong occupancy';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS funding wrong occupancy';END;
 BEGIN
 UPDATE cash_participant_funding_receipts SET amount=NULL WHERE id='f6cd3e20-e3a4-46e0-b4a4-5327794102fc';
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: funding NULL amount';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: funding NULL amount';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS funding NULL amount';END;
 BEGIN
 UPDATE cash_participant_funding_receipts SET amount=amount+0.001 WHERE id='f6cd3e20-e3a4-46e0-b4a4-5327794102fc';
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: funding subcent amount';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: funding subcent amount';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS funding subcent amount';END;
 BEGIN
 UPDATE cash_participant_funding_receipts SET balance_after=balance_after+1 WHERE id='f6cd3e20-e3a4-46e0-b4a4-5327794102fc';
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: funding wallet conservation';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: funding wallet conservation';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS funding wallet conservation';END;
 BEGIN
 UPDATE hand_atomic_commits SET post_commit_result=jsonb_set(post_commit_result,'{ok}','false') WHERE table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND hand_number=31008564;
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: postcommit false';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: postcommit false';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS postcommit false';END;
 BEGIN
 UPDATE hand_atomic_commits SET post_commit_payload=jsonb_set(post_commit_payload,'{pending_addons,ids}','[]') WHERE table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND hand_number=31008564;
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: pending source obligation absent';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: pending source obligation absent';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS pending source obligation absent';END;
 BEGIN
 UPDATE union_pnl_inventory_events SET before_row=jsonb_set(before_row,'{stack}','214.53') WHERE event_id=57263807;
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: felt before hand stack mismatch';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: felt before hand stack mismatch';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS felt before hand stack mismatch';END;
 BEGIN
 UPDATE union_pnl_inventory_events SET after_row=jsonb_set(after_row,'{stack}','585.15') WHERE event_id=57263807;
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: felt applied quantity mismatch';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: felt applied quantity mismatch';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS felt applied quantity mismatch';END;
 BEGIN
 UPDATE union_pnl_inventory_events SET before_row=jsonb_set(before_row,'{occupancy_id}','"00000000-0000-0000-0000-000000000099"') WHERE event_id=57263807;
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: felt wrong original occupancy';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: felt wrong original occupancy';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS felt wrong original occupancy';END;
 BEGIN
 UPDATE union_pnl_inventory_events SET after_row=jsonb_set(after_row,'{user_id}','"00000000-0000-0000-0000-000000000099"') WHERE event_id=57263807;
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: felt wrong beneficiary';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: felt wrong beneficiary';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS felt wrong beneficiary';END;
 BEGIN
 UPDATE union_pnl_inventory_events SET observed_at='2026-10-10 18:22:00+00' WHERE event_id=57263807;
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: felt before accepted timestamp';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: felt before accepted timestamp';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS felt before accepted timestamp';END;
 BEGIN
 UPDATE union_pnl_transaction_frames SET observed_at=observed_at+interval '1 second' WHERE transaction_id='1111921212';
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: transaction frame disagrees';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: transaction frame disagrees';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS transaction frame disagrees';END;
 BEGIN
 UPDATE cash_hand_provenance_receipts SET accepted_request=jsonb_set(accepted_request,'{inflow}','1') WHERE table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND hand_number=31008564;
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: current signed request hash';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: current signed request hash';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS current signed request hash';END;
 BEGIN
 UPDATE cash_hand_provenance_receipts SET participants=jsonb_set(participants,'{1,stack_before}','null') WHERE table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND hand_number=31008564;
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: original target NULL stack';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: original target NULL stack';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS original target NULL stack';END;
 BEGIN
 UPDATE cash_hand_provenance_receipts SET participants=jsonb_set(participants,'{0,stack_before}','null') WHERE table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND hand_number=31008564;
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: other original player NULL stack';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: other original player NULL stack';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS other original player NULL stack';END;
 BEGIN
 UPDATE union_pnl_cash_outcomes SET evidence=jsonb_set(evidence,'{accepted_rake}','4') WHERE table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND hand_number=31008564;
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: accepted rake mismatch';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: accepted rake mismatch';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS accepted rake mismatch';END;
 BEGIN
 UPDATE cash_hand_provenance_receipts SET accepted_request=jsonb_set(accepted_request,'{inflow}','1') WHERE table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND hand_number=31007383;
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: predecessor signed request hash';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: predecessor signed request hash';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS predecessor signed request hash';END;
 BEGIN
 UPDATE union_pnl_cash_outcomes SET evidence=jsonb_set(evidence,'{issues}',evidence->'issues'||'"unrelated_defect"'::jsonb) WHERE table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND hand_number=31008564;
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status'='proven' THEN RAISE EXCEPTION 'negative admitted: unrelated original issue';END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE o.table_id='1c531058-25b9-4aad-b4f0-1641d1d085ea' AND o.hand_number=31008564) IS DISTINCT FROM false THEN RAISE EXCEPTION 'consumer admitted negative: unrelated original issue';END IF;
 RAISE EXCEPTION 'native negative rollback' USING ERRCODE='PT001';EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS unrelated original issue';END;
 IF public.fn_union_pnl_prove_posthand_escrow('1c531058-25b9-4aad-b4f0-1641d1d085ea',31008564)->>'status' IS DISTINCT FROM 'proven' THEN RAISE EXCEPTION 'originals not restored';END IF;
 RAISE NOTICE 'PASS 28 original escrow refusals and per-case rollback restoration';END $test$;
