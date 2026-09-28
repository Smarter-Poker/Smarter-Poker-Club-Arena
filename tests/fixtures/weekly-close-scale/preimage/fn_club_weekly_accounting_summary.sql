CREATE OR REPLACE FUNCTION public.fn_club_weekly_accounting_summary(p_period_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_variable
DECLARE period public.settlement_periods%ROWTYPE;close_row public.ca_settlements%ROWTYPE;frozen jsonb;
 scope_kind text;scope_id uuid;run_status text;union_basis numeric:=0;private_basis numeric:=0;private_banked numeric:=0;private_burned numeric:=0;
 expected numeric:=0;received numeric:=0;outgoing numeric:=0;downstream numeric:=0;roles jsonb;down_roles jsonb;
 unknown_roles int;missing_periods int;receipt_issues int;source_issues int:=0;rows_count int;source_count int;stage_count int;
 ledger_ids jsonb;private_ledger_ids jsonb:='[]';source_fingerprint text;quality jsonb;bank record;bank_sources int;bank_sum numeric;bad_sources int;
 ready boolean;close_count int;
BEGIN
 SELECT * INTO period FROM public.settlement_periods WHERE id=p_period_id;
 IF NOT FOUND OR period.club_id IS NULL THEN RAISE EXCEPTION 'club_accounting_period_missing' USING ERRCODE='22023';END IF;
 IF NOT public.fn_caller_is_engine() AND NOT EXISTS(SELECT 1 FROM public.fn_accounting_party_users('club',period.club_id)u WHERE u.user_id=auth.uid())
  AND (period.union_id IS NULL OR auth.uid() IS NULL OR NOT public.fn_is_union_overseer(period.union_id,auth.uid()))
 THEN RAISE EXCEPTION 'club_accounting_not_authorised' USING ERRCODE='42501';END IF;
 -- Issued statements are historical documents. Never replace their original
 -- accounting basis with later membership, receipts, or agreement changes.
 SELECT i.breakdown INTO frozen FROM public.settlement_invoices i WHERE i.club_id=period.club_id AND i.period_id=period.id
  AND i.invoice_type='club_weekly_accounting' AND i.message_sent;
 IF FOUND THEN RETURN frozen;END IF;
 scope_kind:=CASE WHEN period.union_id IS NULL THEN 'club' ELSE 'union' END;scope_id:=COALESCE(period.union_id,period.club_id);
 SELECT r.status INTO run_status FROM public.union_accounting_runs r WHERE r.period_start=period.start_at AND r.period_end=period.end_at
  AND (r.union_id=period.union_id OR (period.union_id IS NULL AND r.union_id IS NULL AND to_jsonb(r)->>'standalone_club_id'=period.club_id::text));
 IF period.union_id IS NOT NULL THEN
  SELECT count(*) INTO close_count FROM public.ca_settlements s WHERE s.union_id=period.union_id AND s.settlement_type='union_rakeback_close'
   AND s.state='final' AND s.external_ref=period.union_id::text||':'||to_char(period.start_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
    ||'..'||to_char(period.end_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"');
  IF close_count=1 THEN
   SELECT * INTO close_row FROM public.ca_settlements s WHERE s.union_id=period.union_id AND s.settlement_type='union_rakeback_close'
    AND s.state='final' AND s.external_ref=period.union_id::text||':'||to_char(period.start_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
     ||'..'||to_char(period.end_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"');
   expected:=COALESCE((close_row.totals->'payout_by_club'->>period.club_id::text)::numeric,0);
  END IF;
  IF close_count<>1 OR close_row.totals->>'accounting_version' IS DISTINCT FROM '3' THEN source_issues:=source_issues+1;END IF;
 END IF;
 SELECT COALESCE(sum(s.rake_credit) FILTER(WHERE s.union_id IS NOT NULL),0),COALESCE(sum(s.rake_credit) FILTER(WHERE s.union_id IS NULL),0),count(*),
  md5(COALESCE(string_agg(jsonb_build_array(s.source_type,s.source_id,s.rake_record_id,s.earned_at,s.rake_credit,s.contract)::text,'' ORDER BY s.source_type,s.source_id),'')),
  count(*) FILTER(WHERE s.rake_credit IS NULL OR s.rake_credit<0 OR s.rake_credit<>round(s.rake_credit,2) OR s.rake_credit::text IN('NaN','Infinity','-Infinity')
   OR (s.union_id IS NOT NULL AND s.union_id IS DISTINCT FROM period.union_id))
 INTO union_basis,private_basis,source_count,source_fingerprint,bad_sources
 FROM public.accounting_payable_earning_sources s WHERE s.club_id=period.club_id AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id
  AND s.earned_at>=period.start_at AND s.earned_at<period.end_at;
 source_issues:=source_issues+bad_sources;
 IF NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND starts_at<=period.start_at) THEN source_issues:=source_issues+1;END IF;
 IF period.union_id IS NOT NULL AND union_basis IS DISTINCT FROM COALESCE((close_row.totals->'basis_by_club'->>period.club_id::text)::numeric,0)
 THEN source_issues:=source_issues+1;END IF;
 quality:=public.fn_accounting_tournament_week_quality(period.club_id,period.start_at,period.end_at);
 IF quality->>'status' IS DISTINCT FROM 'ready' THEN source_issues:=source_issues+1;END IF;
 -- Match every private source to its exact disposition. Cash retirement
 -- proves earned rake but supplies no spendable funding to this club.
 FOR bank IN
  SELECT 'cash_rake_accrual'::text AS source_type,b.rake_record_id AS source_group,b.club_ledger_id AS ledger_id,b.amount,b.banked_at,
   b.club_id,b.union_id,b.union_transaction_id,NULL::uuid AS tournament_id
  FROM public.accounting_cash_bank_receipts b WHERE b.union_id IS NULL AND
   ((b.club_id=period.club_id AND b.banked_at>=period.start_at AND b.banked_at<period.end_at) OR EXISTS(
    SELECT 1 FROM public.accounting_payable_earning_sources s WHERE s.source_type='cash_rake_accrual' AND s.rake_record_id=b.rake_record_id
     AND s.club_id=period.club_id AND s.union_id IS NULL AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id
     AND s.earned_at>=period.start_at AND s.earned_at<period.end_at))
  UNION ALL
  SELECT 'tournament_fee_accrual',f.tournament_id,f.bank_journal_id,f.net_rake,f.recognized_at,f.bank_club_id,f.union_id,f.union_wallet_transaction_id,f.tournament_id
  FROM public.accounting_tournament_fee_recognitions f WHERE f.union_id IS NULL AND f.net_rake>0 AND
   ((f.bank_club_id=period.club_id AND f.recognized_at>=period.start_at AND f.recognized_at<period.end_at) OR EXISTS(
    SELECT 1 FROM public.accounting_payable_earning_sources s WHERE s.source_type='tournament_fee_accrual' AND s.tournament_id=f.tournament_id
     AND s.club_id=period.club_id AND s.union_id IS NULL AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id
     AND s.earned_at>=period.start_at AND s.earned_at<period.end_at))
 LOOP
  SELECT count(*),COALESCE(sum(s.rake_credit),0),count(*) FILTER(WHERE s.club_id IS DISTINCT FROM period.club_id OR s.union_id IS NOT NULL
   OR s.coordinator_union_id IS DISTINCT FROM period.union_id OR s.earned_at IS DISTINCT FROM bank.banked_at)
  INTO bank_sources,bank_sum,bad_sources FROM public.accounting_payable_earning_sources s WHERE s.source_type=bank.source_type
   AND CASE WHEN bank.source_type='cash_rake_accrual' THEN s.rake_record_id=bank.source_group ELSE s.tournament_id=bank.source_group END;
  -- An entirely certified deposit belonging to another recorded week scope is
  -- excluded; missing evidence cannot establish such an exclusion.
  IF bank_sources>0 AND NOT EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources s WHERE s.source_type=bank.source_type
   AND CASE WHEN bank.source_type='cash_rake_accrual' THEN s.rake_record_id=bank.source_group ELSE s.tournament_id=bank.source_group END
   AND s.club_id=period.club_id AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id) THEN CONTINUE;END IF;
  IF bank_sources=0 OR bad_sources>0 OR bank_sum IS DISTINCT FROM bank.amount OR bank.club_id IS DISTINCT FROM period.club_id
   OR bank.union_transaction_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.id=bank.ledger_id AND l.status='posted'
    AND l.club_id=period.club_id AND l.amount=bank.amount AND l.created_at=bank.banked_at
    AND bank.banked_at>=period.start_at AND bank.banked_at<period.end_at
    AND ((bank.source_type='cash_rake_accrual' AND l.from_type='table_stack'
       AND l.to_type='chip_retirement' AND l.to_entity_id IS NULL AND l.category='burn')
     OR (bank.source_type='tournament_fee_accrual' AND l.from_type='prize_liability' AND l.from_entity_id=bank.tournament_id
       AND l.to_type='chip_retirement' AND l.to_entity_id IS NULL AND l.category='burn')))
  THEN source_issues:=source_issues+1;
  ELSE
   private_burned:=private_burned+bank.amount;
   private_ledger_ids:=private_ledger_ids||jsonb_build_array(bank.ledger_id);
  END IF;
 END LOOP;
 IF private_banked+private_burned IS DISTINCT FROM private_basis THEN source_issues:=source_issues+1;END IF;
 WITH transfers AS (
  SELECT l.*,i.to_entity_type,i.breakdown->>'payee_role_at_transfer' AS payee_role,
   (i.id IS NULL OR i.net_amount IS DISTINCT FROM l.amount OR i.status IS DISTINCT FROM 'paid' OR i.chips_transferred IS DISTINCT FROM true
    OR i.message_sent IS DISTINCT FROM true OR NOT EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d
     JOIN public.social_messages m ON m.id=d.message_id JOIN public.notifications n ON n.id=d.notification_id
     WHERE d.invoice_id=i.id AND m.media_metadata->>'invoice_id'=i.id::text AND n.user_id=d.recipient_id)) AS receipt_bad
  FROM public.chip_ledger l LEFT JOIN public.settlement_invoices i ON i.source_ledger_id=l.id
  WHERE l.club_id=period.club_id AND l.union_id IS NOT DISTINCT FROM period.union_id AND l.status='posted' AND l.category IN('rakeback','commission')
   AND (l.settlement_id=close_row.id::text OR
    (CASE WHEN pg_input_is_valid(l.metadata->>'period_start','timestamptz') THEN (l.metadata->>'period_start')::timestamptz END=period.start_at
     AND CASE WHEN pg_input_is_valid(l.metadata->>'period_end','timestamptz') THEN (l.metadata->>'period_end')::timestamptz END=period.end_at))
 ), typed AS (
  SELECT *,CASE WHEN to_entity_type='player' THEN 'player' WHEN payee_role IN('super_agent','agent','sub_agent') THEN payee_role ELSE 'unclassified' END AS tier
  FROM transfers
 ), club_out AS (SELECT * FROM typed WHERE from_type='club_treasury' AND from_entity_id=period.club_id AND to_type IN('player_wallet','agent_wallet')),
 down_out AS (SELECT * FROM typed WHERE from_type IN('player_wallet','agent_wallet') AND to_type IN('player_wallet','agent_wallet'))
 SELECT (SELECT COALESCE(sum(amount),0) FROM typed WHERE from_type IN('union_wallet','union_bank') AND from_entity_id=period.union_id AND to_type='club_treasury' AND to_entity_id=period.club_id),
  (SELECT COALESCE(sum(amount),0) FROM club_out),(SELECT COALESCE(sum(amount),0) FROM down_out),
  (SELECT COALESCE(jsonb_object_agg(tier,paid),'{}') FROM (SELECT tier,sum(amount)paid FROM club_out GROUP BY tier)x),
  (SELECT COALESCE(jsonb_object_agg(tier,paid),'{}') FROM (SELECT tier,sum(amount)paid FROM down_out GROUP BY tier)x),
  (SELECT count(*) FROM typed WHERE to_type IN('player_wallet','agent_wallet') AND tier='unclassified'),
  (SELECT count(*) FROM typed WHERE receipt_bad OR amount IS NULL OR amount<=0 OR amount<>round(amount,2) OR amount::text IN('NaN','Infinity','-Infinity')
   OR (from_type IN('club_treasury','player_wallet','agent_wallet') AND
    (metadata->>'routing_version' IS DISTINCT FROM '3' OR metadata->>'accounting_scope_kind' IS DISTINCT FROM scope_kind OR metadata->>'accounting_scope_id' IS DISTINCT FROM scope_id::text))),
  (SELECT count(*) FROM typed),(SELECT COALESCE(jsonb_agg(id ORDER BY id),'[]') FROM typed)
 INTO received,outgoing,downstream,roles,down_roles,unknown_roles,receipt_issues,rows_count,ledger_ids;
 SELECT count(*) INTO missing_periods FROM public.chip_ledger l WHERE l.club_id=period.club_id AND l.status='posted' AND l.category IN('rakeback','commission')
  AND l.from_type IN('club_treasury','player_wallet','agent_wallet') AND l.to_type IN('player_wallet','agent_wallet')
  AND l.created_at>=period.start_at AND l.created_at<period.end_at+interval '1 day'
  AND (l.metadata->>'period_start' IS NULL OR l.metadata->>'period_end' IS NULL
   OR NOT pg_input_is_valid(l.metadata->>'period_start','timestamptz') OR NOT pg_input_is_valid(l.metadata->>'period_end','timestamptz'))
  AND (close_row.id IS NULL OR l.settlement_id IS DISTINCT FROM close_row.id::text);
 SELECT count(*) INTO stage_count FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind=scope_kind AND r.scope_id=scope_id
  AND r.period_start=period.start_at AND r.period_end=period.end_at AND r.round_no IN(2,3)
  AND r.result->>'success'='true' AND r.result->>'routing_version'='3' AND r.result->>'source_contract_version'='3'
  AND r.result->>'scope_kind'=scope_kind AND r.result->>'scope_id'=scope_id::text AND (r.result->>'shortfalls')::numeric=0;
 ready:=source_issues=0 AND receipt_issues=0 AND unknown_roles=0 AND missing_periods=0 AND stage_count=2 AND expected=received
  AND period.status IN('settled','closed');
 RETURN jsonb_build_object('accounting_version',3,'scope_kind',scope_kind,'scope_id',scope_id,'period_id',period.id,'club_id',period.club_id,'union_id',period.union_id,
  'period_start',period.start_at,'period_end',period.end_at,'currency','CHIPS','rake_earned',union_basis+private_basis,
  'union_rake_earned',union_basis,'private_rake_earned',private_basis,'private_rake_banked',private_banked,'private_rake_burned',private_burned,'rake_received',received,'expected_union_receipt',expected,
  'total_rake_funding',received+private_banked,'paid_super_agents',COALESCE((roles->>'super_agent')::numeric,0),'paid_agents',COALESCE((roles->>'agent')::numeric,0),
  'paid_sub_agents',COALESCE((roles->>'sub_agent')::numeric,0),'paid_players',COALESCE((roles->>'player')::numeric,0),'paid_unclassified',COALESCE((roles->>'unclassified')::numeric,0),
  'total_paid_by_club',outgoing,'retained_by_club',received+private_banked-outgoing,'downstream_redistributed',downstream,
  'downstream_paid_super_agents',COALESCE((down_roles->>'super_agent')::numeric,0),'downstream_paid_agents',COALESCE((down_roles->>'agent')::numeric,0),
  'downstream_paid_sub_agents',COALESCE((down_roles->>'sub_agent')::numeric,0),'downstream_paid_players',COALESCE((down_roles->>'player')::numeric,0),
  'transfer_count',rows_count,'source_ledger_ids',ledger_ids,'private_bank_ledger_ids',private_ledger_ids,'source_count',source_count,'source_fingerprint',source_fingerprint,
  'unclassified_role_count',unknown_roles,'missing_period_count',missing_periods,'receipt_issue_count',receipt_issues,'source_issue_count',source_issues,'certified_stage_count',stage_count,
  'tournament_quality',quality,'ready_to_issue',ready,'status',CASE WHEN run_status='complete' AND ready THEN 'complete' ELSE 'needs_reconciliation' END,'run_status',run_status,
  'basis_source','Recorded Earning Sources And Posted Disposition Receipts',
  'note','Direct Club Payments Count Once. Downstream Transfers Are Separate. Retained Rake Is This Week''s Funding Less Direct Payments, Not The Treasury Balance Or An Additional Bill. Burned Standalone Rake Is Not Funding; Negative Retained Rake Reflects Payments From Other Existing Treasury Funds.');
END $function$
