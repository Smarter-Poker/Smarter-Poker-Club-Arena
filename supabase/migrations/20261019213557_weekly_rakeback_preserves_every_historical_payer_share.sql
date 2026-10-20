-- @live-proof: (md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='fa489e420cf45112efe0b1e709fb4827' AND md5(pg_get_functiondef('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure))='715379f789f90ee224118581eac81353' AND md5(pg_get_functiondef('smarter_private.deleted_wallet_published_rakeback_reserve(uuid,uuid)'::regprocedure))='0257fa521e81c9d889449b428fd1e72c' AND md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_window(uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='972a500c104aa969b2358887dc1a9407' AND md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_plan(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='3a6e5c361831c329349e4cac35ef8c14' AND md5(pg_get_functiondef('public.fn_ca_rakeback_payout_leg_is_documented()'::regprocedure))='acd6934686f69e1647302357cfd99a3f' AND md5(pg_get_functiondef('public.fn_rakeback_split_check(uuid,date,date,uuid[])'::regprocedure))='681c6a50ca00031cc5826c8be9f8da7d' AND md5(pg_get_functiondef('public.fn_rakeback_split_write(uuid,date,date,uuid[])'::regprocedure))='56dabde9e00f5283a882c5c74fb3e6c4' AND md5(pg_get_functiondef('public.ca_player_stats_financial_report(uuid,uuid,integer,text,text)'::regprocedure))='2576399c7ff0510ed6fab2a4d70e17fc' AND md5(pg_get_functiondef('public.fn_ca_settlement_correctness_check()'::regprocedure))='6b151d00df78c2857dcc05f9abd1ff8d' AND md5(pg_get_functiondef('smarter_private.rakeback_payer_plan(jsonb,numeric)'::regprocedure))='02296e698ad2377afa9dc4ee18315d68' AND md5(pg_get_functiondef('smarter_private.record_rakeback_payer_contracts()'::regprocedure))='82ca3dd2e58a1601f38749ac67105197' AND md5(pg_get_functiondef('smarter_private.rakeback_certificate_payers(bigint)'::regprocedure))='89b7297462b6cd4ba6bf145c7d5fa261' AND md5(pg_get_functiondef('smarter_private.split_rakeback_payout_complete(uuid,bigint)'::regprocedure))='a0e0b8e893456565add9fa7494397711' AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='accounting_rakeback_payer_contracts_at_calculation' AND tgrelid='public.accounting_rakeback_period_calculations'::regclass AND tgenabled='O') AND NOT has_table_privilege('service_role','public.accounting_rakeback_payer_contracts','INSERT') AND has_function_privilege('authenticated','public.ca_player_stats_financial_report(uuid,uuid,integer,text,text)','EXECUTE') AND EXISTS(SELECT 1 FROM public.ca_guard_defs WHERE proname='fn_ca_settlement_correctness_check' AND def_hash='6b151d00df78c2857dcc05f9abd1ff8d' AND declared_ref='migration 20261019213557_weekly_rakeback_preserves_every_historical_payer_share'))
-- 20261019213557_weekly_rakeback_preserves_every_historical_payer_share.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

-- A player keeps one weekly period and the SAME cent-rounded entitlement.
-- Historical payers fund their own source products inside that period's
-- original R3 transaction. Fractional cents are allocated by descending
-- remainder, then payer kind/entity identity, so the parts equal the original
-- ROUND(SUM(source products),2). No second payment path or clearing wallet.
CREATE FUNCTION smarter_private.rakeback_payer_plan(p_allocations jsonb,p_amount numeric)
 RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $plan$
DECLARE result jsonb;expected numeric;
BEGIN
 IF jsonb_typeof(p_allocations) IS DISTINCT FROM 'array' OR jsonb_array_length(p_allocations)=0
 OR p_amount IS NULL OR p_amount<0 OR p_amount<>round(p_amount,2) OR p_amount::text IN('NaN','Infinity','-Infinity')
 THEN RAISE EXCEPTION 'rakeback_payer_plan_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_allocations)a
  WHERE a->>'payer_kind' IS NULL OR a->>'payer_kind' NOT IN('club','agent')
   OR (a->>'payer_kind'='agent') IS DISTINCT FROM(NULLIF(a->>'payer_user_id','') IS NOT NULL)
   OR (a->>'rake_credit')::numeric IS NULL OR (a->>'rake_credit')::numeric<0
   OR (a->>'rake_credit')::numeric<>round((a->>'rake_credit')::numeric,2)
   OR (a->>'rate')::numeric IS NULL OR (a->>'rate')::numeric<0 OR (a->>'rate')::numeric>1
   OR (a->>'rake_credit')::numeric::text IN('NaN','Infinity','-Infinity')
   OR (a->>'rate')::numeric::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'rakeback_payer_allocation_invalid' USING ERRCODE='23514'; END IF;
 SELECT round(sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric),2) INTO expected
 FROM jsonb_array_elements(p_allocations)a;
 IF expected IS DISTINCT FROM p_amount THEN RAISE EXCEPTION 'rakeback_payer_total_disagrees' USING ERRCODE='23514'; END IF;
 WITH g AS(
  SELECT a->>'payer_kind' kind,NULLIF(a->>'payer_user_id','')::uuid payer,
   sum((a->>'rake_credit')::numeric) rake,sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric) unrounded,count(*) n
  FROM jsonb_array_elements(p_allocations)a GROUP BY a->>'payer_kind',NULLIF(a->>'payer_user_id','')::uuid
 ), cents AS(
  SELECT g.*,floor(unrounded*100) whole,
   row_number() OVER(ORDER BY unrounded*100-floor(unrounded*100) DESC,kind,payer NULLS FIRST) remainder_rank,
   p_amount*100-sum(floor(unrounded*100)) OVER() extra FROM g
 )SELECT jsonb_agg(jsonb_build_object('payer_kind',kind,'payer_user_id',payer,'rake',rake,
   'unrounded',unrounded,'source_count',n,'amount',(whole+CASE WHEN remainder_rank<=extra THEN 1 ELSE 0 END)/100)
   ORDER BY kind,payer NULLS FIRST) INTO result FROM cents;
 RETURN result;
END $plan$;
REVOKE ALL ON FUNCTION smarter_private.rakeback_payer_plan(jsonb,numeric) FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE public.accounting_rakeback_payer_contracts(
 calculation_id bigint NOT NULL,
 payer_kind text NOT NULL CHECK(payer_kind IN('agent','club')),
 payer_entity_id uuid NOT NULL,
 payer_user_id uuid,
 amount numeric NOT NULL CHECK(amount>=0 AND amount=round(amount,2)),
 unrounded numeric NOT NULL CHECK(unrounded>=0),
 rake numeric NOT NULL CHECK(rake>=0 AND rake=round(rake,2)),
 source_count bigint NOT NULL CHECK(source_count>0),
 source_fingerprint text NOT NULL,
 PRIMARY KEY(calculation_id,payer_kind,payer_entity_id),
 CHECK((payer_kind='agent')=(payer_user_id IS NOT NULL))
);
CREATE INDEX accounting_rakeback_payer_user ON public.accounting_rakeback_payer_contracts(payer_user_id,calculation_id);
ALTER TABLE public.accounting_rakeback_payer_contracts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_rakeback_payer_contracts FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER accounting_rakeback_payer_contract_immutable BEFORE UPDATE OR DELETE ON public.accounting_rakeback_payer_contracts
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_rakeback_payer_contract_no_truncate BEFORE TRUNCATE ON public.accounting_rakeback_payer_contracts
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();

CREATE FUNCTION smarter_private.record_rakeback_payer_contracts()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $record$
DECLARE plan jsonb;
BEGIN
 plan:=smarter_private.rakeback_payer_plan(NEW.source_allocations,NEW.rakeback_amount);
 IF NEW.payer_kind='split' THEN
  IF NEW.payer_user_id IS NOT NULL OR jsonb_array_length(plan)<2
  THEN RAISE EXCEPTION 'split_rakeback_payers_required' USING ERRCODE='23514'; END IF;
 ELSIF jsonb_array_length(plan)<>1 OR plan->0->>'payer_kind' IS DISTINCT FROM NEW.payer_kind
  OR NULLIF(plan->0->>'payer_user_id','')::uuid IS DISTINCT FROM NEW.payer_user_id
 THEN RAISE EXCEPTION 'rakeback_certificate_payer_disagrees' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(plan)p WHERE NULLIF(p->>'payer_user_id','')::uuid=NEW.player_id)
 THEN RAISE EXCEPTION 'rakeback_player_cannot_pay_self' USING ERRCODE='23514'; END IF;
 INSERT INTO public.accounting_rakeback_payer_contracts(calculation_id,payer_kind,payer_entity_id,payer_user_id,amount,unrounded,rake,source_count,source_fingerprint)
 SELECT NEW.id,p->>'payer_kind',COALESCE(NULLIF(p->>'payer_user_id','')::uuid,NEW.club_id),NULLIF(p->>'payer_user_id','')::uuid,
  (p->>'amount')::numeric,(p->>'unrounded')::numeric,(p->>'rake')::numeric,(p->>'source_count')::bigint,NEW.source_fingerprint
 FROM jsonb_array_elements(plan)p;
 RETURN NULL;
END $record$;
REVOKE ALL ON FUNCTION smarter_private.record_rakeback_payer_contracts() FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public.accounting_rakeback_period_calculations DROP CONSTRAINT accounting_rakeback_period_calculations_payer_kind_check;
ALTER TABLE public.accounting_rakeback_period_calculations ADD CONSTRAINT accounting_rakeback_period_calculations_payer_kind_check CHECK(payer_kind IN('agent','club','split'));
CREATE TRIGGER accounting_rakeback_payer_contracts_at_calculation AFTER INSERT ON public.accounting_rakeback_period_calculations
 FOR EACH ROW EXECUTE FUNCTION smarter_private.record_rakeback_payer_contracts();

-- Per-payer evidence belongs to the one original payout. No hot-table foreign
-- keys: the original deferred leg guard proves every identity and conservation.
CREATE TABLE public.accounting_rakeback_payer_transfers(
 payout_id uuid NOT NULL,
 calculation_id bigint NOT NULL,
 period_id uuid NOT NULL,
 payer_kind text NOT NULL CHECK(payer_kind IN('agent','club')),
 payer_entity_id uuid NOT NULL,
 amount numeric NOT NULL CHECK(amount>0 AND amount=round(amount,2)),
 ledger_id uuid NOT NULL UNIQUE,
 wallet_transaction_id uuid NOT NULL UNIQUE,
 PRIMARY KEY(payout_id,payer_kind,payer_entity_id)
);
ALTER TABLE public.accounting_rakeback_payer_transfers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_rakeback_payer_transfers FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER accounting_rakeback_payer_transfer_immutable BEFORE UPDATE OR DELETE ON public.accounting_rakeback_payer_transfers
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_rakeback_payer_transfer_no_truncate BEFORE TRUNCATE ON public.accounting_rakeback_payer_transfers
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();

CREATE FUNCTION smarter_private.rakeback_certificate_payers(p_calculation bigint)
 RETURNS TABLE(payer_kind text,payer_user uuid,payer_entity uuid,owed numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $payers$
DECLARE c public.accounting_rakeback_period_calculations%ROWTYPE;plan jsonb;
BEGIN
 SELECT * INTO STRICT c FROM public.accounting_rakeback_period_calculations WHERE id=p_calculation;
 IF c.payer_kind<>'split' THEN
  IF c.payer_kind NOT IN('agent','club') OR(c.payer_kind='agent')IS DISTINCT FROM(c.payer_user_id IS NOT NULL)
  THEN RAISE EXCEPTION 'rakeback_certificate_payer_invalid' USING ERRCODE='23514'; END IF;
  RETURN QUERY SELECT c.payer_kind,c.payer_user_id,COALESCE(c.payer_user_id,c.club_id),c.rakeback_amount;RETURN;
 END IF;
 plan:=smarter_private.rakeback_payer_plan(c.source_allocations,c.rakeback_amount);
 IF jsonb_array_length(plan)<2 OR c.payer_user_id IS NOT NULL
  OR(SELECT count(*)FROM public.accounting_rakeback_payer_contracts g WHERE g.calculation_id=c.id)<>jsonb_array_length(plan)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(plan)p LEFT JOIN public.accounting_rakeback_payer_contracts g
   ON g.calculation_id=c.id AND g.payer_kind=p->>'payer_kind' AND g.payer_entity_id=COALESCE(NULLIF(p->>'payer_user_id','')::uuid,c.club_id)
   WHERE g.calculation_id IS NULL OR g.payer_user_id IS DISTINCT FROM NULLIF(p->>'payer_user_id','')::uuid
    OR g.amount IS DISTINCT FROM(p->>'amount')::numeric OR g.unrounded IS DISTINCT FROM(p->>'unrounded')::numeric
    OR g.rake IS DISTINCT FROM(p->>'rake')::numeric OR g.source_count IS DISTINCT FROM(p->>'source_count')::bigint
    OR g.source_fingerprint IS DISTINCT FROM c.source_fingerprint OR g.payer_user_id=c.player_id)
 THEN RAISE EXCEPTION 'split_rakeback_payer_contracts_disagree' USING ERRCODE='23514'; END IF;
 RETURN QUERY SELECT g.payer_kind,g.payer_user_id,g.payer_entity_id,g.amount FROM public.accounting_rakeback_payer_contracts g
  WHERE g.calculation_id=c.id ORDER BY g.payer_kind,g.payer_entity_id;
END $payers$;
REVOKE ALL ON FUNCTION smarter_private.rakeback_certificate_payers(bigint) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.split_rakeback_payout_complete(p_payout uuid,p_calculation bigint)
 RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $complete$
DECLARE pp public.rakeback_period_payouts%ROWTYPE;c public.accounting_rakeback_period_calculations%ROWTYPE;
BEGIN
 SELECT * INTO pp FROM public.rakeback_period_payouts WHERE id=p_payout;
 SELECT * INTO c FROM public.accounting_rakeback_period_calculations WHERE id=p_calculation;
 IF pp.id IS NULL OR c.id IS NULL OR c.payer_kind IS DISTINCT FROM 'split' OR pp.status IS DISTINCT FROM 'paid'
  OR pp.rakeback_period_id IS DISTINCT FROM c.period_id OR pp.club_id IS DISTINCT FROM c.club_id
  OR pp.user_id IS DISTINCT FROM c.player_id OR pp.payout_amount IS DISTINCT FROM c.rakeback_amount
  OR NOT EXISTS(SELECT 1 FROM public.rakeback_periods r WHERE r.id=c.period_id AND r.status='paid')
 THEN RETURN false; END IF;
 IF(SELECT count(*)FROM public.accounting_rakeback_payer_transfers t WHERE t.payout_id=pp.id)
   <>(SELECT count(*)FROM smarter_private.rakeback_certificate_payers(c.id)g WHERE g.owed>0)
 THEN RETURN false; END IF;
 RETURN NOT EXISTS(
 SELECT 1 FROM smarter_private.rakeback_certificate_payers(c.id)g
 LEFT JOIN public.accounting_rakeback_payer_transfers t ON t.payout_id=pp.id AND t.payer_kind=g.payer_kind AND t.payer_entity_id=g.payer_entity
 LEFT JOIN public.chip_ledger l ON l.id=t.ledger_id
 LEFT JOIN public.wallet_transactions w ON w.id=t.wallet_transaction_id
 WHERE g.owed>0 AND(t.payout_id IS NULL OR t.calculation_id IS DISTINCT FROM c.id OR t.period_id IS DISTINCT FROM c.period_id
  OR t.amount IS DISTINCT FROM g.owed OR l.amount IS DISTINCT FROM g.owed OR l.club_id IS DISTINCT FROM c.club_id
  OR l.from_entity_id IS DISTINCT FROM g.payer_entity OR l.from_type IS DISTINCT FROM CASE WHEN g.payer_kind='club' THEN 'club_treasury' ELSE 'player_wallet' END
  OR l.to_type IS DISTINCT FROM 'player_wallet' OR l.to_entity_id IS DISTINCT FROM c.player_id OR l.category IS DISTINCT FROM 'rakeback' OR l.status IS DISTINCT FROM 'posted'
  OR l.idempotency_key IS DISTINCT FROM 'round3-period:v3:'||c.period_id::text||':payer:'||g.payer_kind||':'||g.payer_entity::text
  OR l.metadata->>'certificate_id' IS DISTINCT FROM c.id::text OR l.metadata->>'payout_id' IS DISTINCT FROM pp.id::text
  OR l.metadata->>'period_id' IS DISTINCT FROM c.period_id::text OR l.metadata->>'source_fingerprint' IS DISTINCT FROM c.source_fingerprint
  OR l.pre_from_balance-l.post_from_balance IS DISTINCT FROM g.owed OR l.post_to_balance-l.pre_to_balance IS DISTINCT FROM g.owed
  OR w.user_id IS DISTINCT FROM c.player_id OR w.type IS DISTINCT FROM 'credit' OR w.amount IS DISTINCT FROM g.owed
  OR w.wallet_type IS DISTINCT FROM 'PLAYER' OR w.category IS DISTINCT FROM 'rakeback'
  OR w.related_entity_id IS DISTINCT FROM pp.id OR w.balance_after IS DISTINCT FROM l.post_to_balance
  OR(g.payer_kind='agent' AND(SELECT count(*)FROM public.wallet_transactions wd WHERE wd.related_entity_id=pp.id
    AND wd.user_id=g.payer_user AND wd.wallet_type='PLAYER' AND wd.type='debit' AND wd.category='rakeback'
    AND wd.amount=g.owed AND wd.balance_after=l.post_from_balance)<>1)
  OR(SELECT count(*)FROM public.settlement_invoices i WHERE i.source_ledger_id=l.id AND i.status='paid' AND i.chips_transferred
    AND i.message_sent AND i.gross_amount=g.owed AND i.net_amount=g.owed AND i.deductions=0)<>1));
EXCEPTION WHEN check_violation OR data_exception OR no_data_found THEN
 RETURN false;
