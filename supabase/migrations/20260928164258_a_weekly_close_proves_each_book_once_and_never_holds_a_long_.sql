-- A WEEKLY CLOSE PROVES EACH BOOK ONCE AND NEVER HOLDS A LONG TRANSACTION (2026-09-28).
--
-- WHAT WAS SLOW (measured read-only on production 2026-09-28, week 2026-09-21)
-- Deep Stack Society's exact-scope close ran 47 minutes in one transaction and
-- was cancelled. Its sources: 599k (544k cash, 55k tournament) with 1.44M tiers,
-- 197,135 private cash deposits, ~382 player periods. Page reads from disk cost
-- about 17 ms each on this instance, so every per-row lookup is the cost:
--  * statement (fn_club_weekly_accounting_summary): the private-deposit loop
--    asked the sources twice per deposit; the second query's CASE key sent
--    PL/pgSQL to a generic plan that walks the club's whole source history:
--    233 ms per deposit measured, 197,135 deposits = about 13 hours. Its
--    transfer read was a parallel scan of all 3 GB of chip_ledger.
--  * round 2 (fn_settle_accounting_commission_stage): two agent_commissions
--    index probes per tier (1.44M tiers, 0.83 ms per tier measured, ~20 min),
--    a per-row source probe for every commission row of the week (~3 min), a
--    600k-iteration PL/pgSQL tier loop and a 660 MB temp copy of contracts.
--  * round 3 (fn_settle_accounting_rakeback_stage): one view probe per
--    certificate allocation (~600k; 2.5 ms cold, 0.3 ms warm per allocation).
--  * a union close proves fn_accounting_union_earned_plan up to nine times in
--    one transaction (its agreement pass alone exceeds 45 s warm at Midway).
--  * fn_assert_cash_commission_period called the ghost-twin function for every
--    linked week record.
--
-- WHAT CHANGES (same ledger rows, invoices, receipts, results and refusals)
--  * Each of those proofs is read as sets; every original test is evaluated
--    unchanged on the same rows. Round 2 and round 3 keep their original
--    bodies (round 2 as fn_settle_accounting_commission_stage_v3, round 3 as
--    its unchanged loop) and hand any refusal, or anything the set path cannot
--    read, to them, so an invalid book fails exactly as it always failed.
--  * The statement lists its private bank ledger ids in deposit order (type,
--    banked time, key); the original order was whatever its loop's plan read.
--  * Inside a union close the earned plan is proved once per transaction.
--  * STEP 1: a small partial index of the rakeback/commission legs of
--    chip_ledger for the statement's two ledger reads.
--  * Safety: every close attempt carries a deadline (default 8 minutes,
--    app.weekly_accounting_scope_budget); between stages a close past it ends
--    cleanly (weekly_scope_time_budget_exhausted), its run row failed, nothing
--    posted. The cron close runs at most one close attempt per tick with a
--    20-minute statement budget, so one transaction never holds two books.
--
-- Measurements and the apply procedure: the pull request of fix/weekly-close-scale.
-- Native qualification: scripts/dev/test-weekly-close-scale.sh.

-- ============================================================================
-- STEP 1 - OUTSIDE ANY TRANSACTION
-- ============================================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS chip_ledger_accounting_payout_legs
  ON public.chip_ledger (club_id, created_at) WHERE category IN ('rakeback','commission');

-- ============================================================================
-- STEP 2 - ONE TRANSACTION
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $pre$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid
    WHERE c.relname='chip_ledger_accounting_payout_legs' AND c.relnamespace='public'::regnamespace AND i.indisvalid AND i.indisready) THEN
    RAISE EXCEPTION 'STEP 1 index chip_ledger_accounting_payout_legs missing or INVALID: DROP INDEX CONCURRENTLY IF EXISTS it and re-run STEP 1' USING ERRCODE='55000';
  END IF;
  IF md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '58b9c7c7241fa7ef596a7b1da3b9264b' THEN RAISE EXCEPTION 'preimage mismatch: fn_settle_accounting_commission_stage' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM 'f47ac7383ea3bfaf384642a6ba4fb885' THEN RAISE EXCEPTION 'preimage mismatch: fn_settle_accounting_rakeback_stage' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_club_weekly_accounting_summary(uuid)'::regprocedure)) IS DISTINCT FROM '15dad1cd6be1f299e684068e4655bd3a' THEN RAISE EXCEPTION 'preimage mismatch: fn_club_weekly_accounting_summary' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_assert_cash_commission_period(uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '1c3c3889e97e6dd500afbace341ba0c8' THEN RAISE EXCEPTION 'preimage mismatch: fn_assert_cash_commission_period' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_accounting_union_earned_plan(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM 'c4e909aebc4228ff1d93695ed92f0368' THEN RAISE EXCEPTION 'preimage mismatch: fn_accounting_union_earned_plan' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure)) IS DISTINCT FROM 'fe62d1a4a7ecb63873b826426be031ff' THEN RAISE EXCEPTION 'preimage mismatch: fn_process_weekly_accounting_scope' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_settlement_cascade(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '5d0eb7a8188042a1a4c23aaa90656bfd' THEN RAISE EXCEPTION 'preimage mismatch: fn_union_settlement_cascade' USING ERRCODE='55000'; END IF;
  IF to_regprocedure('public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone)') IS NOT NULL
   OR to_regprocedure('public.fn_accounting_union_earned_plan_v3(uuid,timestamp with time zone,timestamp with time zone)') IS NOT NULL
   OR to_regprocedure('public.fn_weekly_accounting_deadline_check()') IS NOT NULL THEN
    RAISE EXCEPTION 'weekly close scale objects already present' USING ERRCODE='55000';
  END IF;
END $pre$;

COMMENT ON INDEX public.chip_ledger_accounting_payout_legs IS
 'The rakeback and commission legs of a club, for the weekly statement (fn_club_weekly_accounting_summary) instead of a scan of all of chip_ledger. Do not drop it.';

