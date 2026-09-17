-- One weekly statement and one existing delivery path for recorded union and
-- standalone books. Historical issued figures stay frozen. New figures require
-- the certified earning sources, exact private bank receipts and routed stages.
-- Depends on mixed source140015, certificate141013, R1 source14141800 and the
-- coordinator's canonical fn_accounting_week_clubs/settled-period creation.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_club_weekly_accounting_summary(uuid)'::regprocedure))<>'fd8af5960df5b5da23b4e9a6497ae63b'
 OR md5(pg_get_functiondef('public.fn_issue_club_weekly_accounting(uuid,timestamptz,timestamptz)'::regprocedure))<>'3d37ae48c223ec49afc1ad468237e0b5'
 OR md5(pg_get_functiondef('public.fn_deliver_accounting_invoice(uuid)'::regprocedure))<>'8aeee5f47863f0496c9cdf86490eb084'
 OR md5(pg_get_functiondef('public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure))<>'ecda7ce1a97da6c9048ee8b0d6fbd6b5'
 THEN RAISE EXCEPTION 'weekly statement source changed before scope upgrade';END IF;
 IF (SELECT count(*) FROM public.ca_money_rpc_registry WHERE proname IN('fn_club_weekly_accounting_summary','fn_issue_club_weekly_accounting') AND status='approved')<>2
 THEN RAISE EXCEPTION 'weekly statement writer registration missing';END IF;
END $guard$;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_issue_scope_weekly_accounting','approved','One private generic statement issuer for recorded union and standalone periods. Exact validated scope required. Uses existing immutable settlement invoice and its synchronous Messenger/notification delivery. No balance writes.');
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_week_quality(p_club_id uuid,p_from timestamptz,p_to timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE event record;scope_union uuid;actual_union uuid;related boolean;unknown_scope boolean;
 proof jsonb;active_ids uuid[];refunded_ids uuid[];checked int:=0;issue_count bigint;reason text;
BEGIN
 IF p_club_id IS NULL OR p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_from>=p_to
 THEN RAISE EXCEPTION 'invalid_accounting_tournament_week' USING ERRCODE='22023';END IF;
 SELECT union_id INTO scope_union FROM public.clubs WHERE id=p_club_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_club_not_found' USING ERRCODE='22023';END IF;
 FOR event IN
  WITH candidates AS (
   SELECT tournament_id FROM public.accounting_tournament_fee_recognitions WHERE recognized_at>=p_from AND recognized_at<p_to
   UNION SELECT tournament_id FROM public.tournament_rake_settlements WHERE settled_at>=p_from AND settled_at<p_to
   UNION SELECT tournament_id FROM public.tournament_terminal_settlements WHERE COALESCE(settled_at,completed_at)>=p_from AND COALESCE(settled_at,completed_at)<p_to
   UNION SELECT tournament_id FROM public.tournament_cancellation_receipts WHERE settled_at>=p_from AND settled_at<p_to
   UNION SELECT tournament_id FROM public.tournament_satellite_settlements WHERE settled_at>=p_from AND settled_at<p_to
  )
  SELECT c.tournament_id,r.recognized_at,r.status,r.net_rake,r.union_id,r.bank_club_id,r.source_fingerprint,
   b.settled_at AS bank_at,b.amount AS bank_amount,b.union_id AS bank_union,b.club_id AS fee_bank_club
   FROM candidates c LEFT JOIN public.accounting_tournament_fee_recognitions r USING(tournament_id)
    LEFT JOIN public.tournament_rake_settlements b USING(tournament_id) ORDER BY c.tournament_id
 LOOP
  IF COALESCE(event.bank_at,event.recognized_at) IS NOT NULL
   AND NOT(COALESCE(event.bank_at,event.recognized_at)>=p_from AND COALESCE(event.bank_at,event.recognized_at)<p_to)
   AND (event.recognized_at IS NULL OR NOT(event.recognized_at>=p_from AND event.recognized_at<p_to)) THEN CONTINUE;END IF;
  actual_union:=COALESCE(event.union_id,event.bank_union,(SELECT min(s.union_id::text)::uuid
   FROM public.accounting_tournament_fee_sources s WHERE s.tournament_id=event.tournament_id
   HAVING count(DISTINCT COALESCE(s.union_id::text,'private'))=1));
  -- Current union membership only widens conflict detection. It never sets
  -- a payable source's historical coordinator or a player's payer.
  related:=COALESCE(actual_union=scope_union,false) OR COALESCE(event.bank_club_id=p_club_id,false)
   OR COALESCE(event.fee_bank_club=p_club_id,false)
   OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s WHERE s.tournament_id=event.tournament_id
      AND (s.club_id=p_club_id OR (scope_union IS NOT NULL AND s.coordinator_union_id=scope_union)))
   OR EXISTS(SELECT 1 FROM public.tournament_refund_entitlements e WHERE e.tournament_id=event.tournament_id AND e.refund_wallet_club_id=p_club_id);
  -- A private legacy event with unproved coordinator history cannot be silently
  -- assigned to today's standalone/union scope. The affected week stays open.
  unknown_scope:=actual_union IS NULL AND (event.status IS NULL OR event.status='banked_accrual_deferred')
   AND (COALESCE(event.net_rake,event.bank_amount,0)>0
    OR EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=event.tournament_id AND r.is_tournament AND r.rake_amount<>0))
   AND (NOT EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=event.tournament_id AND r.is_tournament AND r.rake_amount>0)
    OR EXISTS(SELECT 1 FROM public.rake_records r LEFT JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=r.id
     WHERE r.tournament_id=event.tournament_id AND r.is_tournament AND r.rake_amount>0
      AND (b.status IS DISTINCT FROM 'captured' OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)
       OR r.rake_amount IS DISTINCT FROM(SELECT sum(s.rake_credit) FROM public.accounting_tournament_fee_sources s WHERE s.rake_record_id=r.id)))
    OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s WHERE s.tournament_id=event.tournament_id
     AND (NOT(s.contract ? 'coordinator_union_id') OR s.contract->'membership'->>'history_id' IS NULL
      OR s.contract->>'club_id' IS DISTINCT FROM s.club_id::text OR s.contract->>'player_id' IS DISTINCT FROM s.player_id::text)));
  IF NOT related AND NOT unknown_scope THEN CONTINUE;END IF;
  checked:=checked+1;
  IF event.status IS NULL THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_terminal_recognition_missing','tournament_id',event.tournament_id,'unknown_scope',unknown_scope);
  END IF;
  IF event.status='banked_accrual_deferred' THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognition_deferred','tournament_id',event.tournament_id,'unknown_scope',unknown_scope);
  END IF;
  -- An eventual normal/satellite terminal receipt may follow a banked fee in
  -- another week. Only original fee-bank/recognition time chooses its liability.
  IF event.bank_at IS NOT NULL AND (event.bank_at IS DISTINCT FROM event.recognized_at
    OR event.bank_amount IS DISTINCT FROM event.net_rake OR event.bank_union IS DISTINCT FROM event.union_id) THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognition_bank_disagrees','tournament_id',event.tournament_id);
  END IF;
  BEGIN proof:=public.fn_accounting_tournament_fee_net_plan(event.tournament_id);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '55000' THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_net_source_evidence_invalid','detail',SQLERRM,'tournament_id',event.tournament_id);
  END;
  IF proof->>'status' IS DISTINCT FROM 'proven' OR proof->>'source_fingerprint' IS DISTINCT FROM event.source_fingerprint
    OR (proof->>'net_fee')::numeric IS DISTINCT FROM event.net_rake OR NULLIF(proof->>'union_id','')::uuid IS DISTINCT FROM event.union_id
    OR (event.status='recognized') IS DISTINCT FROM(event.net_rake>0)
    OR (event.status='cancelled') IS DISTINCT FROM(event.net_rake=0) THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognition_disagrees_with_sources','tournament_id',event.tournament_id);
  END IF;
  SELECT COALESCE(array_agg(value::uuid),'{}') INTO active_ids FROM jsonb_array_elements_text(proof->'active_source_ids');
  SELECT COALESCE(array_agg(value::uuid),'{}') INTO refunded_ids FROM jsonb_array_elements_text(proof->'refunded_source_ids');
  SELECT count(*) INTO issue_count FROM public.accounting_tournament_fee_sources s
   LEFT JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id
   WHERE s.tournament_id=event.tournament_id AND (rs.source_id IS NULL OR rs.tournament_id IS DISTINCT FROM s.tournament_id
    OR rs.recognized_at IS DISTINCT FROM event.recognized_at
    OR NOT(s.id=ANY(active_ids||refunded_ids))
    OR rs.disposition IS DISTINCT FROM CASE WHEN s.id=ANY(active_ids) THEN 'earned' ELSE 'refunded' END
    OR rs.rake_credit IS DISTINCT FROM CASE WHEN s.id=ANY(active_ids) THEN s.rake_credit ELSE 0 END
    OR s.contract->>'player_id' IS DISTINCT FROM s.player_id::text OR s.contract->>'club_id' IS DISTINCT FROM s.club_id::text
    OR (s.contract->>'rake_credit')::numeric IS DISTINCT FROM s.rake_credit
    OR (s.contract->>'terms_at')::timestamptz IS DISTINCT FROM s.charged_at OR s.charged_at>event.recognized_at
    OR NULLIF(s.contract->>'union_id','')::uuid IS DISTINCT FROM s.union_id
    OR NULLIF(s.contract->>'coordinator_union_id','')::uuid IS DISTINCT FROM s.coordinator_union_id);
  IF issue_count>0 OR EXISTS(SELECT 1 FROM public.accounting_tournament_recognized_sources rs
   LEFT JOIN public.accounting_tournament_fee_sources s ON s.id=rs.source_id
   WHERE rs.tournament_id=event.tournament_id AND (s.id IS NULL OR s.tournament_id IS DISTINCT FROM event.tournament_id))
   OR (SELECT COALESCE(sum(rake_credit),0) FROM public.accounting_tournament_recognized_sources WHERE tournament_id=event.tournament_id AND disposition='earned') IS DISTINCT FROM event.net_rake THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognized_source_receipts_incomplete','tournament_id',event.tournament_id);
  END IF;
 END LOOP;
 RETURN jsonb_build_object('status','ready','checked',checked);