END $complete$;
REVOKE ALL ON FUNCTION smarter_private.split_rakeback_payout_complete(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;









-- Qualified original owners follow.
DO $owner$ BEGIN IF md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'d880a99b18d966c092f5d5fb6f2ee98b' OR(SELECT pg_get_userbyid(proowner)FROM pg_proc WHERE oid='public.fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)IS DISTINCT FROM 'postgres' OR(SELECT proacl::text FROM pg_proc WHERE oid='public.fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)IS DISTINCT FROM '{postgres=X/postgres}' THEN RAISE EXCEPTION 'historical_rakeback_payer_owner_changed: fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone)'; END IF; END $owner$;
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
 v_plan jsonb;v_plan_used boolean:=false;v_batched boolean:=false;v_stop timestamptz;v_remaining bigint:=0;
 v_paid_before numeric:=0;v_payees_before int:=0;
 deleted_deferral text; v_deleted record; v_deleted_before numeric; v_deleted_held numeric; v_deleted_locked numeric;
 v_deleted_bank numeric; v_deleted_return jsonb;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_period_start IS NULL OR p_period_end IS NULL OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR p_period_start>=p_period_end OR p_period_end>now()-interval '5 minutes' THEN RAISE EXCEPTION 'routed_rakeback_invalid_period' USING ERRCODE='22023'; END IF;
 IF public.fn_ca_launch_accounting_waived(p_scope_kind,p_scope_id,p_period_end) THEN
  RETURN jsonb_build_object('success',true,'waived',true,'paid',false,'reason','owner_directed_launch_waiver');
 END IF;
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
 -- CHUNKED CLOSE (20261003, round 3 read once): in a chunked close attempt the
 -- week's reads and allocation tests may come from the attempt that read them
 -- (fn_settle_accounting_rakeback_plan); see below for when they are used.
 v_plan:=public.fn_settle_accounting_rakeback_plan_get(p_scope_kind,p_scope_id,p_period_start,p_period_end,scope.club_ids,p_union_id,standalone_club,legacy_paid_cash_replay);
 CREATE TEMP TABLE IF NOT EXISTS _rr3_plan_nonhouse(club_id uuid,player_id uuid,PRIMARY KEY(club_id,player_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._rr3_plan_nonhouse;
 CREATE TEMP TABLE IF NOT EXISTS _rr3_week_v4(source_type text,source_id uuid,club_id uuid,player_id uuid,coordinator_union_id uuid,earned_at timestamptz,
    rake_credit numeric,rake_record_id uuid,agent_text text,house_text text,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
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
  -- WEEKLY CLOSE SCALE (20261003): a period of a club outside scope.club_ids
  -- is admitted when this scope earned from its player in the week. Those
  -- (club, player) pairs are read once, for exactly the clubs of such
  -- periods, in this same statement, instead of a scan of the club's whole
  -- week of sources per period (887 s in the 2026-10-01 Midway close: 382
  -- standalone periods). A period whose club is not in that set (only a row
  -- changed under EvalPlanQual) still asks the sources directly.
  INSERT INTO pg_temp._rr3_periods_v4 SELECT row_number() OVER(ORDER BY x.club_id,x.user_id,x.id),x.*
   FROM (WITH pclubs AS MATERIALIZED (SELECT DISTINCT p2.club_id FROM public.rakeback_periods p2
      WHERE p2.period_start<=to_date AND p2.period_end>=from_date AND p2.club_id IS NOT NULL AND (p2.club_id=ANY(scope.club_ids)) IS NOT TRUE),
    pairs AS MATERIALIZED (SELECT DISTINCT rs.club_id,rs.player_id FROM public.accounting_payable_earning_sources rs
      WHERE rs.club_id IN(SELECT pc.club_id FROM pclubs pc)
      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
      AND v_plan IS NULL
     UNION SELECT (e->>0)::uuid,(e->>1)::uuid FROM jsonb_array_elements(v_plan->'pairs') e
      WHERE v_plan IS NOT NULL AND (e->>0)::uuid IN(SELECT pc.club_id FROM pclubs pc))
   SELECT rp.* FROM public.rakeback_periods rp WHERE rp.period_start<=to_date AND rp.period_end>=from_date
  AND (rp.club_id=ANY(scope.club_ids)
    OR CASE WHEN rp.club_id IN(SELECT pc.club_id FROM pclubs pc)
     THEN EXISTS(SELECT 1 FROM pairs q WHERE q.club_id=rp.club_id AND q.player_id=rp.user_id)
     ELSE EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE rs.club_id=rp.club_id AND rs.player_id=rp.user_id
      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end) END)
  ORDER BY rp.club_id,rp.user_id,rp.id FOR UPDATE OF rp) x;
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
   OR pc.rakeback_amount::text IN('NaN','Infinity','-Infinity') OR pc.payer_kind NOT IN('agent','club','split')
   OR (pc.payer_kind='agent') IS DISTINCT FROM(pc.payer_user_id IS NOT NULL) OR pc.payer_user_id=pr.user_id,false))=0 THEN
   CREATE TEMP TABLE IF NOT EXISTS _rr3_wn_v4(club_id uuid,player_id uuid,n bigint,PRIMARY KEY(club_id,player_id)) ON COMMIT DROP;
   TRUNCATE pg_temp._rr3_wn_v4;
   IF v_plan IS NOT NULL THEN
    CREATE TEMP TABLE IF NOT EXISTS _rr3_plan_alloc(period_id uuid PRIMARY KEY,cert_id bigint,club_id uuid,user_id uuid,allocation_count bigint,matched_count bigint,
     generated numeric,unrounded numeric,any_bad boolean) ON COMMIT DROP;
    TRUNCATE pg_temp._rr3_plan_alloc;
    INSERT INTO pg_temp._rr3_plan_alloc SELECT (e->>0)::uuid,(e->>1)::bigint,(e->>2)::uuid,(e->>3)::uuid,(e->>4)::bigint,(e->>5)::bigint,
     (e->>6)::numeric,(e->>7)::numeric,(e->>8)::boolean FROM jsonb_array_elements(v_plan->'alloc') e;
    IF NOT EXISTS(SELECT 1 FROM pg_temp._rr3_periods_v4 pr JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=pr.id
      WHERE NOT EXISTS(SELECT 1 FROM pg_temp._rr3_plan_alloc a WHERE a.period_id=pr.id AND a.cert_id=pc.id AND a.club_id=pr.club_id AND a.user_id=pr.user_id)) THEN
     v_plan_used:=true;
    END IF;
   END IF;
   IF NOT v_plan_used THEN
   CREATE TEMP TABLE IF NOT EXISTS _rr3_week_v4(source_type text,source_id uuid,club_id uuid,player_id uuid,coordinator_union_id uuid,earned_at timestamptz,
    rake_credit numeric,rake_record_id uuid,agent_text text,house_text text,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
   TRUNCATE pg_temp._rr3_week_v4;
   -- house_text (20261003): the source's is_union_house as written, read in
   -- this one pass so the missing-period check below need not read the week
   -- of sources again.
   INSERT INTO pg_temp._rr3_week_v4 SELECT rs.source_type,rs.source_id,rs.club_id,rs.player_id,rs.coordinator_union_id,rs.earned_at,rs.rake_credit,rs.rake_record_id,
    (CASE WHEN (((rs.contract#>>'{membership,terms,player_rakeback_pct}')::numeric=0.70 OR rs.contract->'tiers'->0 IS NULL) AND EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=rs.club_id AND owner_club.owner_id=NULLIF(rs.contract#>>'{membership,terms,agent_id}','')::uuid)) THEN NULL::uuid ELSE NULLIF(rs.contract#>>'{membership,terms,agent_id}','')::uuid END)::text,rs.contract->>'is_union_house'
    FROM public.accounting_payable_earning_sources rs WHERE rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
     AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club));
   ANALYZE pg_temp._rr3_week_v4;
   END IF;
   CREATE TEMP TABLE IF NOT EXISTS _rr3_alloc_v4(period_id uuid PRIMARY KEY,allocation_count bigint,matched_count bigint,generated numeric,unrounded numeric,any_bad boolean) ON COMMIT DROP;
   TRUNCATE pg_temp._rr3_alloc_v4;
   -- A source of this allocation that is not in this scope's week slice is
   -- outside the scope or the week, which the original test refuses too.
   IF v_plan_used THEN
    INSERT INTO pg_temp._rr3_alloc_v4 SELECT a.period_id,a.allocation_count,a.matched_count,a.generated,a.unrounded,a.any_bad
     FROM pg_temp._rr3_plan_alloc a JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=a.period_id AND pc.id=a.cert_id;
    INSERT INTO pg_temp._rr3_wn_v4 SELECT (e->>0)::uuid,(e->>1)::uuid,(e->>2)::bigint FROM jsonb_array_elements(v_plan->'counts') e;
    INSERT INTO pg_temp._rr3_plan_nonhouse SELECT (e->>0)::uuid,(e->>1)::uuid FROM jsonb_array_elements(v_plan->'nonhouse') e;
   ELSE
   INSERT INTO pg_temp._rr3_alloc_v4 SELECT pc.period_id,count(*),
    count(DISTINCT ROW(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END),a->>'source_id')),
    sum((a->>'rake_credit')::numeric),sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric),
    COALESCE(bool_or(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) IS NULL OR COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) NOT IN('cash_rake_accrual','tournament_fee_accrual')
      OR rs.source_id IS NULL OR rs.club_id<>pr.club_id OR rs.player_id<>pr.user_id OR rs.coordinator_union_id IS DISTINCT FROM p_union_id
      OR rs.earned_at<p_period_start OR rs.earned_at>=p_period_end OR rs.rake_credit IS DISTINCT FROM(a->>'rake_credit')::numeric
      OR rs.rake_record_id IS DISTINCT FROM(a->>'rake_record_id')::uuid
      OR (a->>'rate')::numeric IS NULL OR (a->>'rate')::numeric<0 OR (a->>'rate')::numeric>1
      OR (a->>'rate')::numeric::text IN('NaN','Infinity','-Infinity')
      OR (pc.payer_kind<>'split' AND(a->>'payer_kind' IS DISTINCT FROM pc.payer_kind OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM pc.payer_user_id)) OR (pc.payer_kind='split' AND(a->>'payer_kind' NOT IN('agent','club') OR(a->>'payer_kind'='agent') IS DISTINCT FROM(NULLIF(a->>'payer_user_id','')IS NOT NULL)))
      OR NULLIF(rs.agent_text,'')::uuid IS DISTINCT FROM NULLIF(a->>'payer_user_id','')::uuid),false)
    FROM pg_temp._rr3_certs_v4 pc JOIN pg_temp._rr3_periods_v4 pr ON pr.id=pc.period_id
    JOIN public.accounting_rakeback_period_calculations cc ON cc.id=pc.id
    CROSS JOIN LATERAL jsonb_array_elements(cc.source_allocations) a
    LEFT JOIN pg_temp._rr3_week_v4 rs ON rs.source_type=COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) AND rs.source_id=(a->>'source_id')::uuid
    GROUP BY pc.period_id;
   INSERT INTO pg_temp._rr3_wn_v4 SELECT w.club_id,w.player_id,count(*) FROM pg_temp._rr3_week_v4 w GROUP BY w.club_id,w.player_id;
   END IF;
   IF (SELECT count(*) FROM pg_temp._rr3_periods_v4 pr JOIN pg_temp._rr3_certs_v4 pc ON pc.period_id=pr.id
     LEFT JOIN pg_temp._rr3_alloc_v4 ag ON ag.period_id=pr.id
     LEFT JOIN pg_temp._rr3_wn_v4 w ON w.club_id=pr.club_id AND w.player_id=pr.user_id
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
   OR c.rakeback_amount::text IN('NaN','Infinity','-Infinity') OR c.payer_kind NOT IN('agent','club','split')
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
      OR (c.payer_kind<>'split' AND(a->>'payer_kind' IS DISTINCT FROM c.payer_kind OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM c.payer_user_id)) OR (c.payer_kind='split' AND(a->>'payer_kind' NOT IN('agent','club') OR(a->>'payer_kind'='agent') IS DISTINCT FROM(NULLIF(a->>'payer_user_id','')IS NOT NULL)))
      OR (CASE WHEN (((rs.contract#>>'{membership,terms,player_rakeback_pct}')::numeric=0.70 OR rs.contract->'tiers'->0 IS NULL) AND EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=rs.club_id AND owner_club.owner_id=NULLIF(rs.contract#>>'{membership,terms,agent_id}','')::uuid)) THEN NULL::uuid ELSE NULLIF(rs.contract#>>'{membership,terms,agent_id}','')::uuid END) IS DISTINCT FROM NULLIF(a->>'payer_user_id','')::uuid)
  THEN RAISE EXCEPTION 'routed_rakeback_sources_disagree_with_certificate' USING ERRCODE='23514'; END IF;
  INSERT INTO pg_temp._routed_player_items VALUES(r.id,c.id,r.club_id,r.user_id,c.payer_kind,c.payer_user_id,c.rakeback_amount,c.rake_generated,c.display_rate,c.source_fingerprint,r.status);
 END LOOP;
 END IF;
 -- Missing periods are obligations too: every source player in this scope must
 -- have an admitted certificate, including zero-entitlement players.
 -- 20261003: when the set path admitted the book, _rr3_week_v4 holds exactly
 -- these rows (same predicate, read under this scope's week lock, which every
 -- accrual of the week shares), so they are not read a second time.
 PERFORM set_config('app.accounting_round3_plan_used',CASE WHEN v4_ok AND v_plan_used THEN 'on' ELSE '' END,true);
 IF (CASE WHEN v4_ok AND v_plan_used THEN EXISTS(SELECT 1 FROM pg_temp._rr3_plan_nonhouse rs
     WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id))
  WHEN v4_ok THEN EXISTS(SELECT 1 FROM pg_temp._rr3_week_v4 rs
    WHERE COALESCE((rs.house_text)::boolean,false) IS FALSE
     AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id))
  ELSE EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club))
   AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
   AND COALESCE((rs.contract->>'is_union_house')::boolean,false) IS FALSE
   AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id)) END)
 THEN RAISE EXCEPTION 'routed_rakeback_player_period_missing' USING ERRCODE='55000'; END IF;
 SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(i.period_id,i.certificate_id,i.club_id,i.user_id,i.payer_kind,i.payer_user,i.owed,i.rake,i.rate,i.fingerprint) ORDER BY i.period_id),'[]'::jsonb)::text)
  INTO fingerprint FROM pg_temp._routed_player_items i;
 SELECT * INTO previous FROM public.accounting_routed_settlement_runs
  WHERE scope_kind=p_scope_kind AND scope_id=p_scope_id AND period_start=p_period_start AND period_end=p_period_end AND round_no=3;
 IF FOUND THEN
  IF previous.source_fingerprint<>fingerprint OR EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.status<>'paid' OR NOT EXISTS(
   SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id AND pp.user_id=i.user_id AND pp.club_id=i.club_id AND pp.status='paid' AND pp.payout_amount=i.owed AND(CASE WHEN i.payer_kind='split' THEN smarter_private.split_rakeback_payout_complete(pp.id,i.certificate_id) ELSE true END)))
  THEN RAISE EXCEPTION 'routed_rakeback_changed_after_payment' USING ERRCODE='55000'; END IF;
  RETURN previous.result||jsonb_build_object('duplicate',true);
 END IF;
 -- CHUNKED CLOSE (20261003, round 3 in batches): inside a chunked close attempt
 -- a period an earlier batch of THIS round paid is recognised by its own
 -- evidence and not paid again; outside one nothing is.
 v_batched:=COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'
  AND NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NOT NULL;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_done(period_id uuid PRIMARY KEY) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_done;
 IF v_batched THEN
  INSERT INTO pg_temp._routed_player_done SELECT i.period_id FROM pg_temp._routed_player_items i
   WHERE i.status='paid' AND (SELECT count(*) FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id)=1
    AND EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id AND pp.club_id=i.club_id AND pp.user_id=i.user_id
     AND pp.status='paid' AND pp.payout_amount=i.owed
     AND CASE WHEN i.payer_kind='split' THEN smarter_private.split_rakeback_payout_complete(pp.id,i.certificate_id) WHEN i.owed>0 THEN EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.idempotency_key='round3-period:v3:'||i.period_id::text
       AND l.amount=i.owed AND l.club_id=i.club_id AND l.to_type='player_wallet' AND l.to_entity_id=i.user_id AND l.category='rakeback'
       AND l.metadata->>'accounting_scope_kind'=p_scope_kind AND l.metadata->>'accounting_scope_id'=p_scope_id::text
       AND l.metadata->>'certificate_id'=i.certificate_id::text AND l.metadata->>'payout_id'=pp.id::text
       AND l.metadata->>'source_fingerprint' IS NOT DISTINCT FROM i.fingerprint) ELSE true END);
 END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_todo(LIKE pg_temp._routed_player_items) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_todo;
 INSERT INTO pg_temp._routed_player_todo SELECT i.* FROM pg_temp._routed_player_items i
  WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_done d WHERE d.period_id=i.period_id);
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_now(period_id uuid PRIMARY KEY) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_now;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_todo i WHERE i.status IS DISTINCT FROM 'pending'
   OR EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=i.period_id))
  OR EXISTS(SELECT 1 FROM public.union_settlement_rounds sr WHERE sr.union_id=p_union_id AND sr.round_no=3
   AND sr.period_start<p_period_end AND sr.period_end>p_period_start AND (sr.amount>0 OR sr.payees>0 OR sr.shortfalls>0))
 THEN RAISE EXCEPTION 'legacy_rakeback_payment_requires_reconciliation' USING ERRCODE='55000'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_funding(period_id uuid,payer_kind text,payer_user uuid,payer_entity uuid,owed numeric,club_id uuid,PRIMARY KEY(period_id,payer_kind,payer_entity)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_funding;
 INSERT INTO pg_temp._routed_player_funding SELECT i.period_id,fp.payer_kind,fp.payer_user,fp.payer_entity,fp.owed,i.club_id
 FROM pg_temp._routed_player_todo i CROSS JOIN LATERAL smarter_private.rakeback_certificate_payers(i.certificate_id)fp;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_todo i WHERE i.owed IS DISTINCT FROM(SELECT sum(fp.owed)FROM pg_temp._routed_player_funding fp WHERE fp.period_id=i.period_id))
 THEN RAISE EXCEPTION 'routed_rakeback_payer_funding_not_conserved' USING ERRCODE='23514'; END IF;
 CREATE TEMP TABLE IF NOT EXISTS _routed_player_wallets(club_id uuid,user_id uuid,opening numeric,delta numeric,PRIMARY KEY(club_id,user_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_player_wallets;
 INSERT INTO pg_temp._routed_player_wallets(club_id,user_id,delta)
 SELECT club_id,user_id,sum(delta) FROM(
  SELECT club_id,user_id,owed AS delta FROM pg_temp._routed_player_todo
  UNION ALL SELECT club_id,payer_user,-owed FROM pg_temp._routed_player_funding WHERE payer_kind='agent') x GROUP BY club_id,user_id;
 PERFORM id FROM public.clubs WHERE id IN(SELECT club_id FROM pg_temp._routed_player_todo) ORDER BY id FOR NO KEY UPDATE;
 PERFORM cm.user_id FROM public.club_members cm JOIN pg_temp._routed_player_wallets w ON w.club_id=cm.club_id AND w.user_id=cm.user_id
  ORDER BY cm.club_id,cm.user_id FOR NO KEY UPDATE OF cm;
 UPDATE pg_temp._routed_player_wallets w SET opening=cm.chip_balance FROM public.club_members cm WHERE cm.club_id=w.club_id AND cm.user_id=w.user_id;
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_wallets WHERE opening IS NULL OR opening<0 OR opening<>round(opening,2) OR opening::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'routed_rakeback_account_missing_or_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,payer_user,sum(owed) owed FROM pg_temp._routed_player_funding WHERE payer_kind='agent' GROUP BY club_id,payer_user) x
  JOIN pg_temp._routed_player_wallets w ON w.club_id=x.club_id AND w.user_id=x.payer_user WHERE w.opening<x.owed)
 THEN RAISE EXCEPTION 'routed_rakeback_agent_funding_shortfall' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM(SELECT club_id,sum(owed) owed FROM pg_temp._routed_player_funding WHERE payer_kind='club' GROUP BY club_id) x
  LEFT JOIN public.clubs bank ON bank.id=x.club_id WHERE bank.chip_treasury IS NULL OR bank.chip_treasury<x.owed
   OR bank.chip_treasury<>round(bank.chip_treasury,2) OR bank.chip_treasury::text IN('NaN','Infinity','-Infinity'))
 THEN RAISE EXCEPTION 'routed_rakeback_club_funding_shortfall' USING ERRCODE='23514'; END IF;
 deleted_deferral:=current_setting('app.deleted_wallet_routing_stage',true);
 club_skip:=current_setting('app.ledger_autoskip_clubs',true);member_skip:=current_setting('app.ledger_autoskip_club_members',true);
 maintenance:=current_setting('app.ledger_maintenance',true);
 routing_context:=current_setting('app.accounting_routing_context',true);
 PERFORM set_config('app.accounting_routing_context',scope.routing_context,true);
 PERFORM set_config('app.deleted_wallet_routing_stage','rakeback',true);
 PERFORM set_config('app.ledger_autoskip_clubs','1',true);PERFORM set_config('app.ledger_autoskip_club_members','1',true);
 v_stop:=clock_timestamp()+interval '90 seconds';
 FOR r IN SELECT * FROM pg_temp._routed_player_todo ORDER BY club_id,payer_user NULLS FIRST,user_id,period_id LOOP
  amount:=r.owed;
  INSERT INTO public.rakeback_period_payouts(rakeback_period_id,club_id,user_id,user_rake_contribution,rakeback_pct,payout_amount,status,paid_at)
   VALUES(r.period_id,r.club_id,r.user_id,r.rake,round(r.rate*100,2),amount,'paid',now()) RETURNING id INTO payout_id;
  IF amount>0 THEN
   FOR g IN SELECT * FROM pg_temp._routed_player_funding WHERE period_id=r.period_id ORDER BY payer_kind,payer_entity LOOP
    amount:=g.owed;
    IF amount=0 THEN CONTINUE; END IF;
   SELECT chip_balance INTO player_before FROM public.club_members WHERE club_id=r.club_id AND user_id=r.user_id;
   IF g.payer_kind='club' THEN
    SELECT chip_treasury INTO payer_before FROM public.clubs WHERE id=r.club_id;
    UPDATE public.clubs SET chip_treasury=chip_treasury-amount WHERE id=r.club_id AND chip_treasury>=amount RETURNING chip_treasury INTO payer_after;
   ELSE
    SELECT chip_balance INTO payer_before FROM public.club_members WHERE club_id=r.club_id AND user_id=g.payer_user;
    UPDATE public.club_members SET chip_balance=chip_balance-amount,updated_at=now() WHERE club_id=r.club_id AND user_id=g.payer_user AND chip_balance>=amount RETURNING chip_balance INTO payer_after;
   END IF;
   UPDATE public.club_members SET chip_balance=chip_balance+amount,updated_at=now() WHERE club_id=r.club_id AND user_id=r.user_id RETURNING chip_balance INTO player_after;
   IF payer_after IS NULL OR player_after IS NULL OR payer_before-payer_after<>amount OR player_after-player_before<>amount
   THEN RAISE EXCEPTION 'routed_rakeback_transfer_not_conserved' USING ERRCODE='23514'; END IF;
   IF g.payer_kind='agent' THEN INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)
    VALUES(g.payer_user,'PLAYER','debit',amount,'rakeback','Weekly rakeback paid under recorded agreement',payer_after,payout_id); END IF;
   INSERT INTO public.wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)
    VALUES(r.user_id,'PLAYER','credit',amount,'rakeback','Weekly rakeback received under recorded agreement',player_after,payout_id) RETURNING id INTO wallet_id;
   IF r.payer_kind<>'split' THEN
   PERFORM set_config('app.ledger_maintenance','rakeback payout evidence pointer',true);
   UPDATE public.rakeback_period_payouts SET wallet_transaction_id=wallet_id WHERE id=payout_id;
   PERFORM set_config('app.ledger_maintenance',COALESCE(maintenance,''),true);
   END IF;
   INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
    VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),CASE WHEN g.payer_kind='club' THEN 'club_treasury' ELSE 'player_wallet' END,
     COALESCE(g.payer_user,r.club_id),'player_wallet',r.user_id,amount,'rakeback',r.club_id,p_union_id,'Weekly rakeback from certified historical payer',
     'round3-period:v3:'||r.period_id::text||CASE WHEN r.payer_kind='split' THEN ':payer:'||g.payer_kind||':'||g.payer_entity::text ELSE '' END,jsonb_build_object('routing_version',3,'accounting_scope_kind',p_scope_kind,'accounting_scope_id',p_scope_id,'period_id',r.period_id,'period_start',p_period_start,'period_end',p_period_end,
       'certificate_id',r.certificate_id,'source_fingerprint',r.fingerprint,'payout_id',payout_id,'wallet_transaction_id',wallet_id,'payee_role_at_transfer','player'),
      payer_before,payer_after,player_before,player_after) RETURNING id INTO ledger_id;
   IF r.payer_kind='split' THEN
    INSERT INTO public.accounting_rakeback_payer_transfers(payout_id,calculation_id,period_id,payer_kind,payer_entity_id,amount,ledger_id,wallet_transaction_id)
    VALUES(payout_id,r.certificate_id,r.period_id,g.payer_kind,g.payer_entity,amount,ledger_id,wallet_id);
   END IF;
   SELECT count(*) INTO receipt_count FROM public.settlement_invoices i WHERE i.source_ledger_id=ledger_id AND i.status='paid'
    AND i.chips_transferred AND i.message_sent AND i.net_amount=amount AND i.gross_amount=amount AND i.deductions=0;
   IF receipt_count<>1 THEN RAISE EXCEPTION 'routed_rakeback_invoice_delivery_incomplete' USING ERRCODE='23514'; END IF;
   END LOOP;
   paid:=paid+r.owed;payees:=payees+1;
  END IF;
  UPDATE public.rakeback_periods SET status='paid',paid_at=now() WHERE id=r.period_id;
  INSERT INTO pg_temp._routed_player_now VALUES(r.period_id);
  IF v_batched AND clock_timestamp()>v_stop THEN EXIT; END IF;
 END LOOP;
 SELECT count(*) INTO v_remaining FROM pg_temp._routed_player_todo t WHERE NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_now n WHERE n.period_id=t.period_id);
 IF v_remaining>0 THEN
  -- A batch: every locked wallet must hold exactly what this batch paid it.
  UPDATE pg_temp._routed_player_wallets w SET delta=COALESCE((SELECT sum(x.delta) FROM(
   SELECT t.club_id,t.user_id,t.owed AS delta FROM pg_temp._routed_player_todo t JOIN pg_temp._routed_player_now n ON n.period_id=t.period_id
   UNION ALL SELECT t.club_id,t.payer_user,-t.owed FROM pg_temp._routed_player_funding t JOIN pg_temp._routed_player_now n ON n.period_id=t.period_id WHERE t.payer_kind='agent') x
   WHERE x.club_id=w.club_id AND x.user_id=w.user_id),0);
 END IF;
 PERFORM set_config('app.ledger_autoskip_clubs',COALESCE(club_skip,''),true);PERFORM set_config('app.ledger_autoskip_club_members',COALESCE(member_skip,''),true);
 PERFORM set_config('app.deleted_wallet_routing_stage',COALESCE(deleted_deferral,''),true);
 IF EXISTS(SELECT 1 FROM pg_temp._routed_player_wallets w JOIN public.club_members cm ON cm.club_id=w.club_id AND cm.user_id=w.user_id
   WHERE cm.chip_balance IS DISTINCT FROM w.opening+w.delta)
 THEN RAISE EXCEPTION 'routed_rakeback_final_balance_incorrect' USING ERRCODE='23514'; END IF;
 -- All original transfer, invoice and net-wallet checks above still decide
 -- whether this stage may finish. Return only free net chips afterward,
 -- retaining published unpaid player obligations across bounded chunks.
 FOR v_deleted IN
  SELECT cm.club_id,cm.user_id FROM public.club_members cm
  JOIN public.profiles dp ON dp.id=cm.user_id AND dp.status='deleted'
  WHERE EXISTS(SELECT FROM pg_temp._routed_player_wallets w WHERE w.club_id=cm.club_id AND w.user_id=cm.user_id) AND EXISTS(SELECT FROM pg_temp._routed_player_todo t JOIN pg_temp._routed_player_now done ON done.period_id=t.period_id WHERE t.club_id=cm.club_id AND (t.user_id=cm.user_id OR EXISTS(SELECT 1 FROM pg_temp._routed_player_funding f WHERE f.period_id=t.period_id AND f.payer_kind='agent' AND f.payer_user=cm.user_id))) ORDER BY cm.club_id,cm.user_id
 LOOP
  SELECT cm.chip_balance,coalesce(cm.held_chips,0),coalesce(cm.locked_chips,0)
   INTO STRICT v_deleted_before,v_deleted_held,v_deleted_locked FROM public.club_members cm
   WHERE cm.club_id=v_deleted.club_id AND cm.user_id=v_deleted.user_id;
  SELECT dwr_bank.chip_treasury INTO STRICT v_deleted_bank FROM public.clubs dwr_bank WHERE dwr_bank.id=v_deleted.club_id;
  v_deleted_return:=public.fn_ca_deleted_wallet_bank_return(v_deleted.club_id,v_deleted.user_id,'player_wallet');
  IF v_deleted_return->'success' IS DISTINCT FROM 'true'::jsonb
   OR v_deleted_return->>'reserved_rakeback' IS NULL OR (v_deleted_return->>'reserved_rakeback')::numeric<0
   OR (v_deleted_return->>'reserved_rakeback')::numeric::text IN('NaN','Infinity','-Infinity')
   OR (v_deleted_return->>'amount')::numeric IS DISTINCT FROM greatest(v_deleted_before-v_deleted_held-v_deleted_locked-(v_deleted_return->>'reserved_rakeback')::numeric,0)
   OR (v_deleted_return->>'player_chips')::numeric IS DISTINCT FROM (v_deleted_return->>'amount')::numeric
   OR (v_deleted_return->>'agent_chips')::numeric IS DISTINCT FROM 0::numeric
   OR NOT EXISTS(SELECT FROM public.club_members cm WHERE cm.club_id=v_deleted.club_id AND cm.user_id=v_deleted.user_id
     AND cm.chip_balance=v_deleted_before-(v_deleted_return->>'amount')::numeric
     AND coalesce(cm.held_chips,0)=v_deleted_held AND coalesce(cm.locked_chips,0)=v_deleted_locked)
   OR NOT EXISTS(SELECT FROM public.clubs dwr_bank WHERE dwr_bank.id=v_deleted.club_id AND dwr_bank.chip_treasury=v_deleted_bank+(v_deleted_return->>'amount')::numeric)
  THEN RAISE EXCEPTION 'deleted_weekly_net_bank_return_not_conserved' USING ERRCODE='23514'; END IF;
 END LOOP;
 PERFORM set_config('app.accounting_routing_context',COALESCE(routing_context,''),true);

 IF v_remaining>0 THEN
  RETURN jsonb_build_object('success',false,'batch_committed',true,'round',3,'routing_version',3,'source_version',2,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
   'periods',(SELECT count(*) FROM pg_temp._routed_player_items),'paid_periods',(SELECT count(*) FROM pg_temp._routed_player_done)+(SELECT count(*) FROM pg_temp._routed_player_now),
   'remaining',v_remaining,'source_fingerprint',fingerprint,'plan_used',v_plan_used);
 END IF;
 -- The round's totals include what earlier batches of it paid.
 SELECT COALESCE(sum(i.owed),0),count(*) INTO v_paid_before,v_payees_before FROM pg_temp._routed_player_items i
  JOIN pg_temp._routed_player_done d ON d.period_id=i.period_id WHERE i.owed>0;
 paid:=paid+v_paid_before;payees:=payees+v_payees_before;
 result:=jsonb_build_object('success',true,'round',3,'name','certified_payer_to_players','routing_version',3,'source_version',2,'source_contract_version',3,'scope_kind',p_scope_kind,'scope_id',p_scope_id,
  'amount',paid,'payees',payees,'shortfalls',0,'periods',(SELECT count(*) FROM pg_temp._routed_player_items),'detail','[]'::jsonb);
 INSERT INTO public.accounting_routed_settlement_runs(union_id,standalone_club_id,period_start,period_end,round_no,source_fingerprint,result)
  VALUES(p_union_id,standalone_club,p_period_start,p_period_end,3,fingerprint,result);
 RETURN result;