-- The original round 2, byte-for-byte under a new name: the answer to every
-- book the set path refuses or cannot read.
CREATE OR REPLACE FUNCTION public.fn_settle_accounting_commission_stage_v3(p_scope_kind text, p_scope_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE scope record;p_union_id uuid;standalone_club uuid;
 v_source record;v_edge record;previous public.accounting_routed_settlement_runs%ROWTYPE;
 fingerprint text;result jsonb;run_key text;own_total numeric;direct_total numeric;downstream_total numeric;
 source_count int;node_count int;finished int:=0;step int:=0;progress int;ledger_id uuid;receipt_count int;
 payer_before numeric;payee_before numeric;payer_after numeric;payee_after numeric;club_skip text;member_skip text;routing_context text;
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
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commission_settlements cs WHERE cs.period_start<p_period_end AND cs.period_end>p_period_start
   AND (cs.union_id=p_union_id OR cs.club_id=ANY(scope.club_ids)))
  OR EXISTS(SELECT 1 FROM public.union_settlement_rounds r WHERE r.union_id=p_union_id AND r.round_no=2
    AND r.period_start<p_period_end AND r.period_end>p_period_start AND (r.amount>0 OR r.payees>0 OR r.shortfalls>0))
 THEN RAISE EXCEPTION 'legacy_commission_payment_requires_reconciliation' USING ERRCODE='55000'; END IF;
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
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY club_id,user_id HAVING count(DISTINCT agent_id)<>1 OR count(DISTINCT role)<>1)
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
 -- All accounts are pinned before the first transfer. Current rates and parents
 -- never choose the route. A retired agent keeps the earned entitlement; the
 -- existing club member wallet and immutable source contract remain mandatory.
 PERFORM c.id FROM public.clubs c WHERE c.id IN(SELECT club_id FROM pg_temp._routed_sources) ORDER BY c.id FOR UPDATE;
 PERFORM cm.user_id FROM public.club_members cm JOIN pg_temp._routed_nodes n ON n.club_id=cm.club_id AND n.user_id=cm.user_id ORDER BY cm.club_id,cm.user_id FOR UPDATE OF cm;
 UPDATE pg_temp._routed_nodes n SET opening_balance=cm.chip_balance FROM public.club_members cm WHERE cm.club_id=n.club_id AND cm.user_id=n.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE n.opening_balance IS NULL OR n.opening_balance<0
  OR n.opening_balance::text IN('NaN','Infinity','-Infinity') OR n.opening_balance<>round(n.opening_balance,2))
 THEN RAISE EXCEPTION 'routed_commission_wallet_identity_or_balance_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(amount) owed FROM pg_temp._routed_edges WHERE payer_user IS NULL GROUP BY club_id) e
  LEFT JOIN public.clubs c ON c.id=e.club_id WHERE c.chip_treasury IS NULL OR c.chip_treasury<e.owed
   OR c.chip_treasury::text IN('NaN','Infinity','-Infinity') OR c.chip_treasury<>round(c.chip_treasury,2))
 THEN RAISE EXCEPTION 'routed_commission_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);
 FOR v_edge IN SELECT * FROM pg_temp._routed_edges ORDER BY sort_order,club_id,payer_user NULLS FIRST,payee_user LOOP
  SELECT chip_balance INTO payee_before FROM public.club_members WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user;
  IF v_edge.payer_user IS NULL THEN
   SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=v_edge.club_id;
   UPDATE public.clubs SET chip_treasury=chip_treasury-v_edge.amount WHERE id=v_edge.club_id AND chip_treasury>=v_edge.amount RETURNING chip_treasury INTO payer_after;
  ELSE
   SELECT chip_balance INTO payer_before FROM public.club_members WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user;
   UPDATE public.club_members SET chip_balance=chip_balance-v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user AND chip_balance>=v_edge.amount RETURNING chip_balance INTO payer_after;
  END IF;
  UPDATE public.club_members SET chip_balance=chip_balance+v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user RETURNING chip_balance INTO payee_after;
  IF payer_after IS NULL OR payee_after IS NULL OR payer_before-payer_after<>v_edge.amount OR payee_after-payee_before<>v_edge.amount
  THEN RAISE EXCEPTION 'routed_commission_transfer_not_conserved' USING ERRCODE='23514'; END IF;
  IF v_edge.payer_user IS NOT NULL THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)
   VALUES(v_edge.payer_user,'PLAYER','debit',v_edge.amount,'commission','Recorded weekly commission budget passed to child agent',payer_after); END IF;
  INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)
   VALUES(v_edge.payee_user,'PLAYER','credit',v_edge.amount,'commission','Recorded weekly commission budget received',payee_after);
  INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
   VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN v_edge.payer_user IS NULL THEN 'club_treasury' ELSE 'player_wallet' END,
    COALESCE(v_edge.payer_user,v_edge.club_id),'player_wallet',v_edge.payee_user,v_edge.amount,'commission',v_edge.club_id,p_union_id,
    'Weekly commission through recorded earning hierarchy',run_key||':'||v_edge.club_id::text||':'||COALESCE(v_edge.payer_user::text,'club')||':'||v_edge.payee_user::text,
    jsonb_build_object('routing_version',3,'accounting_scope_kind',p_scope_kind,'accounting_scope_id',p_scope_id,'period_start',p_period_start,'period_end',p_period_end,'payee_role_at_transfer',v_edge.role,
      'own_commission',(SELECT own_amount FROM pg_temp._routed_nodes WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user),
      'pass_through',v_edge.payer_user IS NOT NULL),payer_before,payer_after,payee_before,payee_after) RETURNING id INTO ledger_id;
  SELECT count(*) INTO receipt_count FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
   AND i.chips_transferred AND i.message_sent AND i.net_amount=v_edge.amount AND i.gross_amount=v_edge.amount AND i.deductions=0;
  IF receipt_count<>1 THEN RAISE EXCEPTION 'routed_commission_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);
 PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n JOIN public.club_members cm ON cm.club_id=n.club_id AND cm.user_id=n.user_id
   WHERE cm.chip_balance IS DISTINCT FROM n.opening_balance+n.own_amount)
 THEN RAISE EXCEPTION 'routed_commission_retained_balance_incorrect' USING ERRCODE='23514'; END IF;
 INSERT INTO public.agent_commission_settlements(club_id,user_id,union_id,period_start,period_end,amount,rows_count,paid_at,settlement_ref)
  SELECT club_id,user_id,p_union_id,p_period_start,p_period_end,own_amount,rows_count,now(),run_key FROM pg_temp._routed_nodes;
 IF node_count>0 THEN PERFORM public.fn_agent_commission_rollup_recompute(
  (SELECT jsonb_agg(jsonb_build_object('club_id',club_id,'user_id',user_id)) FROM pg_temp._routed_nodes)); END IF;
 result:=jsonb_build_object('success',true,'round',2,'name','recorded_commission_hierarchy','routing_version',3,'source_version',2,'source_contract_version',3,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
  'payees',node_count,'amount',direct_total,'own_commission_amount',own_total,'downstream_amount',downstream_total,
  'shortfalls',0,'sources',source_count,'detail','[]'::jsonb);
 INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
 VALUES(p_union_id,standalone_club,p_period_start,p_period_end,2,fingerprint,result);
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_settle_accounting_commission_stage(p_scope_kind text, p_scope_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE scope record;p_union_id uuid;standalone_club uuid;
 v_source record;v_edge record;previous public.accounting_routed_settlement_runs%ROWTYPE;
 fingerprint text;result jsonb;run_key text;own_total numeric;direct_total numeric;downstream_total numeric;
 source_count int;node_count int;finished int:=0;step int:=0;progress int;ledger_id uuid;receipt_count int;
 payer_before numeric;payee_before numeric;payer_after numeric;payee_after numeric;club_skip text;member_skip text;routing_context text;v4_ok boolean:=true;
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
 SELECT count(*),md5(COALESCE(string_agg(row_md5,'' ORDER BY source_type,source_id),''))
 INTO source_count,fingerprint FROM pg_temp._routed_sources_v4;
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=2;
 IF FOUND THEN
  IF previous.source_fingerprint<>fingerprint THEN RAISE EXCEPTION 'routed_commission_source_changed_after_payment' USING ERRCODE='55000'; END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commission_settlements cs WHERE cs.period_start<p_period_end AND cs.period_end>p_period_start
   AND (cs.union_id=p_union_id OR cs.club_id=ANY(scope.club_ids)))
  OR EXISTS(SELECT 1 FROM public.union_settlement_rounds r WHERE r.union_id=p_union_id AND r.round_no=2
    AND r.period_start<p_period_end AND r.period_end>p_period_start AND (r.amount>0 OR r.payees>0 OR r.shortfalls>0))
 THEN RAISE EXCEPTION 'legacy_commission_payment_requires_reconciliation' USING ERRCODE='55000'; END IF;
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
  WHERE ac.created_at>=p_period_start AND ac.created_at<p_period_end
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
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY club_id,user_id HAVING count(DISTINCT agent_id)<>1 OR count(DISTINCT role)<>1)
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
 -- All accounts are pinned before the first transfer. Current rates and parents
 -- never choose the route. A retired agent keeps the earned entitlement; the
 -- existing club member wallet and immutable source contract remain mandatory.
 PERFORM c.id FROM public.clubs c WHERE c.id IN(SELECT club_id FROM pg_temp._routed_sources_v4) ORDER BY c.id FOR UPDATE;
 PERFORM cm.user_id FROM public.club_members cm JOIN pg_temp._routed_nodes n ON n.club_id=cm.club_id AND n.user_id=cm.user_id ORDER BY cm.club_id,cm.user_id FOR UPDATE OF cm;
 UPDATE pg_temp._routed_nodes n SET opening_balance=cm.chip_balance FROM public.club_members cm WHERE cm.club_id=n.club_id AND cm.user_id=n.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE n.opening_balance IS NULL OR n.opening_balance<0
  OR n.opening_balance::text IN('NaN','Infinity','-Infinity') OR n.opening_balance<>round(n.opening_balance,2))
 THEN RAISE EXCEPTION 'routed_commission_wallet_identity_or_balance_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(amount) owed FROM pg_temp._routed_edges WHERE payer_user IS NULL GROUP BY club_id) e
  LEFT JOIN public.clubs c ON c.id=e.club_id WHERE c.chip_treasury IS NULL OR c.chip_treasury<e.owed
   OR c.chip_treasury::text IN('NaN','Infinity','-Infinity') OR c.chip_treasury<>round(c.chip_treasury,2))
 THEN RAISE EXCEPTION 'routed_commission_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);
 FOR v_edge IN SELECT * FROM pg_temp._routed_edges ORDER BY sort_order,club_id,payer_user NULLS FIRST,payee_user LOOP
  SELECT chip_balance INTO payee_before FROM public.club_members WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user;
  IF v_edge.payer_user IS NULL THEN
   SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=v_edge.club_id;
   UPDATE public.clubs SET chip_treasury=chip_treasury-v_edge.amount WHERE id=v_edge.club_id AND chip_treasury>=v_edge.amount RETURNING chip_treasury INTO payer_after;
  ELSE
   SELECT chip_balance INTO payer_before FROM public.club_members WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user;
   UPDATE public.club_members SET chip_balance=chip_balance-v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payer_user AND chip_balance>=v_edge.amount RETURNING chip_balance INTO payer_after;
  END IF;
  UPDATE public.club_members SET chip_balance=chip_balance+v_edge.amount,updated_at=now() WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user RETURNING chip_balance INTO payee_after;
  IF payer_after IS NULL OR payee_after IS NULL OR payer_before-payer_after<>v_edge.amount OR payee_after-payee_before<>v_edge.amount
  THEN RAISE EXCEPTION 'routed_commission_transfer_not_conserved' USING ERRCODE='23514'; END IF;
  IF v_edge.payer_user IS NOT NULL THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)
   VALUES(v_edge.payer_user,'PLAYER','debit',v_edge.amount,'commission','Recorded weekly commission budget passed to child agent',payer_after); END IF;
  INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after)
   VALUES(v_edge.payee_user,'PLAYER','credit',v_edge.amount,'commission','Recorded weekly commission budget received',payee_after);
  INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
   VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN v_edge.payer_user IS NULL THEN 'club_treasury' ELSE 'player_wallet' END,
    COALESCE(v_edge.payer_user,v_edge.club_id),'player_wallet',v_edge.payee_user,v_edge.amount,'commission',v_edge.club_id,p_union_id,
    'Weekly commission through recorded earning hierarchy',run_key||':'||v_edge.club_id::text||':'||COALESCE(v_edge.payer_user::text,'club')||':'||v_edge.payee_user::text,
    jsonb_build_object('routing_version',3,'accounting_scope_kind',p_scope_kind,'accounting_scope_id',p_scope_id,'period_start',p_period_start,'period_end',p_period_end,'payee_role_at_transfer',v_edge.role,
      'own_commission',(SELECT own_amount FROM pg_temp._routed_nodes WHERE club_id=v_edge.club_id AND user_id=v_edge.payee_user),
      'pass_through',v_edge.payer_user IS NOT NULL),payer_before,payer_after,payee_before,payee_after) RETURNING id INTO ledger_id;
  SELECT count(*) INTO receipt_count FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
   AND i.chips_transferred AND i.message_sent AND i.net_amount=v_edge.amount AND i.gross_amount=v_edge.amount AND i.deductions=0;
  IF receipt_count<>1 THEN RAISE EXCEPTION 'routed_commission_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);
 PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n JOIN public.club_members cm ON cm.club_id=n.club_id AND cm.user_id=n.user_id
   WHERE cm.chip_balance IS DISTINCT FROM n.opening_balance+n.own_amount)
 THEN RAISE EXCEPTION 'routed_commission_retained_balance_incorrect' USING ERRCODE='23514'; END IF;
 INSERT INTO public.agent_commission_settlements(club_id,user_id,union_id,period_start,period_end,amount,rows_count,paid_at,settlement_ref)
  SELECT club_id,user_id,p_union_id,p_period_start,p_period_end,own_amount,rows_count,now(),run_key FROM pg_temp._routed_nodes;
 IF node_count>0 THEN PERFORM public.fn_agent_commission_rollup_recompute(
  (SELECT jsonb_agg(jsonb_build_object('club_id',club_id,'user_id',user_id)) FROM pg_temp._routed_nodes)); END IF;
 result:=jsonb_build_object('success',true,'round',2,'name','recorded_commission_hierarchy','routing_version',3,'source_version',2,'source_contract_version',3,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
  'payees',node_count,'amount',direct_total,'own_commission_amount',own_total,'downstream_amount',downstream_total,
  'shortfalls',0,'sources',source_count,'detail','[]'::jsonb);
 INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
 VALUES(p_union_id,standalone_club,p_period_start,p_period_end,2,fingerprint,result);
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_settle_accounting_rakeback_stage(p_scope_kind text, p_scope_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE legacy_paid_cash_replay boolean:=false;scope record;p_union_id uuid;standalone_club uuid;
 r record;c public.accounting_rakeback_period_calculations%ROWTYPE;g record;
 previous public.accounting_routed_settlement_runs%ROWTYPE;fingerprint text;result jsonb;
 from_date date;to_date date;allocation_count int;matched_count int;actual_count int;
 generated numeric;unrounded numeric;display_rate numeric;amount numeric;paid numeric:=0;
 payer_before numeric;payer_after numeric;player_before numeric;player_after numeric;
 payout_id uuid;wallet_id uuid;ledger_id uuid;receipt_count int;payees int:=0;
 club_skip text;member_skip text;maintenance text;routing_context text;v4_ok boolean:=false;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_period_start IS NULL OR p_period_end IS NULL OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR p_period_start>=p_period_end OR p_period_end>now()-interval '5 minutes' THEN RAISE EXCEPTION 'routed_rakeback_invalid_period' USING ERRCODE='22023'; END IF;
 SELECT * INTO scope FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_period_start,p_period_end);
 p_union_id:=scope.union_id;standalone_club:=scope.standalone_club_id;
 IF p_union_id IS NOT NULL THEN PERFORM public.fn_accounting_union_earned_plan(p_union_id,p_period_start,p_period_end); END IF;
 IF EXISTS(SELECT 1 FROM public.settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active) THEN RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 IF EXISTS(SELECT 1 FROM public.union_settlement_floor WHERE union_id=p_union_id AND p_period_start<earliest_period_start)
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND p_period_start>=starts_at)
 THEN RAISE EXCEPTION 'routed_rakeback_historical_period_uncertified' USING ERRCODE='55000'; END IF;
 from_date:=(p_period_start AT TIME ZONE 'America/Los_Angeles')::date;
 to_date:=(p_period_end AT TIME ZONE 'America/Los_Angeles')::date-1;
 IF p_period_start IS DISTINCT FROM public.fn_union_week_start(p_period_start)
  OR p_period_end IS DISTINCT FROM public.fn_union_week_start(p_period_start+interval '8 days')
 THEN RAISE EXCEPTION 'routed_rakeback_requires_one_accounting_week' USING ERRCODE='22023'; END IF;
 PERFORM public.fn_lock_rakeback_payer_clubs(scope.club_ids);
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=3;
 -- Only a completed cash-only run can read its original untyped allocation
 -- again. Pending certificates need explicit source types before any payment.
 legacy_paid_cash_replay:=FOUND AND previous.routing_version=3 AND previous.result->>'source_version'='2'
  AND NOT(previous.result ? 'source_contract_version');
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_items(period_id uuid PRIMARY KEY,certificate_id bigint,club_id uuid,user_id uuid,
  payer_kind text,payer_user uuid,owed numeric,rake numeric,rate numeric,fingerprint text,status text) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_items;
 -- WEEKLY CLOSE SCALE (20260928): the per-period proof, read as sets. The
 -- periods are locked in the original order; the latest certificate of each,
 -- every allocation of every certificate and this scope's sources of the week
 -- are each read once, and every original test is evaluated on them. Only a
 -- book that passes every test takes this path. Any refusal, and anything
 -- this path cannot read, runs the original per-period loop below, unchanged,
 -- which raises exactly what it always raised.
 BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _rr3_periods_v4(ord bigint,LIKE public.rakeback_periods) ON COMMIT DROP;
  TRUNCATE pg_temp._rr3_periods_v4;
  INSERT INTO pg_temp._rr3_periods_v4 SELECT row_number() OVER(ORDER BY x.club_id,x.user_id,x.id),x.*
   FROM (SELECT rp.* FROM public.rakeback_periods rp WHERE rp.period_start<=to_date AND rp.period_end>=from_date
  AND (rp.club_id=ANY(scope.club_ids)
    OR EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE rs.club_id=rp.club_id AND rs.player_id=rp.user_id
      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end))
  ORDER BY rp.club_id,rp.user_id,rp.id FOR UPDATE) x;
  CREATE TEMP TABLE IF NOT EXISTS _rr3_certs_v4(period_id uuid PRIMARY KEY,id bigint,accounting_version integer,source_fingerprint text,club_id uuid,player_id uuid,
   coordinator_union_id uuid,period_start date,period_end date,rake_generated numeric,rakeback_amount numeric,display_rate numeric,payer_kind text,payer_user_id uuid) ON COMMIT DROP;
  TRUNCATE pg_temp._rr3_certs_v4;
  INSERT INTO pg_temp._rr3_certs_v4 SELECT DISTINCT ON(x.period_id) x.period_id,x.id,x.accounting_version,x.source_fingerprint,x.club_id,x.player_id,
   x.coordinator_union_id,x.period_start,x.period_end,x.rake_generated,x.rakeback_amount,x.display_rate,x.payer_kind,x.payer_user_id
   FROM public.accounting_rakeback_period_calculations x WHERE x.period_id IN(SELECT id FROM pg_temp._rr3_periods_v4) ORDER BY x.period_id,x.id DESC;
  IF (SELECT count(*) FROM pg_temp._rr3_periods_v4 pr LEFT JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=pr.id
    WHERE COALESCE(pc.id IS NULL OR pc.accounting_version<>2 OR pc.coordinator_union_id IS DISTINCT FROM p_union_id OR pr.period_start<>from_date OR pr.period_end<>to_date
   OR pc.club_id IS DISTINCT FROM pr.club_id OR pc.player_id IS DISTINCT FROM pr.user_id
   OR pc.period_start IS DISTINCT FROM pr.period_start OR pc.period_end IS DISTINCT FROM pr.period_end
   OR pc.rake_generated IS DISTINCT FROM pr.rake_generated OR pc.rake_generated IS DISTINCT FROM pr.total_rake_paid
   OR pc.rakeback_amount IS DISTINCT FROM pr.rakeback_amount OR pc.rakeback_amount IS DISTINCT FROM pr.rakeback_earned
   OR pc.display_rate IS DISTINCT FROM pr.rakeback_rate OR pc.rakeback_amount<0 OR pc.rakeback_amount<>round(pc.rakeback_amount,2)
   OR pc.rakeback_amount::text IN('NaN','Infinity','-Infinity') OR pc.payer_kind NOT IN('agent','club')
   OR (pc.payer_kind='agent') IS DISTINCT FROM(pc.payer_user_id IS NOT NULL) OR pc.payer_user_id=pr.user_id,false))=0 THEN
   CREATE TEMP TABLE IF NOT EXISTS _rr3_week_v4(source_type text,source_id uuid,club_id uuid,player_id uuid,coordinator_union_id uuid,earned_at timestamptz,
    rake_credit numeric,rake_record_id uuid,agent_text text,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
   TRUNCATE pg_temp._rr3_week_v4;
   INSERT INTO pg_temp._rr3_week_v4 SELECT rs.source_type,rs.source_id,rs.club_id,rs.player_id,rs.coordinator_union_id,rs.earned_at,rs.rake_credit,rs.rake_record_id,
    rs.contract->'membership'->'terms'->>'agent_id'
    FROM public.accounting_payable_earning_sources rs WHERE rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
     AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club));
   ANALYZE pg_temp._rr3_week_v4;
   CREATE TEMP TABLE IF NOT EXISTS _rr3_alloc_v4(period_id uuid PRIMARY KEY,allocation_count bigint,matched_count bigint,generated numeric,unrounded numeric,any_bad boolean) ON COMMIT DROP;
   TRUNCATE pg_temp._rr3_alloc_v4;
   -- A source of this allocation that is not in this scope's week slice is
   -- outside the scope or the week, which the original test refuses too.
   INSERT INTO pg_temp._rr3_alloc_v4 SELECT pc.period_id,count(*),
    count(DISTINCT ROW(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END),a->>'source_id')),
    sum((a->>'rake_credit')::numeric),sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric),
    COALESCE(bool_or(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) IS NULL OR COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) NOT IN('cash_rake_accrual','tournament_fee_accrual')
      OR rs.source_id IS NULL OR rs.club_id<>pr.club_id OR rs.player_id<>pr.user_id OR rs.coordinator_union_id IS DISTINCT FROM p_union_id
      OR rs.earned_at<p_period_start OR rs.earned_at>=p_period_end OR rs.rake_credit IS DISTINCT FROM(a->>'rake_credit')::numeric
      OR rs.rake_record_id IS DISTINCT FROM(a->>'rake_record_id')::uuid
      OR (a->>'rate')::numeric IS NULL OR (a->>'rate')::numeric<0 OR (a->>'rate')::numeric>1
      OR (a->>'rate')::numeric::text IN('NaN','Infinity','-Infinity')
      OR a->>'payer_kind' IS DISTINCT FROM pc.payer_kind OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM pc.payer_user_id
      OR NULLIF(rs.agent_text,'')::uuid IS DISTINCT FROM pc.payer_user_id),false)
    FROM pg_temp._rr3_certs_v4 pc JOIN pg_temp._rr3_periods_v4 pr ON pr.id=pc.period_id
    JOIN public.accounting_rakeback_period_calculations cc ON cc.id=pc.id
    CROSS JOIN LATERAL jsonb_array_elements(cc.source_allocations) a
    LEFT JOIN pg_temp._rr3_week_v4 rs ON rs.source_type=COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) AND rs.source_id=(a->>'source_id')::uuid
    GROUP BY pc.period_id;
   IF (SELECT count(*) FROM pg_temp._rr3_periods_v4 pr JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=pr.id
     LEFT JOIN pg_temp._rr3_alloc_v4 ag ON ag.period_id=pr.id
     LEFT JOIN (SELECT w.club_id,w.player_id,count(*) AS n FROM pg_temp._rr3_week_v4 w GROUP BY w.club_id,w.player_id) w ON w.club_id=pr.club_id AND w.player_id=pr.user_id
     WHERE COALESCE((COALESCE(ag.allocation_count,0)=0 OR COALESCE(ag.allocation_count,0)<>COALESCE(ag.matched_count,0) OR COALESCE(ag.allocation_count,0)<>COALESCE(w.n,0)
       OR ag.generated IS DISTINCT FROM pc.rake_generated
       OR round(ag.unrounded,2) IS DISTINCT FROM pc.rakeback_amount
       OR pc.display_rate IS DISTINCT FROM (CASE WHEN ag.generated>0 THEN round(ag.unrounded/ag.generated,4) ELSE 0 END))
      OR COALESCE(ag.any_bad,false),false))=0 THEN
    INSERT INTO pg_temp._routed_player_items SELECT pr.id,pc.id,pr.club_id,pr.user_id,pc.payer_kind,pc.payer_user_id,pc.rakeback_amount,pc.rake_generated,pc.display_rate,pc.source_fingerprint,pr.status
     FROM pg_temp._rr3_periods_v4 pr JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=pr.id;
    v4_ok:=true;
   END IF;
  END IF;
 EXCEPTION WHEN OTHERS THEN v4_ok:=false;
 END;
 IF NOT v4_ok THEN
 TRUNCATE pg_temp._routed_player_items;
 FOR r IN SELECT rp.* FROM public.rakeback_periods rp WHERE rp.period_start<=to_date AND rp.period_end>=from_date
  AND (rp.club_id=ANY(scope.club_ids)
    OR EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE rs.club_id=rp.club_id AND rs.player_id=rp.user_id
      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end))
  ORDER BY rp.club_id,rp.user_id,rp.id FOR UPDATE
 LOOP
  SELECT * INTO c FROM public.accounting_rakeback_period_calculations WHERE period_id=r.id ORDER BY id DESC LIMIT 1;
  IF NOT FOUND OR c.accounting_version<>2 OR c.coordinator_union_id IS DISTINCT FROM p_union_id OR r.period_start<>from_date OR r.period_end<>to_date
   OR c.club_id IS DISTINCT FROM r.club_id OR c.player_id IS DISTINCT FROM r.user_id
   OR c.period_start IS DISTINCT FROM r.period_start OR c.period_end IS DISTINCT FROM r.period_end
   OR c.rake_generated IS DISTINCT FROM r.rake_generated OR c.rake_generated IS DISTINCT FROM r.total_rake_paid
   OR c.rakeback_amount IS DISTINCT FROM r.rakeback_amount OR c.rakeback_amount IS DISTINCT FROM r.rakeback_earned
   OR c.display_rate IS DISTINCT FROM r.rakeback_rate OR c.rakeback_amount<0 OR c.rakeback_amount<>round(c.rakeback_amount,2)
   OR c.rakeback_amount::text IN('NaN','Infinity','-Infinity') OR c.payer_kind NOT IN('agent','club')
   OR (c.payer_kind='agent') IS DISTINCT FROM(c.payer_user_id IS NOT NULL) OR c.payer_user_id=r.user_id
  THEN RAISE EXCEPTION 'routed_rakeback_certificate_required' USING ERRCODE='55000'; END IF;
  SELECT count(*),count(DISTINCT ROW(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END),a->>'source_id')),sum((a->>'rake_credit')::numeric),sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric)
   INTO allocation_count,matched_count,generated,unrounded FROM jsonb_array_elements(c.source_allocations) a;
  SELECT count(*) INTO actual_count FROM public.accounting_payable_earning_sources rs WHERE rs.club_id=r.club_id AND rs.player_id=r.user_id
   AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club));
  IF allocation_count=0 OR allocation_count<>matched_count OR allocation_count<>actual_count OR generated IS DISTINCT FROM c.rake_generated
    OR round(unrounded,2) IS DISTINCT FROM c.rakeback_amount
    OR c.display_rate IS DISTINCT FROM (CASE WHEN generated>0 THEN round(unrounded/generated,4) ELSE 0 END)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(c.source_allocations) a LEFT JOIN public.accounting_payable_earning_sources rs ON rs.source_type=COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) AND rs.source_id=(a->>'source_id')::uuid
     WHERE COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) IS NULL OR COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) NOT IN('cash_rake_accrual','tournament_fee_accrual')
      OR rs.source_id IS NULL OR rs.club_id<>r.club_id OR rs.player_id<>r.user_id OR rs.coordinator_union_id IS DISTINCT FROM p_union_id
      OR rs.earned_at<p_period_start OR rs.earned_at>=p_period_end OR rs.rake_credit IS DISTINCT FROM(a->>'rake_credit')::numeric
      OR rs.rake_record_id IS DISTINCT FROM(a->>'rake_record_id')::uuid
      OR (a->>'rate')::numeric IS NULL OR (a->>'rate')::numeric<0 OR (a->>'rate')::numeric>1
      OR (a->>'rate')::numeric::text IN('NaN','Infinity','-Infinity')
      OR a->>'payer_kind' IS DISTINCT FROM c.payer_kind OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM c.payer_user_id
      OR NULLIF(rs.contract->'membership'->'terms'->>'agent_id','')::uuid IS DISTINCT FROM c.payer_user_id)
  THEN RAISE EXCEPTION 'routed_rakeback_sources_disagree_with_certificate' USING ERRCODE='23514'; END IF;
  INSERT INTO pg_temp._routed_player_items VALUES(r.id,c.id,r.club_id,r.user_id,c.payer_kind,c.payer_user_id,c.rakeback_amount,c.rake_generated,c.display_rate,c.source_fingerprint,r.status);
 END LOOP;
 END IF;
 -- Missing periods are obligations too: every source player in this scope must
 -- have an admitted certificate, including zero-entitlement players.
 IF EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club))
   AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
   AND COALESCE((rs.contract->>'is_union_house')::boolean,false) IS FALSE
   AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id))
 THEN RAISE EXCEPTION 'routed_rakeback_player_period_missing' USING ERRCODE='55000'; END IF;
 SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(i.period_id,i.certificate_id,i.club_id,i.user_id,i.payer_kind,i.payer_user,i.owed,i.rake,i.rate,i.fingerprint) ORDER BY i.period_id),'[]'::jsonb)::text)
  INTO fingerprint FROM pg_temp._routed_player_items i;
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=3;
 IF FOUND THEN
  IF previous.source_fingerprint<>fingerprint OR EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.status<>'paid' OR NOT EXISTS(
   SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id AND pp.user_id=i.user_id AND pp.club_id=i.club_id AND pp.status='paid' AND pp.payout_amount=i.owed))
  THEN RAISE EXCEPTION 'routed_rakeback_changed_after_payment' USING ERRCODE='55000'; END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.status IS DISTINCT FROM 'pending'
   OR EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id))
  OR EXISTS(SELECT 1 FROM public.union_settlement_rounds sr WHERE sr.union_id=p_union_id AND sr.round_no=3
   AND sr.period_start<p_period_end AND sr.period_end>p_period_start AND (sr.amount>0 OR sr.payees>0 OR sr.shortfalls>0))
 THEN RAISE EXCEPTION 'legacy_rakeback_payment_requires_reconciliation' USING ERRCODE='55000'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_wallets(club_id uuid,user_id uuid,opening numeric,delta numeric,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_wallets;
 INSERT INTO pg_temp._routed_player_wallets(club_id,user_id,delta)
 SELECT club_id,user_id,sum(delta) FROM(
  SELECT club_id,user_id,owed AS delta FROM pg_temp._routed_player_items
  UNION ALL SELECT club_id,payer_user,-owed FROM pg_temp._routed_player_items WHERE payer_kind='agent') x GROUP BY club_id,user_id;
 PERFORM id FROM public.clubs WHERE id IN(SELECT club_id FROM pg_temp._routed_player_items) ORDER BY id FOR UPDATE;
 PERFORM cm.user_id FROM public.club_members cm JOIN pg_temp._routed_player_wallets w ON w.club_id=cm.club_id AND w.user_id=cm.user_id
  ORDER BY cm.club_id,cm.user_id FOR UPDATE OF cm;
 UPDATE pg_temp._routed_player_wallets w SET opening=cm.chip_balance FROM public.club_members cm WHERE cm.club_id=w.club_id AND cm.user_id=w.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_wallets WHERE opening IS NULL OR opening<0 OR opening<>round(opening,2) OR opening::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'routed_rakeback_account_missing_or_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,payer_user,sum(owed) owed FROM pg_temp._routed_player_items WHERE payer_kind='agent' GROUP BY club_id,payer_user) x
  JOIN pg_temp._routed_player_wallets w ON w.club_id=x.club_id AND w.user_id=x.payer_user WHERE w.opening<x.owed)
 THEN RAISE EXCEPTION 'routed_rakeback_agent_funding_shortfall' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(owed) owed FROM pg_temp._routed_player_items WHERE payer_kind='club' GROUP BY club_id) x
  LEFT JOIN public.clubs bank ON bank.id=x.club_id WHERE bank.chip_treasury IS NULL OR bank.chip_treasury<x.owed
   OR bank.chip_treasury<>round(bank.chip_treasury,2) OR bank.chip_treasury::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'routed_rakeback_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);
 maintenance:=current_setting('app.ledger_maintenance',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);
 FOR r IN SELECT * FROM pg_temp._routed_player_items ORDER BY club_id,payer_user NULLS FIRST,user_id,period_id LOOP
  amount:=r.owed;
  INSERT INTO public.rakeback_period_payouts(rakeback_period_id,club_id,user_id,user_rake_contribution,rakeback_pct,payout_amount,status,paid_at)
   VALUES(r.period_id,r.club_id,r.user_id,r.rake,round(r.rate*100,2),amount,'paid',now()) RETURNING id INTO payout_id;
  IF amount>0 THEN
   SELECT chip_balance INTO player_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.user_id;
   IF r.payer_kind='club' THEN
    SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=r.club_id;
    UPDATE public.clubs SET chip_treasury=chip_treasury-amount WHERE id=r.club_id AND chip_treasury>=amount RETURNING chip_treasury INTO payer_after;
   ELSE
    SELECT chip_balance INTO payer_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.payer_user;
    UPDATE public.club_members SET chip_balance=chip_balance-amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.payer_user AND chip_balance>=amount RETURNING chip_balance INTO payer_after;
   END IF;
   UPDATE public.club_members SET chip_balance=chip_balance+amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.user_id RETURNING chip_balance INTO player_after;
   IF payer_after IS NULL OR player_after IS NULL OR payer_before-payer_after<>amount OR player_after-player_before<>amount
   THEN RAISE EXCEPTION 'routed_rakeback_transfer_not_conserved' USING ERRCODE='23514'; END IF;
   IF r.payer_kind='agent' THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)
    VALUES(r.payer_user,'PLAYER','debit',amount,'rakeback','Weekly rakeback paid under recorded agreement',payer_after,payout_id); END IF;
   INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)
    VALUES(r.user_id,'PLAYER','credit',amount,'rakeback','Weekly rakeback received under recorded agreement',player_after,payout_id) RETURNING id INTO wallet_id;
   PERFORM set_config('app.ledger_maintenance','rakeback payout evidence pointer',true);
   UPDATE public.rakeback_period_payouts SET wallet_transaction_id=wallet_id WHERE id=payout_id;
   PERFORM set_config('app.ledger_maintenance',COALESCE(maintenance,''),true);
   INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
    VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN r.payer_kind='club' THEN 'club_treasury' ELSE 'player_wallet' END,
     COALESCE(r.payer_user,r.club_id),'player_wallet',r.user_id,amount,'rakeback',r.club_id,p_union_id,'Weekly rakeback from certified historical payer',
     'round3-period:v3:'||r.period_id::text,jsonb_build_object('routing_version',3,'accounting_scope_kind',p_scope_kind,'accounting_scope_id',p_scope_id,'period_id',r.period_id,'period_start',p_period_start,'period_end',p_period_end,
       'certificate_id',r.certificate_id,'source_fingerprint',r.fingerprint,'payout_id',payout_id,'wallet_transaction_id',wallet_id,'payee_role_at_transfer','player'),
      payer_before,payer_after,player_before,player_after) RETURNING id INTO ledger_id;
   SELECT count(*) INTO receipt_count FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
    AND i.chips_transferred AND i.message_sent AND i.net_amount=amount AND i.gross_amount=amount AND i.deductions=0;
   IF receipt_count<>1 THEN RAISE EXCEPTION 'routed_rakeback_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
   paid:=paid+amount;payees:=payees+1;
  END IF;
  UPDATE public.rakeback_periods SET status='paid',paid_at=now() WHERE id=r.period_id;
 END LOOP;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);
 PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_wallets w JOIN public.club_members cm ON cm.club_id=w.club_id AND cm.user_id=w.user_id
   WHERE cm.chip_balance IS DISTINCT FROM w.opening+w.delta)
 THEN RAISE EXCEPTION 'routed_rakeback_final_balance_incorrect' USING ERRCODE='23514'; END IF;
 result:=jsonb_build_object('success',true,'round',3,'name','certified_payer_to_players','routing_version',3,'source_version',2,'source_contract_version',3,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
  'amount',paid,'payees',payees,'shortfalls',0,'periods',(SELECT count(*) FROM pg_temp._routed_player_items),'detail','[]'::jsonb);
 INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
  VALUES(p_union_id,standalone_club,p_period_start,p_period_end,3,fingerprint,result);
 RETURN result;
