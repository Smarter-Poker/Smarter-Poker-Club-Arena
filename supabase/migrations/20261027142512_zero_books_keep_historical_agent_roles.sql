-- @live-proof: md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz)'::regprocedure))='46cc46eac314417706523cc9bd273405' AND md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamptz,timestamptz)'::regprocedure))='efff450311e1c001d8873b29e080e551' AND md5(pg_get_functiondef('smarter_private.zero_standalone_foreign_commissions_proven(uuid,timestamptz,timestamptz)'::regprocedure))='69099f3bac93cb29fad83cb82cb1fe4a' AND md5(pg_get_functiondef('public.fn_settle_accounting_commission_combine(text,uuid,timestamptz,timestamptz)'::regprocedure))='a267a0f650cf4dcb2337d85d638ebc62'
-- Composes the strict zero-book proof with installed 70115 historical roles.
-- Unapplied 52225 was superseded, never installed or recorded. Positive own
-- liability, bank mint, stale foreign proofs or incomplete receipts still refuse.
BEGIN;
SET LOCAL lock_timeout='1500ms';
SET LOCAL statement_timeout='15s';
DO $preimage$ BEGIN
 IF md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))IS DISTINCT FROM '5f24e7244d59db5f2d5e3b6ad18e620b'THEN RAISE EXCEPTION 'zero_standalone_original_owner_preimage_changed: fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone)';END IF;
 IF md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))IS DISTINCT FROM 'c7a3a18fd098b9cde222107007aae316'THEN RAISE EXCEPTION 'zero_standalone_original_owner_preimage_changed: fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone)';END IF;
 IF md5(pg_get_functiondef('public.fn_settle_accounting_commission_combine(text,uuid,timestamptz,timestamptz)'::regprocedure))IS DISTINCT FROM 'a267a0f650cf4dcb2337d85d638ebc62'THEN RAISE EXCEPTION 'zero_standalone_historical_role_combine_changed';END IF;