END $function$;


REVOKE ALL ON FUNCTION fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated;

DO $owner$ BEGIN IF md5(pg_get_functiondef('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure))<>'015a5dc0ceba1ceb37faf74337a41034' OR(SELECT pg_get_userbyid(proowner)FROM pg_proc WHERE oid='public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure)IS DISTINCT FROM 'postgres' OR(SELECT proacl::text FROM pg_proc WHERE oid='public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure)IS DISTINCT FROM '{postgres=X/postgres}' THEN RAISE EXCEPTION 'historical_rakeback_payer_owner_changed: fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'; END IF; END $owner$;
CREATE OR REPLACE FUNCTION public.fn_calculate_cash_rakeback_periods(p_club_id uuid, p_period_start date, p_period_end date, p_user_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
 tournament_quality jsonb;v_from timestamptz; v_to timestamptz; cutover timestamptz; receipt jsonb;
 scope_union uuid; issue_count bigint; existing public.rakeback_periods%ROWTYPE;
 evidence_issues bigint; incomplete_issues bigint; drifted_issues bigint;
 certificate public.accounting_rakeback_period_calculations%ROWTYPE;
 player record; total_unrounded numeric; amount numeric; display_rate numeric;
 payer_kind text; payer_user uuid; coordinator_union uuid; allocations jsonb; plan jsonb;
 fingerprint text; period_id uuid; written integer:=0; confirmed integer:=0;
 digest_now text; evidence_cp public.accounting_rakeback_period_evidence_checkpoints%ROWTYPE; counts record;
 base_horizon timestamptz; next_horizon timestamptz; base_records bigint; base_evidence bigint; base_incomplete bigint; base_drifted bigint;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'accounting_period_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
    OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
    OR extract(isodow FROM p_period_start)<>1 OR p_period_end<>p_period_start+6
    OR (p_user_ids IS NOT NULL AND (cardinality(p_user_ids)>2000 OR array_position(p_user_ids,NULL) IS NOT NULL))
 THEN RAISE EXCEPTION 'invalid_accounting_period_request' USING ERRCODE='22023'; END IF;
 receipt:=jsonb_build_object('accounting_version',2,'club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,'written',0,'status','blocked');
 v_from:=p_period_start::timestamp AT TIME ZONE 'America/Los_Angeles';
 v_to:=(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles';
 v_from:=public.fn_ca_launch_accounting_start('club',p_club_id,v_from);
 SELECT starts_at INTO cutover FROM public.accounting_cash_accrual_cutover WHERE singleton;
 IF cutover IS NULL OR v_from<cutover THEN RETURN receipt||jsonb_build_object('reason','historical_week_before_observed_source_cutover'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'||p_club_id::text||':'||p_period_start::text,0));
 SELECT union_id INTO scope_union FROM public.clubs WHERE id=p_club_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_club_not_found' USING ERRCODE='22023'; END IF;
 IF p_user_ids IS NULL THEN
 -- Tournament fees are earned at terminal recognition. Open captured fees
 -- are excluded; deferred or missing terminal authority blocks its actual week.
 tournament_quality:=public.fn_accounting_tournament_week_quality(p_club_id,v_from,v_to);
 IF tournament_quality->>'status' IS DISTINCT FROM 'ready' THEN
  RETURN receipt||tournament_quality||jsonb_build_object('written',0);END IF;
 -- One pass over the week feeds all three source-evidence counts. They are
 -- TESTED below in the original order, so the reason a bad week reports is
 -- unchanged; only the number of times the week is read has.
 WITH week_records AS MATERIALIZED (
  SELECT r.id,r.hand_id,r.club_id,r.rake_amount,r.created_at
   FROM public.rake_records r
   WHERE r.created_at>=v_from AND r.created_at<v_to AND r.rake_amount>0
     AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL
     -- fn_rake_record_is_ghost_twin returns false the moment hand_id is not
     -- null, so `hand_id IS NOT NULL OR NOT ghost_twin(...)` is the same
     -- predicate - but OR short-circuits, so a linked row never detoasts its
     -- metadata and never runs the function's EXISTS over
     -- idx_rake_records_table_id. 2,652 ms -> 348 ms for the week slice.
     AND (r.hand_id IS NOT NULL OR NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata))
 ), club_attributions AS MATERIALIZED (
  -- Only this week's records reach the two counts that read this slice, so
  -- joining it to week_records is exact. Reading the club's whole history
  -- grew without bound (20260926042810).
  SELECT a.id,a.rake_record_id,a.hand_id,a.player_id,a.club_id,a.weighted_rake_credit
   FROM week_records w JOIN public.rake_attributions a ON a.rake_record_id=w.id
   WHERE a.club_id=p_club_id
 ), week_batches AS MATERIALIZED (
  SELECT b.rake_record_id,b.status FROM public.accounting_cash_accrual_batches b
   JOIN week_records w ON w.id=b.rake_record_id
 ), week_sources AS MATERIALIZED (
  -- A source can only be the PERFECT match the count below looks for if its
  -- club_id is this club and its earned_at is the record's created_at, which
  -- is inside the week by construction. Narrowing to the club-week slice
  -- therefore preserves every perfect match and every miss, and the existing
  -- accounting_cash_rake_sources_period index serves it directly instead of
  -- detoasting `contract` for the whole table.
  SELECT s.id,s.rake_record_id,s.player_id,s.club_id,s.earned_at,s.rake_credit,
   s.contract->>'attribution_id' AS c_attribution,s.contract->>'player_id' AS c_player,s.contract->>'club_id' AS c_club
   FROM public.accounting_cash_rake_sources s
   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
 ), scoped_records AS (
  SELECT w.* FROM week_records w
   WHERE w.club_id=p_club_id
     OR EXISTS(SELECT 1 FROM club_attributions a WHERE a.rake_record_id=w.id)
     OR EXISTS(SELECT 1 FROM public.clubs house WHERE house.id=w.club_id AND house.is_union IS TRUE
        AND scope_union IS NOT NULL AND (house.union_id=scope_union OR house.id=scope_union))
 ), checks AS (
  SELECT r.id,r.hand_id,r.rake_amount,count(a.id) AS attribution_count,
    COALESCE(sum(a.weighted_rake_credit),0) AS attributed,
    count(a.id) FILTER(WHERE a.hand_id IS DISTINCT FROM r.hand_id OR a.club_id IS NULL
      OR a.player_id IS NULL OR a.weighted_rake_credit IS NULL OR a.weighted_rake_credit<0
      OR a.weighted_rake_credit<>round(a.weighted_rake_credit,2)
      -- NOT EXISTS(c WHERE id=a.club_id AND (P OR Q))
      --   = NOT EXISTS(c WHERE id=a.club_id AND P) AND NOT EXISTS(c WHERE id=a.club_id AND Q)
      OR (a.club_id NOT IN(SELECT c.id FROM public.clubs c WHERE c.is_union IS NOT TRUE)
       AND NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=a.club_id AND c.is_union IS TRUE
        AND EXISTS(SELECT 1 FROM public.accounting_cash_rake_sources hs
          JOIN public.accounting_cash_accrual_batches hb ON hb.rake_record_id=hs.rake_record_id
          WHERE hs.rake_record_id=r.id AND hs.player_id=a.player_id AND hs.club_id=a.club_id
           AND hs.union_id=scope_union AND (c.id=hs.union_id OR c.union_id=hs.union_id)
           AND hs.earned_at=r.created_at AND hs.rake_credit=a.weighted_rake_credit AND hb.status='accrued'
           AND hs.contract->>'is_union_house'='true' AND hs.contract->>'attribution_id'=a.id::text
           AND hs.contract->>'club_id'=a.club_id::text AND hs.contract->>'player_id'=a.player_id::text
           AND hs.contract->>'union_id'=hs.union_id::text)))) AS invalid_count
   FROM scoped_records r LEFT JOIN public.rake_attributions a ON a.rake_record_id=r.id
   GROUP BY r.id,r.hand_id,r.rake_amount
 ), evidence AS (
  SELECT count(*) AS n FROM checks WHERE hand_id IS NULL OR attribution_count=0
   OR invalid_count>0 OR attributed<>rake_amount OR rake_amount<>round(rake_amount,2)
 ), incomplete AS (
  SELECT count(*) AS n FROM club_attributions a JOIN week_records r ON r.id=a.rake_record_id
   LEFT JOIN week_sources s ON s.rake_record_id=r.id AND s.player_id=a.player_id
   LEFT JOIN week_batches b ON b.rake_record_id=r.id
   WHERE s.id IS NULL OR b.status IS DISTINCT FROM 'accrued' OR s.club_id IS DISTINCT FROM a.club_id
     OR s.earned_at IS DISTINCT FROM r.created_at OR s.rake_credit IS DISTINCT FROM a.weighted_rake_credit
     OR s.c_attribution IS DISTINCT FROM a.id::text
     OR s.c_player IS DISTINCT FROM a.player_id::text OR s.c_club IS DISTINCT FROM a.club_id::text
 ), drifted AS (
  -- Bidirectional comparison also rejects an extra recorded source that no
  -- longer has an attribution. A matching subset is not a complete source set.
  SELECT count(*) AS n FROM public.accounting_cash_rake_sources s
   LEFT JOIN public.rake_records r ON r.id=s.rake_record_id
   LEFT JOIN public.rake_attributions a ON a.id=(s.contract->>'attribution_id')::uuid
   LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id=s.rake_record_id
   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
    AND (r.id IS NULL OR a.id IS NULL OR b.status IS DISTINCT FROM 'accrued'
     OR a.rake_record_id IS DISTINCT FROM s.rake_record_id OR a.hand_id IS DISTINCT FROM r.hand_id
     OR a.player_id IS DISTINCT FROM s.player_id OR a.club_id IS DISTINCT FROM s.club_id
     OR a.weighted_rake_credit IS DISTINCT FROM s.rake_credit OR s.earned_at IS DISTINCT FROM r.created_at
     OR r.is_tournament IS TRUE OR r.tournament_id IS NOT NULL
     OR NULLIF(s.contract->'union_id','null'::jsonb) IS DISTINCT FROM to_jsonb(s.union_id)
     OR NULLIF(s.contract->'coordinator_union_id','null'::jsonb) IS DISTINCT FROM to_jsonb(s.coordinator_union_id))
 )
 SELECT evidence.n,incomplete.n,drifted.n INTO evidence_issues,incomplete_issues,drifted_issues
   FROM evidence,incomplete,drifted;
 IF evidence_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_earning_evidence_incomplete','source_count',evidence_issues); END IF;
 -- An old UTC or current-membership period remains an explicit conflict even
 -- when its numbers happen to match. Certificates establish the new writer.
 SELECT count(*) INTO issue_count FROM public.rakeback_periods rp
  WHERE rp.club_id=p_club_id AND rp.period_start<=p_period_end AND rp.period_end>=p_period_start AND public.fn_ca_launch_rakeback_period_waived(rp.id) IS NOT TRUE
    AND (rp.status<>'pending' OR rp.period_start<>p_period_start OR rp.period_end<>p_period_end
      OR NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c WHERE c.period_id=rp.id));
 IF issue_count>0 THEN RETURN receipt||jsonb_build_object('reason','legacy_or_paid_period_requires_reconciliation','period_count',issue_count); END IF;
 IF incomplete_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_source_receipts_incomplete','source_count',incomplete_issues); END IF;
 IF drifted_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_source_receipts_drifted','source_count',drifted_issues); END IF;
 ELSE
 -- A PAGE READS ONLY THE EVIDENCE THAT CHANGED (20260930232349, re-derived from 20260927160709).
 -- The three week-level counts below are sums over the week's cash records.
 -- A record whose accrual batch exists is frozen: rake_records and
 -- rake_attributions refuse every change once it has one, and the batch and
 -- its sources are insert-only and written together. So its share of each
 -- count never changes while the clubs' union shape stays as it was. The
 -- checkpoint keeps those shares for every batch recorded before its horizon
 -- (a time no transaction still running had started by), and this page adds
 -- the batches recorded since and the records that have no batch yet, read in
 -- one snapshot. The totals are exactly the whole-week counts. The whole
 -- period call above keeps its own full verification.
 digest_now:=public.fn_accounting_clubs_scope_digest();
 SELECT * INTO evidence_cp FROM public.accounting_rakeback_period_evidence_checkpoints cp
  WHERE cp.club_id=p_club_id AND cp.period_start=p_period_start FOR UPDATE;
 IF FOUND AND evidence_cp.period_end=p_period_end AND evidence_cp.clubs_digest=digest_now THEN
  base_horizon:=evidence_cp.horizon;base_records:=evidence_cp.settled_records;
  base_evidence:=evidence_cp.settled_evidence;base_incomplete:=evidence_cp.settled_incomplete;base_drifted:=evidence_cp.settled_drifted;
 ELSE
  -- No checkpoint yet, or the union shape it was taken under has changed:
  -- start again from the week's first batch.
  base_horizon:='-infinity';base_records:=0;base_evidence:=0;base_incomplete:=0;base_drifted:=0;
 END IF;
 next_horizon:=public.fn_accounting_commit_horizon();
 IF next_horizon IS NULL OR next_horizon<base_horizon THEN next_horizon:=base_horizon; END IF;
 SELECT * INTO counts FROM public.fn_cash_period_evidence_since(p_club_id,v_from,v_to,scope_union,base_horizon,next_horizon);
 evidence_issues:=base_evidence+counts.o_evidence;
 incomplete_issues:=base_incomplete+counts.o_incomplete;
 drifted_issues:=base_drifted+counts.o_drifted;
 INSERT INTO public.accounting_rakeback_period_evidence_checkpoints AS cp(club_id,period_start,period_end,horizon,clubs_digest,
   settled_records,settled_evidence,settled_incomplete,settled_drifted)
  VALUES(p_club_id,p_period_start,p_period_end,next_horizon,digest_now,base_records+counts.o_settled_records,
   base_evidence+counts.o_settled_evidence,base_incomplete+counts.o_settled_incomplete,base_drifted+counts.o_settled_drifted)
  ON CONFLICT(club_id,period_start) DO UPDATE SET period_end=EXCLUDED.period_end,horizon=EXCLUDED.horizon,
   clubs_digest=EXCLUDED.clubs_digest,settled_records=EXCLUDED.settled_records,settled_evidence=EXCLUDED.settled_evidence,
   settled_incomplete=EXCLUDED.settled_incomplete,settled_drifted=EXCLUDED.settled_drifted,
   built_at=CASE WHEN base_horizon='-infinity'::timestamptz THEN clock_timestamp() ELSE cp.built_at END,
   advanced_at=clock_timestamp(),advances=cp.advances+1;
 -- Any of these refuses the page whatever the tournament gate says, so the
 -- gate is asked only when none does. Same reasons, counts and order as below.
 IF evidence_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_earning_evidence_incomplete','source_count',evidence_issues); END IF;
 SELECT count(*) INTO issue_count FROM public.rakeback_periods rp
  WHERE rp.club_id=p_club_id AND rp.period_start<=p_period_end AND rp.period_end>=p_period_start AND public.fn_ca_launch_rakeback_period_waived(rp.id) IS NOT TRUE
    AND (rp.status<>'pending' OR rp.period_start<>p_period_start OR rp.period_end<>p_period_end
      OR NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c WHERE c.period_id=rp.id));
 IF issue_count>0 THEN RETURN receipt||jsonb_build_object('reason','legacy_or_paid_period_requires_reconciliation','period_count',issue_count); END IF;
 IF incomplete_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_source_receipts_incomplete','source_count',incomplete_issues); END IF;
 IF drifted_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_source_receipts_drifted','source_count',drifted_issues); END IF;
 tournament_quality:=public.fn_accounting_tournament_week_quality(p_club_id,v_from,v_to);
 IF tournament_quality->>'status' IS DISTINCT FROM 'ready' THEN
  RETURN receipt||tournament_quality||jsonb_build_object('written',0);END IF;
 END IF;

 FOR player IN
  WITH receipts AS (
   SELECT s.source_type,s.source_id,s.rake_record_id,s.player_id,s.union_id,s.coordinator_union_id,s.earned_at,s.rake_credit,
    CASE WHEN s.source_type='tournament_fee_accrual' THEN public.fn_accounting_tournament_source_terms_at(fee.tournament_id,fee.charged_at,fee.contract) ELSE s.earned_at END AS agreement_at,
    s.contract->'membership'->'terms' AS member,s.contract->'tiers'->0 AS direct,
    (s.contract->'membership'->>'history_id')::bigint AS member_history_ref,
    sum(s.rake_credit) OVER(PARTITION BY s.player_id) AS total_rake
   FROM public.accounting_payable_earning_sources s
   -- A cash row has no fee row, and a NULL join key never enters the index.
   LEFT JOIN public.accounting_tournament_fee_sources fee
     ON fee.id=CASE WHEN s.source_type='tournament_fee_accrual' THEN s.source_id END
   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
     AND (p_user_ids IS NULL OR s.player_id=ANY(p_user_ids))
  ), parsed AS (
   SELECT r.*,CASE WHEN ((r.member->>'player_rakeback_pct')::numeric=0.70 OR r.direct IS NULL) AND EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=p_club_id AND owner_club.owner_id=NULLIF(r.member->>'agent_id','')::uuid) THEN NULL::uuid
     ELSE NULLIF(r.member->>'agent_id','')::uuid END AS member_agent,
    COALESCE((r.member->>'player_rakeback_pct')::numeric,0) AS deal,
    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL
      THEN COALESCE((r.direct->'agreement'->'terms'->>'player_rakeback_rate')::numeric,0) ELSE 0 END AS offer,
    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL THEN (r.direct->>'rate')::numeric END AS cap_rate,
    mh.id AS member_history_id,ah.id AS agent_history_id,
    mh.after_terms AS recorded_member,ah.after_terms AS recorded_agent
   FROM receipts r
   LEFT JOIN public.accounting_agreement_history mh ON mh.id=r.member_history_ref
    AND mh.entity_type='club_members' AND mh.entity_key=p_club_id::text||':'||r.player_id::text AND mh.observed_at<=r.agreement_at
   LEFT JOIN public.accounting_agreement_history ah ON ah.id=(r.direct->'agreement'->>'history_id')::bigint
    AND ah.entity_type='agents' AND ah.observed_at<=r.agreement_at
  ), rates AS (
   SELECT p.*,CASE WHEN p.deal>0 THEN p.deal WHEN p.member_agent IS NOT NULL THEN p.offer
    WHEN p.total_rake>=10000 THEN 0.30 WHEN p.total_rake>=2000 THEN 0.20
    WHEN p.total_rake>=500 THEN 0.15 WHEN p.total_rake>=100 THEN 0.10 ELSE 0.05 END AS base_rate
   FROM parsed p
  ), effective AS (
   SELECT r.*,CASE WHEN r.member_agent IS NULL AND r.deal=0.70 THEN r.deal WHEN r.cap_rate>0 THEN least(r.base_rate,greatest(r.cap_rate-0.10,0)) ELSE r.base_rate END AS applied_rate
   FROM rates r
  )
  SELECT e.player_id,max(e.total_rake) AS total_rake,sum(e.rake_credit*e.applied_rate) AS total_unrounded,
   count(*) FILTER(WHERE e.member_history_id IS NULL OR e.member IS DISTINCT FROM e.recorded_member
    OR e.member->>'club_id' IS DISTINCT FROM p_club_id::text OR e.member->>'user_id' IS DISTINCT FROM e.player_id::text
    OR COALESCE(e.member->>'status','') NOT IN('active','approved') OR e.member->>'is_active' IS DISTINCT FROM 'true') AS invalid_members,
   count(*) FILTER(WHERE e.member_agent IS NOT NULL AND (e.direct IS NULL OR e.agent_history_id IS NULL
    OR e.direct->'agreement'->'terms' IS DISTINCT FROM e.recorded_agent
    OR e.direct->>'user_id' IS DISTINCT FROM e.member_agent::text OR e.direct->>'depth' IS DISTINCT FROM '1'
    OR e.recorded_agent->>'club_id' IS DISTINCT FROM p_club_id::text OR e.recorded_agent->>'user_id' IS DISTINCT FROM e.member_agent::text
    OR e.recorded_agent->>'status' IS DISTINCT FROM 'active')) AS invalid_agents,
   count(*) FILTER(WHERE e.deal::text IN('NaN','Infinity','-Infinity') OR e.offer::text IN('NaN','Infinity','-Infinity')
    OR e.deal<0 OR e.deal>1 OR e.offer<0 OR e.offer>1
    OR (e.member_agent IS NOT NULL AND (e.cap_rate IS NULL OR e.cap_rate<0 OR e.cap_rate>1 OR e.cap_rate::text IN('NaN','Infinity','-Infinity')))) AS invalid_rates,
   count(DISTINCT COALESCE(e.member_agent::text,'club')) AS payer_count,
   count(DISTINCT COALESCE(e.coordinator_union_id::text,'standalone')) AS coordinator_count,
   min(e.member_agent::text)::uuid AS payer_user,
   min(e.coordinator_union_id::text)::uuid AS coordinator_union,
   jsonb_agg(jsonb_build_object('source_type',e.source_type,'source_id',e.source_id,'rake_record_id',e.rake_record_id,'union_id',e.union_id,
    'coordinator_union_id',e.coordinator_union_id,'rake_credit',e.rake_credit,'rate',e.applied_rate,
    'unrounded_rakeback',e.rake_credit*e.applied_rate,'earned_at',e.earned_at,'agreement_at',e.agreement_at,'membership_history_id',e.member_history_id,
    'agent_history_id',e.agent_history_id,'payer_kind',CASE WHEN e.member_agent IS NULL THEN 'club' ELSE 'agent' END,
    'payer_user_id',e.member_agent) ORDER BY e.earned_at,e.source_type,e.rake_record_id,e.source_id) AS allocations
  FROM effective e GROUP BY e.player_id ORDER BY e.player_id
 LOOP
  IF player.invalid_members>0 THEN RAISE EXCEPTION 'period_membership_contract_invalid' USING ERRCODE='55000'; END IF;
  IF player.invalid_agents>0 THEN RAISE EXCEPTION 'period_direct_agent_contract_invalid' USING ERRCODE='55000'; END IF;
  IF player.invalid_rates>0 THEN RAISE EXCEPTION 'period_observed_rate_invalid' USING ERRCODE='55000'; END IF;
  IF player.payer_count<1 THEN RAISE EXCEPTION 'historical_rakeback_payer_required' USING ERRCODE='55000'; END IF;
  IF player.coordinator_count<>1 THEN RAISE EXCEPTION 'multiple_recorded_coordinators_require_split_period' USING ERRCODE='55000'; END IF;
  total_unrounded:=player.total_unrounded;allocations:=player.allocations;payer_user:=CASE WHEN player.payer_count>1 THEN NULL ELSE player.payer_user END;coordinator_union:=player.coordinator_union;
  payer_kind:=CASE WHEN player.payer_count>1 THEN 'split' WHEN payer_user IS NULL THEN 'club' ELSE 'agent' END;
  amount:=round(total_unrounded,2);
  display_rate:=CASE WHEN player.total_rake>0 THEN round(total_unrounded/player.total_rake,4) ELSE 0 END;
  IF amount>player.total_rake OR amount<0 THEN RAISE EXCEPTION 'period_rakeback_not_conserved' USING ERRCODE='55000'; END IF;
  fingerprint:=md5(jsonb_build_object('allocations',allocations,'rake',player.total_rake,'amount',amount,'rate',display_rate)::text);
  plan:=jsonb_build_object('player_id',player.player_id,'rake_generated',player.total_rake,
   'rakeback_amount',amount,'display_rate',display_rate,'coordinator_union_id',coordinator_union,'payer_kind',payer_kind,'payer_user_id',payer_user,
   'source_fingerprint',fingerprint,'allocations',allocations);
  SELECT * INTO existing FROM public.rakeback_periods WHERE club_id=p_club_id AND user_id=(plan->>'player_id')::uuid
    AND period_start=p_period_start AND period_end=p_period_end FOR UPDATE;
  IF FOUND AND public.fn_ca_launch_rakeback_period_waived(existing.id) THEN
   period_id:=existing.id;
   UPDATE public.rakeback_periods SET status='pending',paid_at=NULL,deferred_reason=NULL,deferred_at=NULL,
    rake_generated=(plan->>'rake_generated')::numeric,total_rake_paid=(plan->>'rake_generated')::numeric,
    rakeback_rate=(plan->>'display_rate')::numeric,rakeback_earned=(plan->>'rakeback_amount')::numeric,rakeback_amount=(plan->>'rakeback_amount')::numeric
    WHERE id=period_id;
  ELSIF FOUND THEN
   SELECT * INTO certificate FROM public.accounting_rakeback_period_calculations cert WHERE cert.period_id=existing.id ORDER BY cert.id DESC LIMIT 1;
   IF NOT FOUND OR certificate.accounting_version<>2 OR certificate.club_id IS DISTINCT FROM p_club_id
    OR certificate.player_id IS DISTINCT FROM existing.user_id OR certificate.period_start IS DISTINCT FROM p_period_start
    OR certificate.period_end IS DISTINCT FROM p_period_end
    OR existing.status<>'pending' OR existing.rake_generated IS DISTINCT FROM certificate.rake_generated
    OR existing.total_rake_paid IS DISTINCT FROM certificate.rake_generated OR existing.rakeback_rate IS DISTINCT FROM certificate.display_rate
    OR existing.rakeback_earned IS DISTINCT FROM certificate.rakeback_amount OR existing.rakeback_amount IS DISTINCT FROM certificate.rakeback_amount
   THEN RAISE EXCEPTION 'certified_period_drift_requires_reconciliation' USING ERRCODE='55000'; END IF;
   period_id:=existing.id;
   IF certificate.source_fingerprint=plan->>'source_fingerprint' THEN confirmed:=confirmed+1; CONTINUE; END IF;
   UPDATE public.rakeback_periods SET rake_generated=(plan->>'rake_generated')::numeric,total_rake_paid=(plan->>'rake_generated')::numeric,
    rakeback_rate=(plan->>'display_rate')::numeric,rakeback_earned=(plan->>'rakeback_amount')::numeric,rakeback_amount=(plan->>'rakeback_amount')::numeric
    WHERE id=period_id;
  ELSE
   INSERT INTO public.rakeback_periods(user_id,club_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_earned,rakeback_amount,total_rake_paid,status)
    VALUES((plan->>'player_id')::uuid,p_club_id,p_period_start,p_period_end,(plan->>'rake_generated')::numeric,
     (plan->>'display_rate')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'rake_generated')::numeric,'pending')
    RETURNING id INTO period_id;
  END IF;
  INSERT INTO public.accounting_rakeback_period_calculations(period_id,source_fingerprint,club_id,player_id,coordinator_union_id,period_start,period_end,
    rake_generated,rakeback_amount,display_rate,payer_kind,payer_user_id,source_allocations)
   VALUES(period_id,plan->>'source_fingerprint',p_club_id,(plan->>'player_id')::uuid,(plan->>'coordinator_union_id')::uuid,p_period_start,p_period_end,
    (plan->>'rake_generated')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'display_rate')::numeric,
    plan->>'payer_kind',(plan->>'payer_user_id')::uuid,plan->'allocations');
  written:=written+1;confirmed:=confirmed+1;
 END LOOP;
 RETURN receipt||jsonb_build_object('status','ready','written',written,'confirmed_players',confirmed);