END $function$;

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
 ready boolean;close_count int;bank_bad bigint;bank_burned numeric;bank_ids jsonb;
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
 -- WEEKLY CLOSE SCALE (20260928): the same disposition proof as one read.
 -- The original looped over every private deposit and asked the earning
 -- sources twice per deposit; the second question's CASE made PL/pgSQL settle
 -- on a generic plan that scanned the club's whole source history each time
 -- (233 ms a deposit measured on production, 197,135 deposits for Deep Stack
 -- Society's week). Deposits are now found by index, each deposit's sources by
 -- its own key, and every original test is applied per deposit. The ledger
 -- ids are listed in deposit order (type, banked time, key).
 WITH deposits AS MATERIALIZED (
  SELECT 'cash_rake_accrual'::text AS source_type,b.rake_record_id AS source_group,b.club_ledger_id AS ledger_id,b.amount,b.banked_at,
   b.club_id,b.union_id,b.union_transaction_id,NULL::uuid AS tournament_id
  FROM public.accounting_cash_bank_receipts b WHERE b.union_id IS NULL AND b.rake_record_id IN(
   SELECT x.rake_record_id FROM public.accounting_cash_bank_receipts x
    WHERE x.union_id IS NULL AND x.club_id=period.club_id AND x.banked_at>=period.start_at AND x.banked_at<period.end_at
   UNION SELECT s.rake_record_id FROM public.accounting_cash_rake_sources s WHERE s.club_id=period.club_id AND s.union_id IS NULL
    AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id AND s.earned_at>=period.start_at AND s.earned_at<period.end_at)
  UNION ALL
  SELECT 'tournament_fee_accrual',f.tournament_id,f.bank_journal_id,f.net_rake,f.recognized_at,f.bank_club_id,f.union_id,f.union_wallet_transaction_id,f.tournament_id
  FROM public.accounting_tournament_fee_recognitions f WHERE f.union_id IS NULL AND f.net_rake>0 AND f.tournament_id IN(
   SELECT y.tournament_id FROM public.accounting_tournament_fee_recognitions y
    WHERE y.bank_club_id=period.club_id AND y.recognized_at>=period.start_at AND y.recognized_at<period.end_at
   UNION SELECT s.tournament_id FROM public.accounting_payable_earning_sources s WHERE s.source_type='tournament_fee_accrual'
    AND s.club_id=period.club_id AND s.union_id IS NULL AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id
    AND s.earned_at>=period.start_at AND s.earned_at<period.end_at)
 ), judged AS (
  SELECT b.*,cg.n+tg.n AS n,COALESCE(cg.total,0)+COALESCE(tg.total,0) AS total,cg.bad+tg.bad AS bad,
   COALESCE(cg.mine,false) OR COALESCE(tg.mine,false) AS mine
  FROM (SELECT * FROM deposits ORDER BY source_type,banked_at,source_group) b
  CROSS JOIN LATERAL (SELECT count(*) AS n,sum(s.rake_credit) AS total,
    count(*) FILTER(WHERE s.club_id IS DISTINCT FROM period.club_id OR s.union_id IS NOT NULL
     OR s.coordinator_union_id IS DISTINCT FROM period.union_id OR s.earned_at IS DISTINCT FROM b.banked_at) AS bad,
    bool_or(s.club_id=period.club_id AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id) AS mine
   FROM public.accounting_cash_rake_sources s WHERE b.source_type='cash_rake_accrual' AND s.rake_record_id=b.source_group OFFSET 0) cg
  CROSS JOIN LATERAL (SELECT count(*) AS n,sum(s.rake_credit) AS total,
    count(*) FILTER(WHERE s.club_id IS DISTINCT FROM period.club_id OR s.union_id IS NOT NULL
     OR s.coordinator_union_id IS DISTINCT FROM period.union_id OR s.earned_at IS DISTINCT FROM b.banked_at) AS bad,
    bool_or(s.club_id=period.club_id AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id) AS mine
   FROM public.accounting_payable_earning_sources s WHERE b.source_type='tournament_fee_accrual' AND s.source_type='tournament_fee_accrual'
    AND s.tournament_id=b.source_group OFFSET 0) tg
 ), verdict AS (
  SELECT j.source_type,j.source_group,j.banked_at,j.ledger_id,j.amount,(j.n>0 AND NOT j.mine) AS skipped,
   (j.n=0 OR j.bad>0 OR j.total IS DISTINCT FROM j.amount OR j.club_id IS DISTINCT FROM period.club_id
    OR j.union_transaction_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.id=j.ledger_id AND l.status='posted'
    AND l.club_id=period.club_id AND l.amount=j.amount AND l.created_at=j.banked_at
    AND j.banked_at>=period.start_at AND j.banked_at<period.end_at
    AND ((j.source_type='cash_rake_accrual' AND l.from_type='table_stack'
       AND l.to_type='chip_retirement' AND l.to_entity_id IS NULL AND l.category='burn')
     OR (j.source_type='tournament_fee_accrual' AND l.from_type='prize_liability' AND l.from_entity_id=j.tournament_id
       AND l.to_type='chip_retirement' AND l.to_entity_id IS NULL AND l.category='burn')))) AS issue
  FROM judged j
 )
 SELECT count(*) FILTER(WHERE NOT skipped AND issue),COALESCE(sum(amount) FILTER(WHERE NOT skipped AND NOT issue),0),
  COALESCE(jsonb_agg(ledger_id ORDER BY source_type,banked_at,source_group) FILTER(WHERE NOT skipped AND NOT issue),'[]'::jsonb)
 INTO bank_bad,bank_burned,bank_ids FROM verdict;
 source_issues:=source_issues+bank_bad;
 private_burned:=private_burned+bank_burned;
 private_ledger_ids:=private_ledger_ids||bank_ids;
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