END $preimage$;
CREATE FUNCTION smarter_private.zero_standalone_foreign_commissions_proven(p_club uuid,p_start timestamptz,p_end timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private SET TimeZone='UTC' AS $body$
DECLARE f uuid;comb jsonb;fr public.accounting_routed_settlement_runs%ROWTYPE;key text;
 had_windows boolean;had_clubs boolean;node_total numeric;bank_total numeric;down_total numeric;owner_total numeric;node_n int;owner_n int;paid_stamp timestamptz;stamp_n int;
BEGIN
 IF public.fn_caller_is_engine()IS DISTINCT FROM true OR public.fn_platform_frozen()IS DISTINCT FROM false
 OR to_regclass('pg_temp._routed_zero_standalone_context')IS NULL
 OR NOT EXISTS(SELECT FROM pg_class WHERE oid=to_regclass('pg_temp._routed_zero_standalone_context')AND pg_get_userbyid(relowner)='postgres')
 THEN RAISE EXCEPTION 'zero_standalone_original_stage_required' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT FROM pg_temp._routed_zero_standalone_context c WHERE c.scope_kind='club'AND c.scope_id=p_club AND c.period_start=p_start AND c.period_end=p_end AND c.source_count=0 AND c.fingerprint=md5(''))
 OR EXISTS(SELECT FROM pg_temp._routed_nodes)OR EXISTS(SELECT FROM pg_temp._routed_edges)
 THEN RAISE EXCEPTION 'zero_standalone_full_original_empty_plan_required' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM public.agent_commission_settlements cs WHERE cs.club_id=p_club AND cs.period_start<p_end AND cs.period_end>p_start
  AND(cs.union_id IS NULL OR cs.period_start IS DISTINCT FROM p_start OR cs.period_end IS DISTINCT FROM p_end OR cs.paid_at IS NULL))
 THEN RAISE EXCEPTION 'zero_standalone_legacy_or_partial_foreign_settlement' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT FROM public.chip_ledger l WHERE l.idempotency_key='standalone-rake-bank:'||p_club::text||':'||to_char(p_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')||'..'||to_char(p_end AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))
 OR EXISTS(SELECT FROM public.ca_mint_ledger m WHERE m.op_id='standalone-rake-bank:'||p_club::text||':'||to_char(p_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')||'..'||to_char(p_end AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))
 THEN RAISE EXCEPTION 'zero_standalone_positive_or_unknown_bank_basis_refused' USING ERRCODE='23514';END IF;
 -- The original combine touches exactly four temporary relations and no GUC.
 -- Save every preexisting window/club row; own nodes/edges are genuinely empty.
 -- V3 does not use _routed_clubs and may inherit it from an earlier stage.
 had_clubs:=to_regclass('pg_temp._routed_clubs')IS NOT NULL;
 IF had_clubs THEN
  CREATE TEMP TABLE IF NOT EXISTS _zero_saved_r2_clubs(LIKE pg_temp._routed_clubs INCLUDING ALL)ON COMMIT DROP;
  TRUNCATE pg_temp._zero_saved_r2_clubs;INSERT INTO pg_temp._zero_saved_r2_clubs SELECT * FROM pg_temp._routed_clubs;
 END IF;
 had_windows:=to_regclass('pg_temp._close_r2_windows')IS NOT NULL;
 IF had_windows THEN
  CREATE TEMP TABLE IF NOT EXISTS _zero_saved_r2_windows(LIKE pg_temp._close_r2_windows INCLUDING ALL)ON COMMIT DROP;
  TRUNCATE pg_temp._zero_saved_r2_windows;
  INSERT INTO pg_temp._zero_saved_r2_windows SELECT * FROM pg_temp._close_r2_windows;
 END IF;
 CREATE TEMP TABLE IF NOT EXISTS _zero_foreign_owner_nodes(club_id uuid,user_id uuid,own_amount numeric,PRIMARY KEY(club_id,user_id))ON COMMIT DROP;
 CREATE TEMP TABLE IF NOT EXISTS _zero_foreign_edges(club_id uuid,payer_user uuid,payee_user uuid,amount numeric,role text)ON COMMIT DROP;
 CREATE TEMP TABLE IF NOT EXISTS _zero_foreign_endpoints(club_id uuid,actor_id uuid,PRIMARY KEY(club_id,actor_id))ON COMMIT DROP;
 CREATE TEMP TABLE IF NOT EXISTS _zero_foreign_actual_r2_legs ON COMMIT DROP AS SELECT l.*FROM public.chip_ledger l WHERE false;
 FOR f IN SELECT DISTINCT cs.union_id FROM public.agent_commission_settlements cs
  WHERE cs.club_id=p_club AND cs.period_start<p_end AND cs.period_end>p_start ORDER BY cs.union_id
 LOOP
  SELECT * INTO fr FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind='union'AND r.scope_id=f AND r.union_id=f
   AND r.period_start=p_start AND r.period_end=p_end AND r.round_no=2 FOR SHARE;
  IF NOT FOUND OR fr.completed_at IS NULL OR fr.routing_version IS DISTINCT FROM 3
   OR fr.result->>'success'IS DISTINCT FROM 'true'OR fr.result->>'scope_kind'IS DISTINCT FROM 'union'OR fr.result->>'scope_id'IS DISTINCT FROM f::text
   OR fr.result->>'round'IS DISTINCT FROM '2'OR fr.result->>'routing_version'IS DISTINCT FROM '3'OR fr.result->>'source_version'IS DISTINCT FROM '2'
   OR fr.result->>'source_contract_version'IS DISTINCT FROM '3'OR fr.result->>'shortfalls'IS DISTINCT FROM '0'OR fr.result->>'paid_to'IS DISTINCT FROM 'agent_wallet'
  THEN RAISE EXCEPTION 'zero_standalone_canonical_foreign_round_required' USING ERRCODE='55000';END IF;
  comb:=public.fn_settle_accounting_commission_combine('union',f,p_start,p_end);
  IF comb IS NULL OR comb->>'read_failed'IS DISTINCT FROM 'false'OR comb->>'full_path'IS DISTINCT FROM 'false'
   OR comb->>'hierarchy_bad'IS DISTINCT FROM 'false'OR comb->>'entitlement_bad'IS DISTINCT FROM 'false'OR comb->>'unclassified'IS DISTINCT FROM '0'
   OR comb->>'fingerprint'IS DISTINCT FROM fr.source_fingerprint OR(comb->>'sources')::bigint IS DISTINCT FROM(fr.result->>'sources')::bigint
  THEN RAISE EXCEPTION 'zero_standalone_current_original_foreign_windows_required' USING ERRCODE='55000';END IF;
  key:='round2:v3:'||f::text||':'||extract(epoch FROM p_start)::text||':'||extract(epoch FROM p_end)::text;
  PERFORM cs.id FROM pg_temp._routed_nodes n JOIN public.agent_commission_settlements cs
   ON cs.club_id=n.club_id AND cs.user_id=n.user_id AND cs.period_start=p_start AND cs.period_end=p_end
   ORDER BY cs.club_id,cs.user_id,cs.id FOR SHARE OF cs;
  -- Independently derived per-node authority, not the run's aggregate alone.
  IF EXISTS(SELECT FROM pg_temp._routed_nodes n WHERE(SELECT count(*)FROM public.agent_commission_settlements cs
    WHERE cs.club_id=n.club_id AND cs.user_id=n.user_id AND cs.union_id=f AND cs.period_start=p_start AND cs.period_end=p_end
     AND cs.amount=n.own_amount AND cs.rows_count=n.rows_count AND cs.settlement_ref=key AND cs.paid_at IS NOT NULL)<>1)
   OR EXISTS(SELECT FROM public.agent_commission_settlements cs WHERE cs.union_id=f AND cs.period_start<p_end AND cs.period_end>p_start
    AND(cs.period_start IS DISTINCT FROM p_start OR cs.period_end IS DISTINCT FROM p_end OR NOT EXISTS(SELECT FROM pg_temp._routed_nodes n
     WHERE n.club_id=cs.club_id AND n.user_id=cs.user_id AND n.own_amount=cs.amount AND n.rows_count=cs.rows_count AND cs.settlement_ref=key AND cs.paid_at IS NOT NULL)))
  THEN RAISE EXCEPTION 'zero_standalone_foreign_own_rows_not_bound' USING ERRCODE='23514';END IF;
  SELECT min(cs.paid_at),count(DISTINCT cs.paid_at)INTO paid_stamp,stamp_n FROM public.agent_commission_settlements cs
   WHERE cs.union_id=f AND cs.period_start=p_start AND cs.period_end=p_end AND cs.settlement_ref=key;
  IF stamp_n IS DISTINCT FROM 1 OR paid_stamp IS NULL OR fr.completed_at<paid_stamp
  THEN RAISE EXCEPTION 'zero_standalone_foreign_original_transaction_not_bound' USING ERRCODE='23514';END IF;
  -- The original writer inserts every edge with created_at DEFAULT now(),
  -- and every own settlement explicitly with paid_at=now(), in ONE transaction.
  -- Point-read every possible original source endpoint at that exact timestamp.
  -- No locale-dependent prefix range or whole-ledger metadata scan is used.
  -- This proves the canonical original writer's transaction, not global absence
  -- of unrelated later forged metadata or arbitrary foreign journal activity.
  TRUNCATE pg_temp._zero_foreign_endpoints,pg_temp._zero_foreign_actual_r2_legs;
  INSERT INTO pg_temp._zero_foreign_endpoints SELECT club_id,club_id FROM pg_temp._routed_clubs
   UNION SELECT club_id,user_id FROM pg_temp._routed_nodes;
  INSERT INTO pg_temp._zero_foreign_actual_r2_legs
   SELECT l.*FROM pg_temp._zero_foreign_endpoints ep CROSS JOIN LATERAL(
    SELECT z.*FROM public.chip_ledger z WHERE z.club_id=ep.club_id AND z.from_entity_id=ep.actor_id AND z.created_at=paid_stamp OFFSET 0)l
   WHERE l.idempotency_key LIKE key||':%'
    OR(l.category='commission'AND l.from_type IN('club_treasury','agent_wallet')
      AND(l.union_id=f OR l.metadata->>'accounting_scope_id'=f::text OR(l.union_id IS NULL AND NULLIF(l.metadata->>'accounting_scope_id','')IS NULL))
      AND CASE WHEN pg_input_is_valid(l.metadata->>'period_start','timestamptz')THEN(l.metadata->>'period_start')::timestamptz=p_start ELSE true END
      AND CASE WHEN pg_input_is_valid(l.metadata->>'period_end','timestamptz')THEN(l.metadata->>'period_end')::timestamptz=p_end ELSE true END)
    OR(l.category='treasury_transfer'AND l.metadata->>'payment_method'='owner_confirmed_existing_transfer'
      AND(l.union_id=f OR l.metadata->>'accounting_scope_id'=f::text OR(l.union_id IS NULL AND NULLIF(l.metadata->>'accounting_scope_id','')IS NULL))
      AND CASE WHEN pg_input_is_valid(l.metadata->>'period_start','timestamptz')THEN(l.metadata->>'period_start')::timestamptz=p_start ELSE true END
      AND CASE WHEN pg_input_is_valid(l.metadata->>'period_end','timestamptz')THEN(l.metadata->>'period_end')::timestamptz=p_end ELSE true END);

  TRUNCATE pg_temp._zero_foreign_owner_nodes,pg_temp._zero_foreign_edges;
  INSERT INTO pg_temp._zero_foreign_owner_nodes SELECT n.club_id,n.user_id,n.own_amount FROM pg_temp._routed_nodes n JOIN public.clubs c ON c.id=n.club_id AND c.owner_id=n.user_id;
  IF EXISTS(SELECT FROM pg_temp._routed_edges e JOIN pg_temp._zero_foreign_owner_nodes o ON o.club_id=e.club_id AND o.user_id=e.payee_user WHERE e.payer_user IS NOT NULL)
  THEN RAISE EXCEPTION 'zero_standalone_foreign_owner_hierarchy_changed' USING ERRCODE='23514';END IF;
  INSERT INTO pg_temp._zero_foreign_edges SELECT e.club_id,CASE WHEN o.user_id IS NULL THEN e.payer_user END,e.payee_user,sum(e.amount),min(e.role)
   FROM pg_temp._routed_edges e LEFT JOIN pg_temp._zero_foreign_owner_nodes o ON o.club_id=e.club_id AND o.user_id=e.payer_user
   WHERE NOT EXISTS(SELECT FROM pg_temp._zero_foreign_owner_nodes x WHERE x.club_id=e.club_id AND x.user_id=e.payee_user)
   GROUP BY e.club_id,CASE WHEN o.user_id IS NULL THEN e.payer_user END,e.payee_user;
  SELECT coalesce(sum(own_amount),0),count(*)INTO node_total,node_n FROM pg_temp._routed_nodes;
  SELECT coalesce(sum(own_amount),0),count(*)INTO owner_total,owner_n FROM pg_temp._zero_foreign_owner_nodes;
  SELECT coalesce(sum(amount)FILTER(WHERE payer_user IS NULL),0),coalesce(sum(amount)FILTER(WHERE payer_user IS NOT NULL),0)INTO bank_total,down_total FROM pg_temp._zero_foreign_edges;
  IF node_total IS DISTINCT FROM(fr.result->>'own_commission_amount')::numeric OR owner_total IS DISTINCT FROM(fr.result->>'owner_retained_in_club_bank')::numeric
   OR bank_total IS DISTINCT FROM(fr.result->>'amount')::numeric OR down_total IS DISTINCT FROM(fr.result->>'downstream_amount')::numeric
   OR node_n-owner_n IS DISTINCT FROM(fr.result->>'payees')::int OR bank_total+owner_total IS DISTINCT FROM node_total
   OR EXISTS(SELECT FROM pg_temp._routed_nodes n WHERE(CASE WHEN EXISTS(SELECT FROM pg_temp._zero_foreign_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id)THEN 0 ELSE n.own_amount END)
    IS DISTINCT FROM coalesce((SELECT sum(amount)FROM pg_temp._zero_foreign_edges e WHERE e.club_id=n.club_id AND e.payee_user=n.user_id),0)-coalesce((SELECT sum(amount)FROM pg_temp._zero_foreign_edges e WHERE e.club_id=n.club_id AND e.payer_user=n.user_id),0))
  THEN RAISE EXCEPTION 'zero_standalone_foreign_original_plan_not_conserved' USING ERRCODE='23514';END IF;
  -- A paid prior-transfer discharge is a separate real reimbursement; bind its
  -- source fingerprint and gross own amount to the same independently read node.
  IF EXISTS(SELECT FROM smarter_private.existing_rakeback_transfer_allocations a JOIN public.chip_ledger r ON r.id=a.reimbursement_ledger_id
   WHERE a.obligation_role='commission'AND a.period_start=p_start AND a.period_end=p_end
    AND r.metadata->>'accounting_scope_kind'='union'AND r.metadata->>'accounting_scope_id'=f::text
    AND(r.created_at IS DISTINCT FROM paid_stamp OR NOT smarter_private.existing_rakeback_transfer_complete('commission',a.obligation_id)
     OR NOT EXISTS(SELECT FROM pg_temp._routed_nodes n JOIN public.clubs c ON c.id=n.club_id WHERE n.club_id=a.club_id AND n.user_id=a.beneficiary_id
      AND a.amount=n.own_amount AND a.original_payer_id=c.owner_id
      AND a.source_fingerprint=md5(jsonb_build_array('commission_own',a.club_id,a.beneficiary_id,p_start,p_end,fr.source_fingerprint,n.own_amount)::text))
     OR NOT EXISTS(SELECT FROM pg_temp._zero_foreign_edges e WHERE e.club_id=a.club_id AND e.payee_user=a.beneficiary_id AND e.payer_user IS NULL AND e.amount>=a.amount)))
  THEN RAISE EXCEPTION 'zero_standalone_foreign_prior_discharge_not_bound' USING ERRCODE='23514';END IF;
  UPDATE pg_temp._zero_foreign_edges e SET amount=e.amount-coalesce((SELECT sum(a.amount)FROM smarter_private.existing_rakeback_transfer_allocations a JOIN public.chip_ledger r ON r.id=a.reimbursement_ledger_id
   WHERE a.obligation_role='commission'AND a.club_id=e.club_id AND a.beneficiary_id=e.payee_user AND a.period_start=p_start AND a.period_end=p_end
   AND r.metadata->>'accounting_scope_kind'='union'AND r.metadata->>'accounting_scope_id'=f::text),0)WHERE e.payer_user IS NULL;
  DELETE FROM pg_temp._zero_foreign_edges WHERE amount=0;
  IF EXISTS(SELECT FROM pg_temp._zero_foreign_edges e WHERE(SELECT count(*)FROM public.chip_ledger l
    WHERE l.idempotency_key=key||':'||e.club_id::text||':'||coalesce(e.payer_user::text,'club')||':'||e.payee_user::text
    AND l.status='posted'AND l.category='commission'AND l.created_at=paid_stamp AND l.union_id=f AND l.club_id=e.club_id
    AND l.from_type=CASE WHEN e.payer_user IS NULL THEN 'club_treasury'ELSE 'agent_wallet'END AND l.from_entity_id=coalesce(e.payer_user,e.club_id)
    AND l.to_type='agent_wallet'AND l.to_entity_id=e.payee_user AND l.amount=e.amount
    AND l.pre_from_balance-l.post_from_balance=e.amount AND l.post_to_balance-l.pre_to_balance=e.amount
    AND l.metadata->>'routing_version'='3'AND l.metadata->>'accounting_scope_kind'='union'AND l.metadata->>'accounting_scope_id'=f::text
    AND(l.metadata->>'period_start')::timestamptz=p_start AND(l.metadata->>'period_end')::timestamptz=p_end AND l.metadata->>'paid_to'='agent_wallet'
    AND l.metadata->>'payee_role_at_transfer'=e.role
    AND(l.metadata->>'own_commission')::numeric=(SELECT n.own_amount-coalesce((SELECT sum(a.amount)FROM smarter_private.existing_rakeback_transfer_allocations a JOIN public.chip_ledger r ON r.id=a.reimbursement_ledger_id WHERE a.obligation_role='commission'AND a.club_id=n.club_id AND a.beneficiary_id=n.user_id AND a.period_start=p_start AND a.period_end=p_end AND r.metadata->>'accounting_scope_kind'='union'AND r.metadata->>'accounting_scope_id'=f::text),0)FROM pg_temp._routed_nodes n WHERE n.club_id=e.club_id AND n.user_id=e.payee_user)
    AND(l.metadata->>'pass_through')::boolean=(e.payer_user IS NOT NULL)
    AND(SELECT count(*)FROM public.settlement_invoices i WHERE i.source_ledger_id=l.id AND i.status='paid'AND i.chips_transferred AND i.message_sent AND i.gross_amount=l.amount AND i.net_amount=l.amount AND i.deductions=0)=1)<>1)
   OR EXISTS(SELECT FROM pg_temp._zero_foreign_actual_r2_legs l
    WHERE NOT EXISTS(SELECT FROM pg_temp._zero_foreign_edges e WHERE l.category='commission'AND l.idempotency_key=key||':'||e.club_id::text||':'||coalesce(e.payer_user::text,'club')||':'||e.payee_user::text)
     AND NOT EXISTS(SELECT FROM smarter_private.existing_rakeback_transfer_allocations a WHERE a.obligation_role='commission'AND a.reimbursement_ledger_id=l.id
      AND a.period_start=p_start AND a.period_end=p_end AND smarter_private.existing_rakeback_transfer_complete('commission',a.obligation_id))
     -- A legitimate R3 player reimbursement may share this same transaction.
     -- Classify it through its actual R3 certificate/admission, never role text alone.
     AND NOT EXISTS(SELECT FROM smarter_private.existing_rakeback_transfer_allocations a JOIN public.accounting_rakeback_period_calculations c ON c.id=a.certificate_id
      WHERE a.obligation_role='player'AND a.reimbursement_ledger_id=l.id AND a.period_start=p_start AND a.period_end=p_end AND c.coordinator_union_id=f
       AND l.union_id=f AND l.metadata->>'accounting_scope_kind'='union'AND l.metadata->>'accounting_scope_id'=f::text
       AND smarter_private.existing_rakeback_transfer_complete('player',a.obligation_id)))
  THEN RAISE EXCEPTION 'zero_standalone_foreign_actual_edge_receipt_not_bound' USING ERRCODE='23514';END IF;
 END LOOP;
 -- Restore every relation changed by the original combine, not a cached plan
 -- or a claimed zero. All original own-stage scalar facts remain untouched.
 TRUNCATE pg_temp._routed_nodes,pg_temp._routed_edges;
 IF had_clubs THEN TRUNCATE pg_temp._routed_clubs;INSERT INTO pg_temp._routed_clubs SELECT * FROM pg_temp._zero_saved_r2_clubs;
 ELSE DROP TABLE IF EXISTS pg_temp._routed_clubs;END IF;
 IF had_windows THEN TRUNCATE pg_temp._close_r2_windows;INSERT INTO pg_temp._close_r2_windows SELECT * FROM pg_temp._zero_saved_r2_windows;
 ELSE DROP TABLE IF EXISTS pg_temp._close_r2_windows;END IF;
END $body$;
REVOKE ALL ON FUNCTION smarter_private.zero_standalone_foreign_commissions_proven(uuid,timestamptz,timestamptz)FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_settle_accounting_commission_stage(p_scope_kind text, p_scope_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE foreign_legacy_deferred boolean:=false;prior_plan jsonb;prior_node record;prior_saved_context text;scope record;p_union_id uuid;standalone_club uuid;
 v_source record;v_edge record;previous public.accounting_routed_settlement_runs%ROWTYPE;
 fingerprint text;result jsonb;run_key text;own_total numeric;direct_total numeric;downstream_total numeric;
 source_count int;node_count int;finished int:=0;step int:=0;progress int;ledger_id uuid;receipt_count int;
 payer_before numeric;payee_before numeric;payer_after numeric;payee_after numeric;club_skip text;member_skip text;routing_context text;agent_skip text;owner_retained numeric:=0;v4_ok boolean:=true;v_comb jsonb;
 deleted_deferral text; v_deleted record; v_deleted_before numeric; v_deleted_held numeric; v_deleted_locked numeric;
 v_deleted_bank numeric; v_deleted_return jsonb;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_period_start IS NULL OR p_period_end IS NULL OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR p_period_start>=p_period_end OR p_period_end>now()-interval '5 minutes' THEN RAISE EXCEPTION 'routed_commission_invalid_period' USING ERRCODE='22023'; END IF;
 SELECT * INTO scope FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_period_start,p_period_end);
 p_union_id:=scope.union_id;standalone_club:=scope.standalone_club_id;
 IF EXISTS(SELECT 1 FROM public.settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active) THEN RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 IF EXISTS(SELECT 1 FROM public.union_settlement_floor WHERE union_id=p_union_id AND p_period_start<earliest_period_start)
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND p_period_start>=starts_at)
 THEN RAISE EXCEPTION 'routed_commission_historical_period_uncertified' USING ERRCODE='55000'; END IF;
 IF p_period_start IS DISTINCT FROM public.fn_union_week_start(p_period_start)
  OR p_period_end IS DISTINCT FROM public.fn_union_week_start(p_period_start+interval '8 days')
 THEN RAISE EXCEPTION 'routed_commission_requires_one_accounting_week' USING ERRCODE='22023'; END IF;
 run_key:='round2:v3:'||scope.scope_key||':'||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text;
 PERFORM public.fn_lock_rakeback_payer_clubs(scope.club_ids);
 -- WEEKLY CLOSE SCALE (20260928): one read of the week's sources keeps only
 -- what this stage uses (tiers, the contract's club and each row's own md5),
 -- instead of copying every full contract into a temp table. The fingerprint
 -- is the same md5 over the same per-row md5s in the same order. Anything
 -- this path cannot read exactly as the original did is answered by the
 -- original, byte-for-byte, as public.fn_settle_accounting_commission_stage_v3.
 -- CHUNKED CLOSE WINDOWS (20261003): inside a chunked close the plan below
 -- is combined from the week's proved two-hour windows
 -- (fn_settle_accounting_commission_window, fn_settle_accounting_commission_combine),
 -- exactly as these reads build it; outside one, or with any window missing,
 -- the week is read here as before.
 v_comb:=CASE WHEN COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'
  THEN public.fn_settle_accounting_commission_combine(p_scope_kind,p_scope_id,p_period_start,p_period_end) END;
 IF v_comb IS NOT NULL THEN
  IF (v_comb->>'read_failed')::boolean THEN
   RAISE EXCEPTION 'routed_commission_window_needs_full_path' USING ERRCODE='55000'; END IF;
  fingerprint:=v_comb->>'fingerprint'; source_count:=(v_comb->>'sources')::int;
  SELECT * INTO previous FROM public.accounting_routed_settlement_runs
   WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=2;
  IF FOUND THEN
   IF previous.source_fingerprint<>fingerprint THEN RAISE EXCEPTION 'routed_commission_source_changed_after_payment' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT FROM smarter_private.existing_rakeback_transfer_allocations a JOIN public.chip_ledger l ON l.id=a.reimbursement_ledger_id
   WHERE a.obligation_role='commission'AND a.period_start=p_period_start AND a.period_end=p_period_end AND l.metadata->>'accounting_scope_kind'=p_scope_kind AND l.metadata->>'accounting_scope_id'=p_scope_id::text
   AND NOT smarter_private.existing_rakeback_transfer_complete('commission',a.obligation_id))THEN RAISE EXCEPTION 'existing_transfer_discharge_receipt_incomplete' USING ERRCODE='23514';END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
  END IF;
  IF EXISTS(SELECT 1 FROM public.agent_commission_settlements cs WHERE cs.period_start<p_period_end AND cs.period_end>p_period_start
    AND (cs.union_id=p_union_id OR cs.club_id=ANY(scope.club_ids)))
   OR EXISTS(SELECT 1 FROM public.union_settlement_rounds r WHERE r.union_id=p_union_id AND r.round_no=2
     AND r.period_start<p_period_end AND r.period_end>p_period_start AND (r.amount>0 OR r.payees>0 OR r.shortfalls>0))
  THEN
   IF p_scope_kind='club'AND source_count=0 THEN foreign_legacy_deferred:=true;
   ELSE RAISE EXCEPTION 'legacy_commission_payment_requires_reconciliation' USING ERRCODE='55000';END IF;
 END IF;
  IF (v_comb->>'unclassified')::bigint>0 THEN RAISE EXCEPTION 'unclassified_commission_source_requires_reconciliation' USING ERRCODE='55000'; END IF;
  -- A contract only the original v3 path can read is not paid from windows,
  -- and v3 is never run here in one long transaction: nothing is paid.
  IF (v_comb->>'full_path')::boolean THEN RAISE EXCEPTION 'routed_commission_window_needs_full_path' USING ERRCODE='55000'; END IF;
  IF (v_comb->>'hierarchy_bad')::boolean THEN RAISE EXCEPTION 'routed_commission_hierarchy_ambiguous' USING ERRCODE='23514'; END IF;
  IF (v_comb->>'entitlement_bad')::boolean THEN RAISE EXCEPTION 'routed_commission_entitlement_disagrees_with_source' USING ERRCODE='23514'; END IF;
 ELSE
 BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _routed_sources_v4(source_type text,source_id uuid,club_id uuid,earned_at timestamptz,tiers jsonb,tiers_type text,contract_club text,row_md5 text,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
  TRUNCATE pg_temp._routed_sources_v4;
  INSERT INTO pg_temp._routed_sources_v4 SELECT source_type,source_id,club_id,earned_at,contract->'tiers',jsonb_typeof(contract->'tiers'),contract->>'club_id',
   md5((CASE WHEN source_type='cash_rake_accrual' THEN jsonb_build_array(source_id,club_id,earned_at,contract) ELSE jsonb_build_array(source_type,source_id,club_id,earned_at,contract) END)::text)
   FROM public.accounting_payable_earning_sources
   WHERE (coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND coordinator_union_id IS NULL AND club_id=standalone_club)) AND earned_at>=p_period_start AND earned_at<p_period_end;
 EXCEPTION WHEN OTHERS THEN v4_ok:=false;
 END;
 IF NOT v4_ok THEN RETURN public.fn_settle_accounting_commission_stage_v3(p_scope_kind,p_scope_id,p_period_start,p_period_end); END IF;
 SELECT count(*),md5(COALESCE(string_agg(row_md5,'' ORDER BY source_type||'',source_id),''))
 INTO source_count,fingerprint FROM pg_temp._routed_sources_v4;
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=2;
 IF FOUND THEN
  IF previous.source_fingerprint<>fingerprint THEN RAISE EXCEPTION 'routed_commission_source_changed_after_payment' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT FROM smarter_private.existing_rakeback_transfer_allocations a JOIN public.chip_ledger l ON l.id=a.reimbursement_ledger_id
   WHERE a.obligation_role='commission'AND a.period_start=p_period_start AND a.period_end=p_period_end AND l.metadata->>'accounting_scope_kind'=p_scope_kind AND l.metadata->>'accounting_scope_id'=p_scope_id::text
   AND NOT smarter_private.existing_rakeback_transfer_complete('commission',a.obligation_id))THEN RAISE EXCEPTION 'existing_transfer_discharge_receipt_incomplete' USING ERRCODE='23514';END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commission_settlements cs WHERE cs.period_start<p_period_end AND cs.period_end>p_period_start
   AND (cs.union_id=p_union_id OR cs.club_id=ANY(scope.club_ids)))
  OR EXISTS(SELECT 1 FROM public.union_settlement_rounds r WHERE r.union_id=p_union_id AND r.round_no=2
    AND r.period_start<p_period_end AND r.period_end>p_period_start AND (r.amount>0 OR r.payees>0 OR r.shortfalls>0))
 THEN
   IF p_scope_kind='club'AND source_count=0 THEN foreign_legacy_deferred:=true;
   ELSE RAISE EXCEPTION 'legacy_commission_payment_requires_reconciliation' USING ERRCODE='55000';END IF;
 END IF;
 -- Any source matching (type,id,club,earned_at=created_at) of a commission row
 -- of these clubs created this week is itself one of these clubs' sources
 -- earned this week, so one hashed read of that slice answers every row. The
 -- tests are counted, not EXISTS: an EXISTS is planned for its first row and
 -- a clean book has none, so it would be a nested loop over the whole week.
 IF (WITH club_week AS MATERIALIZED (
   SELECT rs.source_type,rs.source_id,rs.club_id,rs.earned_at FROM public.accounting_payable_earning_sources rs
    WHERE rs.club_id=ANY(scope.club_ids) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end)
  SELECT count(*) FROM public.agent_commissions ac
   LEFT JOIN club_week rs ON rs.source_type=ac.source_type AND rs.source_id=ac.source_id AND rs.club_id=ac.club_id AND rs.earned_at=ac.created_at
  WHERE ac.created_at>=public.fn_ca_launch_accounting_start('club',ac.club_id,p_period_start) AND ac.created_at<p_period_end
  AND (ac.club_id=ANY(scope.club_ids))
  AND (ac.source_type IS NULL OR ac.source_type NOT IN('cash_rake_accrual','tournament_fee_accrual') OR ac.settled_at IS NOT NULL OR rs.source_id IS NULL))>0
 THEN RAISE EXCEPTION 'unclassified_commission_source_requires_reconciliation' USING ERRCODE='55000'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_tiers(source_type text,source_id uuid,club_id uuid,depth int,agent_id uuid,user_id uuid,role text,
  parent_agent_id uuid,own_amount numeric,rate numeric,PRIMARY KEY(source_type,source_id,depth)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_tiers;
 -- One set insert of every tier. A contract the original loop would refuse,
 -- or a tier value it would fail to read, is answered by the original.
 IF EXISTS(SELECT 1 FROM pg_temp._routed_sources_v4 s WHERE s.tiers_type IS DISTINCT FROM 'array' OR s.contract_club IS DISTINCT FROM s.club_id::text) THEN
  RETURN public.fn_settle_accounting_commission_stage_v3(p_scope_kind,p_scope_id,p_period_start,p_period_end);
 END IF;
 BEGIN
  INSERT INTO pg_temp._routed_tiers SELECT s.source_type,s.source_id,s.club_id,ord::int,(j->>'agent_id')::uuid,(j->>'user_id')::uuid,j->>'role',
   NULLIF(j->'agreement'->'terms'->>'parent_agent_id','')::uuid,(j->>'amount')::numeric,(j->>'rate')::numeric
   FROM pg_temp._routed_sources_v4 s CROSS JOIN LATERAL jsonb_array_elements(s.tiers) WITH ORDINALITY x(j,ord);
 EXCEPTION WHEN OTHERS THEN v4_ok:=false;
 END;
 IF NOT v4_ok THEN RETURN public.fn_settle_accounting_commission_stage_v3(p_scope_kind,p_scope_id,p_period_start,p_period_end); END IF;
 ANALYZE pg_temp._routed_tiers;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.agent_id IS NULL OR t.user_id IS NULL OR t.role IS NULL OR t.role NOT IN('super_agent','agent','sub_agent')
   OR t.own_amount IS NULL OR t.own_amount<0 OR t.own_amount<>round(t.own_amount,2) OR t.own_amount::text IN('NaN','Infinity','-Infinity')
   OR t.rate IS NULL OR t.rate<0 OR t.rate>1 OR t.rate::text IN('NaN','Infinity','-Infinity')
   OR t.parent_agent_id IS DISTINCT FROM(SELECT u.agent_id FROM pg_temp._routed_tiers u WHERE u.source_type=t.source_type AND u.source_id=t.source_id AND u.depth=t.depth+1))
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY source_type,source_id,user_id HAVING count(*)<>1)
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY club_id,user_id HAVING count(DISTINCT agent_id)<>1)
 THEN RAISE EXCEPTION 'routed_commission_hierarchy_ambiguous' USING ERRCODE='23514'; END IF;
 -- Every commission row of every source, read once by its (source_id,
 -- source_type) index in source order, whatever its club or time; the three
 -- original tests are then answered from that set.
 CREATE TEMP TABLE IF NOT EXISTS _routed_ac_v4(source_type text,source_id uuid,club_id uuid,user_id uuid,amount numeric,commission_rate numeric,settled_at timestamptz) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_ac_v4;
 INSERT INTO pg_temp._routed_ac_v4 SELECT a.* FROM (SELECT s.source_type,s.source_id FROM pg_temp._routed_sources_v4 s ORDER BY s.source_id,s.source_type) s
  CROSS JOIN LATERAL (SELECT ac.source_type,ac.source_id,ac.club_id,ac.user_id,ac.amount,ac.commission_rate,ac.settled_at FROM public.agent_commissions ac
   WHERE ac.source_id=s.source_id AND ac.source_type=s.source_type OFFSET 0) a;
 ANALYZE pg_temp._routed_ac_v4;
 IF (SELECT count(*) FROM pg_temp._routed_tiers t WHERE t.own_amount>0 AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_ac_v4 ac
    WHERE ac.source_type=t.source_type AND ac.source_id=t.source_id AND ac.club_id=t.club_id AND ac.user_id=t.user_id
     AND ac.amount=t.own_amount AND ac.commission_rate=t.rate AND ac.settled_at IS NULL))>0
  OR (SELECT count(*) FROM pg_temp._routed_tiers t LEFT JOIN (SELECT ac.source_type,ac.source_id,ac.user_id,count(*) AS n FROM pg_temp._routed_ac_v4 ac GROUP BY 1,2,3) c
    ON c.source_type=t.source_type AND c.source_id=t.source_id AND c.user_id=t.user_id
   WHERE COALESCE(c.n,0)<>CASE WHEN t.own_amount>0 THEN 1 ELSE 0 END)>0
  OR (SELECT count(*) FROM pg_temp._routed_ac_v4 ac
   WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.source_type=ac.source_type AND t.source_id=ac.source_id AND t.user_id=ac.user_id AND t.own_amount=ac.amount))>0
 THEN RAISE EXCEPTION 'routed_commission_entitlement_disagrees_with_source' USING ERRCODE='23514'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_nodes(club_id uuid,user_id uuid,agent_id uuid,role text,own_amount numeric,rows_count int,
  opening_balance numeric,sort_order int,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_nodes;
 INSERT INTO pg_temp._routed_nodes(club_id,user_id,agent_id,role,own_amount,rows_count)
  SELECT club_id,user_id,min(agent_id::text)::uuid,min(role),sum(own_amount),count(*) FILTER(WHERE own_amount>0)
  FROM pg_temp._routed_tiers GROUP BY club_id,user_id;
 CREATE TEMP TABLE IF NOT EXISTS _routed_edges(club_id uuid,payer_user uuid,payee_user uuid,amount numeric,role text,sort_order int) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_edges;
 -- The same per-tier running sum (depth is unique within a source).
 INSERT INTO pg_temp._routed_edges(club_id,payer_user,payee_user,amount,role)
 SELECT t.club_id,parent.user_id,t.user_id,sum(t.upto),min(t.role)
 FROM (SELECT t.*,sum(t.own_amount) OVER(PARTITION BY t.source_type,t.source_id ORDER BY t.depth ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS upto
  FROM pg_temp._routed_tiers t) t
 LEFT JOIN pg_temp._routed_tiers parent ON parent.source_type=t.source_type AND parent.source_id=t.source_id AND parent.depth=t.depth+1
 GROUP BY t.club_id,parent.user_id,t.user_id
 HAVING sum(t.upto)>0;
 CREATE TEMP TABLE IF NOT EXISTS _routed_clubs(club_id uuid PRIMARY KEY) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_clubs;
 INSERT INTO pg_temp._routed_clubs SELECT DISTINCT club_id FROM pg_temp._routed_sources_v4;
 END IF;
 SELECT count(*) INTO node_count FROM pg_temp._routed_nodes;
 WHILE finished<node_count LOOP
  step:=step+1;
  UPDATE pg_temp._routed_nodes n SET sort_order=step WHERE sort_order IS NULL AND NOT EXISTS(
   SELECT 1 FROM pg_temp._routed_edges e JOIN pg_temp._routed_nodes p ON p.club_id=e.club_id AND p.user_id=e.payer_user
   WHERE e.club_id=n.club_id AND e.payee_user=n.user_id AND p.sort_order IS NULL);
  GET DIAGNOSTICS progress=ROW_COUNT;
  IF progress=0 THEN RAISE EXCEPTION 'routed_commission_weekly_hierarchy_cycle' USING ERRCODE='23514'; END IF;
  finished:=finished+progress;
 END LOOP;
 UPDATE pg_temp._routed_edges e SET sort_order=n.sort_order FROM pg_temp._routed_nodes n WHERE n.club_id=e.club_id AND n.user_id=e.payee_user;
 SELECT COALESCE(sum(own_amount),0) INTO own_total FROM pg_temp._routed_nodes;
 SELECT COALESCE(sum(amount) FILTER(WHERE payer_user IS NULL),0),COALESCE(sum(amount) FILTER(WHERE payer_user IS NOT NULL),0)
 INTO direct_total,downstream_total FROM pg_temp._routed_edges;
 IF direct_total<>own_total OR EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE n.own_amount IS DISTINCT FROM
   COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payee_user=n.user_id),0)
   -COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payer_user=n.user_id),0))
 THEN RAISE EXCEPTION 'routed_commission_plan_does_not_conserve' USING ERRCODE='23514'; END IF;
 -- COMMISSION LANDS IN AGENT WALLETS; THE OWNER'S SHARE STAYS IN THE CLUB BANK
 -- (20261022, Dan). The club owner (clubs.owner_id) is never paid commission
 -- into any personal wallet: the owner's own tier is not moved out of
 -- clubs.chip_treasury at all, and what the recorded hierarchy passes down
 -- through the owner is paid to the child agent straight from the club bank.
 -- Every other payee is credited in agents.agent_wallet_balance, never in
 -- club_members.chip_balance.
 CREATE TEMP TABLE IF NOT EXISTS _routed_owner_nodes(club_id uuid,user_id uuid,own_amount numeric,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_owner_nodes;
 INSERT INTO pg_temp._routed_owner_nodes SELECT n.club_id,n.user_id,n.own_amount FROM pg_temp._routed_nodes n JOIN public.clubs c ON c.id=n.club_id AND c.owner_id=n.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_edges e JOIN pg_temp._routed_owner_nodes o ON o.club_id=e.club_id AND o.user_id=e.payee_user WHERE e.payer_user IS NOT NULL)
 THEN RAISE EXCEPTION 'routed_commission_owner_below_agent' USING ERRCODE='23514'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_edges_paid(club_id uuid,payer_user uuid,payee_user uuid,amount numeric,role text,sort_order int) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_edges_paid;
 INSERT INTO pg_temp._routed_edges_paid(club_id,payer_user,payee_user,amount,role,sort_order)
 SELECT e.club_id,CASE WHEN o.user_id IS NULL THEN e.payer_user END,e.payee_user,sum(e.amount),min(e.role),min(e.sort_order)
  FROM pg_temp._routed_edges e LEFT JOIN pg_temp._routed_owner_nodes o ON o.club_id=e.club_id AND o.user_id=e.payer_user
  WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes p WHERE p.club_id=e.club_id AND p.user_id=e.payee_user)
  GROUP BY e.club_id,CASE WHEN o.user_id IS NULL THEN e.payer_user END,e.payee_user;
 TRUNCATE pg_temp._routed_edges;
 INSERT INTO pg_temp._routed_edges(club_id,payer_user,payee_user,amount,role,sort_order)
  SELECT club_id,payer_user,payee_user,amount,role,sort_order FROM pg_temp._routed_edges_paid;
 SELECT COALESCE(sum(own_amount),0) INTO owner_retained FROM pg_temp._routed_owner_nodes;
 SELECT COALESCE(sum(amount) FILTER(WHERE payer_user IS NULL),0),COALESCE(sum(amount) FILTER(WHERE payer_user IS NOT NULL),0)
 INTO direct_total,downstream_total FROM pg_temp._routed_edges;
 IF direct_total+owner_retained<>own_total OR EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE
   (CASE WHEN EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) THEN 0 ELSE n.own_amount END) IS DISTINCT FROM
   COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payee_user=n.user_id),0)
   -COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payer_user=n.user_id),0))
 THEN RAISE EXCEPTION 'routed_commission_owner_plan_does_not_conserve' USING ERRCODE='23514'; END IF;
 -- Only a fully proved empty original plan may reconcile canonical foreign
 -- paid rows. The private validator writes no public state or receipt.
 IF foreign_legacy_deferred THEN
  IF p_scope_kind IS DISTINCT FROM 'club'OR source_count IS DISTINCT FROM 0 OR fingerprint IS DISTINCT FROM md5('')
   OR node_count IS DISTINCT FROM 0 OR own_total IS DISTINCT FROM 0 OR direct_total IS DISTINCT FROM 0 OR downstream_total IS DISTINCT FROM 0 OR owner_retained IS DISTINCT FROM 0
  THEN RAISE EXCEPTION 'zero_standalone_full_original_empty_plan_required' USING ERRCODE='23514';END IF;
  CREATE TEMP TABLE IF NOT EXISTS _routed_zero_standalone_context(scope_kind text,scope_id uuid,period_start timestamptz,period_end timestamptz,source_count int,fingerprint text)ON COMMIT DROP;
  TRUNCATE pg_temp._routed_zero_standalone_context;
  INSERT INTO pg_temp._routed_zero_standalone_context VALUES(p_scope_kind,p_scope_id,p_period_start,p_period_end,source_count,fingerprint);
  PERFORM smarter_private.zero_standalone_foreign_commissions_proven(p_scope_id,p_period_start,p_period_end);
  TRUNCATE pg_temp._routed_zero_standalone_context;
 END IF;
 -- Original tiers, entitlement rows, complete hierarchy and full gross
 -- conservation have already been proved. Remove only the subject's own
 -- discharged share, preserving every descendant's genuine pass-through.
 CREATE TEMP TABLE IF NOT EXISTS _routed_prior_discharge_context(stage_round int,period_start timestamptz,period_end timestamptz,club_ids uuid[],source_fingerprint text)ON COMMIT DROP;
 TRUNCATE pg_temp._routed_prior_discharge_context;
 INSERT INTO pg_temp._routed_prior_discharge_context VALUES(2,p_period_start,p_period_end,scope.club_ids,fingerprint);
 prior_saved_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 FOR prior_node IN SELECT n.* FROM pg_temp._routed_nodes n JOIN smarter_private.existing_rakeback_transfer_instructions q
  ON q.club_id=n.club_id AND q.beneficiary_id=n.user_id AND q.period_start=p_period_start AND q.period_end=p_period_end
  WHERE 'commission'=ANY(q.roles)AND n.own_amount>0 ORDER BY n.club_id,n.user_id LOOP
  prior_plan:=smarter_private.apply_existing_rakeback_transfer(p_scope_kind,p_scope_id,p_period_start,p_period_end,'commission',prior_node.club_id,prior_node.user_id);
  IF prior_plan IS NULL THEN RAISE EXCEPTION 'existing_transfer_expected_commission_instruction_required';END IF;
  UPDATE pg_temp._routed_edges SET amount=amount-(prior_plan->>'amount')::numeric WHERE club_id=prior_node.club_id AND payee_user=prior_node.user_id AND payer_user IS NULL;
  IF NOT FOUND OR EXISTS(SELECT FROM pg_temp._routed_edges WHERE amount<0)THEN RAISE EXCEPTION 'existing_transfer_commission_edge_not_conserved';END IF;
 END LOOP;
 DELETE FROM pg_temp._routed_edges WHERE amount=0;
 PERFORM set_config('app.accounting_routing_context',COALESCE(prior_saved_context,''),true);
 IF EXISTS(SELECT FROM pg_temp._routed_nodes n WHERE NOT EXISTS(SELECT FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id)
  AND n.own_amount-COALESCE((SELECT sum(a.amount)FROM smarter_private.existing_rakeback_transfer_allocations a WHERE a.obligation_role='commission'AND a.club_id=n.club_id AND a.beneficiary_id=n.user_id AND a.period_start=p_period_start AND a.period_end=p_period_end),0)
  IS DISTINCT FROM COALESCE((SELECT sum(e.amount)FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payee_user=n.user_id),0)-COALESCE((SELECT sum(e.amount)FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payer_user=n.user_id),0))
 THEN RAISE EXCEPTION 'existing_transfer_commission_adjusted_plan_not_conserved';END IF;
 -- All accounts are pinned before the first transfer. Current rates and parents
 -- never choose the route. A retired agent keeps the earned entitlement; the
 -- existing agent wallet (agents row) and immutable source contract remain mandatory.
 PERFORM c.id FROM public.clubs c WHERE c.id IN(SELECT club_id FROM pg_temp._routed_clubs) ORDER BY c.id FOR NO KEY UPDATE;
 PERFORM a.id FROM public.agents a JOIN pg_temp._routed_nodes n ON n.club_id=a.club_id AND n.user_id=a.user_id
  WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) ORDER BY a.club_id,a.user_id FOR NO KEY UPDATE OF a;
 UPDATE pg_temp._routed_nodes n SET opening_balance=a.agent_wallet_balance FROM public.agents a WHERE a.club_id=n.club_id AND a.user_id=n.user_id
  AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) AND (n.opening_balance IS NULL OR n.opening_balance<0
  OR n.opening_balance::text IN('NaN','Infinity','-Infinity') OR n.opening_balance<>round(n.opening_balance,2)))
 THEN RAISE EXCEPTION 'routed_commission_wallet_identity_or_balance_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(amount) owed FROM pg_temp._routed_edges WHERE payer_user IS NULL GROUP BY club_id) e
  LEFT JOIN public.clubs c ON c.id=e.club_id WHERE c.chip_treasury IS NULL OR c.chip_treasury<e.owed
   OR c.chip_treasury::text IN('NaN','Infinity','-Infinity') OR c.chip_treasury<>round(c.chip_treasury,2))
 THEN RAISE EXCEPTION 'routed_commission_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 deleted_deferral:=current_setting('app.deleted_wallet_routing_stage',true);
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);agent_skip:=current_setting('app.ledger_autoskip_agents',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 PERFORM set_config('app.deleted_wallet_routing_stage','commission',true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);PERFORM set_config('app.ledger_autoskip_agents','1',true);
 FOR v_edge IN SELECT * FROM pg_temp._routed_edges ORDER BY sort_order,club_id,payer_user NULLS FIRST,payee_user LOOP
  SELECT agent_wallet_balance INTO payee_before FROM public.agents WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user;
  IF v_edge.payer_user IS NULL THEN
   SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=v_edge.club_id;
   UPDATE public.clubs SET chip_treasury=chip_treasury-v_edge.amount WHERE id=v_edge.club_id AND chip_treasury>=v_edge.amount RETURNING chip_treasury INTO payer_after;
  ELSE
   SELECT agent_wallet_balance INTO payer_before FROM public.agents WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user;
   UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance-v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user AND agent_wallet_balance>=v_edge.amount RETURNING agent_wallet_balance INTO payer_after;
  END IF;
  UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance+v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user RETURNING agent_wallet_balance INTO payee_after;
  IF payer_after IS NULL OR payee_after IS NULL OR payer_before-payer_after<>v_edge.amount OR payee_after-payee_before<>v_edge.amount
  THEN RAISE EXCEPTION 'routed_commission_transfer_not_conserved' USING ERRCODE='23514'; END IF;
  -- Agent wallets are journalled by the chip_ledger leg and its receipt below,
  -- exactly as every other agent-wallet door; no player-wallet transaction.
  INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
   VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN v_edge.payer_user IS NULL THEN 'club_treasury' ELSE 'agent_wallet' END,
    COALESCE(v_edge.payer_user,v_edge.club_id),'agent_wallet',v_edge.payee_user,v_edge.amount,'commission',v_edge.club_id,p_union_id,
    'Weekly commission through recorded earning hierarchy',run_key||':'||v_edge.club_id::text||':'||COALESCE(v_edge.payer_user::text,'club')||':'||v_edge.payee_user::text,
    jsonb_build_object('routing_version',3,'accounting_scope_kind',p_scope_kind,'accounting_scope_id',p_scope_id,'period_start',p_period_start,'period_end',p_period_end,'payee_role_at_transfer',v_edge.role,
      'own_commission',(SELECT n.own_amount-COALESCE((SELECT sum(a.amount)FROM smarter_private.existing_rakeback_transfer_allocations a WHERE a.obligation_role='commission'AND a.club_id=n.club_id AND a.beneficiary_id=n.user_id AND a.period_start=p_period_start AND a.period_end=p_period_end),0)FROM pg_temp._routed_nodes n WHERE n.club_id=v_edge.club_id AND n.user_id=v_edge.payee_user),
      'pass_through',v_edge.payer_user IS NOT NULL,'paid_to','agent_wallet'),payer_before,payer_after,payee_before,payee_after) RETURNING id INTO ledger_id;
  SELECT count(*) INTO receipt_count FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
   AND i.chips_transferred AND i.message_sent AND i.net_amount=v_edge.amount AND i.gross_amount=v_edge.amount AND i.deductions=0;
  IF receipt_count<>1 THEN RAISE EXCEPTION 'routed_commission_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);PERFORM set_config('app.ledger_autoskip_agents',COALESCE(agent_skip,''),true);
 PERFORM set_config('app.deleted_wallet_routing_stage',COALESCE(deleted_deferral,''),true);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n LEFT JOIN public.agents a ON a.club_id=n.club_id AND a.user_id=n.user_id
   WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) AND a.agent_wallet_balance IS DISTINCT FROM n.opening_balance+n.own_amount-COALESCE((SELECT sum(a.amount)FROM smarter_private.existing_rakeback_transfer_allocations a WHERE a.obligation_role='commission'AND a.club_id=n.club_id AND a.beneficiary_id=n.user_id AND a.period_start=p_period_start AND a.period_end=p_period_end),0))
 THEN RAISE EXCEPTION 'routed_commission_retained_balance_incorrect' USING ERRCODE='23514'; END IF;
 -- All original transfer, invoice and net-wallet checks above still decide
 -- whether this stage may finish. Return only free net chips afterward,
 -- retaining published unpaid player obligations across bounded chunks.
 FOR v_deleted IN
  SELECT a.club_id,a.user_id FROM public.agents a
  JOIN public.profiles dp ON dp.id=a.user_id AND dp.status='deleted'
  WHERE EXISTS(SELECT FROM pg_temp._routed_edges e WHERE e.club_id=a.club_id AND e.payee_user=a.user_id AND e.amount>0) ORDER BY a.club_id,a.user_id
 LOOP
  SELECT a.agent_wallet_balance INTO STRICT v_deleted_before FROM public.agents a
   WHERE a.club_id=v_deleted.club_id AND a.user_id=v_deleted.user_id;
  SELECT dwr_bank.chip_treasury INTO STRICT v_deleted_bank FROM public.clubs dwr_bank WHERE dwr_bank.id=v_deleted.club_id;
  v_deleted_return:=public.fn_ca_deleted_wallet_bank_return(v_deleted.club_id,v_deleted.user_id,'agent_wallet');
  IF v_deleted_return->'success' IS DISTINCT FROM 'true'::jsonb
   OR v_deleted_return->>'reserved_rakeback' IS NULL OR (v_deleted_return->>'reserved_rakeback')::numeric<0
   OR (v_deleted_return->>'reserved_rakeback')::numeric::text IN('NaN','Infinity','-Infinity')
   OR (v_deleted_return->>'amount')::numeric IS DISTINCT FROM greatest(v_deleted_before-(v_deleted_return->>'reserved_rakeback')::numeric,0)
   OR (v_deleted_return->>'agent_chips')::numeric IS DISTINCT FROM (v_deleted_return->>'amount')::numeric
   OR (v_deleted_return->>'player_chips')::numeric IS DISTINCT FROM 0::numeric
   OR NOT EXISTS(SELECT FROM public.agents a WHERE a.club_id=v_deleted.club_id AND a.user_id=v_deleted.user_id
     AND a.agent_wallet_balance=v_deleted_before-(v_deleted_return->>'amount')::numeric)
   OR NOT EXISTS(SELECT FROM public.clubs dwr_bank WHERE dwr_bank.id=v_deleted.club_id AND dwr_bank.chip_treasury=v_deleted_bank+(v_deleted_return->>'amount')::numeric)
  THEN RAISE EXCEPTION 'deleted_weekly_net_bank_return_not_conserved' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);

 INSERT INTO public.agent_commission_settlements(club_id,user_id,union_id,period_start,period_end,amount,rows_count,paid_at,settlement_ref)
  SELECT club_id,user_id,p_union_id,p_period_start,p_period_end,own_amount,rows_count,now(),run_key FROM pg_temp._routed_nodes;
 IF node_count>0 THEN PERFORM public.fn_agent_commission_rollup_recompute(
  (SELECT jsonb_agg(jsonb_build_object('club_id',club_id,'user_id',user_id)) FROM pg_temp._routed_nodes)); END IF;
 result:=jsonb_build_object('success',true,'round',2,'name','recorded_commission_hierarchy','routing_version',3,'source_version',2,'source_contract_version',3,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
  'payees',node_count-(SELECT count(*)::int FROM pg_temp._routed_owner_nodes),'amount',direct_total,'own_commission_amount',own_total,'downstream_amount',downstream_total,
  'owner_retained_in_club_bank',owner_retained,'paid_to','agent_wallet',
  'shortfalls',0,'sources',source_count,'detail','[]'::jsonb);
 result:=result||jsonb_build_object('existing_transfer_economic_plan',smarter_private.existing_rakeback_transfer_scope_economic_plan(p_scope_kind,p_scope_id,p_period_start,p_period_end,'commission'),
  'existing_transfer_receipts',smarter_private.existing_rakeback_transfer_scope_receipts(p_scope_kind,p_scope_id,p_period_start,p_period_end,'commission'));
 INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
 VALUES(p_union_id,standalone_club,p_period_start,p_period_end,2,fingerprint,result);
 RETURN result;