EXCEPTION WHEN SQLSTATE '55000' THEN
 RETURN receipt||jsonb_build_object('reason',SQLERRM);
END $function$;


REVOKE ALL ON FUNCTION fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[]) FROM PUBLIC,anon,authenticated;

DO $owner$ BEGIN IF md5(pg_get_functiondef('smarter_private.deleted_wallet_published_rakeback_reserve(uuid,uuid)'::regprocedure))<>'ec0c5cba6bac63a6c27ff48efe823399' OR(SELECT pg_get_userbyid(proowner)FROM pg_proc WHERE oid='smarter_private.deleted_wallet_published_rakeback_reserve(uuid,uuid)'::regprocedure)IS DISTINCT FROM 'postgres' OR(SELECT proacl::text FROM pg_proc WHERE oid='smarter_private.deleted_wallet_published_rakeback_reserve(uuid,uuid)'::regprocedure)IS DISTINCT FROM '{postgres=X/postgres}' THEN RAISE EXCEPTION 'historical_rakeback_payer_owner_changed: smarter_private.deleted_wallet_published_rakeback_reserve(uuid,uuid)'; END IF; END $owner$;
CREATE OR REPLACE FUNCTION smarter_private.deleted_wallet_published_rakeback_reserve(p_club uuid, p_user uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
 r public.rakeback_periods%ROWTYPE;
 c public.accounting_rakeback_period_calculations%ROWTYPE;
 reserved numeric:=0;
 locked_period_ids uuid[];
BEGIN
 IF p_club IS NULL OR p_user IS NULL THEN
  RAISE EXCEPTION 'deleted_wallet_reserve_identity_required' USING ERRCODE='22023';
 END IF;
 -- Publishers lock an existing period FOR UPDATE before adding its certificate.
 -- NOWAIT is essential: caller may already own the member row, while the
 -- ordinary stage owns period rows before member rows. Never wait in reverse.
 SELECT coalesce(array_agg(locked.id ORDER BY locked.id),ARRAY[]::uuid[]) INTO locked_period_ids
 FROM (SELECT rp.id FROM public.rakeback_periods rp
       WHERE rp.club_id=p_club AND rp.status='pending'
       ORDER BY rp.id FOR SHARE NOWAIT) locked;
 -- Visit ONLY the locked admission cohort, not a second fresh pending scan.
 FOR r IN SELECT rp.* FROM public.rakeback_periods rp
          WHERE rp.id=ANY(locked_period_ids) ORDER BY rp.id
 LOOP
  -- Select latest FIRST. An invalid latest certificate must not expose funds
  -- by falling back to an older certificate or disappearing from a filtered sum.
  SELECT pc.* INTO c FROM public.accounting_rakeback_period_calculations pc
  WHERE pc.period_id=r.id ORDER BY pc.id DESC LIMIT 1;
  IF NOT FOUND THEN
   RAISE EXCEPTION 'deleted_wallet_reserve_latest_certificate_required' USING ERRCODE='55000';
  END IF;
  IF r.id IS NULL OR r.club_id IS NULL OR r.club_id IS DISTINCT FROM p_club
   OR r.user_id IS NULL OR r.period_start IS NULL OR r.period_end IS NULL
   OR NOT isfinite(r.period_start) OR NOT isfinite(r.period_end)
   OR r.period_start>r.period_end OR extract(isodow FROM r.period_start)<>1 OR r.period_end<>r.period_start+6
   OR r.rake_generated IS NULL OR r.total_rake_paid IS NULL
   OR r.rakeback_amount IS NULL OR r.rakeback_earned IS NULL OR r.rakeback_rate IS NULL
   OR c.id IS NULL OR c.period_id IS DISTINCT FROM r.id
   OR c.accounting_version IS DISTINCT FROM 2
   OR c.club_id IS DISTINCT FROM r.club_id OR c.player_id IS DISTINCT FROM r.user_id
   OR c.period_start IS DISTINCT FROM r.period_start OR c.period_end IS DISTINCT FROM r.period_end
   OR c.rake_generated IS NULL OR c.rake_generated IS DISTINCT FROM r.rake_generated
   OR c.rake_generated IS DISTINCT FROM r.total_rake_paid
   OR c.rake_generated<0 OR c.rake_generated::text IN ('NaN','Infinity','-Infinity')
   OR c.rakeback_amount IS NULL OR c.rakeback_amount IS DISTINCT FROM r.rakeback_amount
   OR c.rakeback_amount IS DISTINCT FROM r.rakeback_earned
   OR c.rakeback_amount<0 OR c.rakeback_amount>c.rake_generated OR c.rakeback_amount<>round(c.rakeback_amount,2)
   OR c.rakeback_amount::text IN ('NaN','Infinity','-Infinity')
   OR c.display_rate IS NULL OR c.display_rate IS DISTINCT FROM r.rakeback_rate
   OR c.display_rate<0 OR c.display_rate>1 OR c.display_rate<>round(c.display_rate,4)
   OR c.display_rate::text IN ('NaN','Infinity','-Infinity')
   OR c.payer_kind IS NULL OR c.payer_kind NOT IN ('agent','club','split')
   OR (c.payer_kind='agent') IS DISTINCT FROM (c.payer_user_id IS NOT NULL)
   OR c.payer_user_id=r.user_id
   OR c.source_fingerprint IS NULL OR c.source_fingerprint !~ '^[0-9a-f]{32}$'
  THEN
   RAISE EXCEPTION 'deleted_wallet_reserve_certificate_identity_invalid' USING ERRCODE='55000';
  END IF;
  -- The owning R3 stage refuses any existing payout for a pending period.
  -- A pending row plus a paid receipt must never be mistaken for free money.
  IF EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id=r.id) THEN
   RAISE EXCEPTION 'deleted_wallet_reserve_pending_payout_conflict' USING ERRCODE='55000';
  END IF;
  IF c.payer_kind='split' THEN
   -- Same immutable certificate producer; retain all child liabilities before
   -- any deleted account's free net is returned by the existing R2/R3 owner.
   reserved:=reserved+COALESCE((SELECT sum(g.owed) FROM smarter_private.rakeback_certificate_payers(c.id)g WHERE g.payer_kind='agent' AND g.payer_user=p_user),0);
  ELSIF c.payer_kind='agent' AND c.payer_user_id=p_user THEN
   reserved:=reserved+c.rakeback_amount;
  END IF;
 END LOOP;
 RETURN reserved;