CREATE OR REPLACE FUNCTION public.fn_assert_cash_commission_period(p_union_id uuid, p_club_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
 IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR p_union_id IS NULL OR NOT public.fn_is_union_overseer(p_union_id,auth.uid())) THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF (p_union_id IS NULL)=(p_club_id IS NULL) OR p_from IS NULL OR p_to IS NULL OR p_to<=p_from
 THEN RAISE EXCEPTION 'invalid_cash_commission_scope' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.rake_records r LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id=r.id
  WHERE r.created_at>=p_from AND r.created_at<p_to AND r.rake_amount>0 AND NOT COALESCE(r.is_tournament,false) AND r.tournament_id IS NULL
   AND (r.hand_id IS NOT NULL OR NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata))
   AND ((p_club_id IS NOT NULL AND (r.club_id=p_club_id OR EXISTS(SELECT 1 FROM public.rake_attributions a WHERE a.rake_record_id=r.id AND a.club_id=p_club_id)))
     OR (p_union_id IS NOT NULL AND (r.club_id=p_union_id OR EXISTS(SELECT 1 FROM public.union_clubs c WHERE c.union_id=p_union_id AND c.club_id=r.club_id)
      OR EXISTS(SELECT 1 FROM public.rake_attributions a JOIN public.union_clubs c ON c.club_id=a.club_id WHERE a.rake_record_id=r.id AND c.union_id=p_union_id))))
   AND (b.status IS DISTINCT FROM 'accrued'))
 THEN RAISE EXCEPTION 'cash_commission_earning_evidence_requires_reconciliation' USING ERRCODE='55000'; END IF;