END $function$;
CREATE OR REPLACE FUNCTION public.fn_settle_accounting_commission_stage_v3(p_scope_kind text, p_scope_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE foreign_legacy_deferred boolean:=false;prior_plan jsonb;prior_node record;prior_saved_context text;scope record;p_union_id uuid;standalone_club uuid;
 v_source record;v_edge record;previous public.accounting_routed_settlement_runs%ROWTYPE;
 fingerprint text;result jsonb;run_key text;own_total numeric;direct_total numeric;downstream_total numeric;
 source_count int;node_count int;finished int:=0;step int:=0;progress int;ledger_id uuid;receipt_count int;
 payer_before numeric;payee_before numeric;payer_after numeric;payee_after numeric;club_skip text;member_skip text;routing_context text;agent_skip text;owner_retained numeric:=0;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_period_start IS NULL OR p_period_end IS NULL OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR p_period_start>=p_period_end OR p_period_end>now()-interval '5 minutes' THEN RAISE EXCEPTION 'routed_commission_invalid_period' USING ERRCODE='22023'; END IF;
 SELECT * INTO scope FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_period_start,p_period_end);
 p_union_id:=scope.union_id;standalone_club:=scope.standalone_club_id;
 IF EXISTS(SELECT 1 FROM public.settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active) THEN RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 IF EXISTS(SELECT 1 FROM public.union_settlement_floor WHERE union_id=p_union_id AND p_period_start<earliest_period_start)
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND p_period_start>=starts_at)
 THEN RAISE EXCEPTION 'routed_commission_historical_period_uncertified' USING ERRCODE='55000'; END IF;
 IF p_period_start IS DISTINCT FROM public.fn_union_week_start(p_period_start)
  OR p_period_end IS DISTINCT FROM public.fn_union_week_start(p_period_start+interval '8 days')
 THEN RAISE EXCEPTION 'routed_commission_requires_one_accounting_week' USING ERRCODE='22023'; END IF;
 run_key:='round2:v3:'||scope.scope_key||':'||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text;
 CREATE TEMP TABLE IF NOT EXISTS _routed_sources(source_type text,source_id uuid,club_id uuid,contract jsonb,earned_at timestamptz,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_sources;
 PERFORM public.fn_lock_rakeback_payer_clubs(scope.club_ids);
 INSERT INTO pg_temp._routed_sources SELECT source_type,source_id,club_id,contract,earned_at FROM public.accounting_payable_earning_sources
  WHERE (coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND coordinator_union_id IS NULL AND club_id=standalone_club)) AND earned_at>=p_period_start AND earned_at<p_period_end;
 SELECT count(*),md5(COALESCE(string_agg(md5((CASE WHEN source_type='cash_rake_accrual' THEN jsonb_build_array(source_id,club_id,earned_at,contract) ELSE jsonb_build_array(source_type,source_id,club_id,earned_at,contract) END)::text),'' ORDER BY source_type,source_id),''))
 INTO source_count,fingerprint FROM pg_temp._routed_sources;
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=2;
 IF FOUND THEN
  IF previous.source_fingerprint<>fingerprint THEN RAISE EXCEPTION 'routed_commission_source_changed_after_payment' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT FROM smarter_private.existing_rakeback_transfer_allocations a JOIN public.chip_ledger l ON l.id=a.reimbursement_ledger_id
   WHERE a.obligation_role='commission'AND a.period_start=p_period_start AND a.period_end=p_period_end AND l.metadata->>'accounting_scope_kind'=p_scope_kind AND l.metadata->>'accounting_scope_id'=p_scope_id::text
   AND NOT smarter_private.existing_rakeback_transfer_complete('commission',a.obligation_id))THEN RAISE EXCEPTION 'existing_transfer_discharge_receipt_incomplete' USING ERRCODE='23514';END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commission_settlements cs WHERE cs.period_start<p_period_end AND cs.period_end>p_period_start
   AND (cs.union_id=p_union_id OR cs.club_id=ANY(scope.club_ids)))
  OR EXISTS(SELECT 1 FROM public.union_settlement_rounds r WHERE r.union_id=p_union_id AND r.round_no=2
    AND r.period_start<p_period_end AND r.period_end>p_period_start AND (r.amount>0 OR r.payees>0 OR r.shortfalls>0))
 THEN
   IF p_scope_kind='club'AND source_count=0 THEN foreign_legacy_deferred:=true;
   ELSE RAISE EXCEPTION 'legacy_commission_payment_requires_reconciliation' USING ERRCODE='55000';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commissions ac WHERE ac.created_at>=p_period_start AND ac.created_at<p_period_end
  AND (ac.club_id=ANY(scope.club_ids))
  AND (ac.source_type IS NULL OR ac.source_type NOT IN('cash_rake_accrual','tournament_fee_accrual') OR ac.settled_at IS NOT NULL OR NOT EXISTS(
   SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE rs.source_type=ac.source_type AND rs.source_id=ac.source_id AND rs.club_id=ac.club_id AND rs.earned_at=ac.created_at)))
 THEN RAISE EXCEPTION 'unclassified_commission_source_requires_reconciliation' USING ERRCODE='55000'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_tiers(source_type text,source_id uuid,club_id uuid,depth int,agent_id uuid,user_id uuid,role text,
  parent_agent_id uuid,own_amount numeric,rate numeric,PRIMARY KEY(source_type,source_id,depth)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_tiers;
 FOR v_source IN SELECT * FROM pg_temp._routed_sources ORDER BY source_type,source_id LOOP
  IF jsonb_typeof(v_source.contract->'tiers') IS DISTINCT FROM 'array' OR v_source.contract->>'club_id' IS DISTINCT FROM v_source.club_id::text
  THEN RAISE EXCEPTION 'routed_commission_contract_invalid' USING ERRCODE='23514'; END IF;
  INSERT INTO pg_temp._routed_tiers SELECT v_source.source_type,v_source.source_id,v_source.club_id,ord::int,(j->>'agent_id')::uuid,(j->>'user_id')::uuid,j->>'role',
   NULLIF(j->'agreement'->'terms'->>'parent_agent_id','')::uuid,(j->>'amount')::numeric,(j->>'rate')::numeric
   FROM jsonb_array_elements(v_source.contract->'tiers') WITH ORDINALITY x(j,ord);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.agent_id IS NULL OR t.user_id IS NULL OR t.role IS NULL OR t.role NOT IN('super_agent','agent','sub_agent')
   OR t.own_amount IS NULL OR t.own_amount<0 OR t.own_amount<>round(t.own_amount,2) OR t.own_amount::text IN('NaN','Infinity','-Infinity')
   OR t.rate IS NULL OR t.rate<0 OR t.rate>1 OR t.rate::text IN('NaN','Infinity','-Infinity')
   OR t.parent_agent_id IS DISTINCT FROM(SELECT u.agent_id FROM pg_temp._routed_tiers u WHERE u.source_type=t.source_type AND u.source_id=t.source_id AND u.depth=t.depth+1))
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY source_type,source_id,user_id HAVING count(*)<>1)
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY club_id,user_id HAVING count(DISTINCT agent_id)<>1)
 THEN RAISE EXCEPTION 'routed_commission_hierarchy_ambiguous' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE (t.own_amount>0 AND (SELECT count(*) FROM public.agent_commissions ac
   WHERE ac.source_type=t.source_type AND ac.source_id=t.source_id AND ac.club_id=t.club_id AND ac.user_id=t.user_id
    AND ac.amount=t.own_amount AND ac.commission_rate=t.rate AND ac.settled_at IS NULL)=0)
   OR (SELECT count(*) FROM public.agent_commissions ac WHERE ac.source_type=t.source_type AND ac.source_id=t.source_id AND ac.user_id=t.user_id)<>CASE WHEN t.own_amount>0 THEN 1 ELSE 0 END)
  OR EXISTS(SELECT 1 FROM public.agent_commissions ac JOIN pg_temp._routed_sources s ON s.source_type=ac.source_type AND s.source_id=ac.source_id
   WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.source_type=s.source_type AND t.source_id=s.source_id AND t.user_id=ac.user_id AND t.own_amount=ac.amount))
 THEN RAISE EXCEPTION 'routed_commission_entitlement_disagrees_with_source' USING ERRCODE='23514'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_nodes(club_id uuid,user_id uuid,agent_id uuid,role text,own_amount numeric,rows_count int,
  opening_balance numeric,sort_order int,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_nodes;
 INSERT INTO pg_temp._routed_nodes(club_id,user_id,agent_id,role,own_amount,rows_count)
  SELECT club_id,user_id,min(agent_id::text)::uuid,min(role),sum(own_amount),count(*) FILTER(WHERE own_amount>0)
  FROM pg_temp._routed_tiers GROUP BY club_id,user_id;
 CREATE TEMP TABLE IF NOT EXISTS _routed_edges(club_id uuid,payer_user uuid,payee_user uuid,amount numeric,role text,sort_order int) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_edges;
 INSERT INTO pg_temp._routed_edges(club_id,payer_user,payee_user,amount,role)
 SELECT t.club_id,parent.user_id,t.user_id,sum((SELECT sum(child.own_amount) FROM pg_temp._routed_tiers child WHERE child.source_type=t.source_type AND child.source_id=t.source_id AND child.depth<=t.depth)),min(t.role)
 FROM pg_temp._routed_tiers t LEFT JOIN pg_temp._routed_tiers parent ON parent.source_type=t.source_type AND parent.source_id=t.source_id AND parent.depth=t.depth+1
 GROUP BY t.club_id,parent.user_id,t.user_id
 HAVING sum((SELECT sum(child.own_amount) FROM pg_temp._routed_tiers child WHERE child.source_type=t.source_type AND child.source_id=t.source_id AND child.depth<=t.depth))>0;
 SELECT count(*) INTO node_count FROM pg_temp._routed_nodes;
 WHILE finished<node_count LOOP
  step:=step+1;
  UPDATE pg_temp._routed_nodes n SET sort_order=step WHERE sort_order IS NULL AND NOT EXISTS(
   SELECT 1 FROM pg_temp._routed_edges e JOIN pg_temp._routed_nodes p ON p.club_id=e.club_id AND p.user_id=e.payer_user
   WHERE e.club_id=n.club_id AND e.payee_user=n.user_id AND p.sort_order IS NULL);
  GET DIAGNOSTICS progress=ROW_COUNT;
  IF progress=0 THEN RAISE EXCEPTION 'routed_commission_weekly_hierarchy_cycle' USING ERRCODE='23514'; END IF;
  finished:=finished+progress;
 END LOOP;
 UPDATE pg_temp._routed_edges e SET sort_order=n.sort_order FROM pg_temp._routed_nodes n WHERE n.club_id=e.club_id AND n.user_id=e.payee_user;
 SELECT COALESCE(sum(own_amount),0) INTO own_total FROM pg_temp._routed_nodes;
 SELECT COALESCE(sum(amount) FILTER(WHERE payer_user IS NULL),0),COALESCE(sum(amount) FILTER(WHERE payer_user IS NOT NULL),0)
 INTO direct_total,downstream_total FROM pg_temp._routed_edges;
 IF direct_total<>own_total OR EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE n.own_amount IS DISTINCT FROM
   COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payee_user=n.user_id),0)
   -COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payer_user=n.user_id),0))
 THEN RAISE EXCEPTION 'routed_commission_plan_does_not_conserve' USING ERRCODE='23514'; END IF;
 -- COMMISSION LANDS IN AGENT WALLETS; THE OWNER'S SHARE STAYS IN THE CLUB BANK
 -- (20261022, Dan). The club owner (clubs.owner_id) is never paid commission
 -- into any personal wallet: the owner's own tier is not moved out of
 -- clubs.chip_treasury at all, and what the recorded hierarchy passes down
 -- through the owner is paid to the child agent straight from the club bank.
 -- Every other payee is credited in agents.agent_wallet_balance, never in
 -- club_members.chip_balance.
 CREATE TEMP TABLE IF NOT EXISTS _routed_owner_nodes(club_id uuid,user_id uuid,own_amount numeric,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_owner_nodes;
 INSERT INTO pg_temp._routed_owner_nodes SELECT n.club_id,n.user_id,n.own_amount FROM pg_temp._routed_nodes n JOIN public.clubs c ON c.id=n.club_id AND c.owner_id=n.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_edges e JOIN pg_temp._routed_owner_nodes o ON o.club_id=e.club_id AND o.user_id=e.payee_user WHERE e.payer_user IS NOT NULL)
 THEN RAISE EXCEPTION 'routed_commission_owner_below_agent' USING ERRCODE='23514'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_edges_paid(club_id uuid,payer_user uuid,payee_user uuid,amount numeric,role text,sort_order int) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_edges_paid;
 INSERT INTO pg_temp._routed_edges_paid(club_id,payer_user,payee_user,amount,role,sort_order)
 SELECT e.club_id,CASE WHEN o.user_id IS NULL THEN e.payer_user END,e.payee_user,sum(e.amount),min(e.role),min(e.sort_order)
  FROM pg_temp._routed_edges e LEFT JOIN pg_temp._routed_owner_nodes o ON o.club_id=e.club_id AND o.user_id=e.payer_user
  WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes p WHERE p.club_id=e.club_id AND p.user_id=e.payee_user)
  GROUP BY e.club_id,CASE WHEN o.user_id IS NULL THEN e.payer_user END,e.payee_user;
 TRUNCATE pg_temp._routed_edges;
 INSERT INTO pg_temp._routed_edges(club_id,payer_user,payee_user,amount,role,sort_order)
  SELECT club_id,payer_user,payee_user,amount,role,sort_order FROM pg_temp._routed_edges_paid;
 SELECT COALESCE(sum(own_amount),0) INTO owner_retained FROM pg_temp._routed_owner_nodes;
 SELECT COALESCE(sum(amount) FILTER(WHERE payer_user IS NULL),0),COALESCE(sum(amount) FILTER(WHERE payer_user IS NOT NULL),0)
 INTO direct_total,downstream_total FROM pg_temp._routed_edges;
 IF direct_total+owner_retained<>own_total OR EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE
   (CASE WHEN EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) THEN 0 ELSE n.own_amount END) IS DISTINCT FROM
   COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payee_user=n.user_id),0)
   -COALESCE((SELECT sum(amount) FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payer_user=n.user_id),0))
 THEN RAISE EXCEPTION 'routed_commission_owner_plan_does_not_conserve' USING ERRCODE='23514'; END IF;
 -- Only a fully proved empty original plan may reconcile canonical foreign
 -- paid rows. The private validator writes no public state or receipt.
 IF foreign_legacy_deferred THEN
  IF p_scope_kind IS DISTINCT FROM 'club'OR source_count IS DISTINCT FROM 0 OR fingerprint IS DISTINCT FROM md5('')
   OR node_count IS DISTINCT FROM 0 OR own_total IS DISTINCT FROM 0 OR direct_total IS DISTINCT FROM 0 OR downstream_total IS DISTINCT FROM 0 OR owner_retained IS DISTINCT FROM 0
  THEN RAISE EXCEPTION 'zero_standalone_full_original_empty_plan_required' USING ERRCODE='23514';END IF;
  CREATE TEMP TABLE IF NOT EXISTS _routed_zero_standalone_context(scope_kind text,scope_id uuid,period_start timestamptz,period_end timestamptz,source_count int,fingerprint text)ON COMMIT DROP;
  TRUNCATE pg_temp._routed_zero_standalone_context;
  INSERT INTO pg_temp._routed_zero_standalone_context VALUES(p_scope_kind,p_scope_id,p_period_start,p_period_end,source_count,fingerprint);
  PERFORM smarter_private.zero_standalone_foreign_commissions_proven(p_scope_id,p_period_start,p_period_end);
  TRUNCATE pg_temp._routed_zero_standalone_context;
 END IF;
 -- Original tiers, entitlement rows, complete hierarchy and full gross
 -- conservation have already been proved. Remove only the subject's own
 -- discharged share, preserving every descendant's genuine pass-through.
 CREATE TEMP TABLE IF NOT EXISTS _routed_prior_discharge_context(stage_round int,period_start timestamptz,period_end timestamptz,club_ids uuid[],source_fingerprint text)ON COMMIT DROP;
 TRUNCATE pg_temp._routed_prior_discharge_context;
 INSERT INTO pg_temp._routed_prior_discharge_context VALUES(2,p_period_start,p_period_end,scope.club_ids,fingerprint);
 prior_saved_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 FOR prior_node IN SELECT n.* FROM pg_temp._routed_nodes n JOIN smarter_private.existing_rakeback_transfer_instructions q
  ON q.club_id=n.club_id AND q.beneficiary_id=n.user_id AND q.period_start=p_period_start AND q.period_end=p_period_end
  WHERE 'commission'=ANY(q.roles)AND n.own_amount>0 ORDER BY n.club_id,n.user_id LOOP
  prior_plan:=smarter_private.apply_existing_rakeback_transfer(p_scope_kind,p_scope_id,p_period_start,p_period_end,'commission',prior_node.club_id,prior_node.user_id);
  IF prior_plan IS NULL THEN RAISE EXCEPTION 'existing_transfer_expected_commission_instruction_required';END IF;
  UPDATE pg_temp._routed_edges SET amount=amount-(prior_plan->>'amount')::numeric WHERE club_id=prior_node.club_id AND payee_user=prior_node.user_id AND payer_user IS NULL;
  IF NOT FOUND OR EXISTS(SELECT FROM pg_temp._routed_edges WHERE amount<0)THEN RAISE EXCEPTION 'existing_transfer_commission_edge_not_conserved';END IF;
 END LOOP;
 DELETE FROM pg_temp._routed_edges WHERE amount=0;
 PERFORM set_config('app.accounting_routing_context',COALESCE(prior_saved_context,''),true);
 IF EXISTS(SELECT FROM pg_temp._routed_nodes n WHERE NOT EXISTS(SELECT FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id)
  AND n.own_amount-COALESCE((SELECT sum(a.amount)FROM smarter_private.existing_rakeback_transfer_allocations a WHERE a.obligation_role='commission'AND a.club_id=n.club_id AND a.beneficiary_id=n.user_id AND a.period_start=p_period_start AND a.period_end=p_period_end),0)
  IS DISTINCT FROM COALESCE((SELECT sum(e.amount)FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payee_user=n.user_id),0)-COALESCE((SELECT sum(e.amount)FROM pg_temp._routed_edges e WHERE e.club_id=n.club_id AND e.payer_user=n.user_id),0))
 THEN RAISE EXCEPTION 'existing_transfer_commission_adjusted_plan_not_conserved';END IF;
 -- All accounts are pinned before the first transfer. Current rates and parents
 -- never choose the route. A retired agent keeps the earned entitlement; the
 -- existing agent wallet (agents row) and immutable source contract remain mandatory.
 PERFORM c.id FROM public.clubs c WHERE c.id IN(SELECT club_id FROM pg_temp._routed_sources) ORDER BY c.id FOR NO KEY UPDATE;
 PERFORM a.id FROM public.agents a JOIN pg_temp._routed_nodes n ON n.club_id=a.club_id AND n.user_id=a.user_id
  WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) ORDER BY a.club_id,a.user_id FOR NO KEY UPDATE OF a;
 UPDATE pg_temp._routed_nodes n SET opening_balance=a.agent_wallet_balance FROM public.agents a WHERE a.club_id=n.club_id AND a.user_id=n.user_id
  AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) AND (n.opening_balance IS NULL OR n.opening_balance<0
  OR n.opening_balance::text IN('NaN','Infinity','-Infinity') OR n.opening_balance<>round(n.opening_balance,2)))
 THEN RAISE EXCEPTION 'routed_commission_wallet_identity_or_balance_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(amount) owed FROM pg_temp._routed_edges WHERE payer_user IS NULL GROUP BY club_id) e
  LEFT JOIN public.clubs c ON c.id=e.club_id WHERE c.chip_treasury IS NULL OR c.chip_treasury<e.owed
   OR c.chip_treasury::text IN('NaN','Infinity','-Infinity') OR c.chip_treasury<>round(c.chip_treasury,2))
 THEN RAISE EXCEPTION 'routed_commission_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);agent_skip:=current_setting('app.ledger_autoskip_agents',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);PERFORM set_config('app.ledger_autoskip_agents','1',true);
 FOR v_edge IN SELECT * FROM pg_temp._routed_edges ORDER BY sort_order,club_id,payer_user NULLS FIRST,payee_user LOOP
  SELECT agent_wallet_balance INTO payee_before FROM public.agents WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user;
  IF v_edge.payer_user IS NULL THEN
   SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=v_edge.club_id;
   UPDATE public.clubs SET chip_treasury=chip_treasury-v_edge.amount WHERE id=v_edge.club_id AND chip_treasury>=v_edge.amount RETURNING chip_treasury INTO payer_after;
  ELSE
   SELECT agent_wallet_balance INTO payer_before FROM public.agents WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user;
   UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance-v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user AND agent_wallet_balance>=v_edge.amount RETURNING agent_wallet_balance INTO payer_after;
  END IF;
  UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance+v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user RETURNING agent_wallet_balance INTO payee_after;
  IF payer_after IS NULL OR payee_after IS NULL OR payer_before-payer_after<>v_edge.amount OR payee_after-payee_before<>v_edge.amount
  THEN RAISE EXCEPTION 'routed_commission_transfer_not_conserved' USING ERRCODE='23514'; END IF;
  -- Agent wallets are journalled by the chip_ledger leg and its receipt below,
  -- exactly as every other agent-wallet door; no player-wallet transaction.
  INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
   VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN v_edge.payer_user IS NULL THEN 'club_treasury' ELSE 'agent_wallet' END,
    COALESCE(v_edge.payer_user,v_edge.club_id),'agent_wallet',v_edge.payee_user,v_edge.amount,'commission',v_edge.club_id,p_union_id,
    'Weekly commission through recorded earning hierarchy',run_key||':'||v_edge.club_id::text||':'||COALESCE(v_edge.payer_user::text,'club')||':'||v_edge.payee_user::text,
    jsonb_build_object('routing_version',3,'accounting_scope_kind',p_scope_kind,'accounting_scope_id',p_scope_id,'period_start',p_period_start,'period_end',p_period_end,'payee_role_at_transfer',v_edge.role,
      'own_commission',(SELECT n.own_amount-COALESCE((SELECT sum(a.amount)FROM smarter_private.existing_rakeback_transfer_allocations a WHERE a.obligation_role='commission'AND a.club_id=n.club_id AND a.beneficiary_id=n.user_id AND a.period_start=p_period_start AND a.period_end=p_period_end),0)FROM pg_temp._routed_nodes n WHERE n.club_id=v_edge.club_id AND n.user_id=v_edge.payee_user),
      'pass_through',v_edge.payer_user IS NOT NULL,'paid_to','agent_wallet'),payer_before,payer_after,payee_before,payee_after) RETURNING id INTO ledger_id;
  SELECT count(*) INTO receipt_count FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
   AND i.chips_transferred AND i.message_sent AND i.net_amount=v_edge.amount AND i.gross_amount=v_edge.amount AND i.deductions=0;
  IF receipt_count<>1 THEN RAISE EXCEPTION 'routed_commission_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);PERFORM set_config('app.ledger_autoskip_agents',COALESCE(agent_skip,''),true);
 PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n LEFT JOIN public.agents a ON a.club_id=n.club_id AND a.user_id=n.user_id
   WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_owner_nodes o WHERE o.club_id=n.club_id AND o.user_id=n.user_id) AND a.agent_wallet_balance IS DISTINCT FROM n.opening_balance+n.own_amount-COALESCE((SELECT sum(a.amount)FROM smarter_private.existing_rakeback_transfer_allocations a WHERE a.obligation_role='commission'AND a.club_id=n.club_id AND a.beneficiary_id=n.user_id AND a.period_start=p_period_start AND a.period_end=p_period_end),0))
 THEN RAISE EXCEPTION 'routed_commission_retained_balance_incorrect' USING ERRCODE='23514'; END IF;
 INSERT INTO public.agent_commission_settlements(club_id,user_id,union_id,period_start,period_end,amount,rows_count,paid_at,settlement_ref)
  SELECT club_id,user_id,p_union_id,p_period_start,p_period_end,own_amount,rows_count,now(),run_key FROM pg_temp._routed_nodes;
 IF node_count>0 THEN PERFORM public.fn_agent_commission_rollup_recompute(
  (SELECT jsonb_agg(jsonb_build_object('club_id',club_id,'user_id',user_id)) FROM pg_temp._routed_nodes)); END IF;
 result:=jsonb_build_object('success',true,'round',2,'name','recorded_commission_hierarchy','routing_version',3,'source_version',2,'source_contract_version',3,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
  'payees',node_count-(SELECT count(*)::int FROM pg_temp._routed_owner_nodes),'amount',direct_total,'own_commission_amount',own_total,'downstream_amount',downstream_total,
  'owner_retained_in_club_bank',owner_retained,'paid_to','agent_wallet',
  'shortfalls',0,'sources',source_count,'detail','[]'::jsonb);
 result:=result||jsonb_build_object('existing_transfer_economic_plan',smarter_private.existing_rakeback_transfer_scope_economic_plan(p_scope_kind,p_scope_id,p_period_start,p_period_end,'commission'),
  'existing_transfer_receipts',smarter_private.existing_rakeback_transfer_scope_receipts(p_scope_kind,p_scope_id,p_period_start,p_period_end,'commission'));
 INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
 VALUES(p_union_id,standalone_club,p_period_start,p_period_end,2,fingerprint,result);
 RETURN result;
