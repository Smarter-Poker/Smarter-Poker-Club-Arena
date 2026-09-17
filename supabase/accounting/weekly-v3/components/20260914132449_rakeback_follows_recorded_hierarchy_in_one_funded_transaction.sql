-- The previous agent round paid every tier directly from club treasury and
-- silently skipped insufficient funding. The player round chose its payer
-- from current membership. These private stages now consume recorded earning
-- contracts/certificates, route parent-to-child budgets, lock all accounts,
-- and abort the entire transaction on any missing funding or delivery.
-- Existing paid/partial legacy periods cannot be replayed. No history repair.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_settle_round2_club_to_agents(uuid,timestamptz,timestamptz)'::regprocedure))<>'1f79888c067c5e4892442d88a66affbf'
 OR md5(pg_get_functiondef('public.fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz)'::regprocedure))<>'422380ee15a8e452cf8044c0e91bbddd'
 THEN RAISE EXCEPTION 'routed accounting stage changed since review'; END IF;
 IF (SELECT count(*) FROM public.ca_money_rpc_registry WHERE proname IN('fn_settle_round2_club_to_agents','fn_settle_round3_agents_to_players') AND status='approved')<>2
 THEN RAISE EXCEPTION 'routed accounting writer registration missing'; END IF;
END $guard$;
CREATE TABLE public.accounting_routed_settlement_runs(
 union_id uuid NOT NULL,period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,
 round_no integer NOT NULL CHECK(round_no IN(2,3)),routing_version integer NOT NULL DEFAULT 3 CHECK(routing_version=3),
 source_fingerprint text NOT NULL,result jsonb NOT NULL,completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(union_id,period_start,period_end,round_no),CHECK(period_start<period_end)
);
ALTER TABLE public.accounting_routed_settlement_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_routed_settlement_runs FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.accounting_routed_settlement_runs TO service_role;
CREATE TRIGGER accounting_routed_run_immutable BEFORE UPDATE OR DELETE ON public.accounting_routed_settlement_runs
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_routed_run_no_truncate BEFORE TRUNCATE ON public.accounting_routed_settlement_runs
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();