END $function$;

-- The original earned plan, byte-for-byte under a new name.
CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan_v3(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE issue_count bigint;bank_total numeric;source_total numeric;house_total numeric;detail jsonb;fingerprint text;
BEGIN
 IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_start>=p_end
 THEN RAISE EXCEPTION 'invalid_union_earning_source_period' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND starts_at<=p_start)
 THEN RAISE EXCEPTION 'union_earning_source_historical_week_uncertified' USING ERRCODE='55000'; END IF;
 -- Each real rake-bank credit must have exactly one typed source authority.
 -- A banked tournament with missing agreements is a debt exception, never
 -- silently reclassified as retained union revenue.
 SELECT count(*) INTO issue_count FROM public.union_wallet_transactions t
  LEFT JOIN public.accounting_cash_bank_receipts c ON c.union_transaction_id=t.id
  LEFT JOIN public.accounting_tournament_fee_recognitions f ON f.union_wallet_transaction_id=t.id
  WHERE t.union_id=p_union_id AND t.wallet='rake_wallet' AND t.direction='credit' AND t.tx_type='rake'
   AND t.created_at>=p_start AND t.created_at<p_end
   AND (((c.rake_record_id IS NOT NULL)::int+(f.tournament_id IS NOT NULL)::int)<>1
    OR (c.rake_record_id IS NOT NULL AND (c.union_id IS DISTINCT FROM p_union_id OR c.amount IS DISTINCT FROM t.amount
     OR c.banked_at IS DISTINCT FROM t.created_at OR c.club_ledger_id IS NOT NULL))
    OR (f.tournament_id IS NOT NULL AND (f.union_id IS DISTINCT FROM p_union_id OR f.net_rake IS DISTINCT FROM t.amount
     OR f.recognized_at IS DISTINCT FROM t.created_at OR f.status IS DISTINCT FROM 'recognized' OR f.bank_journal_id IS NOT NULL))
    OR t.amount IS NULL OR t.amount<=0 OR t.amount<>round(t.amount,2) OR t.amount::text IN('NaN','Infinity','-Infinity'));
 IF issue_count>0 THEN RAISE EXCEPTION 'union_rake_bank_source_unverified:%',issue_count USING ERRCODE='55000'; END IF;
 -- Check the reverse direction too, including sources whose bank row was
 -- changed to another week, union, wallet, or category.
 SELECT count(*) INTO issue_count FROM (
  SELECT c.union_transaction_id AS bank_id,c.banked_at AS earned_at,c.amount AS amount,c.union_id
   FROM public.accounting_cash_bank_receipts c WHERE c.union_id=p_union_id AND c.banked_at>=p_start AND c.banked_at<p_end
  UNION ALL
  SELECT f.union_wallet_transaction_id,f.recognized_at,f.net_rake,f.union_id
   FROM public.accounting_tournament_fee_recognitions f WHERE f.union_id=p_union_id AND f.net_rake>0
    AND f.recognized_at>=p_start AND f.recognized_at<p_end
 ) s LEFT JOIN public.union_wallet_transactions t ON t.id=s.bank_id
 WHERE t.id IS NULL OR t.union_id IS DISTINCT FROM s.union_id OR t.created_at IS DISTINCT FROM s.earned_at
  OR t.amount IS DISTINCT FROM s.amount OR t.wallet IS DISTINCT FROM 'rake_wallet'
  OR t.direction IS DISTINCT FROM 'credit' OR t.tx_type IS DISTINCT FROM 'rake';
 IF issue_count>0 THEN RAISE EXCEPTION 'union_rake_bank_receipt_drifted:%',issue_count USING ERRCODE='55000'; END IF;
 SELECT count(*) INTO issue_count FROM public.accounting_cash_bank_receipts c
  LEFT JOIN public.rake_records r ON r.id=c.rake_record_id
  LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id=c.rake_record_id
  LEFT JOIN LATERAL (SELECT count(*) AS n,sum(s.rake_credit) AS total,
    count(*) FILTER(WHERE s.union_id IS DISTINCT FROM c.union_id OR s.earned_at IS DISTINCT FROM c.banked_at) AS invalid
    FROM public.accounting_payable_earning_sources s WHERE s.source_type='cash_rake_accrual' AND s.rake_record_id=c.rake_record_id) x ON true
  WHERE c.union_id=p_union_id AND c.banked_at>=p_start AND c.banked_at<p_end
   AND (r.id IS NULL OR r.rake_amount IS DISTINCT FROM c.amount OR r.created_at IS DISTINCT FROM c.banked_at
    OR r.is_tournament IS TRUE OR r.tournament_id IS NOT NULL OR b.status IS DISTINCT FROM 'accrued'
    OR b.earned_at IS DISTINCT FROM r.created_at OR x.n=0 OR x.total IS DISTINCT FROM c.amount OR x.invalid>0);
 IF issue_count>0 THEN RAISE EXCEPTION 'union_cash_sources_do_not_match_bank:%',issue_count USING ERRCODE='55000'; END IF;
 SELECT count(*) INTO issue_count FROM public.accounting_tournament_fee_recognitions f
  LEFT JOIN LATERAL (SELECT count(*) AS n,sum(s.rake_credit) AS total
   FROM public.accounting_payable_earning_sources s WHERE s.source_type='tournament_fee_accrual'
    AND s.tournament_id=f.tournament_id AND s.union_id=p_union_id AND s.earned_at=f.recognized_at) x ON true
  WHERE f.union_id=p_union_id AND f.recognized_at>=p_start AND f.recognized_at<p_end AND f.net_rake>0
   AND (f.status IS DISTINCT FROM 'recognized' OR x.n=0 OR x.total IS DISTINCT FROM f.net_rake);
 IF issue_count>0 THEN RAISE EXCEPTION 'union_tournament_sources_do_not_match_bank:%',issue_count USING ERRCODE='55000'; END IF;
 SELECT count(*) INTO issue_count FROM public.accounting_payable_earning_sources s
  LEFT JOIN public.accounting_cash_bank_receipts c ON s.source_type='cash_rake_accrual' AND c.rake_record_id=s.rake_record_id
  LEFT JOIN public.accounting_tournament_fee_recognitions f ON s.source_type='tournament_fee_accrual' AND f.tournament_id=s.tournament_id
  WHERE s.union_id=p_union_id AND s.earned_at>=p_start AND s.earned_at<p_end
   AND ((s.source_type='cash_rake_accrual' AND (c.rake_record_id IS NULL OR c.union_id IS DISTINCT FROM s.union_id OR c.banked_at IS DISTINCT FROM s.earned_at))
    OR (s.source_type='tournament_fee_accrual' AND (f.tournament_id IS NULL OR f.union_id IS DISTINCT FROM s.union_id
      OR f.recognized_at IS DISTINCT FROM s.earned_at OR f.status IS DISTINCT FROM 'recognized'))
    OR s.source_type NOT IN('cash_rake_accrual','tournament_fee_accrual'));
 IF issue_count>0 THEN RAISE EXCEPTION 'union_earning_source_without_bank:%',issue_count USING ERRCODE='55000'; END IF;
 -- The recorded union agreement must be the latest observation at earning
 -- (cash) or charge (tournament) time. Current membership/rates do not alter it.
 WITH sources AS (
  SELECT s.*,COALESCE(f.game_type,'cash') AS game_type,
   s.contract->'union_agreement' AS agreement,(s.contract->>'terms_at')::timestamptz AS terms_at,
   COALESCE((s.contract->>'is_union_house')::boolean,false) AS is_house
   FROM public.accounting_payable_earning_sources s LEFT JOIN public.accounting_tournament_fee_sources f
    ON s.source_type='tournament_fee_accrual' AND f.id=s.source_id
   WHERE s.union_id=p_union_id AND s.earned_at>=p_start AND s.earned_at<p_end
 ), checked AS (
  SELECT s.*,h.id AS history_id,h.observed_at,h.after_terms,
   COALESCE(CASE s.game_type WHEN 'cash' THEN s.agreement->'terms'->>'rate_cash'
    WHEN 'mtt' THEN s.agreement->'terms'->>'rate_mtt' WHEN 'sng' THEN s.agreement->'terms'->>'rate_sng'
    WHEN 'spin' THEN s.agreement->'terms'->>'rate_spin' WHEN 'satellite' THEN s.agreement->'terms'->>'rate_satellite' END,
    s.agreement->'terms'->>'club_commission_rate')::numeric AS rate
   FROM sources s LEFT JOIN public.accounting_agreement_history h ON h.id=(s.agreement->>'history_id')::bigint
 )
 SELECT count(*) INTO issue_count FROM checked s
 WHERE s.contract->>'club_id' IS DISTINCT FROM s.club_id::text OR s.contract->>'player_id' IS DISTINCT FROM s.player_id::text
  OR s.contract->>'union_id' IS DISTINCT FROM p_union_id::text OR s.coordinator_union_id IS DISTINCT FROM p_union_id
  OR (s.contract->>'rake_credit')::numeric IS DISTINCT FROM s.rake_credit OR s.terms_at IS NULL OR s.terms_at>s.earned_at
  OR (s.source_type='cash_rake_accrual' AND s.terms_at IS DISTINCT FROM s.earned_at)
  OR (s.source_type='tournament_fee_accrual' AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f
    WHERE f.id=s.source_id AND f.charged_at=s.terms_at))
  OR (s.is_house AND (s.agreement IS DISTINCT FROM 'null'::jsonb OR NOT EXISTS(SELECT 1 FROM public.clubs c
    WHERE c.id=s.club_id AND c.is_union IS TRUE AND (c.id=p_union_id OR c.union_id=p_union_id))))
  OR (NOT s.is_house AND (s.history_id IS NULL OR s.after_terms IS DISTINCT FROM s.agreement->'terms'
    OR s.agreement->'terms'->>'club_id' IS DISTINCT FROM s.club_id::text OR s.agreement->'terms'->>'union_id' IS DISTINCT FROM p_union_id::text
    OR s.observed_at>s.terms_at OR s.observed_at IS DISTINCT FROM (s.agreement->>'observed_at')::timestamptz
    OR NOT EXISTS(SELECT 1 FROM public.accounting_agreement_history h WHERE h.id=s.history_id AND h.entity_type='union_clubs'
     AND h.club_id=s.club_id AND h.entity_key=s.agreement->'terms'->>'id')
    OR EXISTS(SELECT 1 FROM public.accounting_agreement_history h JOIN public.accounting_agreement_history old ON old.id=s.history_id
      WHERE h.entity_type='union_clubs' AND h.entity_key=old.entity_key AND h.observed_at<=s.terms_at AND (h.observed_at,h.id)>(old.observed_at,old.id))
    OR s.rate IS NULL OR s.rate<0 OR s.rate>1 OR s.rate::text IN('NaN','Infinity','-Infinity')));
 IF issue_count>0 THEN RAISE EXCEPTION 'union_earning_agreement_unverified:%',issue_count USING ERRCODE='55000'; END IF;
 SELECT COALESCE(sum(amount),0) INTO bank_total FROM public.union_wallet_transactions
  WHERE union_id=p_union_id AND wallet='rake_wallet' AND direction='credit' AND tx_type='rake' AND created_at>=p_start AND created_at<p_end;
 SELECT COALESCE(sum(s.rake_credit),0),COALESCE(sum(s.rake_credit) FILTER(WHERE (s.contract->>'is_union_house')::boolean),0),
  md5(COALESCE(string_agg(md5(jsonb_build_array(s.source_type,s.source_id,s.rake_record_id,s.tournament_id,s.earned_at,s.rake_credit,s.contract)::text),
    '' ORDER BY s.source_type,s.source_id),'')) INTO source_total,house_total,fingerprint
  FROM public.accounting_payable_earning_sources s WHERE s.union_id=p_union_id AND s.earned_at>=p_start AND s.earned_at<p_end;
 IF source_total IS DISTINCT FROM bank_total THEN RAISE EXCEPTION 'union_earned_rake_does_not_conserve_bank' USING ERRCODE='55000'; END IF;
 WITH source_rates AS (
  SELECT s.club_id,COALESCE(f.game_type,'cash') AS game_type,s.rake_credit,
   COALESCE(CASE COALESCE(f.game_type,'cash') WHEN 'cash' THEN s.contract->'union_agreement'->'terms'->>'rate_cash'
    WHEN 'mtt' THEN s.contract->'union_agreement'->'terms'->>'rate_mtt' WHEN 'sng' THEN s.contract->'union_agreement'->'terms'->>'rate_sng'
    WHEN 'spin' THEN s.contract->'union_agreement'->'terms'->>'rate_spin' WHEN 'satellite' THEN s.contract->'union_agreement'->'terms'->>'rate_satellite' END,
    s.contract->'union_agreement'->'terms'->>'club_commission_rate')::numeric AS rate
  FROM public.accounting_payable_earning_sources s LEFT JOIN public.accounting_tournament_fee_sources f
   ON s.source_type='tournament_fee_accrual' AND f.id=s.source_id
  WHERE s.union_id=p_union_id AND s.earned_at>=p_start AND s.earned_at<p_end AND COALESCE((s.contract->>'is_union_house')::boolean,false) IS FALSE
 ), basis AS (
  SELECT club_id,game_type,sum(rake_credit) AS rake_in,
   CASE WHEN sum(rake_credit)>0 THEN sum(rake_credit*rate)/sum(rake_credit) ELSE 0 END AS rate,
   trunc(sum(rake_credit*rate),2) AS payout FROM source_rates GROUP BY club_id,game_type
 ) SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY club_id,game_type),'[]') INTO detail FROM basis b;
 RETURN jsonb_build_object('accounting_version',3,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,
  'period_rake',bank_total,'earned_rake',source_total,'house_rake',house_total,'source_fingerprint',fingerprint,'basis_detail',detail);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- WEEKLY CLOSE SCALE (20260928): a union's weekly close proves the same earned