END $function$;
CREATE OR REPLACE FUNCTION public.fn_club_weekly_accounting_summary(p_period_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
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
END $function$;

CREATE FUNCTION public.fn_issue_scope_weekly_accounting(p_scope_kind text,p_scope_id uuid,p_from timestamptz,p_to timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
#variable_conflict use_variable
DECLARE scope record;club uuid;period public.settlement_periods%ROWTYPE;report jsonb;invoice uuid;issued int:=0;period_count int;clubs uuid[];delivery jsonb;expected_users int;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501';END IF;
 IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to)
  OR p_from IS DISTINCT FROM public.fn_union_week_start(p_from) OR p_to IS DISTINCT FROM public.fn_union_week_start(p_from+interval '8 days') OR p_to>now()
 THEN RAISE EXCEPTION 'weekly_statement_requires_closed_week' USING ERRCODE='22023';END IF;
 IF current_setting('app.accounting_validated_scope',true) IS DISTINCT FROM p_scope_kind||':'||p_scope_id::text||':'||p_from::text||':'||p_to::text
 THEN RAISE EXCEPTION 'weekly_statement_requires_validated_scope' USING ERRCODE='23514';END IF;
 SELECT * INTO scope FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_from,p_to);
 SELECT COALESCE(array_agg(x.club_id ORDER BY x.club_id),ARRAY[]::uuid[]) INTO clubs FROM (
  SELECT c.club_id FROM public.fn_accounting_week_clubs(scope.union_id,scope.standalone_club_id,p_from,p_to)c
  UNION SELECT s.club_id FROM public.accounting_payable_earning_sources s WHERE s.earned_at>=p_from AND s.earned_at<p_to
   AND (s.coordinator_union_id=scope.union_id OR (scope.standalone_club_id=s.club_id AND s.coordinator_union_id IS NULL))
  UNION SELECT sp.club_id FROM public.settlement_periods sp WHERE sp.start_at=p_from AND sp.end_at=p_to AND sp.club_id IS NOT NULL
   AND (sp.union_id=scope.union_id OR (sp.club_id=scope.standalone_club_id AND sp.union_id IS NULL))
 )x WHERE x.club_id IS DISTINCT FROM scope.union_id;
 FOREACH club IN ARRAY clubs LOOP
  SELECT count(*) INTO period_count FROM public.settlement_periods sp WHERE sp.club_id=club AND sp.union_id IS NOT DISTINCT FROM scope.union_id AND sp.start_at=p_from AND sp.end_at=p_to;
  IF period_count<>1 THEN RAISE EXCEPTION 'weekly_statement_period_missing_or_duplicated' USING ERRCODE='23514',DETAIL=jsonb_build_object('club_id',club,'period_count',period_count)::text;END IF;
  SELECT * INTO period FROM public.settlement_periods sp WHERE sp.club_id=club AND sp.union_id IS NOT DISTINCT FROM scope.union_id AND sp.start_at=p_from AND sp.end_at=p_to FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('club_weekly_invoice:'||period.id::text,0));
  SELECT i.id INTO invoice FROM public.settlement_invoices i WHERE i.period_id=period.id AND i.club_id=club AND i.invoice_type='club_weekly_accounting';
  IF invoice IS NULL THEN
   report:=public.fn_club_weekly_accounting_summary(period.id);
   IF report->>'ready_to_issue' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'club_weekly_statement_requires_reconciliation' USING ERRCODE='23514',DETAIL=report::text;END IF;
   report:=report||jsonb_build_object('status','complete');
   INSERT INTO public.settlement_invoices(club_id,period_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,gross_amount,net_amount,deductions,breakdown,status,notes)
   VALUES(club,period.id,'club_weekly_accounting','club',club::text,'club',club::text,(report->>'total_rake_funding')::numeric,(report->>'retained_by_club')::numeric,
    (report->>'total_paid_by_club')::numeric,report,'generated','Consolidated Weekly Club Accounting. The Net Movement Is Not An Additional Bill Or Transfer.') RETURNING id INTO invoice;
   issued:=issued+1;
  END IF;
  delivery:=public.fn_deliver_accounting_invoice(invoice);
  SELECT count(*) INTO expected_users FROM public.fn_accounting_party_users('club',club);
  IF delivery->>'success' IS DISTINCT FROM 'true' OR expected_users=0 OR EXISTS(
   SELECT 1 FROM public.fn_accounting_party_users('club',club)u WHERE NOT EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d
    JOIN public.social_messages m ON m.id=d.message_id JOIN public.notifications n ON n.id=d.notification_id
    WHERE d.invoice_id=invoice AND d.recipient_id=u.user_id AND m.media_metadata->>'invoice_id'=invoice::text AND n.user_id=u.user_id
     AND m.message_type='invoice' AND n.metadata->>'invoice_id'=invoice::text))
  THEN RAISE EXCEPTION 'club_weekly_statement_delivery_incomplete' USING ERRCODE='23514';END IF;
 END LOOP;
 RETURN jsonb_build_object('success',true,'scope_kind',p_scope_kind,'scope_id',p_scope_id,'period_start',p_from,'period_end',p_to,'clubs',cardinality(clubs),'issued',issued);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_issue_club_weekly_accounting(p_union_id uuid,p_from timestamptz,p_to timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
#variable_conflict use_variable
DECLARE previous_scope text;result jsonb;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501';END IF;
 previous_scope:=current_setting('app.accounting_validated_scope',true);
 IF previous_scope IS DISTINCT FROM 'union:'||p_union_id::text||':'||p_from::text||':'||p_to::text THEN
  IF current_setting('app.union_accounting_validated_period',true) IS DISTINCT FROM p_union_id::text||':'||p_from::text||':'||p_to::text
  THEN RAISE EXCEPTION 'weekly_statement_requires_validated_cascade' USING ERRCODE='23514';END IF;
  PERFORM set_config('app.accounting_validated_scope','union:'||p_union_id::text||':'||p_from::text||':'||p_to::text,true);
 END IF;
 result:=public.fn_issue_scope_weekly_accounting('union',p_union_id,p_from,p_to);
 PERFORM set_config('app.accounting_validated_scope',COALESCE(previous_scope,''),true);
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_deliver_accounting_invoice(p_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_variable
DECLARE inv public.settlement_invoices%ROWTYPE; sender uuid; issuer_name text; recipient_name text;
 issuer_kind text; issuer_id uuid; recipient_id uuid; scope_id uuid; page_id uuid; users uuid[]; issuer_users uuid[]; recipient_users uuid[];
 person uuid; conv uuid; msg uuid; note uuid; body text; meta jsonb; count_sent int:=0; n int; line record;
BEGIN
 SELECT * INTO inv FROM public.settlement_invoices WHERE id=p_invoice_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_invoice_missing' USING ERRCODE='23514'; END IF;
 IF inv.net_amount IS NULL OR inv.net_amount::text IN('NaN','Infinity','-Infinity') OR inv.net_amount<>round(inv.net_amount,2)
 THEN RAISE EXCEPTION 'invalid_invoice_amount' USING ERRCODE='23514'; END IF;
 issuer_kind:=inv.from_entity_type; issuer_id:=inv.from_entity_id::uuid; recipient_id:=inv.to_entity_id::uuid;
 scope_id:=COALESCE(inv.club_id,issuer_id);
 SELECT array_agg(user_id ORDER BY user_id) INTO issuer_users FROM public.fn_accounting_party_users(inv.from_entity_type,issuer_id);
 SELECT array_agg(user_id ORDER BY user_id) INTO recipient_users FROM public.fn_accounting_party_users(inv.to_entity_type,recipient_id);
 IF COALESCE(cardinality(issuer_users),0)=0 OR COALESCE(cardinality(recipient_users),0)=0
 THEN RAISE EXCEPTION 'accounting_invoice_recipient_missing' USING ERRCODE='23514'; END IF;
 SELECT array_agg(DISTINCT x ORDER BY x) INTO users FROM unnest(issuer_users||recipient_users) x;
 -- Club senders receive one weekly summary; individual payees still get their receipt immediately.
 IF inv.from_entity_type='club' AND inv.to_entity_type IN('agent','player')
    AND inv.source_ledger_id IS NOT NULL AND inv.breakdown->>'category' IN('rakeback','commission') THEN
   users:=recipient_users;
 END IF;
 IF inv.invoice_type IN('union_weekly_squareup','union_weekly_credit_note') THEN
   issuer_kind:='union';issuer_id:=(inv.breakdown->>'union_id')::uuid;
 END IF;
 sender:=CASE WHEN issuer_kind='club' THEN (SELECT owner_id FROM public.clubs WHERE id=issuer_id)
              WHEN issuer_kind='union' THEN (SELECT owner_id FROM public.unions WHERE id=issuer_id)
              ELSE issuer_id END;
 IF sender IS NULL OR NOT sender=ANY(issuer_users||recipient_users) THEN RAISE EXCEPTION 'accounting_invoice_sender_missing' USING ERRCODE='23514'; END IF;
 issuer_name:=CASE WHEN issuer_kind='club' THEN (SELECT name FROM public.clubs WHERE id=issuer_id)
                   WHEN issuer_kind='union' THEN (SELECT name FROM public.unions WHERE id=issuer_id)
                   ELSE (SELECT username FROM public.profiles WHERE id=issuer_id) END;
 recipient_name:=CASE WHEN inv.to_entity_type='club' THEN (SELECT name FROM public.clubs WHERE id=recipient_id)
                      WHEN inv.to_entity_type='union' THEN (SELECT name FROM public.unions WHERE id=recipient_id)
                      ELSE (SELECT username FROM public.profiles WHERE id=recipient_id) END;
 IF inv.invoice_number IS NULL THEN
   UPDATE public.settlement_invoices SET invoice_number=public.fn_accounting_next_invoice_number() WHERE id=inv.id RETURNING invoice_number INTO inv.invoice_number;
 END IF;
 IF inv.invoice_type IN('union_weekly_squareup','union_weekly_credit_note') THEN recipient_name:=(SELECT name FROM public.clubs WHERE id=inv.club_id); END IF;
 body:=CASE WHEN inv.invoice_type='club_weekly_accounting' THEN 'Weekly Club Statement ' ELSE 'Invoice ' END||inv.invoice_number||E'\nIssued By: '||COALESCE(issuer_name,inv.from_entity_type)||E'\nFor: '||COALESCE(recipient_name,inv.to_entity_type)
  ||E'\nDirection: '||initcap(inv.from_entity_type)||' To '||initcap(inv.to_entity_type)
  ||E'\nAmount: '||to_char(abs(inv.net_amount),'FM999,999,999,999,990.00')||' Chips'
  ||E'\nStatus: '||initcap(inv.status)
  ||CASE WHEN inv.chips_transferred THEN E'\nTransfer Recorded: '||COALESCE(inv.transferred_at,inv.created_at)::text ELSE '' END
  ||CASE WHEN inv.due_at IS NOT NULL THEN E'\nDue: '||to_char(inv.due_at AT TIME ZONE 'America/Chicago','YYYY-MM-DD HH24:MI')||' Chicago Time' ELSE '' END
  ||CASE WHEN inv.breakdown ? 'period_start' THEN E'\nPeriod: '||(inv.breakdown->>'period_start')||' To '||COALESCE(inv.breakdown->>'period_end','') ELSE '' END
  ||CASE WHEN inv.notes IS NOT NULL THEN E'\n'||inv.notes ELSE '' END;
 FOR line IN SELECT key,value FROM jsonb_each_text(COALESCE(inv.breakdown,'{}'))
   WHERE key IN('rake_generated','rakeback_due','union_fee_kept','players_won','settled_in_chips','eco_amount','presettled','rake_earned','union_rake_earned','private_rake_earned','private_rake_banked','total_rake_funding','rake_received','paid_super_agents','paid_agents','paid_sub_agents','paid_players','total_paid_by_club','retained_by_club','downstream_redistributed','downstream_paid_super_agents','downstream_paid_agents','downstream_paid_sub_agents','downstream_paid_players') ORDER BY key
 LOOP
   IF line.value IS NOT NULL THEN body:=body||E'\n'||initcap(replace(line.key,'_',' '))||': '||to_char(line.value::numeric,'FM999,999,999,999,990.00'); END IF;
 END LOOP;
 meta:=jsonb_build_object('kind','accounting_invoice' ,'invoice_id',inv.id,'invoice_number',inv.invoice_number,
   'club_id',inv.club_id,'source_ledger_id',inv.source_ledger_id,'source_credit_invoice_id',inv.source_credit_invoice_id,
   'source_credit_payment_id',inv.source_credit_payment_id,'amount',inv.net_amount,'currency','CHIPS','conversationId',NULL,'status',inv.status,
   'invoice_type',inv.invoice_type,'from_entity_type',inv.from_entity_type,'from_entity_id',inv.from_entity_id,
   'to_entity_type',inv.to_entity_type,'to_entity_id',inv.to_entity_id,'lines',inv.breakdown-'source_ledger_ids');
 SELECT id INTO page_id FROM public.social_pages WHERE linked_entity_id=scope_id::text AND linked_entity_type='club' ORDER BY id LIMIT 1;
 FOREACH person IN ARRAY users LOOP
   IF EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d WHERE d.invoice_id=inv.id AND d.recipient_id=person) THEN CONTINUE; END IF;
   -- One private accounting conversation per issuer, sender, scope and recipient.
   PERFORM pg_advisory_xact_lock(hashtextextended('accounting_conversation:'||scope_id::text||':'||issuer_id::text||':'||sender::text||':'||person::text,0));
   SELECT conversation_id INTO conv FROM public.accounting_conversations c
    WHERE c.scope_id=scope_id AND c.issuer_type=issuer_kind AND c.issuer_id=issuer_id AND c.sender_id=sender AND c.recipient_id=person;
   IF conv IS NULL THEN
     INSERT INTO public.social_conversations(is_group,group_name,context_entity_id,context_entity_type)
      VALUES(true,COALESCE(issuer_name,'Account')||' Accounting',page_id,CASE WHEN page_id IS NULL THEN NULL ELSE 'club' END) RETURNING id INTO conv;
     INSERT INTO public.social_conversation_participants(conversation_id,user_id,context_entity_id,context_entity_type)
      SELECT conv,x,page_id,CASE WHEN page_id IS NULL THEN NULL ELSE 'club' END FROM (SELECT DISTINCT unnest(ARRAY[sender,person]) AS x) members;
     INSERT INTO public.accounting_conversations(scope_id,issuer_type,issuer_id,sender_id,recipient_id,conversation_id)
      VALUES(scope_id,issuer_kind,issuer_id,sender,person,conv);
   END IF;
   -- Refuse a conversation whose audience changed instead of leaking invoices.
   IF EXISTS(SELECT 1 FROM public.social_conversation_participants WHERE conversation_id=conv AND user_id<>ALL(ARRAY[sender,person]))
      OR NOT EXISTS(SELECT 1 FROM public.social_conversation_participants WHERE conversation_id=conv AND user_id=person)
      OR NOT EXISTS(SELECT 1 FROM public.social_conversation_participants WHERE conversation_id=conv AND user_id=sender)
   THEN RAISE EXCEPTION 'accounting_conversation_audience_changed' USING ERRCODE='23514'; END IF;
   INSERT INTO public.social_messages(conversation_id,sender_id,content,message_type,media_metadata)
    VALUES(conv,sender,body,'invoice',meta) RETURNING id INTO msg;
   UPDATE public.social_conversations SET last_message_at=now(),last_message_preview=left(body,100),updated_at=now() WHERE id=conv;
   meta:=meta||jsonb_build_object('conversation_id',conv,'conversationId',conv);
   INSERT INTO public.notifications(user_id,type,title,message,data,read,action_url,metadata)
    VALUES(person,'accounting_invoice',CASE WHEN inv.invoice_type='club_weekly_accounting' THEN 'Weekly Club Statement ' ELSE 'Invoice ' END||inv.invoice_number,
     CASE WHEN inv.chips_transferred AND inv.breakdown->>'category'='rakeback' THEN 'Rakeback Transfer Recorded: ' WHEN inv.chips_transferred AND inv.breakdown->>'category'='commission' THEN 'Commission Transfer Recorded: ' WHEN inv.chips_transferred THEN 'Transfer Recorded: ' ELSE 'Invoice Issued: ' END||to_char(abs(inv.net_amount),'FM999,999,999,999,990.00')||' Chips',
     meta,false,'/hub/messenger?conversation='||conv::text,meta) RETURNING id INTO note;
   INSERT INTO public.accounting_invoice_deliveries(invoice_id,recipient_id,message_id,notification_id) VALUES(inv.id,person,msg,note);
   count_sent:=count_sent+1;
 END LOOP;
 SELECT count(*) INTO n FROM public.accounting_invoice_deliveries WHERE invoice_id=inv.id;
 UPDATE public.settlement_invoices SET message_sent=true,message_sent_at=COALESCE(message_sent_at,now()) WHERE id=inv.id;
 RETURN jsonb_build_object('success',true,'invoice_id',inv.id,'delivered',n,'new_deliveries',count_sent);
END $function$
;

REVOKE ALL ON FUNCTION public.fn_issue_scope_weekly_accounting(text,uuid,timestamptz,timestamptz),public.fn_issue_club_weekly_accounting(uuid,timestamptz,timestamptz),public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_club_weekly_accounting_summary(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_club_weekly_accounting_summary(uuid) TO authenticated,service_role;
COMMIT;