END;
$function$;


REVOKE ALL ON FUNCTION smarter_private.deleted_wallet_published_rakeback_reserve(uuid,uuid) FROM PUBLIC,anon,authenticated;

DO $owner$ BEGIN IF md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_window(uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'dd8908620a4afcda29e9f6be42e4a096' OR(SELECT pg_get_userbyid(proowner)FROM pg_proc WHERE oid='public.fn_settle_accounting_rakeback_window(uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)IS DISTINCT FROM 'postgres' OR(SELECT proacl::text FROM pg_proc WHERE oid='public.fn_settle_accounting_rakeback_window(uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'historical_rakeback_payer_owner_changed: fn_settle_accounting_rakeback_window(uuid,uuid,timestamp with time zone,timestamp with time zone)'; END IF; END $owner$;
CREATE OR REPLACE FUNCTION public.fn_settle_accounting_rakeback_window(p_union_id uuid, p_standalone_club_id uuid, p_window_start timestamp with time zone, p_window_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
-- ONE WINDOW OF ROUND 3'S SOURCES (chunked close, 20261003): per (club, player)
-- of the book's sources earned in the window, the count, the non-house count
-- and two 60-bit sums of md5(source type|id|rake credit|rake record|agent).
DECLARE v jsonb; standalone_club uuid:=p_standalone_club_id;
BEGIN
 BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _rw3_src(club_id uuid,player_id uuid,nonhouse boolean,h text) ON COMMIT DROP;
  TRUNCATE pg_temp._rw3_src;
  IF p_union_id IS NOT NULL AND standalone_club IS NULL THEN
   INSERT INTO pg_temp._rw3_src SELECT rs.club_id,rs.player_id,COALESCE((rs.contract->>'is_union_house')::boolean,false) IS FALSE,
    md5(concat_ws('|',COALESCE(rs.source_type,'~'),COALESCE(rs.source_id::text,'~'),COALESCE(trim_scale(rs.rake_credit)::text,'~'),
     COALESCE(rs.rake_record_id::text,'~'),COALESCE((CASE WHEN (((rs.contract#>>'{membership,terms,player_rakeback_pct}')::numeric=0.70 OR rs.contract->'tiers'->0 IS NULL) AND EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=rs.club_id AND owner_club.owner_id=NULLIF(rs.contract#>>'{membership,terms,agent_id}','')::uuid)) THEN NULL::uuid ELSE NULLIF(rs.contract#>>'{membership,terms,agent_id}','')::uuid END)::text,'~')))
    FROM public.accounting_payable_earning_sources rs WHERE rs.earned_at>=p_window_start AND rs.earned_at<p_window_end
     AND rs.coordinator_union_id=p_union_id;
  ELSIF p_union_id IS NULL AND standalone_club IS NOT NULL THEN
   INSERT INTO pg_temp._rw3_src SELECT rs.club_id,rs.player_id,COALESCE((rs.contract->>'is_union_house')::boolean,false) IS FALSE,
    md5(concat_ws('|',COALESCE(rs.source_type,'~'),COALESCE(rs.source_id::text,'~'),COALESCE(trim_scale(rs.rake_credit)::text,'~'),
     COALESCE(rs.rake_record_id::text,'~'),COALESCE((CASE WHEN (((rs.contract#>>'{membership,terms,player_rakeback_pct}')::numeric=0.70 OR rs.contract->'tiers'->0 IS NULL) AND EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=rs.club_id AND owner_club.owner_id=NULLIF(rs.contract#>>'{membership,terms,agent_id}','')::uuid)) THEN NULL::uuid ELSE NULLIF(rs.contract#>>'{membership,terms,agent_id}','')::uuid END)::text,'~')))
    FROM public.accounting_payable_earning_sources rs WHERE rs.earned_at>=p_window_start AND rs.earned_at<p_window_end
     AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club;
  ELSE
   INSERT INTO pg_temp._rw3_src SELECT rs.club_id,rs.player_id,COALESCE((rs.contract->>'is_union_house')::boolean,false) IS FALSE,
    md5(concat_ws('|',COALESCE(rs.source_type,'~'),COALESCE(rs.source_id::text,'~'),COALESCE(trim_scale(rs.rake_credit)::text,'~'),
     COALESCE(rs.rake_record_id::text,'~'),COALESCE((CASE WHEN (((rs.contract#>>'{membership,terms,player_rakeback_pct}')::numeric=0.70 OR rs.contract->'tiers'->0 IS NULL) AND EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=rs.club_id AND owner_club.owner_id=NULLIF(rs.contract#>>'{membership,terms,agent_id}','')::uuid)) THEN NULL::uuid ELSE NULLIF(rs.contract#>>'{membership,terms,agent_id}','')::uuid END)::text,'~')))
    FROM public.accounting_payable_earning_sources rs WHERE rs.earned_at>=p_window_start AND rs.earned_at<p_window_end
     AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club));
  END IF;
  SELECT jsonb_build_object('read_failed',false,'sources',COALESCE(sum(x.n),0),
    'pairs',COALESCE(jsonb_agg(jsonb_build_array(x.club_id,x.player_id,x.n,x.nn,x.d1,x.d2)),'[]'::jsonb)) INTO v
   FROM (SELECT s.club_id,s.player_id,count(*) AS n,count(*) FILTER(WHERE s.nonhouse) AS nn,
     sum(('x'||substr(s.h,1,15))::bit(60)::bigint) AS d1,sum(('x'||substr(s.h,16,15))::bit(60)::bigint) AS d2
     FROM pg_temp._rw3_src s GROUP BY s.club_id,s.player_id) x;
 EXCEPTION WHEN OTHERS THEN
  -- Anything this read cannot do, the stage does itself (and refuses as it refuses).
  v:=jsonb_build_object('read_failed',true,'error',SQLERRM,'sqlstate',SQLSTATE);
 END;
 RETURN v;
END $function$;


REVOKE ALL ON FUNCTION fn_settle_accounting_rakeback_window(uuid,uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated;

DO $owner$ BEGIN IF md5(pg_get_functiondef('public.fn_settle_accounting_rakeback_plan(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'43b5010f1f183953ecae78800f9c3cde' OR(SELECT pg_get_userbyid(proowner)FROM pg_proc WHERE oid='public.fn_settle_accounting_rakeback_plan(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)IS DISTINCT FROM 'postgres' OR(SELECT proacl::text FROM pg_proc WHERE oid='public.fn_settle_accounting_rakeback_plan(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'historical_rakeback_payer_owner_changed: fn_settle_accounting_rakeback_plan(text,uuid,timestamp with time zone,timestamp with time zone)'; END IF; END $owner$;
CREATE OR REPLACE FUNCTION public.fn_settle_accounting_rakeback_plan(p_scope_kind text, p_scope_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
-- ROUND 3'S CERTIFICATES, READ ONCE (chunked close, 20261003): the periods the
-- stage admits, their latest certificates and every allocation's counts,
-- sums, element-only tests and md5 sums, kept for the paying attempt.
DECLARE scope record; p_union_id uuid; standalone_club uuid; from_date date; to_date date; v jsonb;
 legacy_paid_cash_replay boolean:=false;
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NULL
  OR p_scope_kind NOT IN('union','club') OR p_scope_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
  OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end) OR p_period_start>=p_period_end OR p_period_end>clock_timestamp() THEN
  RETURN NULL;
 END IF;
 SELECT * INTO scope FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_period_start,p_period_end);
 p_union_id:=scope.union_id;standalone_club:=scope.standalone_club_id;
 from_date:=(p_period_start AT TIME ZONE 'America/Los_Angeles')::date;
 to_date:=(p_period_end AT TIME ZONE 'America/Los_Angeles')::date-1;
 BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _rp3_pairs(club_id uuid,player_id uuid,PRIMARY KEY(club_id,player_id)) ON COMMIT DROP;
  TRUNCATE pg_temp._rp3_pairs;
  INSERT INTO pg_temp._rp3_pairs SELECT x.club_id,x.player_id FROM public.fn_settle_accounting_rakeback_pairs(p_scope_kind,p_scope_id,p_period_start,p_period_end) x;
  IF NOT FOUND THEN RAISE EXCEPTION 'round3_windows_missing'; END IF;
  CREATE TEMP TABLE IF NOT EXISTS _rp3_periods(id uuid PRIMARY KEY,club_id uuid,user_id uuid) ON COMMIT DROP;
  TRUNCATE pg_temp._rp3_periods;
  -- The stage's admitted periods; the outside clubs' pairs are the windows'
  -- pairs (same predicate, same week).
  INSERT INTO pg_temp._rp3_periods SELECT x.id,x.club_id,x.user_id
   FROM (WITH pclubs AS MATERIALIZED (SELECT DISTINCT p2.club_id FROM public.rakeback_periods p2
      WHERE p2.period_start<=to_date AND p2.period_end>=from_date AND p2.club_id IS NOT NULL AND (p2.club_id=ANY(scope.club_ids)) IS NOT TRUE),
    pairs AS MATERIALIZED (SELECT w.club_id,w.player_id FROM pg_temp._rp3_pairs w WHERE w.club_id IN(SELECT pc.club_id FROM pclubs pc))
   SELECT rp.* FROM public.rakeback_periods rp WHERE rp.period_start<=to_date AND rp.period_end>=from_date
  AND (rp.club_id=ANY(scope.club_ids)
    OR CASE WHEN rp.club_id IN(SELECT pc.club_id FROM pclubs pc)
     THEN EXISTS(SELECT 1 FROM pairs q WHERE q.club_id=rp.club_id AND q.player_id=rp.user_id)
     ELSE EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE rs.club_id=rp.club_id AND rs.player_id=rp.user_id
      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end) END)) x;
  CREATE TEMP TABLE IF NOT EXISTS _rp3_certs(period_id uuid PRIMARY KEY,id bigint,payer_kind text,payer_user_id uuid) ON COMMIT DROP;
  TRUNCATE pg_temp._rp3_certs;
  INSERT INTO pg_temp._rp3_certs SELECT DISTINCT ON(x.period_id) x.period_id,x.id,x.payer_kind,x.payer_user_id
   FROM public.accounting_rakeback_period_calculations x WHERE x.period_id IN(SELECT id FROM pg_temp._rp3_periods) ORDER BY x.period_id,x.id DESC;
  -- Per period: the stage's counts and sums, its tests of each allocation that
  -- need no source, and the md5 sums of each allocation as its source must be.
  SELECT jsonb_build_object('failed',false,'legacy',legacy_paid_cash_replay,'union_id',p_union_id,'standalone_club_id',standalone_club,
    'club_ids',to_jsonb(scope.club_ids),'periods',(SELECT count(*) FROM pg_temp._rp3_periods),
    'alloc',COALESCE(jsonb_agg(jsonb_build_array(x.period_id,x.cert_id,x.club_id,x.user_id,x.n,x.nd,x.generated,x.unrounded,x.elem_bad,x.d1,x.d2)),'[]'::jsonb)) INTO v
   FROM (SELECT pc.period_id,pc.id AS cert_id,pr.club_id,pr.user_id,count(*) AS n,
     count(DISTINCT ROW(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END),a->>'source_id')) AS nd,
     sum((a->>'rake_credit')::numeric) AS generated,sum((a->>'rake_credit')::numeric*(a->>'rate')::numeric) AS unrounded,
     COALESCE(bool_or(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) IS NULL OR COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END) NOT IN('cash_rake_accrual','tournament_fee_accrual')
      OR (a->>'rate')::numeric IS NULL OR (a->>'rate')::numeric<0 OR (a->>'rate')::numeric>1
      OR (a->>'rate')::numeric::text IN('NaN','Infinity','-Infinity')
      OR (pc.payer_kind<>'split' AND(a->>'payer_kind' IS DISTINCT FROM pc.payer_kind OR NULLIF(a->>'payer_user_id','')::uuid IS DISTINCT FROM pc.payer_user_id)) OR (pc.payer_kind='split' AND(a->>'payer_kind' NOT IN('agent','club') OR(a->>'payer_kind'='agent') IS DISTINCT FROM(NULLIF(a->>'payer_user_id','')IS NOT NULL)))),false) AS elem_bad,
     sum(('x'||substr(hh.h,1,15))::bit(60)::bigint) AS d1,sum(('x'||substr(hh.h,16,15))::bit(60)::bigint) AS d2
    FROM pg_temp._rp3_certs pc JOIN pg_temp._rp3_periods pr ON pr.id=pc.period_id
    JOIN public.accounting_rakeback_period_calculations cc ON cc.id=pc.id
    CROSS JOIN LATERAL jsonb_array_elements(cc.source_allocations) a
    CROSS JOIN LATERAL (SELECT md5(concat_ws('|',COALESCE(COALESCE(a->>'source_type',CASE WHEN legacy_paid_cash_replay THEN 'cash_rake_accrual' END),'~'),
       COALESCE((a->>'source_id')::uuid::text,'~'),COALESCE(trim_scale((a->>'rake_credit')::numeric)::text,'~'),
       COALESCE((a->>'rake_record_id')::uuid::text,'~'),COALESCE(NULLIF(a->>'payer_user_id','')::uuid::text,'~'))) AS h) hh
    GROUP BY pc.period_id,pc.id,pr.club_id,pr.user_id) x;
 EXCEPTION WHEN OTHERS THEN
  -- Anything this read cannot do, the stage does itself (and refuses as it refuses).
  v:=jsonb_build_object('failed',true,'error',SQLERRM,'sqlstate',SQLSTATE);
 END;
 INSERT INTO public.accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,computed_at)
 VALUES('round3_'||p_scope_kind||'_plan',p_scope_id,p_period_start,p_period_end,p_period_start,p_period_end,v,clock_timestamp())
 ON CONFLICT(kind,union_id,period_start,period_end,window_start) DO UPDATE SET window_end=EXCLUDED.window_end,value=EXCLUDED.value,
  cash_ids=NULL,cash_md5=NULL,fee_ids=NULL,fee_md5=NULL,computed_at=EXCLUDED.computed_at;
 RETURN v;
END $function$;


REVOKE ALL ON FUNCTION fn_settle_accounting_rakeback_plan(text,uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated;

DO $owner$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_rakeback_payout_leg_is_documented()'::regprocedure))<>'5c6c64bbca20e1bef41b3346b846b896' OR(SELECT pg_get_userbyid(proowner)FROM pg_proc WHERE oid='public.fn_ca_rakeback_payout_leg_is_documented()'::regprocedure)IS DISTINCT FROM 'postgres' OR(SELECT proacl::text FROM pg_proc WHERE oid='public.fn_ca_rakeback_payout_leg_is_documented()'::regprocedure)IS DISTINCT FROM '{postgres=X/postgres}' THEN RAISE EXCEPTION 'historical_rakeback_payer_owner_changed: fn_ca_rakeback_payout_leg_is_documented()'; END IF; END $owner$;
CREATE OR REPLACE FUNCTION public.fn_ca_rakeback_payout_leg_is_documented()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  m        jsonb := COALESCE(NEW.metadata,'{}'::jsonb);
  v_period uuid; v_cert bigint; v_payout uuid;
  v_kind   text; v_scope uuid; v_start timestamptz; v_end timestamptz;
  v_docs   int;
  v_legacy_operation uuid;
BEGIN
  IF NEW.idempotency_key IS NULL OR btrim(NEW.idempotency_key)='' THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' carries no idempotency key';
  END IF;
  IF m->>'routing_version' IS DISTINCT FROM '3' THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' has no routed accounting identity';
  END IF;
  BEGIN
    v_period:=(m->>'period_id')::uuid;   v_cert :=(m->>'certificate_id')::bigint;
    v_payout:=(m->>'payout_id')::uuid;   v_kind :=m->>'accounting_scope_kind';
    v_scope :=(m->>'accounting_scope_id')::uuid;
    v_start :=(m->>'period_start')::timestamptz;
    v_end   :=(m->>'period_end')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' has an unreadable routed accounting identity';
  END;
  IF v_period IS NULL OR v_cert IS NULL OR v_payout IS NULL OR v_kind IS NULL
     OR v_scope IS NULL OR v_start IS NULL OR v_end IS NULL THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' is missing part of its period, certificate or payout identity';
  END IF;

  -- The settlement run a disputing player is shown the payment under.
  IF NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r
    WHERE r.scope_kind=v_kind AND r.scope_id=v_scope AND r.period_start=v_start
      AND r.period_end=v_end AND r.round_no=3 AND r.routing_version=3)
    AND NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c
      JOIN public.rakeback_period_payouts pp ON pp.id=v_payout AND pp.rakeback_period_id=c.period_id
      JOIN public.rakeback_periods rp ON rp.id=c.period_id
      WHERE NOT(m ? 'certificate_kind') AND c.id=v_cert AND c.accounting_version=2
       AND c.period_id=v_period AND c.club_id=NEW.club_id AND c.player_id=NEW.to_entity_id
       AND pp.club_id=c.club_id AND pp.user_id=c.player_id AND pp.status='paid' AND pp.payout_amount=c.rakeback_amount
       AND rp.status='paid' AND rp.club_id=c.club_id AND rp.user_id=c.player_id
       AND c.period_start=(v_start AT TIME ZONE 'America/Los_Angeles')::date
       AND c.period_end=(v_end AT TIME ZONE 'America/Los_Angeles')::date-1 AND c.period_end=c.period_start+6
       AND v_end<=now()-interval '5 minutes' AND v_start=public.fn_union_week_start(v_start)
       AND v_end=public.fn_union_week_start(v_start+interval '8 days')
       AND m->>'source_fingerprint'=c.source_fingerprint
       AND((v_kind='union' AND c.coordinator_union_id=v_scope)
         OR(v_kind='club' AND c.coordinator_union_id IS NULL AND c.club_id=v_scope))) THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' names no routed settlement run';
  END IF;

  IF EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c WHERE c.id=v_cert AND c.payer_kind='split') THEN
    IF NOT smarter_private.split_rakeback_payout_complete(v_payout,v_cert)
      OR NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_payer_transfers t WHERE t.payout_id=v_payout AND t.calculation_id=v_cert AND t.period_id=v_period AND t.ledger_id=NEW.id AND t.amount=NEW.amount)
    THEN RAISE EXCEPTION 'split_rakeback_payout_leg_undocumented' USING ERRCODE='23514'; END IF;
    RETURN NULL;
  END IF;

  IF NOT EXISTS(SELECT 1 FROM public.rakeback_period_payouts pp
    WHERE pp.id=v_payout AND pp.rakeback_period_id=v_period AND pp.club_id=NEW.club_id
      AND pp.user_id=NEW.to_entity_id AND pp.status='paid' AND pp.payout_amount=NEW.amount) THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' names no matching paid rakeback period payout';
  END IF;

  IF m ? 'certificate_kind' THEN
    -- The only other certificate kind is the owner-authorized legacy one. It
    -- must name its operation, and the certificate must be that operation's.
    IF m->>'certificate_kind' IS DISTINCT FROM 'owner_legacy_v1' THEN
      RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
        DETAIL='chip_ledger '||NEW.id::text||' names an unknown certificate kind';
    END IF;
    BEGIN v_legacy_operation:=(m->>'legacy_operation_id')::uuid;
    EXCEPTION WHEN OTHERS THEN v_legacy_operation:=NULL; END;
    IF v_legacy_operation IS NULL OR NOT EXISTS(SELECT 1 FROM public.accounting_legacy_rakeback_certificates c
      JOIN public.accounting_owner_legacy_operations o ON o.operation_id=c.operation_id
      WHERE c.id=v_cert AND c.operation_id=v_legacy_operation AND c.period_id=v_period AND c.club_id=NEW.club_id
        AND c.player_id=NEW.to_entity_id AND c.rakeback_amount=NEW.amount
        AND o.period_start=v_start AND o.period_end=v_end) THEN
      RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
        DETAIL='chip_ledger '||NEW.id::text||' names no matching owner legacy certificate';
    END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c
    WHERE c.id=v_cert AND c.period_id=v_period AND c.club_id=NEW.club_id
      AND c.player_id=NEW.to_entity_id AND c.rakeback_amount=NEW.amount) THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' names no matching rakeback certificate';
  END IF;

  SELECT count(*) INTO v_docs FROM public.settlement_invoices i
   WHERE i.source_ledger_id=NEW.id AND i.status='paid' AND i.chips_transferred
     AND i.gross_amount=NEW.amount AND i.net_amount=NEW.amount;
  IF v_docs<>1 THEN
    RAISE EXCEPTION 'rakeback_payout_leg_undocumented' USING ERRCODE='23514',
      DETAIL='chip_ledger '||NEW.id::text||' has '||v_docs::text||' source-linked paid receipts, expected exactly 1';
  END IF;
  RETURN NULL;
END $function$;


REVOKE ALL ON FUNCTION fn_ca_rakeback_payout_leg_is_documented() FROM PUBLIC,anon,authenticated;

DO $owner$ BEGIN IF md5(pg_get_functiondef('public.fn_rakeback_split_check(uuid,date,date,uuid[])'::regprocedure))<>'4ad97c5889886d9f51b4585e7600ca37' OR(SELECT pg_get_userbyid(proowner)FROM pg_proc WHERE oid='public.fn_rakeback_split_check(uuid,date,date,uuid[])'::regprocedure)IS DISTINCT FROM 'postgres' OR(SELECT proacl::text FROM pg_proc WHERE oid='public.fn_rakeback_split_check(uuid,date,date,uuid[])'::regprocedure)IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'historical_rakeback_payer_owner_changed: fn_rakeback_split_check(uuid,date,date,uuid[])'; END IF; END $owner$;
CREATE OR REPLACE FUNCTION public.fn_rakeback_split_check(p_club_id uuid, p_period_start date, p_period_end date, p_user_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
-- One page of fn_calculate_cash_rakeback_periods' loop, checked and not
-- written (20261003): its plan query for the page's players and every refusal
-- of its loop body, in its order, up to the certified-period test (both built
-- from its text by this migration). The first refusal is returned with its
-- player; otherwise the page's player count, how many already hold a
-- certificate of the same fingerprint, and a digest.
DECLARE
 v_from timestamptz; v_to timestamptz; existing public.rakeback_periods%ROWTYPE;
 certificate public.accounting_rakeback_period_calculations%ROWTYPE;
 player record; total_unrounded numeric; amount numeric; display_rate numeric;
 payer_kind text; payer_user uuid; coordinator_union uuid; allocations jsonb; plan jsonb;
 fingerprint text; period_id uuid; written integer:=0; confirmed integer:=0;
 n integer:=0; n_same integer:=0; dg text:='';
BEGIN
 v_from:=p_period_start::timestamp AT TIME ZONE 'America/Los_Angeles';
 v_to:=(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles';
 BEGIN
 FOR player IN
  WITH receipts AS (
   SELECT s.source_type,s.source_id,s.rake_record_id,s.player_id,s.union_id,s.coordinator_union_id,s.earned_at,s.rake_credit,
    CASE WHEN s.source_type='tournament_fee_accrual' THEN public.fn_accounting_tournament_source_terms_at(fee.tournament_id,fee.charged_at,fee.contract) ELSE s.earned_at END AS agreement_at,
    s.contract->'membership'->'terms' AS member,s.contract->'tiers'->0 AS direct,
    (s.contract->'membership'->>'history_id')::bigint AS member_history_ref,
    sum(s.rake_credit) OVER(PARTITION BY s.player_id) AS total_rake
   FROM public.accounting_payable_earning_sources s
   -- A cash row has no fee row, and a NULL join key never enters the index.
   LEFT JOIN public.accounting_tournament_fee_sources fee
     ON fee.id=CASE WHEN s.source_type='tournament_fee_accrual' THEN s.source_id END
   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
     AND (p_user_ids IS NULL OR s.player_id=ANY(p_user_ids))
  ), parsed AS (
   SELECT r.*,CASE WHEN ((r.member->>'player_rakeback_pct')::numeric=0.70 OR r.direct IS NULL) AND EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=p_club_id AND owner_club.owner_id=NULLIF(r.member->>'agent_id','')::uuid) THEN NULL::uuid
     ELSE NULLIF(r.member->>'agent_id','')::uuid END AS member_agent,
    COALESCE((r.member->>'player_rakeback_pct')::numeric,0) AS deal,
    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL
      THEN COALESCE((r.direct->'agreement'->'terms'->>'player_rakeback_rate')::numeric,0) ELSE 0 END AS offer,
    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL THEN (r.direct->>'rate')::numeric END AS cap_rate,
    mh.id AS member_history_id,ah.id AS agent_history_id,
    mh.after_terms AS recorded_member,ah.after_terms AS recorded_agent
   FROM receipts r
   LEFT JOIN public.accounting_agreement_history mh ON mh.id=r.member_history_ref
    AND mh.entity_type='club_members' AND mh.entity_key=p_club_id::text||':'||r.player_id::text AND mh.observed_at<=r.agreement_at
   LEFT JOIN public.accounting_agreement_history ah ON ah.id=(r.direct->'agreement'->>'history_id')::bigint
    AND ah.entity_type='agents' AND ah.observed_at<=r.agreement_at
  ), rates AS (
   SELECT p.*,CASE WHEN p.deal>0 THEN p.deal WHEN p.member_agent IS NOT NULL THEN p.offer
    WHEN p.total_rake>=10000 THEN 0.30 WHEN p.total_rake>=2000 THEN 0.20
    WHEN p.total_rake>=500 THEN 0.15 WHEN p.total_rake>=100 THEN 0.10 ELSE 0.05 END AS base_rate
   FROM parsed p
  ), effective AS (
   SELECT r.*,CASE WHEN r.member_agent IS NULL AND r.deal=0.70 THEN r.deal WHEN r.cap_rate>0 THEN least(r.base_rate,greatest(r.cap_rate-0.10,0)) ELSE r.base_rate END AS applied_rate
   FROM rates r
  )
  SELECT e.player_id,max(e.total_rake) AS total_rake,sum(e.rake_credit*e.applied_rate) AS total_unrounded,
   count(*) FILTER(WHERE e.member_history_id IS NULL OR e.member IS DISTINCT FROM e.recorded_member
    OR e.member->>'club_id' IS DISTINCT FROM p_club_id::text OR e.member->>'user_id' IS DISTINCT FROM e.player_id::text
    OR COALESCE(e.member->>'status','') NOT IN('active','approved') OR e.member->>'is_active' IS DISTINCT FROM 'true') AS invalid_members,
   count(*) FILTER(WHERE e.member_agent IS NOT NULL AND (e.direct IS NULL OR e.agent_history_id IS NULL
    OR e.direct->'agreement'->'terms' IS DISTINCT FROM e.recorded_agent
    OR e.direct->>'user_id' IS DISTINCT FROM e.member_agent::text OR e.direct->>'depth' IS DISTINCT FROM '1'
    OR e.recorded_agent->>'club_id' IS DISTINCT FROM p_club_id::text OR e.recorded_agent->>'user_id' IS DISTINCT FROM e.member_agent::text
    OR e.recorded_agent->>'status' IS DISTINCT FROM 'active')) AS invalid_agents,
   count(*) FILTER(WHERE e.deal::text IN('NaN','Infinity','-Infinity') OR e.offer::text IN('NaN','Infinity','-Infinity')
    OR e.deal<0 OR e.deal>1 OR e.offer<0 OR e.offer>1
    OR (e.member_agent IS NOT NULL AND (e.cap_rate IS NULL OR e.cap_rate<0 OR e.cap_rate>1 OR e.cap_rate::text IN('NaN','Infinity','-Infinity')))) AS invalid_rates,
   count(DISTINCT COALESCE(e.member_agent::text,'club')) AS payer_count,
   count(DISTINCT COALESCE(e.coordinator_union_id::text,'standalone')) AS coordinator_count,
   min(e.member_agent::text)::uuid AS payer_user,
   min(e.coordinator_union_id::text)::uuid AS coordinator_union,
   jsonb_agg(jsonb_build_object('source_type',e.source_type,'source_id',e.source_id,'rake_record_id',e.rake_record_id,'union_id',e.union_id,
    'coordinator_union_id',e.coordinator_union_id,'rake_credit',e.rake_credit,'rate',e.applied_rate,
    'unrounded_rakeback',e.rake_credit*e.applied_rate,'earned_at',e.earned_at,'agreement_at',e.agreement_at,'membership_history_id',e.member_history_id,
    'agent_history_id',e.agent_history_id,'payer_kind',CASE WHEN e.member_agent IS NULL THEN 'club' ELSE 'agent' END,
    'payer_user_id',e.member_agent) ORDER BY e.earned_at,e.source_type,e.rake_record_id,e.source_id) AS allocations
  FROM effective e GROUP BY e.player_id ORDER BY e.player_id
 LOOP
  IF player.invalid_members>0 THEN RAISE EXCEPTION 'period_membership_contract_invalid' USING ERRCODE='55000'; END IF;
  IF player.invalid_agents>0 THEN RAISE EXCEPTION 'period_direct_agent_contract_invalid' USING ERRCODE='55000'; END IF;
  IF player.invalid_rates>0 THEN RAISE EXCEPTION 'period_observed_rate_invalid' USING ERRCODE='55000'; END IF;
  IF player.payer_count<1 THEN RAISE EXCEPTION 'historical_rakeback_payer_required' USING ERRCODE='55000'; END IF;
  IF player.coordinator_count<>1 THEN RAISE EXCEPTION 'multiple_recorded_coordinators_require_split_period' USING ERRCODE='55000'; END IF;
  total_unrounded:=player.total_unrounded;allocations:=player.allocations;payer_user:=CASE WHEN player.payer_count>1 THEN NULL ELSE player.payer_user END;coordinator_union:=player.coordinator_union;
  payer_kind:=CASE WHEN player.payer_count>1 THEN 'split' WHEN payer_user IS NULL THEN 'club' ELSE 'agent' END;
  amount:=round(total_unrounded,2);
  display_rate:=CASE WHEN player.total_rake>0 THEN round(total_unrounded/player.total_rake,4) ELSE 0 END;
  IF amount>player.total_rake OR amount<0 THEN RAISE EXCEPTION 'period_rakeback_not_conserved' USING ERRCODE='55000'; END IF;
  fingerprint:=md5(jsonb_build_object('allocations',allocations,'rake',player.total_rake,'amount',amount,'rate',display_rate)::text);
  plan:=jsonb_build_object('player_id',player.player_id,'rake_generated',player.total_rake,
   'rakeback_amount',amount,'display_rate',display_rate,'coordinator_union_id',coordinator_union,'payer_kind',payer_kind,'payer_user_id',payer_user,
   'source_fingerprint',fingerprint,'allocations',allocations);
  SELECT * INTO existing FROM public.rakeback_periods WHERE club_id=p_club_id AND user_id=(plan->>'player_id')::uuid
    AND period_start=p_period_start AND period_end=p_period_end FOR UPDATE;
  IF FOUND THEN
   SELECT * INTO certificate FROM public.accounting_rakeback_period_calculations cert WHERE cert.period_id=existing.id ORDER BY cert.id DESC LIMIT 1;
   IF NOT FOUND OR certificate.accounting_version<>2 OR certificate.club_id IS DISTINCT FROM p_club_id
    OR certificate.player_id IS DISTINCT FROM existing.user_id OR certificate.period_start IS DISTINCT FROM p_period_start
    OR certificate.period_end IS DISTINCT FROM p_period_end
    OR existing.status<>'pending' OR existing.rake_generated IS DISTINCT FROM certificate.rake_generated
    OR existing.total_rake_paid IS DISTINCT FROM certificate.rake_generated OR existing.rakeback_rate IS DISTINCT FROM certificate.display_rate
    OR existing.rakeback_earned IS DISTINCT FROM certificate.rakeback_amount OR existing.rakeback_amount IS DISTINCT FROM certificate.rakeback_amount
   THEN RAISE EXCEPTION 'certified_period_drift_requires_reconciliation' USING ERRCODE='55000'; END IF;
  END IF;
  n:=n+1;
  IF existing.id IS NOT NULL AND certificate.source_fingerprint=plan->>'source_fingerprint' THEN n_same:=n_same+1; END IF;
  dg:=md5(dg||player.player_id::text||':'||fingerprint);
 END LOOP;
 EXCEPTION WHEN SQLSTATE '55000' THEN
  RETURN jsonb_build_object('reason',SQLERRM,'player_id',player.player_id);
 END;
 RETURN jsonb_build_object('players',n,'same',n_same,'digest',dg);
END
$function$;


REVOKE ALL ON FUNCTION fn_rakeback_split_check(uuid,date,date,uuid[]) FROM PUBLIC,anon,authenticated;

DO $owner$ BEGIN IF md5(pg_get_functiondef('public.fn_rakeback_split_write(uuid,date,date,uuid[])'::regprocedure))<>'7c8849be5746c9f274d5685c55a458e0' OR(SELECT pg_get_userbyid(proowner)FROM pg_proc WHERE oid='public.fn_rakeback_split_write(uuid,date,date,uuid[])'::regprocedure)IS DISTINCT FROM 'postgres' OR(SELECT proacl::text FROM pg_proc WHERE oid='public.fn_rakeback_split_write(uuid,date,date,uuid[])'::regprocedure)IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'historical_rakeback_payer_owner_changed: fn_rakeback_split_write(uuid,date,date,uuid[])'; END IF; END $owner$;
CREATE OR REPLACE FUNCTION public.fn_rakeback_split_write(p_club_id uuid, p_period_start date, p_period_end date, p_user_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
-- One page of fn_calculate_cash_rakeback_periods' loop (20261003): its plan
-- query for the page's players and its loop body, verbatim (built from its
-- text by this migration). Called only after every page passed
-- fn_rakeback_split_check.
DECLARE
 v_from timestamptz; v_to timestamptz; existing public.rakeback_periods%ROWTYPE;
 certificate public.accounting_rakeback_period_calculations%ROWTYPE;
 player record; total_unrounded numeric; amount numeric; display_rate numeric;
 payer_kind text; payer_user uuid; coordinator_union uuid; allocations jsonb; plan jsonb;
 fingerprint text; period_id uuid; written integer:=0; confirmed integer:=0;
BEGIN
 v_from:=p_period_start::timestamp AT TIME ZONE 'America/Los_Angeles';
 v_to:=(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles';
 FOR player IN
  WITH receipts AS (
   SELECT s.source_type,s.source_id,s.rake_record_id,s.player_id,s.union_id,s.coordinator_union_id,s.earned_at,s.rake_credit,
    CASE WHEN s.source_type='tournament_fee_accrual' THEN public.fn_accounting_tournament_source_terms_at(fee.tournament_id,fee.charged_at,fee.contract) ELSE s.earned_at END AS agreement_at,
    s.contract->'membership'->'terms' AS member,s.contract->'tiers'->0 AS direct,
    (s.contract->'membership'->>'history_id')::bigint AS member_history_ref,
    sum(s.rake_credit) OVER(PARTITION BY s.player_id) AS total_rake
   FROM public.accounting_payable_earning_sources s
   -- A cash row has no fee row, and a NULL join key never enters the index.
   LEFT JOIN public.accounting_tournament_fee_sources fee
     ON fee.id=CASE WHEN s.source_type='tournament_fee_accrual' THEN s.source_id END
   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
     AND (p_user_ids IS NULL OR s.player_id=ANY(p_user_ids))
  ), parsed AS (
   SELECT r.*,CASE WHEN ((r.member->>'player_rakeback_pct')::numeric=0.70 OR r.direct IS NULL) AND EXISTS(SELECT 1 FROM public.clubs owner_club WHERE owner_club.id=p_club_id AND owner_club.owner_id=NULLIF(r.member->>'agent_id','')::uuid) THEN NULL::uuid
     ELSE NULLIF(r.member->>'agent_id','')::uuid END AS member_agent,
    COALESCE((r.member->>'player_rakeback_pct')::numeric,0) AS deal,
    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL
      THEN COALESCE((r.direct->'agreement'->'terms'->>'player_rakeback_rate')::numeric,0) ELSE 0 END AS offer,
    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL THEN (r.direct->>'rate')::numeric END AS cap_rate,
    mh.id AS member_history_id,ah.id AS agent_history_id,
    mh.after_terms AS recorded_member,ah.after_terms AS recorded_agent
   FROM receipts r
   LEFT JOIN public.accounting_agreement_history mh ON mh.id=r.member_history_ref
    AND mh.entity_type='club_members' AND mh.entity_key=p_club_id::text||':'||r.player_id::text AND mh.observed_at<=r.agreement_at
   LEFT JOIN public.accounting_agreement_history ah ON ah.id=(r.direct->'agreement'->>'history_id')::bigint
    AND ah.entity_type='agents' AND ah.observed_at<=r.agreement_at
  ), rates AS (
   SELECT p.*,CASE WHEN p.deal>0 THEN p.deal WHEN p.member_agent IS NOT NULL THEN p.offer
    WHEN p.total_rake>=10000 THEN 0.30 WHEN p.total_rake>=2000 THEN 0.20
    WHEN p.total_rake>=500 THEN 0.15 WHEN p.total_rake>=100 THEN 0.10 ELSE 0.05 END AS base_rate
   FROM parsed p
  ), effective AS (
   SELECT r.*,CASE WHEN r.member_agent IS NULL AND r.deal=0.70 THEN r.deal WHEN r.cap_rate>0 THEN least(r.base_rate,greatest(r.cap_rate-0.10,0)) ELSE r.base_rate END AS applied_rate
   FROM rates r
  )
  SELECT e.player_id,max(e.total_rake) AS total_rake,sum(e.rake_credit*e.applied_rate) AS total_unrounded,
   count(*) FILTER(WHERE e.member_history_id IS NULL OR e.member IS DISTINCT FROM e.recorded_member
    OR e.member->>'club_id' IS DISTINCT FROM p_club_id::text OR e.member->>'user_id' IS DISTINCT FROM e.player_id::text
    OR COALESCE(e.member->>'status','') NOT IN('active','approved') OR e.member->>'is_active' IS DISTINCT FROM 'true') AS invalid_members,
   count(*) FILTER(WHERE e.member_agent IS NOT NULL AND (e.direct IS NULL OR e.agent_history_id IS NULL
    OR e.direct->'agreement'->'terms' IS DISTINCT FROM e.recorded_agent
    OR e.direct->>'user_id' IS DISTINCT FROM e.member_agent::text OR e.direct->>'depth' IS DISTINCT FROM '1'
    OR e.recorded_agent->>'club_id' IS DISTINCT FROM p_club_id::text OR e.recorded_agent->>'user_id' IS DISTINCT FROM e.member_agent::text
    OR e.recorded_agent->>'status' IS DISTINCT FROM 'active')) AS invalid_agents,
   count(*) FILTER(WHERE e.deal::text IN('NaN','Infinity','-Infinity') OR e.offer::text IN('NaN','Infinity','-Infinity')
    OR e.deal<0 OR e.deal>1 OR e.offer<0 OR e.offer>1
    OR (e.member_agent IS NOT NULL AND (e.cap_rate IS NULL OR e.cap_rate<0 OR e.cap_rate>1 OR e.cap_rate::text IN('NaN','Infinity','-Infinity')))) AS invalid_rates,
   count(DISTINCT COALESCE(e.member_agent::text,'club')) AS payer_count,
   count(DISTINCT COALESCE(e.coordinator_union_id::text,'standalone')) AS coordinator_count,
   min(e.member_agent::text)::uuid AS payer_user,
   min(e.coordinator_union_id::text)::uuid AS coordinator_union,
   jsonb_agg(jsonb_build_object('source_type',e.source_type,'source_id',e.source_id,'rake_record_id',e.rake_record_id,'union_id',e.union_id,
    'coordinator_union_id',e.coordinator_union_id,'rake_credit',e.rake_credit,'rate',e.applied_rate,
    'unrounded_rakeback',e.rake_credit*e.applied_rate,'earned_at',e.earned_at,'agreement_at',e.agreement_at,'membership_history_id',e.member_history_id,
    'agent_history_id',e.agent_history_id,'payer_kind',CASE WHEN e.member_agent IS NULL THEN 'club' ELSE 'agent' END,
    'payer_user_id',e.member_agent) ORDER BY e.earned_at,e.source_type,e.rake_record_id,e.source_id) AS allocations
  FROM effective e GROUP BY e.player_id ORDER BY e.player_id
 LOOP
  IF player.invalid_members>0 THEN RAISE EXCEPTION 'period_membership_contract_invalid' USING ERRCODE='55000'; END IF;
  IF player.invalid_agents>0 THEN RAISE EXCEPTION 'period_direct_agent_contract_invalid' USING ERRCODE='55000'; END IF;
  IF player.invalid_rates>0 THEN RAISE EXCEPTION 'period_observed_rate_invalid' USING ERRCODE='55000'; END IF;
  IF player.payer_count<1 THEN RAISE EXCEPTION 'historical_rakeback_payer_required' USING ERRCODE='55000'; END IF;
  IF player.coordinator_count<>1 THEN RAISE EXCEPTION 'multiple_recorded_coordinators_require_split_period' USING ERRCODE='55000'; END IF;
  total_unrounded:=player.total_unrounded;allocations:=player.allocations;payer_user:=CASE WHEN player.payer_count>1 THEN NULL ELSE player.payer_user END;coordinator_union:=player.coordinator_union;
  payer_kind:=CASE WHEN player.payer_count>1 THEN 'split' WHEN payer_user IS NULL THEN 'club' ELSE 'agent' END;
  amount:=round(total_unrounded,2);
  display_rate:=CASE WHEN player.total_rake>0 THEN round(total_unrounded/player.total_rake,4) ELSE 0 END;
  IF amount>player.total_rake OR amount<0 THEN RAISE EXCEPTION 'period_rakeback_not_conserved' USING ERRCODE='55000'; END IF;
  fingerprint:=md5(jsonb_build_object('allocations',allocations,'rake',player.total_rake,'amount',amount,'rate',display_rate)::text);
  plan:=jsonb_build_object('player_id',player.player_id,'rake_generated',player.total_rake,
   'rakeback_amount',amount,'display_rate',display_rate,'coordinator_union_id',coordinator_union,'payer_kind',payer_kind,'payer_user_id',payer_user,
   'source_fingerprint',fingerprint,'allocations',allocations);
  SELECT * INTO existing FROM public.rakeback_periods WHERE club_id=p_club_id AND user_id=(plan->>'player_id')::uuid
    AND period_start=p_period_start AND period_end=p_period_end FOR UPDATE;
  IF FOUND THEN
   SELECT * INTO certificate FROM public.accounting_rakeback_period_calculations cert WHERE cert.period_id=existing.id ORDER BY cert.id DESC LIMIT 1;
   IF NOT FOUND OR certificate.accounting_version<>2 OR certificate.club_id IS DISTINCT FROM p_club_id
    OR certificate.player_id IS DISTINCT FROM existing.user_id OR certificate.period_start IS DISTINCT FROM p_period_start
    OR certificate.period_end IS DISTINCT FROM p_period_end
    OR existing.status<>'pending' OR existing.rake_generated IS DISTINCT FROM certificate.rake_generated
    OR existing.total_rake_paid IS DISTINCT FROM certificate.rake_generated OR existing.rakeback_rate IS DISTINCT FROM certificate.display_rate
    OR existing.rakeback_earned IS DISTINCT FROM certificate.rakeback_amount OR existing.rakeback_amount IS DISTINCT FROM certificate.rakeback_amount
   THEN RAISE EXCEPTION 'certified_period_drift_requires_reconciliation' USING ERRCODE='55000'; END IF;
   period_id:=existing.id;
   IF certificate.source_fingerprint=plan->>'source_fingerprint' THEN confirmed:=confirmed+1; CONTINUE; END IF;
   UPDATE public.rakeback_periods SET rake_generated=(plan->>'rake_generated')::numeric,total_rake_paid=(plan->>'rake_generated')::numeric,
    rakeback_rate=(plan->>'display_rate')::numeric,rakeback_earned=(plan->>'rakeback_amount')::numeric,rakeback_amount=(plan->>'rakeback_amount')::numeric
    WHERE id=period_id;
  ELSE
   INSERT INTO public.rakeback_periods(user_id,club_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_earned,rakeback_amount,total_rake_paid,status)
    VALUES((plan->>'player_id')::uuid,p_club_id,p_period_start,p_period_end,(plan->>'rake_generated')::numeric,
     (plan->>'display_rate')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'rake_generated')::numeric,'pending')
    RETURNING id INTO period_id;
  END IF;
  INSERT INTO public.accounting_rakeback_period_calculations(period_id,source_fingerprint,club_id,player_id,coordinator_union_id,period_start,period_end,
    rake_generated,rakeback_amount,display_rate,payer_kind,payer_user_id,source_allocations)
   VALUES(period_id,plan->>'source_fingerprint',p_club_id,(plan->>'player_id')::uuid,(plan->>'coordinator_union_id')::uuid,p_period_start,p_period_end,
    (plan->>'rake_generated')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'display_rate')::numeric,
    plan->>'payer_kind',(plan->>'payer_user_id')::uuid,plan->'allocations');
  written:=written+1;confirmed:=confirmed+1;
 END LOOP;
 RETURN jsonb_build_object('written',written,'confirmed',confirmed);
END
$function$;


REVOKE ALL ON FUNCTION fn_rakeback_split_write(uuid,date,date,uuid[]) FROM PUBLIC,anon,authenticated;

DO $owner$ BEGIN IF md5(pg_get_functiondef('public.ca_player_stats_financial_report(uuid,uuid,integer,text,text)'::regprocedure))<>'a3f80aecfd4d1577753386c5b3efc44c' OR(SELECT pg_get_userbyid(proowner)FROM pg_proc WHERE oid='public.ca_player_stats_financial_report(uuid,uuid,integer,text,text)'::regprocedure)IS DISTINCT FROM 'postgres' OR(SELECT proacl::text FROM pg_proc WHERE oid='public.ca_player_stats_financial_report(uuid,uuid,integer,text,text)'::regprocedure)IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}' THEN RAISE EXCEPTION 'historical_rakeback_payer_owner_changed: ca_player_stats_financial_report(uuid,uuid,integer,text,text)'; END IF; END $owner$;
CREATE OR REPLACE FUNCTION public.ca_player_stats_financial_report(p_user uuid, p_club_id uuid DEFAULT NULL::uuid, p_days integer DEFAULT NULL::integer, p_tz text DEFAULT 'UTC'::text, p_asset text DEFAULT 'chips'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_days integer; v_tz text; v_from timestamptz; v_to timestamptz;
BEGIN
  PERFORM public.ca_assert_self(p_user);
  IF p_asset NOT IN ('chips','diamonds') THEN RAISE EXCEPTION 'unknown stats asset' USING ERRCODE='22023'; END IF;
  IF p_club_id IS NOT NULL THEN PERFORM public.ca_assert_player_stats_club(p_user,p_club_id,p_asset); END IF;
  SELECT b.range_days,b.range_tz,b.from_at,b.to_at INTO v_days,v_tz,v_from,v_to
    FROM public.ca_stats_calendar_bounds(p_days,p_tz) b;
  RETURN (WITH eligible AS MATERIALIZED (
    SELECT DISTINCT c.id FROM public.club_members m JOIN public.clubs c ON c.id=m.club_id
    WHERE m.user_id=p_user AND m.status IN ('active','approved')
      AND coalesce(c.lifecycle_status,'active')<>'retired' AND coalesce(c.asset,'chips')=p_asset
      AND (p_club_id IS NULL OR c.id=p_club_id)
  ), tx AS MATERIALIZED (
    SELECT w.id,w.created_at,w.related_entity_id tournament_id,t.club_id,w.type,w.category,
      round(w.amount,2) amount,w.balance_after,w.description
    FROM public.wallet_transactions w JOIN public.tournaments t ON t.id=w.related_entity_id
    JOIN eligible e ON e.id=t.club_id
    WHERE w.user_id=p_user AND p_asset='chips'
      AND lower(w.category) IN ('tournament_buyin','rebuy','addon','refund','tournament_refund',
        'tournament_prize','tournament_winnings','tournament_cashout','bounty','ticket_issue',
        'ticket_redeem','correction','reversal','prize_reversal')
      AND (v_from IS NULL OR w.created_at>=v_from) AND (v_to IS NULL OR w.created_at<v_to)
  ), categories AS (
    SELECT lower(category) category,lower(type) direction,count(*)::integer entries,round(sum(amount),2) amount
    FROM tx GROUP BY 1,2
  ), tournament_totals AS (
    SELECT count(*)::integer journal_rows,
      round(coalesce(sum(amount) FILTER(WHERE lower(type)='debit'),0),2) debits,
      round(coalesce(sum(amount) FILTER(WHERE lower(type)='credit'),0),2) credits,
      round(coalesce(sum(CASE WHEN lower(type)='credit' THEN amount
        WHEN lower(type)='debit' THEN -amount ELSE 0 END),0),2) net
    FROM tx
  ), periods AS MATERIALIZED (
    SELECT r.id,r.club_id,r.period_start,r.period_end,r.rake_generated,r.rakeback_rate,
      coalesce(r.rakeback_amount,r.rakeback_earned,0) amount,r.status,r.paid_at,
      r.deferred_reason,r.deferred_at,r.defer_count
    FROM public.rakeback_periods r JOIN eligible e ON e.id=r.club_id
    WHERE r.user_id=p_user AND p_asset='chips'
      AND (v_from IS NULL OR r.period_end>=v_from) AND (v_to IS NULL OR r.period_start<v_to)
  ), payouts AS MATERIALIZED (
    SELECT p.id,p.rakeback_period_id,p.club_id,p.payout_amount,p.currency,p.status,p.paid_at,
      p.wallet_transaction_id,p.failure_reason,p.created_at,
      coalesce((SELECT jsonb_agg(jsonb_build_object('wallet_transaction_id',t.wallet_transaction_id,'amount',t.amount)ORDER BY t.payer_kind,t.payer_entity_id)
       FROM public.accounting_rakeback_payer_transfers t WHERE t.payout_id=p.id AND t.period_id=p.rakeback_period_id),'[]'::jsonb) AS wallet_transactions
    FROM public.rakeback_period_payouts p JOIN eligible e ON e.id=p.club_id
    WHERE p.user_id=p_user AND p_asset='chips'
      AND (v_from IS NULL OR coalesce(p.paid_at,p.created_at)>=v_from)
      AND (v_to IS NULL OR coalesce(p.paid_at,p.created_at)<v_to)
  ) SELECT jsonb_build_object('contract_version',2,'scope',jsonb_build_object(
      'target_user_id',p_user,'club_id',p_club_id,'asset',p_asset,'range_days',v_days,
      'range_tz',v_tz,'visibility','owner'),'generated_at',now(),
    'availability',jsonb_build_object(
      'tournament_wallet',p_asset='chips','rakeback',p_asset='chips',
      'bankroll_ledger',false,'bankroll_reason','no_club_scoped_authoritative_player_balance_series',
      'cash_sessions',false,'cash_sessions_reason','session_identity_has_no_final_stack_or_hand_foreign_key'),
    'tournament_wallet',jsonb_build_object('source','wallet_transactions',
      'totals',(SELECT to_jsonb(tournament_totals) FROM tournament_totals),
      'categories',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY category,direction) FROM categories c),'[]'::jsonb),
      'entries',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY created_at DESC,id DESC) FROM
        (SELECT * FROM tx ORDER BY created_at DESC,id DESC LIMIT 250) x),'[]'::jsonb),
      'capped',(SELECT count(*)>250 FROM tx)),
    'rakeback',jsonb_build_object('source','rakeback_periods+rakeback_period_payouts',
      'pending_amount',coalesce((SELECT round(sum(amount),2) FROM periods WHERE status='pending'),0),
      'paid_amount',coalesce((SELECT round(sum(payout_amount),2) FROM payouts WHERE status='paid'),0),
      'periods',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY period_end DESC,id DESC) FROM periods p),'[]'::jsonb),
      'payout_receipts',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY coalesce(paid_at,created_at) DESC,id DESC) FROM payouts p),'[]'::jsonb)),
    'bankroll',jsonb_build_object('available',false,'series','[]'::jsonb),
    'cash_sessions',jsonb_build_object('available',false,'sessions','[]'::jsonb)));
END;$function$;


REVOKE ALL ON FUNCTION ca_player_stats_financial_report(uuid,uuid,integer,text,text) FROM PUBLIC,anon;

DO $owner$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_settlement_correctness_check()'::regprocedure))<>'72ddf644e991f750039e4fe399598fed' OR(SELECT pg_get_userbyid(proowner)FROM pg_proc WHERE oid='public.fn_ca_settlement_correctness_check()'::regprocedure)IS DISTINCT FROM 'postgres' OR(SELECT proacl::text FROM pg_proc WHERE oid='public.fn_ca_settlement_correctness_check()'::regprocedure)IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'historical_rakeback_payer_owner_changed: fn_ca_settlement_correctness_check()'; END IF; END $owner$;
CREATE OR REPLACE FUNCTION public.fn_ca_settlement_correctness_check()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r record; n integer := 0;
BEGIN
  -- B. Cross-club direct postings (last 60 min)
  FOR r IN
    SELECT l.id, l.from_type, l.from_entity_id, l.to_type, l.to_entity_id, l.amount, l.category
    FROM public.chip_ledger l
    WHERE l.created_at > now() - interval '60 minutes'
      AND l.from_type IN ('club_treasury','club_wallet')
      AND l.to_type   IN ('club_treasury','club_wallet')
      AND l.from_entity_id IS DISTINCT FROM l.to_entity_id
      AND l.category NOT IN ('treasury_transfer','pnl_settlement','horse_funding','correction')
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:cross_club', 'cross_club_posting', 'warning',
      'cross-club:' || COALESCE(r.from_entity_id::text,'?') || ':' || COALESCE(r.to_entity_id::text,'?'),
      r.amount, NULL, NULL, 'ledger', 'chip_ledger', NULL,
      r.from_entity_id, NULL, NULL, NULL, NULL, NULL, NULL, ARRAY[r.id],
      'chips moved directly between two different clubs (' || r.category || ', '
        || r.from_type || '→' || r.to_type || ') outside the allowed cross-club categories',
      NULL, jsonb_build_object('ledger_row', r.id, 'category', r.category));
    n := n + 1;
  END LOOP;

  -- C1. Rakeback over-attribution (last 24 h)
  FOR r IN
    WITH attributed AS MATERIALIZED (
      SELECT rr.id AS record_id, rr.club_id, rr.rake_amount, round(sum(ra.rake_amount),2) AS attributed
      FROM public.rake_records rr
      JOIN public.rake_attributions ra ON ra.rake_record_id = rr.id
      WHERE rr.created_at > now() - interval '24 hours'
      GROUP BY rr.id, rr.club_id, rr.rake_amount
      HAVING round(sum(ra.rake_amount),2) > round(rr.rake_amount,2) + 0.01
    )
    SELECT * FROM attributed LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:rakeback_chain', 'incorrect_rakeback', 'warning',
      'rakeback-overattr:' || r.record_id::text,
      round(r.attributed - r.rake_amount, 2), r.rake_amount, r.attributed,
      'reporting', 'rake_attributions', r.record_id, r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'rake attributions exceed the rake actually collected for this record - the rakeback chain would over-accrue',
      NULL, jsonb_build_object('rake_record_id', r.record_id));
    n := n + 1;
  END LOOP;

  -- C2. Rakeback over-payout (paid more than the player contributed, last 7 d)
  FOR r IN
    SELECT p.id, p.club_id, p.user_id, p.payout_amount, p.user_rake_contribution
    FROM public.rakeback_period_payouts p
    WHERE p.status = 'paid' AND p.paid_at > now() - interval '7 days'
      AND p.payout_amount > COALESCE(p.user_rake_contribution, 0) + 0.01
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:rakeback_chain', 'incorrect_rakeback', 'critical',
      'rakeback-overpay:' || r.id::text,
      round(r.payout_amount - COALESCE(r.user_rake_contribution,0), 2),
      r.user_rake_contribution, r.payout_amount,
      'settlement', 'rakeback_period_payouts', r.id, r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'a rakeback payout exceeds the player''s ENTIRE rake contribution - impossible under any percentage',
      NULL, jsonb_build_object('payout_id', r.id, 'user_id', r.user_id));
    n := n + 1;
  END LOOP;

  -- C3. Rakeback dual-write evidence gaps (last 7 d)
  /* A ZERO PAYOUT HAS NO MONEY SIDE TO POINT AT (2026-10-03). The routed
     and legacy rakeback stages write one 'paid' payout row per certified
     period, including a period whose rakeback rounds to 0.00 (0.08 of rake
     at 5% is 0.004), and move chips only when the amount is above zero. A
     0.00 row therefore never has a wallet transaction, and asking it for one
     filed a permanent evidence warning (period payout e7f0b9bc, 2026-10-02).
     Only a payout or transfer that moved chips owes an evidence pointer. */
  FOR r IN
    SELECT 'period_payout' AS src, p.id, p.club_id FROM public.rakeback_period_payouts p
     WHERE p.status = 'paid' AND p.paid_at > now() - interval '7 days' AND p.wallet_transaction_id IS NULL
       AND p.payout_amount > 0
       AND NOT EXISTS(SELECT 1 FROM(SELECT c.id,c.payer_kind FROM public.accounting_rakeback_period_calculations c
        WHERE c.period_id=p.rakeback_period_id ORDER BY c.id DESC LIMIT 1)cert
        WHERE cert.payer_kind='split' AND smarter_private.split_rakeback_payout_complete(p.id,cert.id))
    UNION ALL
    SELECT 'distribution', d.id, d.club_id FROM public.rakeback_distributions d
     WHERE d.status IN ('transferred','paid') AND d.transferred_at > now() - interval '7 days'
       AND d.chip_transfer_id IS NULL
       AND d.rakeback_amount > 0
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:rakeback_chain', 'reporting_mismatch', 'warning',
      'rakeback-evidence:' || r.src || ':' || r.id::text,
      0, NULL, NULL, 'reporting', 'rakeback_' || r.src, r.id, r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'rakeback marked paid/transferred with no linked wallet/chip transaction - the money side has no evidence pointer',
      NULL, jsonb_build_object('kind', r.src, 'row_id', r.id));
    n := n + 1;
  END LOOP;

  -- D. Ticket conservation
  FOR r IN
    SELECT t.id, t.club_id, t.status, t.value,
           CASE WHEN t.status='redeemed' AND t.redeemed_at IS NULL THEN 'redeemed_without_timestamp'
                WHEN t.status='cancelled' AND t.cancelled_at IS NULL THEN 'cancelled_without_timestamp'
                WHEN t.status NOT IN ('redeemed','cancelled') AND COALESCE(t.value,0) <= 0 THEN 'active_nonpositive_value'
           END AS why
    FROM public.tournament_tickets t
    WHERE (t.status='redeemed' AND t.redeemed_at IS NULL)
       OR (t.status='cancelled' AND t.cancelled_at IS NULL)
       OR (t.status NOT IN ('redeemed','cancelled') AND COALESCE(t.value,0) <= 0)
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:tickets', 'reporting_mismatch', 'warning',
      'ticket:' || r.id::text,
      COALESCE(r.value,0), NULL, NULL, 'reporting', 'tournament_tickets', r.id, r.club_id,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'ticket conservation violation: ' || r.why,
      NULL, jsonb_build_object('ticket_id', r.id, 'status', r.status, 'why', r.why));
    n := n + 1;
  END LOOP;

  -- E. Insurance pair-match (net must equal payout − premium; last 24 h)
  FOR r IN
    SELECT i.id, i.club_id, i.union_id, i.premium, i.payout, i.net_result
    FROM public.insurance_transactions i
    WHERE i.created_at > now() - interval '24 hours'
      AND round(COALESCE(i.payout,0) - COALESCE(i.premium,0), 2) <> round(COALESCE(i.net_result,0), 2)
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:insurance', 'reporting_mismatch', 'warning',
      'insurance-pair:' || r.id::text,
      round((COALESCE(r.payout,0) - COALESCE(r.premium,0)) - COALESCE(r.net_result,0), 2),
      round(COALESCE(r.payout,0) - COALESCE(r.premium,0), 2), r.net_result,
      'reporting', 'insurance_transactions', r.id, r.club_id, r.union_id,
      NULL, NULL, NULL, NULL, NULL, NULL,
      'insurance row does not pair: net_result must equal payout minus premium exactly',
      NULL, jsonb_build_object('insurance_id', r.id));
    n := n + 1;
  END LOOP;

  -- F. Ticket VALUE conservation (phase 2b): every redeemed/cancelled
  -- ticket must have exactly one credit receipt of exactly its value.
  FOR r IN
    SELECT t.id, t.club_id, t.value, t.status,
           (SELECT count(*) FROM public.chip_transactions ct
             /* A TICKET ENTRY IS AN ENTRY (2026-09-10): an entry-only ticket is
                redeemed by the entry door, whose receipt is
                tournament_ticket_entry; the cash door writes
                tournament_ticket_redeem. Both are the one receipt. */
             WHERE ct.transaction_type = ANY (CASE t.status WHEN 'redeemed'
                     THEN ARRAY['tournament_ticket_redeem','tournament_ticket_entry']
                     ELSE ARRAY['tournament_ticket_cancel'] END)
               AND ct.metadata->>'ticket_id' = t.id::text) AS receipts,
           (SELECT COALESCE(sum(ct.amount),0) FROM public.chip_transactions ct
             /* A TICKET ENTRY IS AN ENTRY (2026-09-10): an entry-only ticket is
                redeemed by the entry door, whose receipt is
                tournament_ticket_entry; the cash door writes
                tournament_ticket_redeem. Both are the one receipt. */
             WHERE ct.transaction_type = ANY (CASE t.status WHEN 'redeemed'
                     THEN ARRAY['tournament_ticket_redeem','tournament_ticket_entry']
                     ELSE ARRAY['tournament_ticket_cancel'] END)
               AND ct.metadata->>'ticket_id' = t.id::text) AS receipt_value
    FROM public.tournament_tickets t
    WHERE t.status IN ('redeemed','cancelled')
      AND COALESCE(t.redeemed_at, t.cancelled_at) > now() - interval '24 hours'
    LIMIT 50
  LOOP
    IF r.receipts <> 1 OR round(r.receipt_value,2) <> round(r.value,2) THEN
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_settlement_correctness_check:ticket_value', 'reporting_mismatch', 'warning',
        'ticket-value:' || r.id::text,
        round(r.receipt_value - r.value, 2), r.value, r.receipt_value,
        'settlement', 'tournament_tickets', r.id, r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'ticket value conservation broken: ' || r.status || ' ticket worth ' || r.value
          || ' has ' || r.receipts || ' receipt(s) totalling ' || r.receipt_value,
        NULL, jsonb_build_object('ticket_id', r.id));
      n := n + 1;
    END IF;
  END LOOP;

  -- G. All-player atomic coverage: both windows count the same hand identities.
  -- The common commit receipt covers ordinary and diamond hands. The existing
  -- claims metadata keys remain compatible, and now mean matched receipts.
  DECLARE
    v_hands_24h bigint; v_claims_24h bigint; v_hands_1h bigint; v_claims_1h bigint;
  BEGIN
    /* THE HOUR FIRST, THE DAY ONLY WHEN THE HOUR ACCUSES (2026-10-03).
       An incident needs BOTH the 24-hour adoption gate and the 1-hour
       shortfall. Reading the day first materialised ~885,000 hands and as
       many receipts every hour and was cancelled in 3 of 6 runs. The hour is
       read alone (the same hands: created_at > now() - 60 min is inside the
       24 h set, and a receipt that matches a hand's hand_number is inside the
       set's hand_number range by construction; hand_atomic_commits.hand_id is
       unique, so the join cannot duplicate). The day is read, exactly as
       before, only when the hour would fire; otherwise its counts stay NULL
       and the gate below is false, which is the verdict the hour already
       gave. Measured: 17.3 s for the hour on production. */
    SELECT count(*), count(c.hand_id)
      INTO v_hands_1h, v_claims_1h
      FROM public.hand_history h
      LEFT JOIN public.hand_atomic_commits c
        ON c.hand_id=h.id AND c.table_id=h.table_id AND c.hand_number=h.hand_number
     WHERE h.created_at>now()-interval '60 minutes';
    IF v_hands_1h >= 20 AND v_claims_1h < (v_hands_1h * 9) / 10 THEN
      WITH recent AS MATERIALIZED (
        SELECT id,table_id,hand_number,created_at
        FROM public.hand_history WHERE created_at>now()-interval '24 hours'
      ), receipts AS MATERIALIZED (
        SELECT hand_id,table_id,hand_number FROM public.hand_atomic_commits
        WHERE hand_number BETWEEN (SELECT min(hand_number) FROM recent)
                              AND (SELECT max(hand_number) FROM recent)
      )
      SELECT count(*) AS hands_24h,count(c.hand_id) AS commits_24h
      INTO v_hands_24h,v_claims_24h
      FROM recent h LEFT JOIN receipts c
       ON c.hand_id=h.id AND c.table_id=h.table_id AND c.hand_number=h.hand_number;
    END IF;
    IF v_hands_24h > 100 AND v_claims_24h >= v_hands_24h / 2 THEN
      IF v_hands_1h >= 20 AND v_claims_1h < (v_hands_1h * 9) / 10 THEN
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_settlement_correctness_check:fallback_regression', 'settlement_error', 'warning',
          'fallback-regression:' || to_char(now(), 'YYYY-MM-DD-HH24'),
          0, v_hands_1h, v_claims_1h, 'settlement', 'hand_atomic_commits',
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          'atomic hand settlement coverage fell to ' || v_claims_1h || '/' || v_hands_1h
            || ' hands in the last hour after adoption - matching atomic hand receipts are missing',
          NULL, jsonb_build_object('claims_1h', v_claims_1h, 'hands_1h', v_hands_1h));
        n := n + 1;
      END IF;
    END IF;
  END;

  -- ═══════════════════════════════════════════════════════════════════════
  --  H. THE SETTLER'S WATERMARK IS THE UNION CASCADE'S GATE (2026-09-21)
  -- ═══════════════════════════════════════════════════════════════════════
  --
  -- fn_process_weekly_accounting_scope raises
  -- `weekly_rake_source_not_fully_accrued` when any cash rake record inside
  -- the week being settled still sits above
  -- daemon_state.rakeback_settler.high_water_mark. That refusal is correct and
  -- must stay - settling a week on a source that is not fully accrued posts an
  -- understated week. What was missing is that the CONDITION causing it was
  -- invisible.
  --
  -- Measured 2026-09-21T15:26:06Z: the watermark was 2026-09-21T14:34:09Z, 52
  -- minutes stale, with 985 rake_records above it, while
  -- engine.smarter.poker/health reported settlementStatus "ok" and
  -- blockedSettlementCount 0, and fn_settler_lag_check - which nothing in the
  -- codebase or the cron schedule ever called - returned healthy:true.
  --
  -- No new job, timer, watcher or repair loop: this hourly settlement
  -- correctness check already runs and already raises durable, deduped,
  -- escalatable incidents. It now also asks the settler probe, and the probe
  -- now knows what the settler's interval is and what the cascade needs.
  DECLARE
    v_settler jsonb;
    v_blocked boolean;
  BEGIN
    v_settler := public.fn_settler_lag_check();
    IF COALESCE((v_settler->>'healthy')::boolean, true) IS NOT TRUE THEN
      v_blocked := COALESCE((v_settler->>'week_settlement_blocked')::boolean, false);
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_settlement_correctness_check:settler_lag', 'settlement_error',
        CASE WHEN v_blocked THEN 'critical' ELSE 'warning' END,
        'settler-lag:' || CASE WHEN v_blocked THEN 'blocking:' ELSE 'stalled:' END
          || to_char(now(), 'YYYY-MM-DD-HH24'),
        0, NULL, NULLIF(v_settler->>'backlog_rows','')::numeric,
        'settlement', 'daemon_state', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        CASE WHEN v_blocked THEN
          'the union weekly cascade WILL refuse this week: '
            || COALESCE(v_settler->>'week_unaccrued_rows','?')
            || ' cash rake record(s) inside the week now due to settle are still above the'
            || ' rakeback settler watermark (' || COALESCE(v_settler->>'cursor','?')
            || '). fn_process_weekly_accounting_scope raises'
            || ' weekly_rake_source_not_fully_accrued on exactly this state and settles nothing.'
        ELSE
          'the rakeback settler watermark has not advanced for '
            || COALESCE(v_settler->>'last_save_minutes_ago','?') || ' minute(s) while '
            || COALESCE(v_settler->>'backlog_rows','?') || ' rake record(s) wait above it.'
            || ' The settler interval is ' || COALESCE(v_settler->>'interval_minutes','?')
            || ' minutes, so the drain has skipped a cycle - and a watermark left behind the'
            || ' week end blocks the whole union settlement cascade.'
        END,
        NULL, v_settler);
      n := n + 1;
    END IF;
  END;

  RETURN n;
END $function$;


REVOKE ALL ON FUNCTION fn_ca_settlement_correctness_check() FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION public.fn_ca_settlement_correctness_check() TO service_role;
DO $declaration$ DECLARE declared text;BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_declare_guard_redefinition(text,text)'::regprocedure))<>'3a3746dc6e0a5b7a1db97805588c0eb8'
 THEN RAISE EXCEPTION 'historical_rakeback_guard_declaration_owner_changed';END IF;
 declared:=public.fn_ca_declare_guard_redefinition('fn_ca_settlement_correctness_check',
  'migration 20261019213557_weekly_rakeback_preserves_every_historical_payer_share');
 IF declared<>'6b151d00df78c2857dcc05f9abd1ff8d' OR NOT EXISTS(SELECT 1 FROM public.ca_guard_defs
  WHERE proname='fn_ca_settlement_correctness_check' AND def_hash=declared
   AND declared_ref='migration 20261019213557_weekly_rakeback_preserves_every_historical_payer_share')
 THEN RAISE EXCEPTION 'historical_rakeback_guard_declaration_not_recorded';END IF;
END $declaration$;

COMMIT;