-- plan up to nine times in one transaction (preparation twice, round 1 twice,
-- round 3, the ECO gate and the invoice evidence), about a minute each at
-- Midway's scale. Inside a close (app.accounting_close_memo='on', set only by
-- fn_process_weekly_accounting_scope for the attempt it is running) the first
-- proof of a (union, week) is kept for the rest of that transaction; a
-- rolled-back attempt forgets it with its subtransaction. Everywhere else the
-- plan is proved on every call, exactly as before, by
-- fn_accounting_union_earned_plan_v3.
DECLARE memo jsonb; memo_key text; plan jsonb;
BEGIN
 IF current_setting('app.accounting_close_memo',true)='on' THEN
  memo_key:=p_union_id::text||'|'||p_start::text||'|'||p_end::text;
  memo:=NULLIF(current_setting('app.accounting_earned_plan_memo',true),'')::jsonb;
  IF memo ? memo_key THEN RETURN memo->memo_key; END IF;
 END IF;
 plan:=public.fn_accounting_union_earned_plan_v3(p_union_id,p_start,p_end);
 IF memo_key IS NOT NULL THEN
  PERFORM set_config('app.accounting_earned_plan_memo',(COALESCE(memo,'{}'::jsonb)||jsonb_build_object(memo_key,plan))::text,true);
 END IF;
 RETURN plan;