END $function$;
REVOKE ALL ON FUNCTION public.fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone) TO service_role;
DO $postimage$ BEGIN
 IF md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz)'::regprocedure))IS DISTINCT FROM '46cc46eac314417706523cc9bd273405'THEN RAISE EXCEPTION 'zero_standalone_original_owner_postimage_changed: public.fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz)';END IF;
 IF md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamptz,timestamptz)'::regprocedure))IS DISTINCT FROM 'efff450311e1c001d8873b29e080e551'THEN RAISE EXCEPTION 'zero_standalone_original_owner_postimage_changed: public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamptz,timestamptz)';END IF;
 IF md5(pg_get_functiondef('smarter_private.zero_standalone_foreign_commissions_proven(uuid,timestamptz,timestamptz)'::regprocedure))IS DISTINCT FROM '69099f3bac93cb29fad83cb82cb1fe4a'THEN RAISE EXCEPTION 'zero_standalone_original_owner_postimage_changed: smarter_private.zero_standalone_foreign_commissions_proven(uuid,timestamptz,timestamptz)';END IF;
 IF has_function_privilege('service_role','smarter_private.zero_standalone_foreign_commissions_proven(uuid,timestamptz,timestamptz)','EXECUTE')OR has_function_privilege('authenticated','smarter_private.zero_standalone_foreign_commissions_proven(uuid,timestamptz,timestamptz)','EXECUTE')OR has_function_privilege('anon','smarter_private.zero_standalone_foreign_commissions_proven(uuid,timestamptz,timestamptz)','EXECUTE')THEN RAISE EXCEPTION 'zero_standalone_private_validator_exposed';END IF;
END $postimage$;
COMMIT;