CREATE OR REPLACE FUNCTION public.fn_settle_round2_club_to_agents(p_union_id uuid,p_period_start timestamptz,p_period_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE v_source record;v_edge record;previous public.accounting_routed_settlement_runs%ROWTYPE;
 fingerprint text;result jsonb;run_key text;own_total numeric;direct_total numeric;downstream_total numeric;
 source_count int;node_count int;finished int:=0;step int:=0;progress int;ledger_id uuid;receipt_count int;
 payer_before numeric;payee_before numeric;payer_after numeric;payee_after numeric;club_skip text;member_skip text;routing_context text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_union_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR p_period_start>=p_period_end OR p_period_end>now()-interval '5 minutes' THEN RAISE EXCEPTION 'routed_commission_invalid_period' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active) THEN RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 IF EXISTS(SELECT 1 FROM public.union_settlement_floor WHERE union_id=p_union_id AND p_period_start<earliest_period_start)
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND p_period_start>=starts_at)
 THEN RAISE EXCEPTION 'routed_commission_historical_period_uncertified' USING ERRCODE='55000'; END IF;
 IF p_period_start IS DISTINCT FROM public.fn_union_week_start(p_period_start)
  OR p_period_end IS DISTINCT FROM public.fn_union_week_start(p_period_start+interval '8 days')
 THEN RAISE EXCEPTION 'routed_commission_requires_one_accounting_week' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting:'||p_union_id::text||':'||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text,0));
 run_key:='round2:v3:'||p_union_id::text||':'||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text;
 CREATE TEMP TABLE IF NOT EXISTS _routed_sources(source_id uuid PRIMARY KEY,club_id uuid,contract jsonb,earned_at timestamptz) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_sources;
 INSERT INTO pg_temp._routed_sources SELECT id,club_id,contract,earned_at FROM public.accounting_cash_rake_sources
  WHERE coordinator_union_id=p_union_id AND earned_at>=p_period_start AND earned_at<p_period_end;
 PERFORM public.fn_lock_rakeback_payer_clubs(ARRAY(SELECT club_id FROM pg_temp._routed_sources UNION
  SELECT club_id FROM public.union_clubs WHERE union_id=p_union_id ORDER BY club_id));
 SELECT count(*),md5(COALESCE(string_agg(md5(jsonb_build_array(source_id,club_id,earned_at,contract)::text),'' ORDER BY source_id),''))
 INTO source_count,fingerprint FROM pg_temp._routed_sources;
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE union_id=p_union_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=2;
 IF FOUND THEN
  IF previous.source_fingerprint<>fingerprint THEN RAISE EXCEPTION 'routed_commission_source_changed_after_payment' USING ERRCODE='55000'; END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commission_settlements cs WHERE cs.period_start<p_period_end AND cs.period_end>p_period_start
   AND (cs.union_id=p_union_id OR cs.club_id IN(SELECT club_id FROM pg_temp._routed_sources)))
  OR EXISTS(SELECT 1 FROM public.union_settlement_rounds r WHERE r.union_id=p_union_id AND r.round_no=2
    AND r.period_start<p_period_end AND r.period_end>p_period_start AND (r.amount>0 OR r.payees>0 OR r.shortfalls>0))
 THEN RAISE EXCEPTION 'legacy_commission_payment_requires_reconciliation' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commissions ac WHERE ac.created_at>=p_period_start AND ac.created_at<p_period_end
  AND (ac.club_id IN(SELECT club_id FROM pg_temp._routed_sources) OR ac.club_id IN(SELECT club_id FROM public.union_clubs WHERE union_id=p_union_id))
  AND (ac.source_type IS DISTINCT FROM 'cash_rake_accrual' OR ac.settled_at IS NOT NULL OR NOT EXISTS(
   SELECT 1 FROM public.accounting_cash_rake_sources rs WHERE rs.id=ac.source_id AND rs.club_id=ac.club_id AND rs.earned_at=ac.created_at)))
 THEN RAISE EXCEPTION 'unclassified_commission_source_requires_reconciliation' USING ERRCODE='55000'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_tiers(source_id uuid,club_id uuid,depth int,agent_id uuid,user_id uuid,role text,
  parent_agent_id uuid,own_amount numeric,rate numeric,PRIMARY KEY(source_id,depth)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_tiers;
 FOR v_source IN SELECT * FROM pg_temp._routed_sources ORDER BY source_id LOOP
  IF jsonb_typeof(v_source.contract->'tiers') IS DISTINCT FROM 'array' OR v_source.contract->>'club_id' IS DISTINCT FROM v_source.club_id::text
  THEN RAISE EXCEPTION 'routed_commission_contract_invalid' USING ERRCODE='23514'; END IF;
  INSERT INTO pg_temp._routed_tiers SELECT v_source.source_id,v_source.club_id,ord::int,(j->>'agent_id')::uuid,(j->>'user_id')::uuid,j->>'role',
   NULLIF(j->'agreement'->'terms'->>'parent_agent_id','')::uuid,(j->>'amount')::numeric,(j->>'rate')::numeric
   FROM jsonb_array_elements(v_source.contract->'tiers') WITH ORDINALITY x(j,ord);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.agent_id IS NULL OR t.user_id IS NULL OR t.role IS NULL OR t.role NOT IN('super_agent','agent','sub_agent')
   OR t.own_amount IS NULL OR t.own_amount<0 OR t.own_amount<>round(t.own_amount,2) OR t.own_amount::text IN('NaN','Infinity','-Infinity')
   OR t.rate IS NULL OR t.rate<0 OR t.rate>1 OR t.rate::text IN('NaN','Infinity','-Infinity')
   OR t.parent_agent_id IS DISTINCT FROM(SELECT u.agent_id FROM pg_temp._routed_tiers u WHERE u.source_id=t.source_id AND u.depth=t.depth+1))
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY source_id,user_id HAVING count(*)<>1)
  OR EXISTS(SELECT 1 FROM pg_temp._routed_tiers GROUP BY club_id,user_id HAVING count(DISTINCT agent_id)<>1 OR count(DISTINCT role)<>1)
 THEN RAISE EXCEPTION 'routed_commission_hierarchy_ambiguous' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE (t.own_amount>0 AND (SELECT count(*) FROM public.agent_commissions ac
   WHERE ac.source_type='cash_rake_accrual' AND ac.source_id=t.source_id AND ac.club_id=t.club_id AND ac.user_id=t.user_id
    AND ac.amount=t.own_amount AND ac.commission_rate=t.rate AND ac.settled_at IS NULL)=0)
   OR (SELECT count(*) FROM public.agent_commissions ac WHERE ac.source_type='cash_rake_accrual' AND ac.source_id=t.source_id AND ac.user_id=t.user_id)<>CASE WHEN t.own_amount>0 THEN 1 ELSE 0 END)
  OR EXISTS(SELECT 1 FROM public.agent_commissions ac JOIN pg_temp._routed_sources s ON s.source_id=ac.source_id
   WHERE ac.source_type='cash_rake_accrual' AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_tiers t WHERE t.source_id=s.source_id AND t.user_id=ac.user_id AND t.own_amount=ac.amount))
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
 SELECT t.club_id,parent.user_id,t.user_id,sum((SELECT sum(child.own_amount) FROM pg_temp._routed_tiers child WHERE child.source_id=t.source_id AND child.depth<=t.depth)),min(t.role)
 FROM pg_temp._routed_tiers t LEFT JOIN pg_temp._routed_tiers parent ON parent.source_id=t.source_id AND parent.depth=t.depth+1
 GROUP BY t.club_id,parent.user_id,t.user_id
 HAVING sum((SELECT sum(child.own_amount) FROM pg_temp._routed_tiers child WHERE child.source_id=t.source_id AND child.depth<=t.depth))>0;
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
 -- never choose the route; only the persisted account identity is checked.
 PERFORM c.id FROM public.clubs c WHERE c.id IN(SELECT club_id FROM pg_temp._routed_sources) ORDER BY c.id FOR UPDATE;
 PERFORM cm.id FROM public.club_members cm JOIN pg_temp._routed_nodes n ON n.club_id=cm.club_id AND n.user_id=cm.user_id ORDER BY cm.club_id,cm.user_id FOR UPDATE OF cm;
 UPDATE pg_temp._routed_nodes n SET opening_balance=cm.chip_balance FROM public.club_members cm WHERE cm.club_id=n.club_id AND cm.user_id=n.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_nodes n WHERE n.opening_balance IS NULL OR n.opening_balance<0
  OR n.opening_balance::text IN('NaN','Infinity','-Infinity') OR n.opening_balance<>round(n.opening_balance,2)
  OR NOT EXISTS(SELECT 1 FROM public.agents a WHERE a.id=n.agent_id AND a.club_id=n.club_id AND a.user_id=n.user_id))
 THEN RAISE EXCEPTION 'routed_commission_wallet_identity_or_balance_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(amount) owed FROM pg_temp._routed_edges WHERE payer_user IS NULL GROUP BY club_id) e
  LEFT JOIN public.clubs c ON c.id=e.club_id WHERE c.chip_treasury IS NULL OR c.chip_treasury<e.owed
   OR c.chip_treasury::text IN('NaN','Infinity','-Infinity') OR c.chip_treasury<>round(c.chip_treasury,2))
 THEN RAISE EXCEPTION 'routed_commission_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',p_union_id::text||':'||p_period_start::text||':'||p_period_end::text,true);
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
    jsonb_build_object('routing_version',3,'period_start',p_period_start,'period_end',p_period_end,'payee_role_at_transfer',v_edge.role,
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
 result:=jsonb_build_object('success',true,'round',2,'name','recorded_commission_hierarchy','routing_version',3,'source_version',2,
  'payees',node_count,'amount',direct_total,'own_commission_amount',own_total,'downstream_amount',downstream_total,
  'shortfalls',0,'sources',source_count,'detail','[]'::jsonb);
 INSERT INTO public.accounting_routed_settlement_runs(union_id,period_start,period_end,round_no,source_fingerprint,result)
 VALUES(p_union_id,p_period_start,p_period_end,2,fingerprint,result);
 RETURN result;
END $function$;
-- Internal stages are called only by the single SECURITY DEFINER coordinator.
REVOKE ALL ON FUNCTION public.fn_settle_round2_club_to_agents(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_settle_round3_agents_to_players(p_union_id uuid,p_period_start timestamptz,p_period_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE r record;c public.accounting_rakeback_period_calculations%ROWTYPE;g record;
 previous public.accounting_routed_settlement_runs%ROWTYPE;fingerprint text;result jsonb;
 from_date date;to_date date;allocation_count int;matched_count int;actual_count int;
 generated numeric;unrounded numeric;display_rate numeric;amount numeric;paid numeric:=0;
 payer_before numeric;payer_after numeric;player_before numeric;player_after numeric;
 payout_id uuid;wallet_id uuid;ledger_id uuid;receipt_count int;payees int:=0;
 club_skip text;member_skip text;maintenance text;routing_context text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_union_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR p_period_start>=p_period_end OR p_period_end>now()-interval '5 minutes' THEN RAISE EXCEPTION 'routed_rakeback_invalid_period' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active) THEN RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 IF EXISTS(SELECT 1 FROM public.union_settlement_floor WHERE union_id=p_union_id AND p_period_start<earliest_period_start)
  OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_cutover WHERE singleton AND p_period_start>=starts_at)
 THEN RAISE EXCEPTION 'routed_rakeback_historical_period_uncertified' USING ERRCODE='55000'; END IF;
 from_date:=(p_period_start AT TIME ZONE 'America/Los_Angeles')::date;
 to_date:=(p_period_end AT TIME ZONE 'America/Los_Angeles')::date-1;
 IF p_period_start IS DISTINCT FROM public.fn_union_week_start(p_period_start)
  OR p_period_end IS DISTINCT FROM public.fn_union_week_start(p_period_start+interval '8 days')
 THEN RAISE EXCEPTION 'routed_rakeback_requires_one_accounting_week' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting:'||p_union_id::text||':'||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text,0));
 PERFORM public.fn_lock_rakeback_payer_clubs(ARRAY(SELECT club_id FROM public.union_clubs WHERE union_id=p_union_id UNION
  SELECT club_id FROM public.accounting_cash_rake_sources WHERE coordinator_union_id=p_union_id AND earned_at>=p_period_start AND earned_at<p_period_end ORDER BY club_id));
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_items(period_id uuid PRIMARY KEY,certificate_id bigint,club_id uuid,user_id uuid,
  payer_kind text,payer_user uuid,owed numeric,rake numeric,rate numeric,fingerprint text,status text) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_items;
 FOR r IN SELECT rp.* FROM public.rakeback_periods rp WHERE rp.period_start<=to_date AND rp.period_end>=from_date
  AND (rp.club_id IN(SELECT club_id FROM public.union_clubs WHERE union_id=p_union_id)
    OR EXISTS(SELECT 1 FROM public.accounting_cash_rake_sources rs WHERE rs.club_id=rp.club_id AND rs.player_id=rp.user_id
      AND rs.coordinator_union_id=p_union_id AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end))
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
  SELECT count(*),count(DISTINCT a->>'source_id'),sum((a->>'rake_credit')::numeric),sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric)
   INTO allocation_count,matched_count,generated,unrounded FROM jsonb_array_elements(c.source_allocations) a;
  SELECT count(*) INTO actual_count FROM public.accounting_cash_rake_sources rs WHERE rs.club_id=r.club_id AND rs.player_id=r.user_id
   AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end AND rs.coordinator_union_id=p_union_id;
  IF allocation_count=0 OR allocation_count<>matched_count OR allocation_count<>actual_count OR generated IS DISTINCT FROM c.rake_generated
    OR round(unrounded,2) IS DISTINCT FROM c.rakeback_amount
    OR c.display_rate IS DISTINCT FROM (CASE WHEN generated>0 THEN round(unrounded/generated,4) ELSE 0 END)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(c.source_allocations) a LEFT JOIN public.accounting_cash_rake_sources rs ON rs.id=(a->>'source_id')::uuid
     WHERE rs.id IS NULL OR rs.club_id<>r.club_id OR rs.player_id<>r.user_id OR rs.coordinator_union_id IS DISTINCT FROM p_union_id
      OR rs.earned_at<p_period_start OR rs.earned_at>=p_period_end OR rs.rake_credit IS DISTINCT FROM(a->>'rake_credit')::numeric
      OR rs.rake_record_id IS DISTINCT FROM(a->>'rake_record_id')::uuid
      OR (a->>'rate')::numeric IS NULL OR (a->>'rate')::numeric<0 OR (a->>'rate')::numeric>1
      OR (a->>'rate')::numeric::text IN('NaN','Infinity','-Infinity')
      OR a->>'payer_kind' IS DISTINCT FROM c.payer_kind OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM c.payer_user_id
      OR NULLIF(rs.contract->'membership'->'terms'->>'agent_id','')::uuid IS DISTINCT FROM c.payer_user_id)
  THEN RAISE EXCEPTION 'routed_rakeback_sources_disagree_with_certificate' USING ERRCODE='23514'; END IF;
  INSERT INTO pg_temp._routed_player_items VALUES(r.id,c.id,r.club_id,r.user_id,c.payer_kind,c.payer_user_id,c.rakeback_amount,c.rake_generated,c.display_rate,c.source_fingerprint,r.status);
 END LOOP;
 -- Missing periods are obligations too: every source player in this scope must
 -- have an admitted certificate, including zero-entitlement players.
 IF EXISTS(SELECT 1 FROM public.accounting_cash_rake_sources rs WHERE rs.coordinator_union_id=p_union_id
   AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
   AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id))
 THEN RAISE EXCEPTION 'routed_rakeback_player_period_missing' USING ERRCODE='55000'; END IF;
 SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(i.period_id,i.certificate_id,i.club_id,i.user_id,i.payer_kind,i.payer_user,i.owed,i.rake,i.rate,i.fingerprint) ORDER BY i.period_id),'[]'::jsonb)::text)
  INTO fingerprint FROM pg_temp._routed_player_items i;
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE union_id=p_union_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=3;
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
 PERFORM cm.id FROM public.club_members cm JOIN pg_temp._routed_player_wallets w ON w.club_id=cm.club_id AND w.user_id=cm.user_id
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
 PERFORM set_config('app.accounting_routing_context',p_union_id::text||':'||p_period_start::text||':'||p_period_end::text,true);
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
     'round3-period:v3:'||r.period_id::text,jsonb_build_object('routing_version',3,'period_id',r.period_id,'period_start',p_period_start,'period_end',p_period_end,
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
 result:=jsonb_build_object('success',true,'round',3,'name','certified_payer_to_players','routing_version',3,'source_version',2,
  'amount',paid,'payees',payees,'shortfalls',0,'periods',(SELECT count(*) FROM pg_temp._routed_player_items),'detail','[]'::jsonb);
 INSERT INTO public.accounting_routed_settlement_runs(union_id,period_start,period_end,round_no,source_fingerprint,result)
  VALUES(p_union_id,p_period_start,p_period_end,3,fingerprint,result);
 RETURN result;
END $function$;
REVOKE ALL ON FUNCTION public.fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