END $function$;

CREATE FUNCTION public.fn_weekly_accounting_attempt_begin(p_memo boolean) RETURNS void
 LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
 -- One close attempt of one book: its deadline, and (for a union) the
 -- earned-plan memo, both transaction-local and cleared by attempt_end.
 PERFORM set_config('app.weekly_accounting_scope_deadline',
  (clock_timestamp()+COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval)::text,true);
 PERFORM set_config('app.accounting_close_memo',CASE WHEN p_memo THEN 'on' ELSE '' END,true);
 PERFORM set_config('app.accounting_earned_plan_memo','',true);
END $function$;
CREATE FUNCTION public.fn_weekly_accounting_deadline_check() RETURNS void
 LANGUAGE plpgsql SET search_path TO 'public' AS $function$
DECLARE deadline text:=current_setting('app.weekly_accounting_scope_deadline',true);
BEGIN
 IF deadline IS NOT NULL AND deadline<>'' AND clock_timestamp()>deadline::timestamptz THEN
  RAISE EXCEPTION 'weekly_scope_time_budget_exhausted' USING DETAIL=jsonb_build_object('deadline',deadline,
   'budget',COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes'),'at',clock_timestamp())::text;
 END IF;
END $function$;
CREATE FUNCTION public.fn_weekly_accounting_attempt_end() RETURNS void
 LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
 PERFORM set_config('app.weekly_accounting_scope_deadline','',true);
 PERFORM set_config('app.accounting_close_memo','',true);
 PERFORM set_config('app.accounting_earned_plan_memo','',true);
END $function$;

DO $patch$
DECLARE src text; needle text;
BEGIN
 src:=pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure);
 needle:='      -- Keep a refused preparation request durable outside the wallet rollback.
';
 IF (length(src)-length(replace(src,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'patch needle not unique in %: %','fn_process_weekly_accounting_scope(uuid,uuid)',left(needle,80); END IF;
 src:=replace(src,needle,'      PERFORM public.fn_weekly_accounting_attempt_begin(true);
      -- Keep a refused preparation request durable outside the wallet rollback.
');
 needle:='          v_result:=public.fn_union_settlement_cascade(v_union.id,v_from,v_end);
';
 IF (length(src)-length(replace(src,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'patch needle not unique in %: %','fn_process_weekly_accounting_scope(uuid,uuid)',left(needle,80); END IF;
 src:=replace(src,needle,'          PERFORM public.fn_weekly_accounting_deadline_check();
          v_result:=public.fn_union_settlement_cascade(v_union.id,v_from,v_end);
          PERFORM public.fn_weekly_accounting_deadline_check();
');
 needle:='      IF v_result->>''success''=''true'' THEN v_result:=v_result||jsonb_build_object(''accounting_version'',3); END IF;
';
 IF (length(src)-length(replace(src,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'patch needle not unique in %: %','fn_process_weekly_accounting_scope(uuid,uuid)',left(needle,80); END IF;
 src:=replace(src,needle,'      PERFORM public.fn_weekly_accounting_attempt_end();
      IF v_result->>''success''=''true'' THEN v_result:=v_result||jsonb_build_object(''accounting_version'',3); END IF;
');
 needle:='        BEGIN v_preparation:=public.fn_prepare_accounting_week(NULL,v_club.id,v_from,v_end);
';
 IF (length(src)-length(replace(src,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'patch needle not unique in %: %','fn_process_weekly_accounting_scope(uuid,uuid)',left(needle,80); END IF;
 src:=replace(src,needle,'        PERFORM public.fn_weekly_accounting_attempt_begin(false);
        BEGIN v_preparation:=public.fn_prepare_accounting_week(NULL,v_club.id,v_from,v_end);
');
 needle:='          v_stage2:=public.fn_settle_accounting_commission_stage(''club'',v_club.id,v_from,v_end);
          v_stage3:=public.fn_settle_accounting_rakeback_stage(''club'',v_club.id,v_from,v_end);
';
 IF (length(src)-length(replace(src,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'patch needle not unique in %: %','fn_process_weekly_accounting_scope(uuid,uuid)',left(needle,80); END IF;
 src:=replace(src,needle,'          PERFORM public.fn_weekly_accounting_deadline_check();
          v_stage2:=public.fn_settle_accounting_commission_stage(''club'',v_club.id,v_from,v_end);
          PERFORM public.fn_weekly_accounting_deadline_check();
          v_stage3:=public.fn_settle_accounting_rakeback_stage(''club'',v_club.id,v_from,v_end);
          PERFORM public.fn_weekly_accounting_deadline_check();
');
 needle:='          v_statements:=public.fn_issue_scope_weekly_accounting(''club'',v_club.id,v_from,v_end);
';
 IF (length(src)-length(replace(src,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'patch needle not unique in %: %','fn_process_weekly_accounting_scope(uuid,uuid)',left(needle,80); END IF;
 src:=replace(src,needle,'          PERFORM public.fn_weekly_accounting_deadline_check();
          v_statements:=public.fn_issue_scope_weekly_accounting(''club'',v_club.id,v_from,v_end);
          PERFORM public.fn_weekly_accounting_deadline_check();
');
 needle:='        UPDATE public.union_accounting_runs SET status=CASE WHEN v_result->>''success''=''true'' THEN ''complete'' ELSE ''failed'' END,
          finished_at=clock_timestamp(),result=v_result WHERE standalone_club_id=v_club.id';
 IF (length(src)-length(replace(src,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'patch needle not unique in %: %','fn_process_weekly_accounting_scope(uuid,uuid)',left(needle,80); END IF;
 src:=replace(src,needle,'        PERFORM public.fn_weekly_accounting_attempt_end();
        UPDATE public.union_accounting_runs SET status=CASE WHEN v_result->>''success''=''true'' THEN ''complete'' ELSE ''failed'' END,
          finished_at=clock_timestamp(),result=v_result WHERE standalone_club_id=v_club.id');
 EXECUTE src;
 src:=pg_get_functiondef('public.fn_union_settlement_cascade(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure);
 needle:='  v_r1 := public.fn_union_weekly_rakeback_close(p_union_id, v_from, v_to);
';
 IF (length(src)-length(replace(src,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'patch needle not unique in %: %','fn_union_settlement_cascade(uuid,timestamp with time zone,timestamp with time zone)',left(needle,80); END IF;
 src:=replace(src,needle,'  PERFORM public.fn_weekly_accounting_deadline_check();
  v_r1 := public.fn_union_weekly_rakeback_close(p_union_id, v_from, v_to);
');
 needle:='  v_r2 := public.fn_settle_round2_club_to_agents(p_union_id, v_from, v_to);
';
 IF (length(src)-length(replace(src,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'patch needle not unique in %: %','fn_union_settlement_cascade(uuid,timestamp with time zone,timestamp with time zone)',left(needle,80); END IF;
 src:=replace(src,needle,'  PERFORM public.fn_weekly_accounting_deadline_check();
  v_r2 := public.fn_settle_round2_club_to_agents(p_union_id, v_from, v_to);
');
 needle:='  v_r3 := public.fn_settle_round3_agents_to_players(p_union_id, v_from, v_to);
';
 IF (length(src)-length(replace(src,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'patch needle not unique in %: %','fn_union_settlement_cascade(uuid,timestamp with time zone,timestamp with time zone)',left(needle,80); END IF;
 src:=replace(src,needle,'  PERFORM public.fn_weekly_accounting_deadline_check();
  v_r3 := public.fn_settle_round3_agents_to_players(p_union_id, v_from, v_to);
');
 needle:='  IF public.fn_union_setting(p_union_id, ''weekly_invoices_enabled'', 1) <> 1 THEN
';
 IF (length(src)-length(replace(src,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'patch needle not unique in %: %','fn_union_settlement_cascade(uuid,timestamp with time zone,timestamp with time zone)',left(needle,80); END IF;
 src:=replace(src,needle,'  PERFORM public.fn_weekly_accounting_deadline_check();
  IF public.fn_union_setting(p_union_id, ''weekly_invoices_enabled'', 1) <> 1 THEN
');
 needle:='  FOR v_credit_club IN SELECT club_id FROM public.fn_accounting_week_clubs(p_union_id,NULL,v_from,v_to) ORDER BY club_id LOOP
';
 IF (length(src)-length(replace(src,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'patch needle not unique in %: %','fn_union_settlement_cascade(uuid,timestamp with time zone,timestamp with time zone)',left(needle,80); END IF;
 src:=replace(src,needle,'  PERFORM public.fn_weekly_accounting_deadline_check();
  FOR v_credit_club IN SELECT club_id FROM public.fn_accounting_week_clubs(p_union_id,NULL,v_from,v_to) ORDER BY club_id LOOP
');
 needle:='  v_club_statements:=public.fn_issue_club_weekly_accounting(p_union_id,v_from,v_to);
';
 IF (length(src)-length(replace(src,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'patch needle not unique in %: %','fn_union_settlement_cascade(uuid,timestamp with time zone,timestamp with time zone)',left(needle,80); END IF;
 src:=replace(src,needle,'  v_club_statements:=public.fn_issue_club_weekly_accounting(p_union_id,v_from,v_to);
  PERFORM public.fn_weekly_accounting_deadline_check();
');
 EXECUTE src;
END $patch$;

REVOKE ALL ON FUNCTION public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_accounting_union_earned_plan_v3(uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_weekly_accounting_attempt_begin(boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_weekly_accounting_deadline_check() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_weekly_accounting_attempt_end() FROM PUBLIC, anon, authenticated, service_role;

-- The cron close: one close attempt per tick, a 20-minute statement budget
-- (still the >= 20 minute cron-sized budget the inventory seal requires).
-- The job's active flag is left as it is.
DO $cron$
DECLARE j bigint;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN RETURN; END IF;
  SELECT jobid INTO j FROM cron.job WHERE jobname='union-weekly-rakeback-close';
  IF j IS NULL THEN RAISE EXCEPTION 'cron job union-weekly-rakeback-close missing' USING ERRCODE='55000'; END IF;
  IF (SELECT command FROM cron.job WHERE jobid=j) IS DISTINCT FROM 'SET statement_timeout=''2400s''; SELECT public.fn_union_settlement_cascade_due();' THEN
    RAISE EXCEPTION 'preimage mismatch: union-weekly-rakeback-close command' USING ERRCODE='55000';
  END IF;
  PERFORM cron.alter_job(j, command:='SET statement_timeout=''1200s''; SET app.weekly_accounting_attempt_budget=''1''; SELECT public.fn_union_settlement_cascade_due();');
END $cron$;

DO $post$
BEGIN
  IF md5(pg_get_functiondef('public.fn_accounting_union_earned_plan(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '409eade1f18decea288db84784f127b2' THEN RAISE EXCEPTION 'postimage mismatch: fn_accounting_union_earned_plan(uuid,timestamp with time zone,timestamp with time zone)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_accounting_union_earned_plan_v3(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM 'e16d7ddd96e4d349d15973bb71a19036' THEN RAISE EXCEPTION 'postimage mismatch: fn_accounting_union_earned_plan_v3(uuid,timestamp with time zone,timestamp with time zone)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_assert_cash_commission_period(uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '49ef927cb15979fea12511890e520542' THEN RAISE EXCEPTION 'postimage mismatch: fn_assert_cash_commission_period(uuid,uuid,timestamp with time zone,timestamp with time zone)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_club_weekly_accounting_summary(uuid)'::regprocedure)) IS DISTINCT FROM '1f2d91e88471ab5ef8cd481d3ec7f32b' THEN RAISE EXCEPTION 'postimage mismatch: fn_club_weekly_accounting_summary(uuid)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure)) IS DISTINCT FROM '6e8a3d775891ae1d4685231a07ff72d3' THEN RAISE EXCEPTION 'postimage mismatch: fn_process_weekly_accounting_scope(uuid,uuid)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM 'ec2dd57271b8061b8ac9f7e7b531d964' THEN RAISE EXCEPTION 'postimage mismatch: fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '9a7515813a8f48c4430c6ca60378f941' THEN RAISE EXCEPTION 'postimage mismatch: fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '292225abed2d6783c0f3ee0009a05fa3' THEN RAISE EXCEPTION 'postimage mismatch: fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_union_settlement_cascade(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '1adc53784a37e366e50cc01832df4521' THEN RAISE EXCEPTION 'postimage mismatch: fn_union_settlement_cascade(uuid,timestamp with time zone,timestamp with time zone)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_weekly_accounting_attempt_begin(boolean)'::regprocedure)) IS DISTINCT FROM '96e8c69092908fbe9526963e9012b3e0' THEN RAISE EXCEPTION 'postimage mismatch: fn_weekly_accounting_attempt_begin(boolean)' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_weekly_accounting_attempt_end()'::regprocedure)) IS DISTINCT FROM 'b7d27aa978a1b8db3a98921d6af82588' THEN RAISE EXCEPTION 'postimage mismatch: fn_weekly_accounting_attempt_end()' USING ERRCODE='55000'; END IF;
  IF md5(pg_get_functiondef('public.fn_weekly_accounting_deadline_check()'::regprocedure)) IS DISTINCT FROM 'cc0ab45c0c4fdcfed6dd050580d47acf' THEN RAISE EXCEPTION 'postimage mismatch: fn_weekly_accounting_deadline_check()' USING ERRCODE='55000'; END IF;
END $post$;
COMMIT;
