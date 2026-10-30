-- @live-proof: md5(pg_get_functiondef('public.fn_agent_wallet_send_core_20260830(uuid,uuid,numeric,text,text,uuid)'::regprocedure))='1ee7dc270ba19bf1b6a4a894900d9b38' AND md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz)'::regprocedure))='ce1a9dd4344c7987918dcf8a82427ef5' AND md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamptz,timestamptz)'::regprocedure))='4e44bbbaf769aafe445819ab7a6683a4' AND md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))='a68500342f07e0608c6eb69f4cb0739e' AND md5(pg_get_functiondef('smarter_private.weekly_payout_eligible_scopes(timestamptz,timestamptz)'::regprocedure))='fd2603a21dc9c93a234afbda57d6abba' AND md5(pg_get_functiondef('public.fn_club_set_member_role(uuid,uuid,text,uuid,numeric,numeric,boolean,numeric)'::regprocedure))='c0f4657b3a53265b0d7fe03784d1b83b' AND md5(pg_get_functiondef('public.fn_process_credit_invoice_payment(uuid,numeric,text,uuid,text)'::regprocedure))='e99cfa877c5a67d5dde5744ea76b4285' AND md5(pg_get_functiondef('public.fn_accounting_credit_document_on_insert()'::regprocedure))='5a515636d7634d29514c723aa5dcfae2' AND md5(pg_get_functiondef('public.fn_generate_credit_invoice(uuid,timestamptz,timestamptz,numeric,timestamptz)'::regprocedure))='c87928c03ef42c498377c17bbaa51a7f' AND md5(pg_get_functiondef('public.fn_generate_scope_credit_invoices(uuid,timestamptz,timestamptz)'::regprocedure))='851f015057ecefc7ab4162cc36fa522c' AND md5(pg_get_functiondef('public.fn_generate_all_credit_invoices(timestamptz)'::regprocedure))='e1e68666b757cda7b3d314acde7c599b' AND md5(pg_get_functiondef('public.fn_capture_agent_credit_week(uuid[],timestamptz,timestamptz,text,uuid)'::regprocedure))='0d3ab6e7532fc9a3ee245658c617d79a' AND NOT has_function_privilege('authenticated','public.fn_capture_agent_credit_week(uuid[],timestamptz,timestamptz,text,uuid)','EXECUTE') AND NOT has_table_privilege('authenticated','public.agent_credit_weekly_basis','INSERT,UPDATE,DELETE') AND (SELECT relrowsecurity FROM pg_class WHERE oid='public.agent_credit_weekly_basis'::regclass)
-- Credit lines track funded advances; they never create spendable chips.
-- Weekly invoices freeze max(0,line-wallet) before R2/R3 earnings, including zero
-- balances. Historical documents/receipts are retained. No live money is moved by installation.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';
DO $preimage$ DECLARE r record;BEGIN
 FOR r IN SELECT * FROM jsonb_to_recordset($json$[{"signature":"public.fn_agent_wallet_send_core_20260830(uuid,uuid,numeric,text,text,uuid)","md5":"b6a564b2790c6fdcfe7f7a86d058048a"},{"signature":"public.fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz)","md5":"acc58329cf6eb0e50ca47afea3bdf60f"},{"signature":"public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamptz,timestamptz)","md5":"cbf5dc2e01fada46b4f04625f00282f9"},{"signature":"public.fn_process_weekly_accounting_scope(uuid,uuid)","md5":"aa771409420704b6dd05cfaef9d2f8dc"},{"signature":"smarter_private.weekly_payout_eligible_scopes(timestamptz,timestamptz)","md5":"470f87a0efd7f20ab78320e051ab8453"},{"signature":"public.fn_club_set_member_role(uuid,uuid,text,uuid,numeric,numeric,boolean,numeric)","md5":"7432735e2bbb96eea24bf22d2cc79817"},{"signature":"public.fn_process_credit_invoice_payment(uuid,numeric,text,uuid,text)","md5":"3c31d57d2c4f6ecdf388c5157f311e5a"},{"signature":"public.fn_accounting_credit_document_on_insert()","md5":"64b3c2467897361d25e4646613ca6b7d"},{"signature":"public.fn_generate_credit_invoice(uuid,timestamptz,timestamptz,numeric,timestamptz)","md5":"b0e4603b081f48ce1beb6963e0356c9a"},{"signature":"public.fn_generate_scope_credit_invoices(uuid,timestamptz,timestamptz)","md5":"39c253e5712a955d50520f431c8b48ab"},{"signature":"public.fn_generate_all_credit_invoices(timestamptz)","md5":"05cc9531e75de24dc86ec3c5e16de04e"}]$json$::jsonb) AS x(signature text,md5 text) LOOP
 IF md5(pg_get_functiondef(to_regprocedure(r.signature))) IS DISTINCT FROM r.md5 THEN RAISE EXCEPTION 'credit_tracking_owner_preimage_changed:%',r.signature; END IF;
 END LOOP;
END $preimage$;
CREATE TABLE public.agent_credit_tracking_policy(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),activated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO public.agent_credit_tracking_policy(singleton) VALUES(true);
CREATE TABLE public.agent_credit_weekly_scopes(club_id uuid NOT NULL,period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,captured_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(club_id,period_end),CHECK(isfinite(period_start) AND isfinite(period_end) AND period_start<period_end));
CREATE TABLE public.agent_credit_weekly_basis(
 agent_id uuid NOT NULL,club_id uuid NOT NULL,period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,
 credit_line numeric NOT NULL,agent_wallet_before_rakeback numeric NOT NULL,
 amount_owed numeric GENERATED ALWAYS AS(greatest(credit_line-agent_wallet_before_rakeback,0)) STORED,
 captured_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(agent_id,period_end),
 CHECK(isfinite(period_start) AND isfinite(period_end) AND period_start<period_end),
 CHECK(credit_line::text NOT IN('NaN','Infinity','-Infinity') AND credit_line>=0 AND credit_line=round(credit_line,2)),
 CHECK(agent_wallet_before_rakeback::text NOT IN('NaN','Infinity','-Infinity') AND agent_wallet_before_rakeback>=0 AND agent_wallet_before_rakeback=round(agent_wallet_before_rakeback,2)));
ALTER TABLE public.agent_credit_tracking_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_credit_weekly_basis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_credit_weekly_scopes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_credit_tracking_policy,public.agent_credit_weekly_basis,public.agent_credit_weekly_scopes FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.agent_credit_tracking_policy,public.agent_credit_weekly_basis,public.agent_credit_weekly_scopes TO service_role;
CREATE OR REPLACE FUNCTION public.fn_capture_agent_credit_week(p_clubs uuid[],p_from timestamptz,p_to timestamptz,p_kind text,p_scope uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE c uuid;a record;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_clubs IS NULL OR p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_from>=p_to OR p_to>now() THEN RAISE EXCEPTION 'invalid_credit_scope' USING ERRCODE='22023'; END IF;
 IF p_from IS DISTINCT FROM public.fn_union_week_start(p_from) OR p_to IS DISTINCT FROM public.fn_union_week_start(p_from+interval '8 days') THEN RAISE EXCEPTION 'credit_tracking_requires_one_accounting_week' USING ERRCODE='22023'; END IF;
 -- Never reconstruct an old week's balance from today's chips.
 IF p_to<(SELECT activated_at FROM public.agent_credit_tracking_policy WHERE singleton) THEN RETURN; END IF;
 -- A paid stage can only replay the basis it captured, never invent a late one.
 IF EXISTS(SELECT FROM public.accounting_routed_settlement_runs WHERE scope_kind=p_kind AND scope_id=p_scope AND period_start=p_from AND period_end=p_to AND round_no=2) THEN RETURN; END IF;
 FOR c IN SELECT DISTINCT x FROM unnest(p_clubs)x ORDER BY x LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||c::text,0));
 END LOOP;
 FOR a IN SELECT id,club_id,credit_limit,agent_wallet_balance FROM public.agents WHERE club_id=ANY(p_clubs) AND NOT COALESCE(is_prepaid,false) AND credit_limit>0 AND NOT EXISTS(SELECT FROM public.agent_credit_weekly_scopes captured WHERE captured.club_id=agents.club_id AND captured.period_end=p_to) ORDER BY club_id,id FOR UPDATE LOOP
  INSERT INTO public.agent_credit_weekly_basis(agent_id,club_id,period_start,period_end,credit_line,agent_wallet_before_rakeback)
  VALUES(a.id,a.club_id,p_from,p_to,a.credit_limit,a.agent_wallet_balance) ON CONFLICT(agent_id,period_end) DO NOTHING;
 END LOOP;
 FOR c IN SELECT DISTINCT x FROM unnest(p_clubs)x ORDER BY x LOOP
  INSERT INTO public.agent_credit_weekly_scopes(club_id,period_start,period_end) VALUES(c,p_from,p_to) ON CONFLICT(club_id,period_end) DO NOTHING;
  PERFORM public.fn_generate_scope_credit_invoices(c,p_from,p_to);
 END LOOP;
END $function$;
REVOKE ALL ON FUNCTION public.fn_capture_agent_credit_week(uuid[],timestamptz,timestamptz,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_capture_agent_credit_week(uuid[],timestamptz,timestamptz,text,uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_agent_wallet_send_core_20260830(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_context jsonb;
  v_setting text;
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_dest         text := lower(coalesce(p_destination, 'player_wallet'));
  v_op_id        uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior        record;
  v_agent_id     uuid;
  v_float_before numeric;
  v_float_after  numeric;
  v_is_prepaid   boolean;
  v_credit_limit numeric;
  v_credit_used  numeric;
  v_credit_after numeric;
  v_to_role      text;
  v_to_agent_id  uuid;
  v_to_after     numeric;
  v_tx_id        uuid;
  v_until        timestamptz;
begin
  -- Serialize the existing agreement before any operation/hierarchy/row lock.
  -- Nested callers reacquire the same transaction lock; no new money path.
  IF p_club_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
  END IF;

  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'agent_wallet_send'
     and from_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric,
      'credit_drawn', coalesce((v_prior.metadata ->> 'credit_drawn')::numeric, 0),
      'credit_used_after', (v_prior.metadata ->> 'credit_used_after')::numeric,
      'credit_limit', (v_prior.metadata ->> 'credit_limit')::numeric);
  end if;

  v_actor_role := public.fn_club_bank_role(p_club_id);
  if v_actor_role is null
     or v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only Staff Or Agents Hold An Agent Wallet');
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;
  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('success', false,
      'error', 'Chips Move In Hundredths At Most');
  end if;
  if p_amount > 1e9 then
    return jsonb_build_object('success', false, 'error', 'Amount Exceeds The Single Send Limit');
  end if;
  if v_dest not in ('player_wallet', 'agent_wallet', 'promo_wallet') then
    return jsonb_build_object('success', false, 'error', 'Unknown Destination Wallet');
  end if;
  if p_to_user_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose A Recipient');
  end if;
  if p_to_user_id = v_actor and v_dest <> 'player_wallet' then
    return jsonb_build_object('success', false,
      'error', 'You Cannot Send Chips To Yourself');
  end if;

  if p_to_user_id <> v_actor and not public.fn_club_cashier_can_transact(p_club_id, v_actor, p_to_user_id) then
    return jsonb_build_object('success', false,
      'error', 'That Member Is Not In Your Downline');
  end if;

  select cm.role into v_to_role
    from club_members cm
   where cm.club_id = p_club_id
     and cm.user_id = p_to_user_id
     and coalesce(cm.status, 'active') in ('active', 'approved')
   for update;
  if v_to_role is null then
    return jsonb_build_object('success', false,
      'error', 'Recipient Is Not An Active Member Of This Club');
  end if;
  if v_dest in ('agent_wallet', 'promo_wallet')
     and v_to_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only Staff Or Agents Hold An Agent Wallet');
  end if;

  if v_dest = 'player_wallet' and v_to_role = 'admin' then
    return jsonb_build_object('success', false,
      'error', 'An Admin Does Not Hold A Player Wallet');
  end if;

  select a.id, coalesce(a.agent_wallet_balance, 0),
         coalesce(a.is_prepaid, true),
         coalesce(a.credit_limit, 0), coalesce(a.credit_used, 0)
    into v_agent_id, v_float_before, v_is_prepaid, v_credit_limit, v_credit_used
    from agents a
   where a.club_id = p_club_id and a.user_id = v_actor
   for update;
  if v_agent_id is null then
    return jsonb_build_object('success', false,
      'error', 'Your Agent Wallet Has Not Been Funded Yet');
  end if;

  -- The credit line records advances; it never funds a send.
  if v_float_before::text in ('NaN','Infinity','-Infinity') or v_float_before < 0 then
    raise exception 'Agent Wallet Balance Is Invalid' using errcode='23514';
  end if;
  if v_float_before < p_amount then
    return jsonb_build_object('success', false,
      'error', 'Your Agent Wallet Only Holds '
        || trim(to_char(v_float_before, 'FM999,999,999,990.00')) || ' Chips',
      'balance', v_float_before, 'requested', p_amount,
      'credit_tracking_only', true);
  end if;

  -- One funded agent_send transfers existing chips to the selected wallet.
  select jsonb_object_agg(k,coalesce(current_setting(k,true),'')) into v_context
   from unnest(array['app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_tournament','app.ledger_settlement','app.ledger_idempotency_key','app.ledger_correlation','app.ledger_autoskip_agents']) settings(k);
  perform set_config('app.ledger_tournament','',true);
  perform set_config('app.ledger_settlement','',true);
  perform public.fn_ca_declare_ledger('agent_send', 'agent_wallet', v_actor, null,
    'agent_send:' || v_op_id::text, array['agents']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);
  update agents
     set agent_wallet_balance = coalesce(agent_wallet_balance, 0) - p_amount,
         updated_at = now()
   where id = v_agent_id
   returning agent_wallet_balance, credit_used into v_float_after, v_credit_after;

  if v_dest = 'player_wallet' then
    update club_members
       set chip_balance = coalesce(chip_balance, 0) + p_amount,
           updated_at = now()
     where club_id = p_club_id and user_id = p_to_user_id
     returning chip_balance into v_to_after;
  else
    v_to_agent_id := public.fn_ensure_agent_row(p_club_id, p_to_user_id, v_to_role);
    if v_to_agent_id is null then
      raise exception 'could not ensure agents row for % in club %', p_to_user_id, p_club_id;
    end if;
    if v_dest = 'promo_wallet' then
      update agents set promo_wallet_balance = coalesce(promo_wallet_balance, 0) + p_amount, updated_at = now()
       where id = v_to_agent_id returning promo_wallet_balance into v_to_after;
    else
      update agents set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + p_amount, updated_at = now()
       where id = v_to_agent_id returning agent_wallet_balance into v_to_after;
    end if;
    perform set_config('app.ledger_idempotency_key', '', true);
    perform public.fn_ca_post_leg('agent_send', 'agent_wallet', v_actor, v_dest, p_to_user_id,
      p_amount, p_club_id, 'agent_send:' || v_op_id::text,
      'Agent wallet send to a downline agent wallet (fn_agent_wallet_send_core_20260830)');
  end if;

  for v_setting in select jsonb_object_keys(v_context) loop
    perform set_config(v_setting,v_context->>v_setting,true);
  end loop;

  v_until := now() + interval '10 minutes';

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata,
     balance_after, reversible_until)
  values
    (p_club_id, v_actor, p_to_user_id, p_amount, 'agent_wallet_send',
     coalesce(nullif(btrim(p_reason), ''), 'Agent Wallet Send'),
     jsonb_build_object(
       'op_id', v_op_id,
       'destination', v_dest,
       'actor_role', v_actor_role,
       'recipient_role', v_to_role,
       'agent_wallet_before', v_float_before,
       'agent_wallet_after', v_float_after,
       'recipient_balance_after', v_to_after,
       'claimed_back', 0,
       -- What was borrowed to make this send, and how much of that borrowing
       -- has since been handed back. The claim back reads both.
       'credit_drawn', 0,
       'credit_repaid', 0,
       'credit_used_after', v_credit_after,
       'credit_limit', v_credit_limit,
       'clawback_window_minutes', 10),
     v_float_after, v_until)
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true, 'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', p_amount,
    'destination', v_dest,
    'agent_wallet_before', v_float_before,
    'agent_wallet_after', v_float_after,
    'recipient_balance_after', v_to_after,
    'credit_drawn', 0,
    'credit_used_after', v_credit_after,
    'credit_limit', v_credit_limit,
    'reversible_until', v_until);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from chip_transactions
     where club_id = p_club_id
       and transaction_type = 'agent_wallet_send'
       and from_user_id = v_actor
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    if v_prior.id is null then
      raise;
    end if;
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric,
      'credit_drawn', coalesce((v_prior.metadata ->> 'credit_drawn')::numeric, 0),
      'credit_used_after', (v_prior.metadata ->> 'credit_used_after')::numeric,
      'credit_limit', (v_prior.metadata ->> 'credit_limit')::numeric);
end
$function$;

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
 PERFORM smarter_private.assert_own_agent_scope_interpreted(p_scope_kind,p_scope_id,p_period_start,p_period_end,2);
 run_key:='round2:v3:'||scope.scope_key||':'||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text;
 PERFORM public.fn_lock_rakeback_payer_clubs(scope.club_ids);
 PERFORM public.fn_capture_agent_credit_week(scope.club_ids,p_period_start,p_period_end,p_scope_kind,p_scope_id);
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
 PERFORM smarter_private.weekly_payout_require_round(p_scope_kind,p_scope_id,p_period_start,p_period_end,2);
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
 PERFORM smarter_private.assert_own_agent_scope_interpreted(p_scope_kind,p_scope_id,p_period_start,p_period_end,2);
 run_key:='round2:v3:'||scope.scope_key||':'||extract(epoch FROM p_period_start)::text||':'||extract(epoch FROM p_period_end)::text;
 CREATE TEMP TABLE IF NOT EXISTS _routed_sources(source_type text,source_id uuid,club_id uuid,contract jsonb,earned_at timestamptz,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
 TRUNCATE pg_temp._routed_sources;
 PERFORM public.fn_lock_rakeback_payer_clubs(scope.club_ids);
 PERFORM public.fn_capture_agent_credit_week(scope.club_ids,p_period_start,p_period_end,p_scope_kind,p_scope_id);
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
 PERFORM smarter_private.weekly_payout_require_round(p_scope_kind,p_scope_id,p_period_start,p_period_end,2);
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

CREATE OR REPLACE FUNCTION public.fn_process_weekly_accounting_scope(p_union_id uuid, p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_attempt_budget integer := LEAST(8,COALESCE(NULLIF(current_setting('app.weekly_accounting_attempt_budget',true),'')::integer,8));
  v_scheduler_started timestamptz := LEAST(clock_timestamp(),COALESCE(NULLIF(current_setting('app.weekly_accounting_scheduler_started',true),'')::timestamptz,clock_timestamp()));
  v_scope record;v_scope_result jsonb;v_scope_checked integer;v_scope_failed integer;
  v_saved_budget text;v_saved_started text;v_more boolean:=false;v_visits integer:=0;
  v_stage2 jsonb;v_stage3 jsonb;v_statements jsonb;v_validated_before text;
  v_preparing_before_due boolean:=false;
  v_preparation jsonb; v_club record; v_pass int; v_batch jsonb; v_credit jsonb; v_started timestamptz; 
  v_now timestamptz := clock_timestamp();
  v_seal jsonb;
  v_report_seeded boolean := false;
  -- CHUNKED CLOSE (20261003): job 272 sets app.weekly_accounting_chunked.
  -- Each attempt then commits at most one money round of one book (the
  -- cascade or the standalone stages return 'chunk_committed'), the run row
  -- stays 'running' with that receipt, and the next tick continues from the
  -- rounds' own receipts. Unset, nothing below changes.
  v_chunked boolean := COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on';
  v_to timestamptz := public.fn_union_week_start(v_now);
  v_from timestamptz;
  v_first timestamptz;
  v_end timestamptz;
  v_due timestamptz;
  v_union record;
  v_previous jsonb;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_orphans integer;
  v_orphan_amount numeric;
  v_complete boolean;
  v_failed integer := 0;
  v_checked integer := 0;
  v_msg text; v_detail text; v_state text; v_context text;
  v_scope_outcome text; v_scope_error jsonb; v_prior_outcome text;
  -- A cron-sized statement budget (the 2400s tick), as opposed to the
  -- engine's 8s service_role probe.
  v_tick_budget_large boolean := current_setting('statement_timeout') IN ('0','0ms')
    OR current_setting('statement_timeout')::interval >= interval '20 minutes';
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = '42501';
  END IF;
  IF (p_union_id IS NOT NULL AND p_club_id IS NOT NULL)
    OR (p_union_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.unions WHERE id=p_union_id))
    OR (p_club_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.clubs WHERE id=p_club_id AND is_union IS NOT TRUE)) THEN
    RAISE EXCEPTION 'invalid_weekly_accounting_scope' USING ERRCODE='22023';END IF;
  -- Transaction locks release on errors and also work in reused connections.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN
    RETURN jsonb_build_object('success',true,'skipped',true,'reason','already_running');
  END IF;
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('success',true,'skipped',true,'reason','maintenance_window');
  END IF;

  IF v_attempt_budget<1 OR NOT isfinite(v_scheduler_started) THEN
    RAISE EXCEPTION 'invalid_weekly_scheduler_budget' USING ERRCODE='22023';END IF;
  IF p_union_id IS NULL AND p_club_id IS NULL THEN
    -- Seal any closed week's original inventory once, before a scope reads it,
    -- when this tick's budget can hold the seal. A chunked tick (job 272)
    -- seals six hours at a time within its own bounded statement (20261012):
    -- job 272 no longer has a larger budget to wait for.
    IF (v_tick_budget_large OR v_chunked) AND to_regprocedure('public.fn_union_pnl_inventory_checkpoint_due()') IS NOT NULL
      -- A gated week's seal waits with its close (20261003).
      AND NOT public.fn_accounting_close_seal_held(public.fn_union_week_start(v_now)) THEN
      BEGIN
        -- SPLIT SEAL (20261003): while the week's seal is still computed six
        -- hours at a time, this tick visits no scope (their P&L reads it);
        -- nor does the tick that sealed, which ran under the large budget.
        v_seal:=public.fn_union_pnl_inventory_checkpoint_due();
        IF v_seal->>'status'='sealing' OR jsonb_array_length(COALESCE(v_seal->'sealed','[]'::jsonb))>0 THEN
          RETURN jsonb_build_object('success',true,'checked',0,'failed',0,'visited_scopes',0,'more_remaining',true,
            'observed_at',clock_timestamp(),'detail','[]'::jsonb,'inventory_seal',v_seal);
        END IF;
      EXCEPTION
        WHEN query_canceled THEN
          GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT;
          IF v_msg IS DISTINCT FROM 'canceling statement due to statement timeout' THEN RAISE; END IF;
          -- A SEAL STEP THAT DOES NOT FIT THE TICK IS LOUD (20261012): there is no
          -- larger budget to retry it with, so it is a step to split, not to wait on.
          IF v_chunked AND NOT EXISTS(SELECT 1 FROM public.financial_alerts a WHERE a.source='union_accounting_scheduler'
            AND a.message='A weekly inventory seal step did not fit the bounded close tick' AND NOT COALESCE(a.resolved,false)
            AND a.created_at>clock_timestamp()-interval '1 hour') THEN
            INSERT INTO public.financial_alerts(source,severity,message,context)
            VALUES('union_accounting_scheduler','critical','A weekly inventory seal step did not fit the bounded close tick',
              jsonb_build_object('statement_timeout',current_setting('statement_timeout')));
          END IF;
          RETURN jsonb_build_object('success',false,'checked',0,'failed',0,'visited_scopes',0,'more_remaining',true,
            'observed_at',clock_timestamp(),'detail','[]'::jsonb,'error','inventory_checkpoint_seal_exceeded_the_tick_budget');
        WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
          INSERT INTO public.financial_alerts(source,severity,message,context)
          VALUES('union_accounting_scheduler','critical','The weekly original inventory checkpoint could not be sealed',
            jsonb_build_object('error',v_msg,'sqlstate',v_state,'detail',v_detail));
          -- A FAILED SEAL ENDS A CHUNKED TICK (20261012): the 2026-10-12 seal
          -- failures ran ~10 minutes each and the tick then went on to visit a
          -- scope in the same transaction (13 to 24 minutes in all).
          IF v_chunked THEN
            RETURN jsonb_build_object('success',false,'checked',0,'failed',0,'visited_scopes',0,'more_remaining',true,
              'observed_at',clock_timestamp(),'detail','[]'::jsonb,'error','inventory_checkpoint_seal_failed');
          END IF;
      END;
    END IF;
    -- A CALCULATING WEEK ADVANCES ON ITS OWN TICK (20261015173123): while a
    -- closed club-week is part way through its split recompute, a chunked
    -- tick spends its budget on those parts and visits no scope, as a tick
    -- still sealing the week's inventory does.
    IF v_chunked THEN
      v_seal:=public.fn_accounting_split_advance_due();
      IF v_seal->>'advanced'='true' THEN
        RETURN jsonb_build_object('success',true,'checked',0,'failed',0,'visited_scopes',0,'more_remaining',true,
          'observed_at',clock_timestamp(),'detail','[]'::jsonb,'split_advance',v_seal);
      END IF;
    END IF;
    -- A PROVING WEEK ADVANCES ON ITS OWN TICK (20261015182133): while a
    -- weekly close is in stage 'prepared', a chunked tick spends its budget
    -- proving that book's windows and visits no scope.
    IF v_chunked THEN
      v_seal:=public.fn_accounting_window_advance_due();
      IF v_seal->>'advanced'='true' THEN
        RETURN jsonb_build_object('success',true,'checked',0,'failed',0,'visited_scopes',0,'more_remaining',true,
          'observed_at',clock_timestamp(),'detail','[]'::jsonb,'window_advance',v_seal);
      END IF;
    END IF;
    v_saved_budget:=current_setting('app.weekly_accounting_attempt_budget',true);
    v_saved_started:=current_setting('app.weekly_accounting_scheduler_started',true);
    BEGIN
      FOR v_scope IN
        WITH cash_clubs AS MATERIALIZED (
          SELECT DISTINCT s.club_id FROM public.accounting_cash_rake_sources s
          WHERE s.coordinator_union_id IS NULL AND s.earned_at<v_to
        ), cash_cutoffs AS MATERIALIZED (
          SELECT c.club_id,public.fn_ca_launch_accounting_cutoff('club',c.club_id) AS cutoff FROM cash_clubs c
        ), standalone_earned AS (
          SELECT s.club_id,s.earned_at FROM public.accounting_cash_rake_sources s
          LEFT JOIN cash_cutoffs c ON c.club_id=s.club_id
          WHERE s.coordinator_union_id IS NULL AND s.earned_at<v_to
            AND CASE WHEN c.cutoff IS NULL THEN true
              ELSE s.earned_at IS NOT NULL AND isfinite(s.earned_at) AND s.earned_at>=c.cutoff END
          UNION ALL
          -- STANDALONE TOURNAMENT EARNINGS ARE READ PER CLUB (20261022150614): this branch
          -- used to read the tournament_fee_accrual half of
          -- accounting_payable_earning_sources for every source row on every tick
          -- (1.7M recognition probes, 10 s warm and over 100 s cold), which spent
          -- the close attempt's own 3-minute budget before the attempt began.
          -- The predicate below is that view branch verbatim, read per club from
          -- the club's own standalone fee rows. Only eligible below reads these
          -- rows, as GREATEST(first week, the club's settlement floor) for clubs
          -- that are not unions, so a club with any such earning before its floor
          -- contributes the floor itself and is not read further; any other club
          -- contributes its earliest earning (and earliest finite one).
          SELECT tc.id AS club_id,te.earned_at FROM public.clubs tc
          CROSS JOIN LATERAL (SELECT public.fn_club_settlement_floor_week(tc.id) AS floor) tf
          CROSS JOIN LATERAL (SELECT CASE WHEN tf.floor IS NOT NULL AND EXISTS(SELECT 1
              FROM (SELECT s.id,s.tournament_id,s.club_id,s.union_id,s.charged_at,s.rake_credit FROM public.accounting_tournament_fee_sources s
                     WHERE s.club_id=tc.id AND s.coordinator_union_id IS NULL OFFSET 0) s
              JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id AND rs.tournament_id=s.tournament_id
              JOIN public.accounting_tournament_fee_recognitions r ON r.tournament_id=s.tournament_id
              LEFT JOIN public.fn_ca_launch_accounting_club_cutoffs() bd(club_id,cutoff_at) ON bd.club_id=s.club_id
              WHERE (bd.cutoff_at IS NULL OR s.charged_at IS NOT NULL AND isfinite(s.charged_at) AND s.charged_at>=bd.cutoff_at)
                AND (bd.cutoff_at IS NULL OR rs.recognized_at IS NOT NULL AND isfinite(rs.recognized_at) AND rs.recognized_at>=bd.cutoff_at)
                AND rs.disposition='earned' AND r.status='recognized' AND rs.rake_credit=s.rake_credit AND rs.recognized_at=r.recognized_at
                AND NOT s.union_id IS DISTINCT FROM r.union_id AND rs.recognized_at<v_to AND rs.recognized_at<tf.floor)
            THEN tf.floor END AS clamp) tk
          CROSS JOIN LATERAL (
            SELECT tk.clamp AS earned_at WHERE tk.clamp IS NOT NULL
            UNION ALL
            SELECT tm.earned_at FROM (SELECT min(rs.recognized_at) AS m,min(rs.recognized_at) FILTER(WHERE isfinite(rs.recognized_at)) AS mf
              FROM (SELECT s.id,s.tournament_id,s.club_id,s.union_id,s.charged_at,s.rake_credit FROM public.accounting_tournament_fee_sources s
                     WHERE s.club_id=tc.id AND s.coordinator_union_id IS NULL OFFSET 0) s
              JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id AND rs.tournament_id=s.tournament_id
              JOIN public.accounting_tournament_fee_recognitions r ON r.tournament_id=s.tournament_id
              LEFT JOIN public.fn_ca_launch_accounting_club_cutoffs() bd(club_id,cutoff_at) ON bd.club_id=s.club_id
              WHERE tk.clamp IS NULL AND (bd.cutoff_at IS NULL OR s.charged_at IS NOT NULL AND isfinite(s.charged_at) AND s.charged_at>=bd.cutoff_at)
                AND (bd.cutoff_at IS NULL OR rs.recognized_at IS NOT NULL AND isfinite(rs.recognized_at) AND rs.recognized_at>=bd.cutoff_at)
                AND rs.disposition='earned' AND r.status='recognized' AND rs.rake_credit=s.rake_credit AND rs.recognized_at=r.recognized_at
                AND NOT s.union_id IS DISTINCT FROM r.union_id AND rs.recognized_at<v_to) ta
            CROSS JOIN LATERAL (VALUES(ta.m),(ta.mf)) tm(earned_at) WHERE tm.earned_at IS NOT NULL) te
          WHERE tc.is_union IS NOT TRUE
        ), standalone_work AS (
          SELECT s.club_id,LEAST(public.fn_union_week_start(min(s.earned_at) FILTER(WHERE isfinite(s.earned_at))),min(s.earned_at)) AS first_week
           FROM standalone_earned s GROUP BY s.club_id
          UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
           WHERE q.standalone_club_id IS NOT NULL AND q.status<>'complete'
          UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
           WHERE q.standalone_club_id IS NOT NULL AND q.status='complete' AND q.period_end<v_to
            AND NOT EXISTS(SELECT 1 FROM public.union_accounting_runs later
              WHERE later.standalone_club_id=q.standalone_club_id AND later.period_end>q.period_end)
          UNION ALL SELECT rp.club_id,min(public.fn_union_week_start(rp.period_start::timestamp AT TIME ZONE 'America/Los_Angeles'))
           FROM public.rakeback_periods rp WHERE rp.status='pending' AND rp.period_end<(v_to AT TIME ZONE 'America/Los_Angeles')::date
            AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=rp.club_id) GROUP BY rp.club_id
          UNION ALL SELECT a.club_id,public.fn_union_prev_week_start(v_now) FROM public.agents a
           WHERE NOT COALESCE(a.is_prepaid,false) AND a.credit_limit>0 AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=a.club_id)
        ), union_floors AS (
          SELECT u.id,f.earliest_period_start,CASE WHEN f.earliest_period_start IS NULL THEN public.fn_union_prev_week_start(v_now)
             WHEN public.fn_union_week_start(f.earliest_period_start)<f.earliest_period_start
              THEN public.fn_union_week_start(public.fn_union_week_start(f.earliest_period_start)+interval '8 days')
             ELSE public.fn_union_week_start(f.earliest_period_start) END AS first_week
           FROM public.unions u LEFT JOIN public.union_settlement_floor f ON f.union_id=u.id
        ), union_work AS (
          SELECT u.id,LEAST(u.first_week,(SELECT min(q.period_start) FROM public.union_accounting_runs q
            WHERE q.union_id=u.id
              AND (q.status<>'complete' OR (u.earliest_period_start IS NULL
                AND q.status='complete' AND q.result->>'success'='true' AND q.result->>'accounting_version'='3'))
              AND (u.earliest_period_start IS NULL OR q.period_start>=u.first_week))) AS first_week
           FROM union_floors u
        ), eligible AS (
          -- Match the exact-scope floor rounding and per-week due check. An
          -- older union backlog remains due before this Monday's new close.
          SELECT 'union'::text AS kind,w.id FROM union_work w WHERE w.first_week<v_to
           AND v_now>=CASE WHEN v_chunked THEN public.fn_union_week_start(w.first_week+interval '8 days') ELSE public.fn_union_accounting_run_at(public.fn_union_week_start(w.first_week+interval '8 days')) END
          UNION ALL SELECT 'club',w.club_id FROM standalone_work w JOIN public.clubs c ON c.id=w.club_id
           WHERE c.is_union IS NOT TRUE AND GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))<v_to
            AND v_now>=CASE WHEN v_chunked THEN public.fn_union_week_start(GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))+interval '8 days') ELSE public.fn_union_accounting_run_at(public.fn_union_week_start(GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))+interval '8 days')) END GROUP BY w.club_id
        ), eligible_unions AS (
          -- AN IN-PROGRESS CLOSE IS VISITED WITHOUT THE WHOLE SCAN (20261017121500):
          -- exactly the union rows of eligible. When no club book is in progress,
          -- every in-progress row of eligible is one of these, so the rows below
          -- are the exact in-progress prefix of the full ordering, and the tick
          -- ends with the first one's visit; the full scan is then not read.
          SELECT 'union'::text AS kind,w.id FROM union_work w WHERE w.first_week<v_to
           AND v_now>=CASE WHEN v_chunked THEN public.fn_union_week_start(w.first_week+interval '8 days') ELSE public.fn_union_accounting_run_at(public.fn_union_week_start(w.first_week+interval '8 days')) END
        ), owned_tick AS MATERIALIZED (
          SELECT e.kind,e.id,GREATEST(max(GREATEST(q.last_scheduler_visit_at,q.started_at)),max(v.last_visit_at)) AS last_visit,
            COALESCE(bool_or(v.last_outcome IN ('error','statement_timeout')),false) AS last_unfinished,
            -- AN IN-PROGRESS CLOSE OWNS ITS TICK (20261016000241): a book with a
            -- committed step and more to do goes first, unless its own last
            -- visit had that place and still did not finish.
            COALESCE(bool_or(q.status='running' AND q.result->>'chunk_committed'='true' AND q.period_end<=v_now),false)
             AND NOT COALESCE(bool_or(v.last_outcome IN ('error','statement_timeout') AND v.last_error->>'in_progress_visit'='true'),false) AS in_progress
          FROM eligible_unions e LEFT JOIN public.union_accounting_runs q ON q.scope_kind=e.kind AND q.scope_id=e.id
          LEFT JOIN public.weekly_accounting_scheduler_visits v ON v.scope_kind=e.kind AND v.scope_id=e.id
          GROUP BY e.kind,e.id
        ), tick_owner AS MATERIALIZED (
          SELECT NOT EXISTS(SELECT 1 FROM public.union_accounting_runs q WHERE q.scope_kind='club' AND q.status='running'
              AND q.result->>'chunk_committed'='true' AND q.period_end<=v_now)
            AND EXISTS(SELECT 1 FROM owned_tick o WHERE o.in_progress)
            -- ONLY A CHUNKED TICK OWNS IT (20261017132500): the engine's 8 s
            -- service_role probe reads the full scan, as it always has.
            AND v_chunked AS owned
        ) SELECT z.kind,z.id,z.last_visit,z.last_unfinished,z.in_progress FROM (
          SELECT o.kind,o.id,o.last_visit,o.last_unfinished,o.in_progress FROM owned_tick o
           WHERE o.in_progress AND (SELECT t.owned FROM tick_owner t)
          UNION ALL
          SELECT e.kind,e.id,GREATEST(max(GREATEST(q.last_scheduler_visit_at,q.started_at)),max(v.last_visit_at)) AS last_visit,
            COALESCE(bool_or(v.last_outcome IN ('error','statement_timeout')),false) AS last_unfinished,
            -- AN IN-PROGRESS CLOSE OWNS ITS TICK (20261016000241): a book with a
            -- committed step and more to do goes first, unless its own last
            -- visit had that place and still did not finish.
            COALESCE(bool_or(q.status='running' AND q.result->>'chunk_committed'='true' AND q.period_end<=v_now),false)
             AND NOT COALESCE(bool_or(v.last_outcome IN ('error','statement_timeout') AND v.last_error->>'in_progress_visit'='true'),false) AS in_progress
          FROM eligible e LEFT JOIN public.union_accounting_runs q ON q.scope_kind=e.kind AND q.scope_id=e.id
          LEFT JOIN public.weekly_accounting_scheduler_visits v ON v.scope_kind=e.kind AND v.scope_id=e.id
          WHERE NOT (SELECT t.owned FROM tick_owner t)
          GROUP BY e.kind,e.id
        ) z
          -- A scope whose last visit did not finish goes after every scope
          -- whose visit finished: it can never hold the others back.
          ORDER BY z.in_progress DESC,z.last_unfinished,z.last_visit NULLS FIRST,(z.kind='union') DESC,z.id
      LOOP
        IF v_checked>=v_attempt_budget OR clock_timestamp()-v_scheduler_started>interval '15 minutes'
          OR public.fn_platform_frozen() THEN
          v_more:=true;EXIT;END IF;
        -- Transaction advisory locks are reentrant. The exact child call uses
        -- this same scheduler lock and only the remaining TOTAL attempt budget.
        PERFORM set_config('app.weekly_accounting_attempt_budget',(v_attempt_budget-v_checked)::text,true);
        PERFORM set_config('app.weekly_accounting_scheduler_started',v_scheduler_started::text,true);
        -- The visit is its own subtransaction: whatever it raises rolls back
        -- this scope only, and is recorded below.
        v_scope_outcome:='visited'; v_scope_error:=NULL;
        BEGIN
        v_scope_result:=public.fn_process_weekly_accounting_scope(
          CASE WHEN v_scope.kind='union' THEN v_scope.id END,
          CASE WHEN v_scope.kind='club' THEN v_scope.id END);
        IF v_scope_result->>'skipped'='true' AND v_scope_result->>'reason'='maintenance_window' THEN
          v_scope_outcome:='maintenance';
        ELSE
        IF jsonb_typeof(v_scope_result->'checked') IS DISTINCT FROM 'number'
          OR jsonb_typeof(v_scope_result->'failed') IS DISTINCT FROM 'number'
          OR jsonb_typeof(v_scope_result->'detail') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'weekly_scope_scheduler_receipt_invalid' USING ERRCODE='23514';END IF;
        v_scope_checked:=(v_scope_result->>'checked')::integer;v_scope_failed:=(v_scope_result->>'failed')::integer;
        IF v_scope_checked<0 OR v_scope_checked>v_attempt_budget-v_checked OR v_scope_failed<0
          OR v_scope_failed>v_scope_checked OR jsonb_array_length(v_scope_result->'detail')<>v_scope_checked
          OR v_scope_result->'checked' IS DISTINCT FROM to_jsonb(v_scope_checked)
          OR v_scope_result->'failed' IS DISTINCT FROM to_jsonb(v_scope_failed)
          OR v_scope_result->'success' IS DISTINCT FROM to_jsonb(v_scope_failed=0)
          OR (SELECT count(*) FROM jsonb_array_elements(v_scope_result->'detail')d WHERE d->'result'->'success' IS DISTINCT FROM 'true'::jsonb
            AND d->'result'->'chunk_committed' IS DISTINCT FROM 'true'::jsonb)<>v_scope_failed
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_scope_result->'detail')d
            WHERE CASE WHEN v_scope.kind='union' THEN d->>'union_id' ELSE d->>'club_id' END IS DISTINCT FROM v_scope.id::text) THEN
          RAISE EXCEPTION 'weekly_scope_scheduler_receipt_invalid' USING ERRCODE='23514';END IF;
        END IF;
        EXCEPTION
          WHEN query_canceled THEN
            GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_state=RETURNED_SQLSTATE;
            -- An operator's cancel keeps its meaning: the whole tick stops.
            IF v_msg IS DISTINCT FROM 'canceling statement due to statement timeout' THEN RAISE; END IF;
            v_scope_outcome:='statement_timeout';
            v_scope_error:=jsonb_build_object('success',false,'error','weekly_scope_statement_budget_exhausted','sqlstate',v_state,
              'statement_timeout',current_setting('statement_timeout'));
          WHEN OTHERS THEN
            GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
            v_scope_outcome:='error';
            v_scope_error:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail);
        END;
        -- An in-progress book whose own visit had the tick and did not finish
        -- gives its place back for one tick (20261016000241).
        IF v_scope_outcome IN ('error','statement_timeout') AND v_scope.in_progress THEN
          v_scope_error:=v_scope_error||jsonb_build_object('in_progress_visit',true);
        END IF;
        IF v_scope_outcome='maintenance' THEN v_more:=true;EXIT;END IF;
        IF v_scope_outcome<>'visited' THEN
          v_scope_checked:=1;v_scope_failed:=1;
          v_scope_result:=jsonb_build_object('detail',jsonb_build_array(jsonb_build_object(
            CASE WHEN v_scope.kind='union' THEN 'union_id' ELSE 'club_id' END,v_scope.id,'result',v_scope_error)));
        END IF;
        v_checked:=v_checked+v_scope_checked;v_failed:=v_failed+v_scope_failed;
        v_results:=v_results||(v_scope_result->'detail');v_visits:=v_visits+1;
        v_more:=v_more OR COALESCE((v_scope_result->>'more_remaining')::boolean,false);
        -- Completed/zero-work scopes must move to the back too. Reuse one real
        -- run row; never change attempts, result, started_at or finished_at.
        UPDATE public.union_accounting_runs q SET last_scheduler_visit_at=clock_timestamp()
         WHERE q.scope_kind=v_scope.kind AND q.scope_id=v_scope.id
          AND (q.period_start,q.period_end)=(SELECT r.period_start,r.period_end FROM public.union_accounting_runs r
            WHERE r.scope_kind=v_scope.kind AND r.scope_id=v_scope.id ORDER BY r.period_start DESC,r.period_end DESC LIMIT 1);
        -- The durable visit exists even when the scope has no run row yet.
        SELECT s.last_outcome INTO v_prior_outcome FROM public.weekly_accounting_scheduler_visits s
         WHERE s.scope_kind=v_scope.kind AND s.scope_id=v_scope.id;
        INSERT INTO public.weekly_accounting_scheduler_visits AS s(scope_kind,scope_id,last_visit_at,last_outcome,last_error,unfinished_visits)
        VALUES(v_scope.kind,v_scope.id,clock_timestamp(),v_scope_outcome,v_scope_error,CASE WHEN v_scope_outcome='visited' THEN 0 ELSE 1 END)
        ON CONFLICT(scope_kind,scope_id) DO UPDATE SET last_visit_at=excluded.last_visit_at,last_outcome=excluded.last_outcome,
          last_error=excluded.last_error,unfinished_visits=CASE WHEN excluded.last_outcome='visited' THEN 0 ELSE s.unfinished_visits+1 END;
        -- A VISIT THAT FINISHED ENDS ITS SCOPE'S UNFINISHED-VISIT ALARMS
        -- (2026-10-17). Each says a visit to this scope did not finish; this
        -- one did, so that condition is over. Nothing else ever closed them:
        -- 41 stood open for one union and one club, every one already over.
        IF v_scope_outcome='visited' THEN
          UPDATE public.financial_alerts a
             SET resolved=true,resolved_at=clock_timestamp(),
                 resolution='verified: a later scheduler visit to this '||v_scope.kind||' scope finished at '||clock_timestamp()::text||'.',
                 context=COALESCE(a.context,'{}'::jsonb)||jsonb_build_object('resolved_by_fn','fn_process_weekly_accounting_scope')
           WHERE a.source='union_accounting_scheduler' AND NOT COALESCE(a.resolved,false)
             AND a.message='A weekly accounting scope did not finish its scheduler visit'
             AND a.context->>'scope_kind'=v_scope.kind AND a.context->>'scope_id'=v_scope.id::text;
        END IF;
        IF v_scope_outcome<>'visited' AND v_prior_outcome IS DISTINCT FROM v_scope_outcome
          AND (v_scope_outcome='error' OR v_tick_budget_large OR v_chunked) THEN
          INSERT INTO public.financial_alerts(source,severity,message,context)
          VALUES('union_accounting_scheduler','critical','A weekly accounting scope did not finish its scheduler visit',
            jsonb_build_object('scope_kind',v_scope.kind,'scope_id',v_scope.id,'outcome',v_scope_outcome,'result',v_scope_error));
        END IF;
        -- The statement budget is spent: nothing more can run in this tick.
        IF v_scope_outcome='statement_timeout' THEN v_more:=true;EXIT;END IF;
        -- The tick an in-progress book owned ends with its visit (20261016000241).
        IF v_scope.in_progress THEN v_more:=true;EXIT;END IF;
      END LOOP;
      PERFORM set_config('app.weekly_accounting_attempt_budget',COALESCE(v_saved_budget,''),true);
      PERFORM set_config('app.weekly_accounting_scheduler_started',COALESCE(v_saved_started,''),true);
    EXCEPTION WHEN OTHERS THEN
      PERFORM set_config('app.weekly_accounting_attempt_budget',COALESCE(v_saved_budget,''),true);
      PERFORM set_config('app.weekly_accounting_scheduler_started',COALESCE(v_saved_started,''),true);
      RAISE;
    END;
    RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
      'visited_scopes',v_visits,'more_remaining',v_more,'observed_at',clock_timestamp(),'detail',v_results);
  END IF;

  FOR v_union IN SELECT u.id, f.earliest_period_start
    FROM public.unions u LEFT JOIN public.union_settlement_floor f ON f.union_id=u.id WHERE p_club_id IS NULL AND (p_union_id IS NULL OR u.id=p_union_id) ORDER BY u.id
  LOOP
    -- Catch up chronologically from the explicit clean-data floor. A union
    -- without one starts at the just-closed week, never an invented history.
    v_first := COALESCE(public.fn_union_week_start(v_union.earliest_period_start),
                        public.fn_union_prev_week_start(v_now));
    IF v_first < v_union.earliest_period_start THEN
      v_first := public.fn_union_week_start(v_first + interval '8 days');
    END IF;
    SELECT LEAST(v_first,min(q.period_start)) INTO v_first
      FROM public.union_accounting_runs q WHERE q.union_id=v_union.id
        AND (q.status<>'complete' OR (v_union.earliest_period_start IS NULL
          AND q.status='complete' AND q.result->>'success'='true' AND q.result->>'accounting_version'='3'))
        AND (v_union.earliest_period_start IS NULL OR q.period_start>=v_first);
    v_from := v_first;
    WHILE v_from < v_to LOOP
      v_end := public.fn_union_week_start(v_from + interval '8 days');
      v_due := public.fn_union_accounting_run_at(v_end);
      v_preparing_before_due:=v_chunked AND v_end=v_to AND v_now>=v_end AND v_now<v_due;
      IF v_now < v_due AND NOT v_preparing_before_due THEN EXIT; END IF;
      -- A LONG WEEK'S FIRST CLOSE WAITS FOR A QUIET HOUR (20261003): while
      -- this book's week has a gate and no attempt yet, nothing of it runs
      -- (fn_accounting_close_gate_holds files one warning, never a critical).
      IF public.fn_accounting_close_gate_holds('union',v_union.id,v_from,v_end) THEN EXIT; END IF;

      IF clock_timestamp()-v_scheduler_started>interval '15 minutes'
        OR public.fn_platform_frozen() THEN
        RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
          'more_remaining',true,'detail',v_results);
      END IF;
      PERFORM public.fn_union_pnl_closed_book_barrier(v_end);
      PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting:'||v_union.id::text||':'||extract(epoch FROM v_from)::text||':'||extract(epoch FROM v_end)::text,0));
      -- Older club books cannot withhold this week's unpaid earned fees.
      -- A complete canonical player-payment receipt is the prerequisite;
      -- unpaid older fees keep their chronological priority. Leave the old
      -- book/result untouched and return to it after current fees are paid.
      IF v_chunked AND v_end<v_to
       AND EXISTS(SELECT FROM public.accounting_routed_settlement_runs r
        WHERE r.scope_kind='union' AND r.scope_id=v_union.id AND r.period_start=v_from
         AND r.period_end=v_end AND r.round_no=3 AND r.result->>'success'='true'
         AND r.result->>'routing_version'='3' AND r.result->>'source_version'='2'
         AND r.result->'shortfalls'='0'::jsonb)
       AND NOT EXISTS(SELECT FROM public.accounting_routed_settlement_runs r
        WHERE r.scope_kind='union' AND r.scope_id=v_union.id AND r.period_end=v_to
         AND r.period_start=public.fn_union_prev_week_start(v_now) AND r.round_no=3
         AND r.result->>'success'='true' AND r.result->>'routing_version'='3'
         AND r.result->>'source_version'='2' AND r.result->'shortfalls'='0'::jsonb) THEN
        v_from:=v_end;CONTINUE;
      END IF;
      SELECT result INTO v_previous FROM public.union_accounting_runs
       WHERE union_id=v_union.id AND period_start=v_from AND period_end=v_end;
      SELECT count(*), COALESCE(sum(rakeback_amount),0) INTO v_orphans,v_orphan_amount
        FROM public.rakeback_periods rp
       WHERE rp.club_id=v_union.id AND rp.status='pending' AND rp.rakeback_amount>0
         AND (rp.period_start::timestamp AT TIME ZONE 'UTC') < v_end
         AND ((rp.period_end+1)::timestamp AT TIME ZONE 'UTC') > v_from;

      SELECT NOT EXISTS (
        SELECT 1 FROM generate_series(1,4) n
        WHERE NOT EXISTS (SELECT 1 FROM public.union_settlement_rounds r
          WHERE r.union_id=v_union.id AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=n
            AND CASE
              WHEN n=1 THEN r.detail->>'success'='true'
              WHEN n IN(2,3) THEN
                COALESCE(r.detail->'latest_attempt',r.detail)->>'amount' IS NOT NULL
                AND COALESCE(r.detail->'latest_attempt',r.detail)->>'payees' IS NOT NULL
                AND COALESCE(r.detail->'latest_attempt',r.detail)->'shortfalls'='0'::jsonb
                AND COALESCE(COALESCE(r.detail->'latest_attempt',r.detail)->>'success','true')='true'
              ELSE r.detail->>'success'='true' AND COALESCE(r.detail->>'skipped','false')='false'
            END)) INTO v_complete;

      -- Completion uses one fresh earning-club set under this book's lock.
      IF v_complete THEN
        DECLARE v_completion_clubs uuid[];
        BEGIN
          SELECT ARRAY(SELECT club_id FROM public.fn_accounting_week_clubs(v_union.id,NULL,v_from,v_end)) INTO v_completion_clubs;
      v_complete := v_complete AND NOT EXISTS (
        SELECT 1 FROM public.rakeback_periods rp
        JOIN unnest(v_completion_clubs) AS uc(club_id) ON uc.club_id=rp.club_id
        WHERE rp.status='pending' AND rp.rakeback_amount>0
          AND rp.period_start >= (v_from AT TIME ZONE 'UTC')::date
          AND ((rp.period_end+1)::timestamp AT TIME ZONE 'UTC') <= v_end)
        AND NOT EXISTS (SELECT 1 FROM unnest(v_completion_clubs) AS uc(club_id)
          WHERE uc.club_id<>v_union.id
            AND NOT EXISTS (SELECT 1 FROM public.settlement_invoices si
              WHERE si.club_id=uc.club_id AND si.invoice_type='union_weekly_squareup'
                AND si.breakdown->>'union_id'=v_union.id::text
                AND (si.breakdown->>'period_start')::timestamptz=v_from
                AND (si.breakdown->>'period_end')::timestamptz=v_end
                AND si.message_sent=true AND si.status<>'cancelled'));

      v_complete:=v_complete AND NOT EXISTS(SELECT 1 FROM unnest(v_completion_clubs) AS uc(club_id)
        WHERE uc.club_id<>v_union.id AND NOT EXISTS(
          SELECT 1 FROM public.settlement_invoices i JOIN public.settlement_periods sp ON sp.id=i.period_id
          WHERE i.club_id=uc.club_id AND i.invoice_type='club_weekly_accounting' AND i.message_sent
            AND sp.club_id=uc.club_id AND sp.union_id=v_union.id AND sp.start_at=v_from AND sp.end_at=v_end AND sp.status IN('settled','closed') AND i.status<>'cancelled'));
      -- Completion is proved by the actual posted source receipts, not only
      -- the coordinator's summary JSON or another union's period document.
      v_complete:=v_complete AND EXISTS(SELECT 1 FROM public.ca_settlements c
        WHERE c.settlement_type='union_rakeback_close' AND c.union_id=v_union.id AND c.state='final'
         AND c.totals->>'accounting_version'='3' AND c.external_ref=v_union.id::text||':'
          ||to_char(v_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')||'..'
          ||to_char(v_end AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))
        AND NOT EXISTS(SELECT 1 FROM generate_series(2,3) n WHERE NOT EXISTS(
          SELECT 1 FROM public.accounting_routed_settlement_runs r
           WHERE r.scope_kind='union' AND r.scope_id=v_union.id AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=n
            AND r.result->>'routing_version'='3' AND r.result->>'source_version'='2'
            AND r.result->>'success'='true' AND r.result->'shortfalls'='0'::jsonb
            AND r.result=(v_previous->CASE WHEN n=2 THEN 'round2_club_to_agents' ELSE 'round3_agents_to_players' END)-'duplicate'));
        END;
      END IF;
      IF v_complete AND v_orphans=0 AND v_previous->>'success'='true' AND v_previous->>'accounting_version'='3'
        -- A BOOK THIS SCHEDULER ALREADY CLOSED (20261002) is not re-proved:
        -- its evidence was certified before it was paid, and only that close
        -- writes status 'complete'. Anything else is checked as before.
        AND (CASE WHEN EXISTS(SELECT 1 FROM public.union_accounting_runs q
                    WHERE q.union_id=v_union.id AND q.period_start=v_from AND q.period_end=v_end
                      AND q.status='complete')
             THEN true
             ELSE public.fn_union_pnl_close_quality(v_union.id,v_from,v_end)->>'status'='ready' END) THEN
        v_from:=v_end; CONTINUE;
      END IF;
      -- Bounded recovery: never let a large history monopolize live wallets.
      IF v_checked>=v_attempt_budget OR clock_timestamp()-v_scheduler_started>interval '15 minutes'
        OR public.fn_platform_frozen() THEN
        RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
          'more_remaining',true,'detail',v_results);
      END IF;
      INSERT INTO public.union_accounting_runs
        (union_id,period_start,period_end,scheduled_at,status,attempts,started_at)
      VALUES (v_union.id,v_from,v_end,v_due,'running',1,clock_timestamp())
      ON CONFLICT(union_id,period_start,period_end) DO UPDATE
        SET status='running',attempts=union_accounting_runs.attempts+1,started_at=clock_timestamp();

      PERFORM public.fn_weekly_accounting_attempt_begin(true);
      -- A READY REPORT IS PROVED ONCE A HALF HOUR, NOT ONCE A TICK (2026-10-17).
      -- With every P&L certificate fresh, an attempt still spent ~3 minutes of
      -- uncached report reads before the cascade, met the deadline before
      -- round 2, and was rolled back: 104 timeouts in a day and no money round
      -- for 13 hours. A report this close proved ready in the last 30 minutes,
      -- under the same original inventory generation, is handed to this
      -- attempt through the report's own memo; one it proves now is kept,
      -- outside the money block, for the next attempt.
      v_report_seeded := v_chunked AND public.fn_accounting_close_report_seed(v_union.id,v_from,v_end);
      -- Keep a refused preparation request durable outside the wallet rollback.
      BEGIN
        v_preparation:=public.fn_prepare_accounting_week(v_union.id,NULL,v_from,v_end);
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
        v_preparation:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail);
      END;
      IF v_chunked AND NOT v_report_seeded THEN
        PERFORM public.fn_accounting_close_report_keep(v_union.id,v_from,v_end);
      END IF;

      -- Only this block may move chips. Any refused downstream stage raises
      -- and rolls back the whole union attempt, while the failure record below
      -- survives. Other unions have independent ledgers and transaction scopes.
      BEGIN
        -- CHUNKED CLOSE: a preparation that stopped while its book's P&L
        -- certificates are still being proved (fn_union_pnl_evidence_report
        -- 'warming': the steps proved so far are kept, nothing is paid) ends
        -- this attempt as a committed step, not a failure.
        IF v_preparing_before_due AND v_preparation->>'success'='true' THEN
          -- Closed-week commission/player proof windows advance before due.
          -- This original owner is nonfinancial; the04 money gate remains.
          PERFORM public.fn_accounting_close_windows_pending(v_union.id,NULL,v_from,v_end);
          v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',0,'stage','prepared',
            'purpose','fees_before_due','union_id',v_union.id,'period_start',v_from,'period_end',v_end);
        ELSIF v_chunked AND v_preparation->>'success' IS DISTINCT FROM 'true'
          AND jsonb_typeof(v_preparation->'problems')='array' AND jsonb_array_length(v_preparation->'problems')=1
          AND (v_preparation#>'{problems,0,pnl_evidence,issues}'='["union_pnl_certification_in_progress"]'::jsonb
           OR v_preparation#>>'{problems,0,reason}'='earned_fee_certification_in_progress') THEN
          v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',0,'stage','certifying',
            'union_id',v_union.id,'period_start',v_from,'period_end',v_end);
        -- SPLIT RECOMPUTE (20261003): a preparation whose only problems are
        -- clubs whose week is still calculated in parts ends this attempt as
        -- a committed step.
        ELSIF v_chunked AND public.fn_accounting_preparation_calculating(v_preparation) THEN
          v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',0,'stage','calculating',
            'union_id',v_union.id,'period_start',v_from,'period_end',v_end);
        -- CHUNKED CLOSE (20261003, prepared): a preparation that did durable
        -- work of its own (a P&L step it kept, a weekly recompute it recorded)
        -- for more than 60 seconds ends this attempt as a committed step; the
        -- next attempt reuses those receipts and pays.
        ELSIF v_chunked AND v_preparation->>'success'='true' AND v_preparation->>'paid_scope_replay' IS DISTINCT FROM 'true'
          -- CHUNKED CLOSE WINDOWS (20261003): round 2's windows are proved in
          -- attempts of their own (after any long preparation, never with it)
          -- before the attempt that pays it.
          AND (CASE WHEN public.fn_accounting_close_prepared_long(v_union.id,NULL,v_from,v_end) THEN true
            ELSE public.fn_accounting_close_windows_pending(v_union.id,NULL,v_from,v_end) END) THEN
          v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',0,'stage','prepared',
            'union_id',v_union.id,'period_start',v_from,'period_end',v_end);
        ELSE
        IF v_preparation->>'success' IS DISTINCT FROM 'true' THEN
          RAISE EXCEPTION 'weekly_accounting_calculation_incomplete' USING DETAIL=v_preparation::text;
        END IF;
        IF EXISTS(SELECT 1 FROM public.rake_records rr LEFT JOIN public.daemon_state ds ON ds.daemon='rakeback_settler'
          WHERE rr.is_tournament IS NOT TRUE AND rr.tournament_id IS NULL AND rr.rake_amount>0
            AND rr.created_at>=COALESCE((SELECT watermark.high_water_mark FROM public.daemon_state watermark WHERE watermark.daemon='rakeback_settler'),v_from)
            AND rr.created_at>=v_from AND rr.created_at<v_end
            AND (rr.club_id=v_union.id OR EXISTS(SELECT 1 FROM public.fn_accounting_week_clubs(v_union.id,NULL,v_from,v_end) uc WHERE uc.club_id=rr.club_id))
            AND (ds.high_water_mark IS NULL OR rr.created_at>ds.high_water_mark OR
              (rr.created_at=ds.high_water_mark AND (ds.high_water_mark_id IS NULL OR rr.id>ds.high_water_mark_id)))) THEN
          RAISE EXCEPTION 'weekly_rake_source_not_fully_accrued';
        END IF;
        PERFORM public.fn_assert_cash_commission_period(v_union.id,NULL,v_from,v_end);
        IF v_orphans>0 THEN
          RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_rakeback_wrong_club',
            DETAIL=jsonb_build_object('pending_periods',v_orphans,'pending_amount',v_orphan_amount)::text;
        END IF;
        IF v_complete AND v_previous->>'accounting_version'='3' THEN
          v_result:=v_previous||jsonb_build_object('success',true,'already_posted',true);
        ELSE
          PERFORM public.fn_weekly_accounting_deadline_check();
          v_result:=public.fn_union_settlement_cascade(v_union.id,v_from,v_end);
          -- CHUNKED CLOSE: a committed round ends this attempt (it is not a
          -- failure and is not rolled back for the time it took).
          IF v_result->>'chunk_committed' IS DISTINCT FROM 'true' THEN
          PERFORM public.fn_weekly_accounting_deadline_check();
          IF v_result->>'success' IS DISTINCT FROM 'true' THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_settlement_incomplete',DETAIL=v_result::text;
          END IF;
          END IF;
        END IF;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE,v_context=PG_EXCEPTION_CONTEXT;
        v_result:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail,'context',left(v_context,4000));
      END;

      PERFORM public.fn_weekly_accounting_attempt_end();
      IF v_result->>'success'='true' THEN v_result:=v_result||jsonb_build_object('accounting_version',3); END IF;
      v_checked:=v_checked+1;
      UPDATE public.union_accounting_runs
         SET status=CASE WHEN v_result->>'success'='true' THEN 'complete' WHEN v_result->>'chunk_committed'='true' THEN 'running' ELSE 'failed' END,
             finished_at=clock_timestamp(),result=v_result
       WHERE union_id=v_union.id AND period_start=v_from AND period_end=v_end;
      -- A COMPLETED WEEK ENDS ITS INCOMPLETE-WEEK ALARMS (2026-10-17): the
      -- week each one describes has just been recorded complete.
      IF v_result->>'success'='true' THEN
        UPDATE public.financial_alerts a
           SET resolved=true,resolved_at=clock_timestamp(),
               resolution='verified: the union week '||v_from::text||' to '||v_end::text||' was recorded complete at '||clock_timestamp()::text||'.',
               context=COALESCE(a.context,'{}'::jsonb)||jsonb_build_object('resolved_by_fn','fn_process_weekly_accounting_scope')
         WHERE a.source='union_accounting_scheduler' AND NOT COALESCE(a.resolved,false)
           AND a.message='Weekly union accounting is incomplete'
           AND a.context->>'union_id'=v_union.id::text
           AND a.context->>'period_start' IS NOT NULL AND a.context->>'period_end' IS NOT NULL
           AND (a.context->>'period_start')::timestamptz=v_from AND (a.context->>'period_end')::timestamptz=v_end;
      END IF;
      IF v_result->>'success' IS DISTINCT FROM 'true' AND v_result->>'chunk_committed' IS DISTINCT FROM 'true' THEN
        v_failed:=v_failed+1;
        -- Report a new failure or a changed failure, not the same alert every tick.
        IF public.fn_accounting_failure_identity(v_previous) IS DISTINCT FROM public.fn_accounting_failure_identity(v_result) THEN
          INSERT INTO public.financial_alerts(source,severity,message,context)
          -- CHUNKED CLOSE: an attempt that ran out of its 9-minute budget left
          -- nothing half-done (it rolled back to its last committed round)
          -- and the next tick retries it with the large budget; that is a
          -- warning, not an incident. Out of the large budget it is critical.
          VALUES ('union_accounting_scheduler',CASE WHEN v_chunked AND NOT v_tick_budget_large AND v_result->>'error'='weekly_scope_time_budget_exhausted' THEN 'warning' ELSE 'critical' END,'Weekly union accounting is incomplete',
            jsonb_build_object('union_id',v_union.id,'period_start',v_from,'period_end',v_end,
                               'scheduled_at',v_due,'result',v_result));
        END IF;
      END IF;
      v_results:=v_results||jsonb_build_array(jsonb_build_object('union_id',v_union.id,
        'period_start',v_from,'period_end',v_end,'result',v_result));
      -- CHUNKED CLOSE: the next round of this book is the next tick's.
      IF v_result->>'chunk_committed'='true' THEN
        RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
          'more_remaining',true,'detail',v_results);
      END IF;
      -- Resolve an older period before posting a later one for the same union.
      IF v_result->>'success' IS DISTINCT FROM 'true' THEN EXIT; END IF;
      v_from:=v_end;
    END LOOP;
  END LOOP;

  -- Standalone and formerly standalone earnings use this same coordinator,
  -- run table, preparation, routed stages and document sender.
  IF p_union_id IS NULL THEN
    FOR v_club IN
      WITH cash_candidates AS MATERIALIZED (
 SELECT s.club_id,s.earned_at FROM public.accounting_cash_rake_sources s
 WHERE s.coordinator_union_id IS NULL AND s.earned_at<v_to AND (p_club_id IS NULL OR s.club_id=p_club_id)
), tournament_candidates AS MATERIALIZED (
 SELECT s.club_id,s.charged_at,s.union_id,s.rake_credit,rs.recognized_at,rs.disposition,rs.rake_credit AS recognized_rake_credit,
 r.status AS recognition_status,r.recognized_at AS recognition_at,r.union_id AS recognition_union_id
 FROM public.accounting_tournament_fee_sources s
 JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id AND rs.tournament_id=s.tournament_id
 JOIN public.accounting_tournament_fee_recognitions r ON r.tournament_id=s.tournament_id
 WHERE s.coordinator_union_id IS NULL AND rs.recognized_at<v_to AND (p_club_id IS NULL OR s.club_id=p_club_id)
), earning_clubs AS MATERIALIZED (
 SELECT e.club_id FROM (SELECT c.club_id FROM cash_candidates c UNION ALL SELECT t.club_id FROM tournament_candidates t)e GROUP BY e.club_id
), earning_cutoffs AS MATERIALIZED (
 SELECT c.club_id,public.fn_ca_launch_accounting_cutoff('club',c.club_id) AS cutoff FROM earning_clubs c
), accepted_earnings AS (
 SELECT s.club_id,s.earned_at FROM cash_candidates s
 LEFT JOIN earning_cutoffs b ON b.club_id=s.club_id
 WHERE CASE WHEN b.cutoff IS NULL THEN true ELSE s.earned_at IS NOT NULL AND isfinite(s.earned_at) AND s.earned_at>=b.cutoff END
 UNION ALL
 SELECT s.club_id,s.recognized_at AS earned_at FROM tournament_candidates s
 LEFT JOIN earning_cutoffs b ON b.club_id=s.club_id
 WHERE CASE WHEN b.cutoff IS NULL THEN true ELSE s.charged_at IS NOT NULL AND isfinite(s.charged_at) AND s.charged_at>=b.cutoff END
 AND CASE WHEN b.cutoff IS NULL THEN true ELSE s.recognized_at IS NOT NULL AND isfinite(s.recognized_at) AND s.recognized_at>=b.cutoff END
 AND s.disposition='earned' AND s.recognition_status='recognized'
 AND s.recognized_rake_credit=s.rake_credit AND s.recognized_at=s.recognition_at
 AND NOT s.union_id IS DISTINCT FROM s.recognition_union_id
), pending_scope AS (
        SELECT s.club_id,LEAST(public.fn_union_week_start(min(s.earned_at) FILTER(WHERE isfinite(s.earned_at))),min(s.earned_at)) AS first_week
         FROM accepted_earnings s GROUP BY s.club_id
        UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
         WHERE q.standalone_club_id IS NOT NULL AND q.status<>'complete'
        UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
         WHERE q.standalone_club_id IS NOT NULL AND q.status='complete' AND q.period_end<v_to
          AND NOT EXISTS(SELECT 1 FROM public.union_accounting_runs later
            WHERE later.standalone_club_id=q.standalone_club_id AND later.period_end>q.period_end)
        UNION ALL SELECT rp.club_id,min(public.fn_union_week_start(rp.period_start::timestamp AT TIME ZONE 'America/Los_Angeles'))
         FROM public.rakeback_periods rp WHERE rp.status='pending' AND rp.period_end<(v_to AT TIME ZONE 'America/Los_Angeles')::date
          AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=rp.club_id) GROUP BY rp.club_id
        UNION ALL SELECT a.club_id,public.fn_union_prev_week_start(v_now) FROM public.agents a
         WHERE NOT COALESCE(a.is_prepaid,false) AND a.credit_limit>0 AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=a.club_id)
      ) SELECT x.club_id AS id,GREATEST(min(x.first_week),public.fn_club_settlement_floor_week(x.club_id)) AS first_week FROM pending_scope x JOIN public.clubs c ON c.id=x.club_id
       WHERE c.is_union IS NOT TRUE AND (p_club_id IS NULL OR x.club_id=p_club_id) GROUP BY x.club_id ORDER BY x.club_id
    LOOP
      v_from:=v_club.first_week;
      WHILE v_from<v_to LOOP
        v_end:=public.fn_union_week_start(v_from+interval '8 days');v_due:=public.fn_union_accounting_run_at(v_end);
        v_preparing_before_due:=v_chunked AND v_end=v_to AND v_now>=v_end AND v_now<v_due;
        IF v_now<v_due AND NOT v_preparing_before_due THEN EXIT;END IF;
        -- A LONG WEEK'S FIRST CLOSE WAITS FOR A QUIET HOUR (20261003): as for a union book.
        IF public.fn_accounting_close_gate_holds('club',v_club.id,v_from,v_end) THEN EXIT;END IF;
        IF v_checked>=v_attempt_budget OR clock_timestamp()-v_scheduler_started>interval '15 minutes'
          OR public.fn_platform_frozen() THEN
          RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,'more_remaining',true,'detail',v_results);
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('club-accounting:'||v_club.id::text||':'||extract(epoch FROM v_from)::text||':'||extract(epoch FROM v_end)::text,0));
        -- A paid older standalone book also yields to current unpaid fees.
        IF v_chunked AND v_end<v_to
         AND EXISTS(SELECT FROM public.accounting_routed_settlement_runs r
          WHERE r.scope_kind='club' AND r.scope_id=v_club.id AND r.period_start=v_from
           AND r.period_end=v_end AND r.round_no=3 AND r.result->>'success'='true'
           AND r.result->>'routing_version'='3' AND r.result->>'source_version'='2'
           AND r.result->'shortfalls'='0'::jsonb)
         AND NOT EXISTS(SELECT FROM public.accounting_routed_settlement_runs r
          WHERE r.scope_kind='club' AND r.scope_id=v_club.id AND r.period_end=v_to
           AND r.period_start=public.fn_union_prev_week_start(v_now) AND r.round_no=3
           AND r.result->>'success'='true' AND r.result->>'routing_version'='3'
           AND r.result->>'source_version'='2' AND r.result->'shortfalls'='0'::jsonb) THEN
          v_from:=v_end;CONTINUE;
        END IF;
        SELECT result INTO v_previous FROM public.union_accounting_runs q
          WHERE q.standalone_club_id=v_club.id AND q.period_start=v_from AND q.period_end=v_end;
        IF v_previous->>'success'='true' AND v_previous->>'accounting_version'='3'
          AND EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind='club' AND r.scope_id=v_club.id
            AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=2 AND r.result=v_previous->'round2')
          AND EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind='club' AND r.scope_id=v_club.id
            AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=3 AND r.result=v_previous->'round3')
          AND EXISTS(SELECT 1 FROM public.settlement_invoices i JOIN public.settlement_periods sp ON sp.id=i.period_id
            WHERE sp.club_id=v_club.id AND sp.union_id IS NULL AND sp.start_at=v_from AND sp.end_at=v_end
             AND sp.status IN('settled','closed') AND i.club_id=v_club.id
             AND i.invoice_type='club_weekly_accounting' AND i.message_sent AND i.status<>'cancelled') THEN
          v_from:=v_end;CONTINUE;
        END IF;
        -- A source writer may have held this period lock across the deadline,
        -- maintenance announcement or a freeze change. Recheck after the lock
        -- and completion reads before creating a new financial attempt.
        IF v_checked>=v_attempt_budget OR clock_timestamp()-v_scheduler_started>interval '15 minutes'
          OR public.fn_platform_frozen() THEN
          RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,'more_remaining',true,'detail',v_results);
        END IF;
        INSERT INTO public.union_accounting_runs(standalone_club_id,period_start,period_end,scheduled_at,status,attempts,started_at)
          VALUES(v_club.id,v_from,v_end,v_due,'running',1,clock_timestamp())
          ON CONFLICT(scope_kind,scope_id,period_start,period_end) DO UPDATE
          SET status='running',attempts=union_accounting_runs.attempts+1,started_at=clock_timestamp();
        -- Preparation writes a durable queue result even if wallet work below
        -- refuses. No source calculator reports an unpersisted ready flag.
        PERFORM public.fn_weekly_accounting_attempt_begin(false);
        BEGIN v_preparation:=public.fn_prepare_accounting_week(NULL,v_club.id,v_from,v_end);
        EXCEPTION WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
          v_preparation:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail);
        END;
        BEGIN
          IF v_preparation->>'success' IS DISTINCT FROM 'true'
            AND NOT (v_chunked AND public.fn_accounting_preparation_calculating(v_preparation)) THEN
            RAISE EXCEPTION 'weekly_accounting_calculation_incomplete' USING DETAIL=v_preparation::text;END IF;
          -- CHUNKED CLOSE (20261003, prepared): as for a union book.
          -- SPLIT RECOMPUTE (20261003): a club whose week is still calculated in
          -- parts ends this attempt as a committed step ('calculating').
          IF v_preparing_before_due AND v_preparation->>'success'='true' THEN
            PERFORM public.fn_accounting_close_windows_pending(NULL,v_club.id,v_from,v_end);
          END IF;
          IF v_chunked AND (CASE WHEN v_preparing_before_due THEN true
            WHEN public.fn_accounting_preparation_calculating(v_preparation) THEN true
            WHEN public.fn_accounting_close_prepared_long(NULL,v_club.id,v_from,v_end) THEN true
            ELSE public.fn_accounting_close_windows_pending(NULL,v_club.id,v_from,v_end) END) THEN
            v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',0,
              'stage',CASE WHEN public.fn_accounting_preparation_calculating(v_preparation) THEN 'calculating' ELSE 'prepared' END,'scope_kind','club','scope_id',v_club.id,
              'period_start',v_from,'period_end',v_end);
          ELSE
          PERFORM public.fn_assert_cash_commission_period(NULL,v_club.id,v_from,v_end);
          PERFORM public.fn_weekly_accounting_deadline_check();
          PERFORM public.fn_bank_standalone_week_rake(v_club.id,v_from,v_end);
          -- CHUNKED CLOSE (20261003): a round an earlier attempt committed is
          -- answered from its own receipt (what the stage returns for it as a
          -- duplicate) instead of reading the week again.
          v_stage2:=NULL; v_stage3:=NULL;
          IF v_chunked THEN
            SELECT r.result||jsonb_build_object('duplicate',true) INTO v_stage2 FROM public.accounting_routed_settlement_runs r
             WHERE r.scope_kind='club' AND r.scope_id=v_club.id AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=2;
            SELECT r.result||jsonb_build_object('duplicate',true) INTO v_stage3 FROM public.accounting_routed_settlement_runs r
             WHERE r.scope_kind='club' AND r.scope_id=v_club.id AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=3;
          END IF;
          IF v_stage2 IS NULL THEN
          v_stage2:=public.fn_settle_accounting_commission_stage('club',v_club.id,v_from,v_end);
          END IF;
          -- CHUNKED CLOSE: a round 2 or round 3 that paid commits on its own
          -- (after the same receipt tests the unchunked path applies to it);
          -- the next tick finds its receipt and the stage returns it as a
          -- duplicate. Credit invoices, the settled period and the weekly
          -- statements wait for the attempt that finds both rounds committed.
          IF v_chunked AND v_stage2->>'duplicate' IS DISTINCT FROM 'true' THEN
            IF v_stage2->>'success' IS DISTINCT FROM 'true' OR v_stage2->>'routing_version' IS DISTINCT FROM '3'
              OR v_stage2->>'source_version' IS DISTINCT FROM '2' OR v_stage2->'shortfalls' IS DISTINCT FROM '0'::jsonb
              OR NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind='club' AND r.scope_id=v_club.id
                AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=2 AND r.result=(v_stage2-'duplicate')) THEN
              RAISE EXCEPTION 'weekly_routing_receipt_not_confirmed' USING ERRCODE='23514';END IF;
            v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',2,'scope_kind','club','scope_id',v_club.id,
              'period_start',v_from,'period_end',v_end,'round2',v_stage2);
          ELSE
          PERFORM public.fn_weekly_accounting_deadline_check();
          IF v_stage3 IS NULL THEN
          v_stage3:=public.fn_settle_accounting_rakeback_stage('club',v_club.id,v_from,v_end);
          END IF;
          -- CHUNKED CLOSE (20261003, round 3 in batches): as for a union book.
          IF v_chunked AND v_stage3->>'batch_committed'='true' THEN
            v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',3,'stage','round3_batch','scope_kind','club','scope_id',v_club.id,
              'period_start',v_from,'period_end',v_end,'round2',v_stage2-'duplicate','round3_batch',v_stage3);
          ELSIF v_chunked AND v_stage3->>'duplicate' IS DISTINCT FROM 'true' THEN
            IF v_stage3->>'success' IS DISTINCT FROM 'true' OR v_stage3->>'routing_version' IS DISTINCT FROM '3'
              OR v_stage3->>'source_version' IS DISTINCT FROM '2' OR v_stage3->'shortfalls' IS DISTINCT FROM '0'::jsonb
              OR NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind='club' AND r.scope_id=v_club.id
                AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=3 AND r.result=(v_stage3-'duplicate')) THEN
              RAISE EXCEPTION 'weekly_routing_receipt_not_confirmed' USING ERRCODE='23514';END IF;
            v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',3,'scope_kind','club','scope_id',v_club.id,
              'period_start',v_from,'period_end',v_end,'round2',v_stage2-'duplicate','round3',v_stage3);
          ELSE
          PERFORM public.fn_weekly_accounting_deadline_check();
          IF v_stage2->>'success' IS DISTINCT FROM 'true' OR v_stage3->>'success' IS DISTINCT FROM 'true'
            OR v_stage2->>'routing_version' IS DISTINCT FROM '3' OR v_stage3->>'routing_version' IS DISTINCT FROM '3'
            OR v_stage2->>'source_version' IS DISTINCT FROM '2' OR v_stage3->>'source_version' IS DISTINCT FROM '2'
            OR v_stage2->'shortfalls' IS DISTINCT FROM '0'::jsonb OR v_stage3->'shortfalls' IS DISTINCT FROM '0'::jsonb
            OR NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind='club' AND r.scope_id=v_club.id
              AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=2 AND r.result=(v_stage2-'duplicate'))
            OR NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind='club' AND r.scope_id=v_club.id
              AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=3 AND r.result=(v_stage3-'duplicate')) THEN
            RAISE EXCEPTION 'weekly_routing_receipt_not_confirmed' USING ERRCODE='23514';END IF;
          v_credit:=public.fn_generate_scope_credit_invoices(v_club.id,v_from,v_end);
          IF v_credit->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'weekly_credit_invoice_incomplete' USING ERRCODE='23514';END IF;
          PERFORM public.fn_mark_scope_accounting_settled('club',v_club.id,v_from,v_end);
          v_validated_before:=current_setting('app.accounting_validated_scope',true);
          PERFORM set_config('app.accounting_validated_scope','club:'||v_club.id::text||':'||v_from::text||':'||v_end::text,true);
          PERFORM public.fn_weekly_accounting_deadline_check();
          v_statements:=public.fn_issue_scope_weekly_accounting('club',v_club.id,v_from,v_end);
          PERFORM public.fn_weekly_accounting_deadline_check();
          PERFORM set_config('app.accounting_validated_scope',COALESCE(v_validated_before,''),true);
          IF v_statements->>'success' IS DISTINCT FROM 'true' OR NOT EXISTS(
            SELECT 1 FROM public.settlement_invoices i JOIN public.settlement_periods sp ON sp.id=i.period_id
             WHERE sp.club_id=v_club.id AND sp.union_id IS NULL AND sp.start_at=v_from AND sp.end_at=v_end
              AND sp.status IN('settled','closed') AND i.club_id=v_club.id
              AND i.invoice_type='club_weekly_accounting' AND i.message_sent AND i.status<>'cancelled') THEN
            RAISE EXCEPTION 'weekly_club_statement_delivery_incomplete' USING ERRCODE='23514';END IF;
          v_result:=jsonb_build_object('success',true,'scope_kind','club','scope_id',v_club.id,'period_start',v_from,'period_end',v_end,
            'round2',v_stage2-'duplicate','round3',v_stage3-'duplicate','credit_invoices',v_credit,'club_weekly_statements',v_statements,'accounting_version',3);
          END IF;
          END IF;
          END IF;
        EXCEPTION WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
          v_result:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail);
        END;
        PERFORM public.fn_weekly_accounting_attempt_end();
        UPDATE public.union_accounting_runs SET status=CASE WHEN v_result->>'success'='true' THEN 'complete' WHEN v_result->>'chunk_committed'='true' THEN 'running' ELSE 'failed' END,
          finished_at=clock_timestamp(),result=v_result WHERE standalone_club_id=v_club.id AND period_start=v_from AND period_end=v_end;
        IF v_result->>'success' IS DISTINCT FROM 'true' AND v_result->>'chunk_committed' IS DISTINCT FROM 'true' THEN
          v_failed:=v_failed+1;
          IF public.fn_accounting_failure_identity(v_previous) IS DISTINCT FROM public.fn_accounting_failure_identity(v_result) THEN
            INSERT INTO public.financial_alerts(source,severity,message,context) VALUES('weekly_club_accounting',CASE WHEN v_chunked AND NOT v_tick_budget_large AND v_result->>'error'='weekly_scope_time_budget_exhausted' THEN 'warning' ELSE 'critical' END,'Weekly club accounting is incomplete',
              jsonb_build_object('club_id',v_club.id,'period_start',v_from,'period_end',v_end,'result',v_result));
          END IF;
        END IF;
        v_checked:=v_checked+1;
        v_results:=v_results||jsonb_build_array(jsonb_build_object('club_id',v_club.id,'period_start',v_from,'period_end',v_end,'result',v_result));
        IF v_result->>'chunk_committed'='true' THEN
          RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,'more_remaining',true,'detail',v_results);
        END IF;
        IF v_result->>'success' IS DISTINCT FROM 'true' THEN EXIT;END IF;
        v_from:=v_end;
      END LOOP;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
    'observed_at',clock_timestamp(),'detail',v_results);
END $function$;

CREATE OR REPLACE FUNCTION smarter_private.weekly_payout_eligible_scopes(p_end timestamp with time zone, p_now timestamp with time zone)
 RETURNS TABLE(kind text, id uuid, first_week timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_to timestamptz:=p_end;v_now timestamptz:=p_now;v_chunked boolean:=true;
BEGIN
 IF md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))<>'a68500342f07e0608c6eb69f4cb0739e'
 THEN RAISE EXCEPTION 'weekly_payout_original_scope_authority_changed' USING ERRCODE='55000';END IF;
 RETURN QUERY
WITH cash_clubs AS MATERIALIZED (
          SELECT DISTINCT s.club_id FROM public.accounting_cash_rake_sources s
          WHERE s.coordinator_union_id IS NULL AND s.earned_at<v_to
        ), cash_cutoffs AS MATERIALIZED (
          SELECT c.club_id,public.fn_ca_launch_accounting_cutoff('club',c.club_id) AS cutoff FROM cash_clubs c
        ), standalone_earned AS (
          SELECT s.club_id,s.earned_at FROM public.accounting_cash_rake_sources s
          LEFT JOIN cash_cutoffs c ON c.club_id=s.club_id
          WHERE s.coordinator_union_id IS NULL AND s.earned_at<v_to
            AND CASE WHEN c.cutoff IS NULL THEN true
              ELSE s.earned_at IS NOT NULL AND isfinite(s.earned_at) AND s.earned_at>=c.cutoff END
          UNION ALL
          -- STANDALONE TOURNAMENT EARNINGS ARE READ PER CLUB (20261022150614): this branch
          -- used to read the tournament_fee_accrual half of
          -- accounting_payable_earning_sources for every source row on every tick
          -- (1.7M recognition probes, 10 s warm and over 100 s cold), which spent
          -- the close attempt's own 3-minute budget before the attempt began.
          -- The predicate below is that view branch verbatim, read per club from
          -- the club's own standalone fee rows. Only eligible below reads these
          -- rows, as GREATEST(first week, the club's settlement floor) for clubs
          -- that are not unions, so a club with any such earning before its floor
          -- contributes the floor itself and is not read further; any other club
          -- contributes its earliest earning (and earliest finite one).
          SELECT tc.id AS club_id,te.earned_at FROM public.clubs tc
          CROSS JOIN LATERAL (SELECT public.fn_club_settlement_floor_week(tc.id) AS floor) tf
          CROSS JOIN LATERAL (SELECT CASE WHEN tf.floor IS NOT NULL AND EXISTS(SELECT 1
              FROM (SELECT s.id,s.tournament_id,s.club_id,s.union_id,s.charged_at,s.rake_credit FROM public.accounting_tournament_fee_sources s
                     WHERE s.club_id=tc.id AND s.coordinator_union_id IS NULL OFFSET 0) s
              JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id AND rs.tournament_id=s.tournament_id
              JOIN public.accounting_tournament_fee_recognitions r ON r.tournament_id=s.tournament_id
              LEFT JOIN public.fn_ca_launch_accounting_club_cutoffs() bd(club_id,cutoff_at) ON bd.club_id=s.club_id
              WHERE (bd.cutoff_at IS NULL OR s.charged_at IS NOT NULL AND isfinite(s.charged_at) AND s.charged_at>=bd.cutoff_at)
                AND (bd.cutoff_at IS NULL OR rs.recognized_at IS NOT NULL AND isfinite(rs.recognized_at) AND rs.recognized_at>=bd.cutoff_at)
                AND rs.disposition='earned' AND r.status='recognized' AND rs.rake_credit=s.rake_credit AND rs.recognized_at=r.recognized_at
                AND NOT s.union_id IS DISTINCT FROM r.union_id AND rs.recognized_at<v_to AND rs.recognized_at<tf.floor)
            THEN tf.floor END AS clamp) tk
          CROSS JOIN LATERAL (
            SELECT tk.clamp AS earned_at WHERE tk.clamp IS NOT NULL
            UNION ALL
            SELECT tm.earned_at FROM (SELECT min(rs.recognized_at) AS m,min(rs.recognized_at) FILTER(WHERE isfinite(rs.recognized_at)) AS mf
              FROM (SELECT s.id,s.tournament_id,s.club_id,s.union_id,s.charged_at,s.rake_credit FROM public.accounting_tournament_fee_sources s
                     WHERE s.club_id=tc.id AND s.coordinator_union_id IS NULL OFFSET 0) s
              JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id AND rs.tournament_id=s.tournament_id
              JOIN public.accounting_tournament_fee_recognitions r ON r.tournament_id=s.tournament_id
              LEFT JOIN public.fn_ca_launch_accounting_club_cutoffs() bd(club_id,cutoff_at) ON bd.club_id=s.club_id
              WHERE tk.clamp IS NULL AND (bd.cutoff_at IS NULL OR s.charged_at IS NOT NULL AND isfinite(s.charged_at) AND s.charged_at>=bd.cutoff_at)
                AND (bd.cutoff_at IS NULL OR rs.recognized_at IS NOT NULL AND isfinite(rs.recognized_at) AND rs.recognized_at>=bd.cutoff_at)
                AND rs.disposition='earned' AND r.status='recognized' AND rs.rake_credit=s.rake_credit AND rs.recognized_at=r.recognized_at
                AND NOT s.union_id IS DISTINCT FROM r.union_id AND rs.recognized_at<v_to) ta
            CROSS JOIN LATERAL (VALUES(ta.m),(ta.mf)) tm(earned_at) WHERE tm.earned_at IS NOT NULL) te
          WHERE tc.is_union IS NOT TRUE
        ), standalone_work AS (
          SELECT s.club_id,LEAST(public.fn_union_week_start(min(s.earned_at) FILTER(WHERE isfinite(s.earned_at))),min(s.earned_at)) AS first_week
           FROM standalone_earned s GROUP BY s.club_id
          UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
           WHERE q.standalone_club_id IS NOT NULL AND q.status<>'complete'
          UNION ALL SELECT q.standalone_club_id,q.period_start FROM public.union_accounting_runs q
           WHERE q.standalone_club_id IS NOT NULL AND q.status='complete' AND q.period_end<v_to
            AND NOT EXISTS(SELECT 1 FROM public.union_accounting_runs later
              WHERE later.standalone_club_id=q.standalone_club_id AND later.period_end>q.period_end)
          UNION ALL SELECT rp.club_id,min(public.fn_union_week_start(rp.period_start::timestamp AT TIME ZONE 'America/Los_Angeles'))
           FROM public.rakeback_periods rp WHERE rp.status='pending' AND rp.period_end<(v_to AT TIME ZONE 'America/Los_Angeles')::date
            AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=rp.club_id) GROUP BY rp.club_id
          UNION ALL SELECT a.club_id,public.fn_union_prev_week_start(v_now) FROM public.agents a
           WHERE NOT COALESCE(a.is_prepaid,false) AND a.credit_limit>0 AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=a.club_id)
        ), union_floors AS (
          SELECT u.id,f.earliest_period_start,CASE WHEN f.earliest_period_start IS NULL THEN public.fn_union_prev_week_start(v_now)
             WHEN public.fn_union_week_start(f.earliest_period_start)<f.earliest_period_start
              THEN public.fn_union_week_start(public.fn_union_week_start(f.earliest_period_start)+interval '8 days')
             ELSE public.fn_union_week_start(f.earliest_period_start) END AS first_week
           FROM public.unions u LEFT JOIN public.union_settlement_floor f ON f.union_id=u.id
        ), union_work AS (
          SELECT u.id,LEAST(u.first_week,(SELECT min(q.period_start) FROM public.union_accounting_runs q
            WHERE q.union_id=u.id
              AND (q.status<>'complete' OR (u.earliest_period_start IS NULL
                AND q.status='complete' AND q.result->>'success'='true' AND q.result->>'accounting_version'='3'))
              AND (u.earliest_period_start IS NULL OR q.period_start>=u.first_week))) AS first_week
           FROM union_floors u
        ), eligible AS (
          -- Match the exact-scope floor rounding and per-week due check. An
          -- older union backlog remains due before this Monday's new close.
          SELECT 'union'::text AS kind,w.id FROM union_work w WHERE w.first_week<v_to
           AND v_now>=CASE WHEN v_chunked THEN public.fn_union_week_start(w.first_week+interval '8 days') ELSE public.fn_union_accounting_run_at(public.fn_union_week_start(w.first_week+interval '8 days')) END
          UNION ALL SELECT 'club',w.club_id FROM standalone_work w JOIN public.clubs c ON c.id=w.club_id
           WHERE c.is_union IS NOT TRUE AND GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))<v_to
            AND v_now>=CASE WHEN v_chunked THEN public.fn_union_week_start(GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))+interval '8 days') ELSE public.fn_union_accounting_run_at(public.fn_union_week_start(GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))+interval '8 days')) END GROUP BY w.club_id
        )
 SELECT e.kind,e.id,CASE WHEN e.kind='union' THEN (SELECT min(w.first_week) FROM union_work w WHERE w.id=e.id)
  ELSE (SELECT min(GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))) FROM standalone_work w WHERE w.club_id=e.id) END
 FROM eligible e ORDER BY (e.kind='union') DESC,e.id;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_club_set_member_role(p_club_id uuid, p_user_id uuid, p_role text, p_actor_user_id uuid DEFAULT NULL::uuid, p_commission_rate numeric DEFAULT NULL::numeric, p_player_rakeback_rate numeric DEFAULT NULL::numeric, p_is_prepaid boolean DEFAULT NULL::boolean, p_credit_limit numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor      uuid;
  v_old_role   text;
  v_actor_role text;
  v_allowed    text[];
  v_downline   int;
  v_agent_id   uuid;
  v_parent     uuid;
  v_set_upline boolean := false;
  v_is_agent   boolean;
  v_is_staff   boolean;
  v_comm       numeric;
  v_rake       numeric;
  v_prepaid    boolean;
  v_limit      numeric;
  v_have_row   boolean := false;
  v_fresh      boolean;
  v_cap_comm   numeric;
  v_cap_rake   numeric;
  v_cap_limit  numeric;
  v_float      numeric;
  v_owed       numeric;
  v_commission numeric;
  v_keeps_wallet boolean;
  v_club_name  text;
  v_label      text;
BEGIN
  -- Serialize the existing agreement before any operation/hierarchy/row lock.
  -- Nested callers reacquire the same transaction lock; no new money path.
  IF p_club_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
  END IF;

  -- IDENTITY. auth.uid() is the ONLY identity a browser can establish; it is
  -- NULL for anon, and a NULL here used to mean "believe p_actor_user_id".
  -- A caller-supplied actor is now accepted from a trusted backend only.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    IF COALESCE(auth.role(), 'service_role') = 'service_role'
       AND p_actor_user_id IS NOT NULL THEN
      v_actor := p_actor_user_id;
    ELSE
      RETURN jsonb_build_object('success', false, 'error', 'actor identity required');
    END IF;
  END IF;

  IF p_role IS NULL OR p_role NOT IN
     ('co_owner','admin','super_agent','agent','sub_agent','player') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid role: ' || COALESCE(p_role,'null'));
  END IF;

  v_is_agent := p_role IN ('super_agent','agent','sub_agent');
  v_is_staff := p_role IN ('co_owner','admin');

  IF NOT v_is_agent
     AND (COALESCE(p_commission_rate, 0) <> 0 OR COALESCE(p_player_rakeback_rate, 0) <> 0) THEN
    RETURN jsonb_build_object('success', false,
      'error', CASE WHEN v_is_staff
                    THEN 'co owners and admins receive no rakeback, so no rate may be set for one'
                    ELSE 'only an agent role carries a commission or rakeback rate' END);
  END IF;

  -- Funding belongs to an agent role. Sending it with a demotion to player, or
  -- with a promotion to staff, is a caller mistake worth naming rather than
  -- quietly ignoring: it usually means the wrong role reached this call.
  IF NOT v_is_agent AND (p_is_prepaid IS NOT NULL OR p_credit_limit IS NOT NULL) THEN
    RETURN jsonb_build_object('success', false,
      'error', 'only an agent role is funded prepaid or on a credit line');
  END IF;

  SELECT role INTO v_old_role FROM club_members
   WHERE club_id = p_club_id AND user_id = p_user_id
     AND status IN ('active','approved')
   FOR UPDATE;

  IF v_old_role IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'target is not a member of this club');
  END IF;

  IF v_old_role = p_role THEN
    RETURN jsonb_build_object('success', true, 'unchanged', true, 'role', p_role);
  END IF;

  v_allowed := fn_club_grantable_roles(p_club_id, v_actor, p_user_id);
  IF NOT (p_role = ANY (v_allowed)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not permitted to set this role',
      'allowed', COALESCE(to_jsonb(v_allowed), '[]'::jsonb));
  END IF;

  SELECT role INTO v_actor_role FROM club_members
   WHERE club_id = p_club_id AND user_id = v_actor AND status IN ('active','approved');

  IF fn_club_role_rank(v_old_role) > fn_club_role_rank(p_role)
     AND v_old_role IN ('super_agent','agent','sub_agent') THEN
    SELECT count(*) INTO v_downline FROM club_members
     WHERE club_id = p_club_id AND agent_id = p_user_id;
    IF v_downline > 0 THEN
      RETURN jsonb_build_object('success', false,
        'error', 'this member still has ' || v_downline || ' player'
                 || CASE WHEN v_downline = 1 THEN '' ELSE 's' END
                 || ' reporting to them. Move them to another agent first.',
        'downline_count', v_downline);
    END IF;
  END IF;

  v_set_upline := v_actor_role IN ('super_agent','agent')
                  AND p_role IN ('agent','sub_agent');

  -- ---------------------------------------------------------------------------
  -- A DEMOTION MUST NOT STRAND MONEY
  -- ---------------------------------------------------------------------------
  -- Every role except 'player' may hold an agent wallet - Dan, 2026-08-31:
  -- "OWNERS AND CO OWNERS CAN AND SHOULD HAVE AGENT WALLETS." So moving an
  -- agent up to co-owner, or sideways to another agent tier, strands nothing:
  -- the wallet goes with them and they can still spend it.
  --
  -- Becoming a PLAYER is the one move that takes the wallet away.
  -- fn_club_bank_role then returns 'player', fn_agent_wallet_send refuses them
  -- outright, and fn_agent_wallet_claim_back with it - so whatever the row still
  -- holds becomes chips nobody can move and nobody is watching. 67 of the 111
  -- active agents hold float today, 6,726,000 chips between them.
  --
  -- The remedy already exists and is named in the refusal:
  -- fn_club_bank_claim_back pulls the float back into the club bank, keyed on an
  -- op_id and written to the ledger, and any owner, co-owner, admin or super
  -- agent may run it. A debt is not sweepable and must be settled instead -
  -- fn_apply_credit_payment pays credit_used down when the invoice is paid.
  v_keeps_wallet := p_role <> 'player';

  -- PHASE 7. What the club still owes this person, from the ledger the claim
  -- path settles - rather than from the agents column that migration drops,
  -- which nothing ever wrote. It said 26,859.87 across 5 agents on a day the
  -- ledger held 408,809.59 across 114, so 109 of those 114 were reported to the
  -- person changing their role as owed nothing at all. One partial-index lookup
  -- (agent_commissions_unsettled_idx).
  -- reads the ledger directly: this function has already authorized its
  -- actor through fn_club_grantable_roles above, and it is SECURITY DEFINER,
  -- so it does not need the guarded caller-facing RPC's door. That RPC now
  -- admits only self, club admin and above, an agent ancestor, or the
  -- service role, and THIS report must not be able to fail on it. Same
  -- SELECT, same partial index (agent_commissions_unsettled_idx).
  SELECT COALESCE(SUM(ac.amount), 0)::numeric INTO v_commission
    FROM public.agent_commissions ac
   WHERE ac.club_id = p_club_id
     AND ac.user_id = p_user_id
     AND ac.settled_at IS NULL AND NOT public.fn_agent_commission_paid_by_period(ac.club_id, ac.user_id, ac.created_at);

  -- v_old_role was checked against the three AGENT tiers here, which missed the
  -- people phase 2 deliberately gave wallets to. A co-owner or an admin holds an
  -- agent wallet by design - Dan: "OWNERS AND CO OWNERS CAN AND SHOULD HAVE
  -- AGENT WALLETS" - so demoting one straight to player took the wallet away
  -- with the float still in it, which is the exact defect this phase exists to
  -- stop. Any role that is not already 'player' can be holding one.
  IF NOT v_keeps_wallet AND v_old_role <> 'player' THEN
    SELECT COALESCE(a.agent_wallet_balance, 0), greatest(COALESCE(a.credit_used, 0), CASE WHEN NOT COALESCE(a.is_prepaid,false) THEN greatest(a.credit_limit-a.agent_wallet_balance,0) ELSE 0 END)
      INTO v_float, v_owed
      FROM agents a
     WHERE a.club_id = p_club_id AND a.user_id = p_user_id;

    IF COALESCE(v_float, 0) > 0 OR COALESCE(v_owed, 0) > 0 THEN
      -- Name only what is actually outstanding. "holds 5,000 chips and owes
      -- 0.00" invites somebody to go looking for a debt that is not there.
      RETURN jsonb_build_object('success', false, 'needs_settlement', true,
        'error', 'this member cannot become a player yet: '
                 || CASE WHEN COALESCE(v_float, 0) > 0 AND COALESCE(v_owed, 0) > 0
                         THEN 'their agent wallet still holds '
                              || trim(to_char(v_float, 'FM999,999,999,990.00'))
                              || ' chips, and they still owe '
                              || trim(to_char(v_owed, 'FM999,999,999,990.00'))
                              || '. Claim the chips back into the club bank and settle the debt first.'
                         WHEN COALESCE(v_float, 0) > 0
                         THEN 'their agent wallet still holds '
                              || trim(to_char(v_float, 'FM999,999,999,990.00'))
                              || ' chips. Claim them back into the club bank first, '
                              || 'because a player cannot spend an agent wallet.'
                         ELSE 'they still owe '
                              || trim(to_char(v_owed, 'FM999,999,999,990.00'))
                              || ' on their credit line. Settle the invoice first.'
                    END,
        'agent_wallet_balance', COALESCE(v_float, 0),
        'credit_used', COALESCE(v_owed, 0),
        'unclaimed_commission', COALESCE(v_commission, 0));
    END IF;
  END IF;

  IF v_is_agent THEN
    SELECT a.commission_rate, a.player_rakeback_rate, a.is_prepaid, a.credit_limit
      INTO v_comm, v_rake, v_prepaid, v_limit
      FROM agents a
     WHERE a.club_id = p_club_id AND a.user_id = p_user_id;
    v_have_row := FOUND;

    -- B-01, Dan 2026-08-31: FORCE A FRESH CHOICE.
    --
    -- A member whose current club role is not an agent tier is being PROMOTED.
    -- Their agents row may still hold the commission, rakeback and credit line
    -- they carried before they were demoted, and a commercial term nobody has
    -- re-agreed does not come back by default - "getting this wrong costs
    -- money" was the whole of the question put to Dan. So on a promotion every
    -- term is taken from this call and from nowhere else.
    --
    -- Re-GRADING an existing agent (agent to super agent) is a different act:
    -- their terms are live, not stale, and carrying them forward when the
    -- caller sends nothing is what every existing caller already relies on.
    v_fresh := v_old_role NOT IN ('super_agent','agent','sub_agent');

    IF v_fresh THEN
      v_comm    := p_commission_rate;
      -- The agent sets what their own players receive (Dan, 2026-10-15).
      -- A promotion that does not name it starts it at 0 until they do.
      v_rake    := COALESCE(p_player_rakeback_rate, 0);
      v_prepaid := p_is_prepaid;
      v_limit   := p_credit_limit;
    ELSE
      v_comm    := COALESCE(p_commission_rate, v_comm);
      v_rake    := COALESCE(p_player_rakeback_rate, v_rake);
      v_prepaid := COALESCE(p_is_prepaid, v_prepaid);
      v_limit   := COALESCE(p_credit_limit, v_limit);
    END IF;

    IF v_comm IS NULL OR v_rake IS NULL THEN
      RETURN jsonb_build_object('success', false, 'needs_rates', true,
        'error', 'a commission rate and a player rakeback rate must be chosen when granting an agent role');
    END IF;
    IF v_comm < 0 OR v_comm > 0.70 THEN
      RETURN jsonb_build_object('success', false, 'error', 'the commission rate must be between 0 and 0.70');
    END IF;
    IF v_rake < 0 OR v_rake > 0.50 THEN
      RETURN jsonb_build_object('success', false, 'error', 'the player rakeback rate must be between 0 and 0.50');
    END IF;
    IF v_rake > v_comm THEN
      RETURN jsonb_build_object('success', false,
        'error', 'the player rakeback rate cannot exceed the commission rate it is paid out of');
    END IF;

    -- Dan, 2026-08-31: "WHEN A AGENT IS PROMOTED ... THEY ALSO NEED TO BE
    -- ASSIGNED 'PRE PAID' OR CREDIT LINE, (AND IF SO, THEN HOW MUCH)".
    -- Before this, every promotion hardcoded credit_limit 0 and left is_prepaid
    -- at its column default of false, which is the one combination that can
    -- send nothing at all: not prepaid, and no line to draw on. Three agents
    -- are in exactly that state on production today.
    IF v_prepaid IS NULL THEN
      RETURN jsonb_build_object('success', false, 'needs_funding', true,
        'error', 'choose prepaid or a credit line when granting an agent role');
    END IF;
    IF v_prepaid THEN
      IF COALESCE(v_limit, 0) <> 0 THEN
        RETURN jsonb_build_object('success', false,
          'error', 'a prepaid agent carries no credit line, so the limit must be 0');
      END IF;
      v_limit := 0;
    ELSE
      IF v_limit IS NULL THEN
        RETURN jsonb_build_object('success', false, 'needs_funding', true,
          'error', 'a credit agent needs a credit limit');
      END IF;
      IF v_limit <= 0 THEN
        RETURN jsonb_build_object('success', false,
          'error', 'a credit line must be greater than 0, or the agent should be prepaid');
      END IF;
    END IF;

    IF v_set_upline THEN
      SELECT id, commission_rate, player_rakeback_rate, credit_limit
        INTO v_parent, v_cap_comm, v_cap_rake, v_cap_limit
        FROM agents WHERE club_id = p_club_id AND user_id = v_actor;
    ELSIF v_have_row THEN
      SELECT p.commission_rate, p.player_rakeback_rate, p.credit_limit
        INTO v_cap_comm, v_cap_rake, v_cap_limit
        FROM agents a JOIN agents p ON p.id = a.parent_agent_id
       WHERE a.club_id = p_club_id AND a.user_id = p_user_id;
    END IF;

    IF v_cap_comm IS NOT NULL AND v_comm > v_cap_comm THEN
      RETURN jsonb_build_object('success', false,
        'error', 'the commission rate cannot exceed the upline rate of ' || v_cap_comm);
    END IF;
    -- No upline cap on the PLAYER rakeback (Dan, 2026-10-15): it is paid out
    -- of this agent's own commission, which is checked against it above.
    -- An upline cannot lend downward what it does not itself hold.
    IF v_cap_limit IS NOT NULL AND v_limit > v_cap_limit THEN
      RETURN jsonb_build_object('success', false,
        'error', 'the credit limit cannot exceed the upline limit of ' || v_cap_limit);
    END IF;
  END IF;

  PERFORM set_config('app.club_role_change', 'on', true);

  UPDATE club_members
     SET role                = p_role,
         agent_id            = CASE WHEN v_set_upline THEN v_actor ELSE agent_id END,
         player_rakeback_pct = CASE WHEN v_is_staff THEN 0 ELSE player_rakeback_pct END,
         rakeback_rate       = CASE WHEN v_is_staff THEN 0 ELSE rakeback_rate END,
         commission_rate     = CASE WHEN v_is_staff THEN 0 ELSE commission_rate END,
         updated_at          = now()
   WHERE club_id = p_club_id AND user_id = p_user_id;

  PERFORM set_config('app.club_role_change', '', true);

  IF v_is_agent THEN
    SELECT id INTO v_agent_id FROM agents
     WHERE club_id = p_club_id AND user_id = p_user_id;

    IF v_agent_id IS NOT NULL THEN
      UPDATE agents
         SET role = p_role, status = 'active',
             parent_agent_id = COALESCE(v_parent, parent_agent_id),
             commission_rate = v_comm, player_rakeback_rate = v_rake,
             is_prepaid = v_prepaid, credit_limit = v_limit,
             updated_at = now()
       WHERE id = v_agent_id;
    ELSE
      INSERT INTO agents (club_id, user_id, role, status, parent_agent_id,
                          commission_rate, player_rakeback_rate,
                          is_prepaid, credit_limit, credit_used)
      VALUES (p_club_id, p_user_id, p_role, 'active', v_parent, v_comm, v_rake,
              v_prepaid, v_limit, 0)
      RETURNING id INTO v_agent_id;
    END IF;
  ELSE
    -- Suspend the row only when the member can no longer hold a wallet. A
    -- promotion to co-owner or admin used to suspend it too, which contradicted
    -- the rule that staff hold agent wallets and left the club bank funding a
    -- row marked inactive.
    -- Active while they can hold a wallet, suspended when they cannot. Keyed on
    -- the role they are BECOMING, for the same reason the guard above is: a
    -- co-owner demoted to player left an ACTIVE agents row behind, so a player
    -- still read as an agent - fn_player_rakeback_rate joins that row on
    -- status = 'active'.
    UPDATE agents
       SET status = CASE WHEN p_role = 'player' AND v_old_role <> 'player'
                         THEN 'suspended' ELSE status END,
           commission_rate      = CASE WHEN v_is_staff THEN 0 ELSE commission_rate END,
           player_rakeback_rate = CASE WHEN v_is_staff THEN 0 ELSE player_rakeback_rate END,
           updated_at = now()
     WHERE club_id = p_club_id AND user_id = p_user_id;
  END IF;

  INSERT INTO audit_trail (actor_id, actor_role, action, target_type, target_id,
                           club_id, before_state, after_state, reason)
  VALUES (v_actor, COALESCE(v_actor_role, 'platform_admin'), 'set_member_role',
          'club_member', p_user_id, p_club_id,
          jsonb_build_object('role', v_old_role),
          jsonb_build_object('role', p_role, 'upline_set', v_set_upline,
                             'commission_rate', v_comm, 'player_rakeback_rate', v_rake,
                             'is_prepaid', v_prepaid, 'credit_limit', v_limit,
                             'funding_rechosen', COALESCE(v_fresh, false)),
          'Role changed via fn_club_set_member_role');

  -- ---------------------------------------------------------------------------
  -- TELL THE PERSON IT HAPPENED
  -- ---------------------------------------------------------------------------
  -- Until now the only announcement was masterBus.emit('MEMBER_ROLE_CHANGED'),
  -- a browser-local event. It reaches the tabs of whoever performed the change
  -- and nobody else, so the person whose role actually changed found out when a
  -- button appeared or vanished. notifications is the estate's real channel:
  -- 11,362 rows, four RLS policies, rendered by NotificationDropdown, the
  -- header store and NotificationsPage.
  --
  -- Failing to notify must never fail the role change. The role is the fact;
  -- the notice is a courtesy, and a courtesy that can roll back a promotion is
  -- worse than no courtesy at all.
  SELECT name INTO v_club_name FROM clubs WHERE id = p_club_id;
  v_label := CASE p_role
               WHEN 'co_owner' THEN 'Co Owner'
               WHEN 'admin' THEN 'Admin'
               WHEN 'super_agent' THEN 'Super Agent'
               WHEN 'agent' THEN 'Agent'
               WHEN 'sub_agent' THEN 'Sub Agent'
               ELSE 'Player'
             END;
  BEGIN
    PERFORM public.fn_raise_notification(
      p_user_id,
      'club_role_changed',
      'Your Role Changed In ' || COALESCE(v_club_name, 'Your Club'),
      'You Are Now ' || v_label || '.'
        || CASE WHEN v_is_agent
                THEN ' Your Commission Is ' || trim(to_char(v_comm * 100, 'FM990.00'))
                     || ' Percent. You Set The Rakeback Your Players Receive, Now '
                     || trim(to_char(v_rake * 100, 'FM990.00')) || ' Percent.'
                     || CASE WHEN v_prepaid THEN ' You Are Prepaid.'
                             ELSE ' Your Credit Line Is '
                                  || trim(to_char(v_limit, 'FM999,999,999,990.00')) || ' Chips.'
                        END
                ELSE '' END,
      '/clubs/' || p_club_id::text,
      jsonb_build_object(
        'club_id', p_club_id, 'old_role', v_old_role, 'new_role', p_role,
        'commission_rate', v_comm, 'player_rakeback_rate', v_rake,
        'is_prepaid', v_prepaid, 'credit_limit', v_limit));
  EXCEPTION WHEN OTHERS THEN
    -- Swallowed on purpose, and only here. The role change is already durable.
    NULL;
  END;

  RETURN jsonb_build_object('success', true, 'old_role', v_old_role, 'new_role', p_role,
    'commission_rate', v_comm, 'player_rakeback_rate', v_rake,
    'is_prepaid', v_prepaid, 'credit_limit', v_limit,
    -- Commission the CLUB owes THEM. It does not block the demotion: the agents
    -- row survives with the figure intact, so nothing is lost by moving the
    -- role, and there is no payout path to send them to yet (phase 6 builds
    -- one). Blocking here would strand the club, not the money. Reported so the
    -- caller can say it out loud rather than discover it later.
    'unclaimed_commission', COALESCE(v_commission, 0),
    'reports_to', CASE WHEN v_set_upline THEN v_actor ELSE NULL END);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_process_credit_invoice_payment(p_invoice_id uuid, p_amount numeric, p_method text, p_operation_id uuid, p_reference text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE inv public.credit_invoices%ROWTYPE; agent public.agents%ROWTYPE; pay public.credit_payments%ROWTYPE;
 actor uuid:=auth.uid(); engine boolean:=public.fn_caller_is_engine(); remaining numeric; old_club text; deducted boolean; new_status text; tracking boolean; bank numeric; ctx jsonb; setting_key text;
BEGIN
 IF p_invoice_id IS NULL OR p_operation_id IS NULL OR p_amount IS NULL OR p_amount<=0
    OR p_amount::text IN('NaN','Infinity','-Infinity') OR p_amount<>round(p_amount,2)
 THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','invalid_payment'); END IF;
 IF p_method IS NULL OR p_method NOT IN('wallet','external') THEN
   RETURN jsonb_build_object('ok',false,'success',false,'reason','unsupported_payment_method'); END IF;
 SELECT * INTO inv FROM public.credit_invoices WHERE id=p_invoice_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','invoice_not_found'); END IF;
 SELECT * INTO agent FROM public.agents WHERE id=inv.agent_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','agent_user_not_found'); END IF;
 IF p_method='wallet' THEN
   -- A service credential is not authority to spend an arbitrary user's wallet.
   IF actor IS NULL OR actor<>agent.user_id THEN
    RAISE EXCEPTION 'not_your_wallet' USING ERRCODE='42501'; END IF;
 ELSE
   IF NOT engine AND (actor IS NULL OR NOT (public.fn_is_club_admin_uid(agent.club_id) OR public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'only_receiving_club_can_record_external_payment' USING ERRCODE='42501'; END IF;
   IF NULLIF(btrim(p_reference),'') IS NULL OR length(p_reference)>256 THEN
    RETURN jsonb_build_object('ok',false,'success',false,'reason','payment_reference_required'); END IF;
 END IF;
 SELECT EXISTS(SELECT FROM public.agent_credit_weekly_basis b WHERE b.agent_id=inv.agent_id AND b.period_end=inv.period_end) INTO tracking;
 IF tracking THEN PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||agent.club_id::text,0)); END IF;
 -- Use the same agent -> invoice lock order as invoice generation.
 SELECT * INTO agent FROM public.agents WHERE id=inv.agent_id FOR UPDATE;
 SELECT * INTO inv FROM public.credit_invoices WHERE id=p_invoice_id FOR UPDATE;
 IF inv.agent_id IS DISTINCT FROM agent.id OR agent.club_id IS NULL
   OR (p_method='wallet' AND actor IS DISTINCT FROM agent.user_id)
   OR (p_method='external' AND NOT engine AND NOT (public.fn_is_club_admin_uid(agent.club_id) OR public.fn_is_platform_admin()))
 THEN RAISE EXCEPTION 'credit_account_changed' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('credit_payment:'||p_operation_id::text,0));
 SELECT * INTO pay FROM public.credit_payments WHERE operation_id=p_operation_id;
 IF NOT FOUND AND p_method='external' THEN
   SELECT * INTO pay FROM public.credit_payments WHERE invoice_id=p_invoice_id AND payment_method='external' AND payment_reference=btrim(p_reference);
 END IF;
 IF pay.id IS NOT NULL THEN
   IF pay.invoice_id<>p_invoice_id OR pay.amount<>p_amount OR pay.payment_method<>p_method
      OR pay.payer_user_id IS DISTINCT FROM actor OR pay.payment_reference IS DISTINCT FROM NULLIF(btrim(p_reference),'')
   THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','operation_conflict'); END IF;
   RETURN jsonb_build_object('ok',true,'success',true,'duplicate',true,'amount',pay.amount,'applied',pay.amount,
     'invoice_id',inv.id,'status',inv.status,'amount_remaining',inv.amount_remaining,'payment',to_jsonb(pay));
 END IF;
 IF inv.status NOT IN('pending','partial','overdue') THEN
   RETURN jsonb_build_object('ok',false,'success',false,'reason',CASE inv.status WHEN 'void' THEN 'invoice_voided' WHEN 'paid' THEN 'already_settled' ELSE 'invoice_not_payable' END);
 END IF;
 IF inv.debt_owed IS NULL OR inv.amount_paid IS NULL OR inv.amount_remaining IS NULL OR agent.credit_used IS NULL
   OR inv.debt_owed::text IN('NaN','Infinity','-Infinity') OR inv.amount_paid::text IN('NaN','Infinity','-Infinity')
   OR inv.amount_remaining::text IN('NaN','Infinity','-Infinity') OR agent.credit_used::text IN('NaN','Infinity','-Infinity')
   OR inv.debt_owed<>round(inv.debt_owed,2) OR inv.amount_paid<>round(inv.amount_paid,2)
   OR agent.credit_used<>round(agent.credit_used,2) OR inv.amount_paid<0 OR agent.credit_used<0
   OR inv.amount_remaining<>inv.debt_owed-inv.amount_paid
 THEN RAISE EXCEPTION 'credit_balance_evidence_invalid' USING ERRCODE='23514'; END IF;
 remaining:=inv.amount_remaining;
 IF p_amount>remaining THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','amount_exceeds_remaining','amount_remaining',remaining); END IF;
 IF NOT tracking AND p_amount>agent.credit_used THEN RAISE EXCEPTION 'credit_invoice_exceeds_drawn_debt' USING ERRCODE='23514'; END IF;
 IF tracking THEN
   IF agent.agent_wallet_balance IS NULL OR agent.agent_wallet_balance::text IN('NaN','Infinity','-Infinity') OR agent.agent_wallet_balance<0 OR agent.agent_wallet_balance<>round(agent.agent_wallet_balance,2) THEN RAISE EXCEPTION 'invalid_agent_wallet' USING ERRCODE='23514'; END IF;
   SELECT jsonb_object_agg(k,COALESCE(current_setting(k,true),'')) INTO ctx FROM unnest(ARRAY['app.ledger_club_id','app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_counterparty_label','app.ledger_idempotency_key','app.ledger_settlement','app.ledger_autoskip_agents','app.ledger_autoskip_clubs','app.ledger_autoskip_club_members','app.ledger_tournament','app.ledger_correlation']) k;
   PERFORM set_config('app.ledger_tournament','',true);
   PERFORM set_config('app.ledger_settlement','',true);
   PERFORM set_config('app.ledger_correlation',p_operation_id::text,true);
   PERFORM public.fn_ca_declare_ledger(CASE WHEN p_method='wallet' THEN 'transfer' ELSE 'club_bank_send' END,'agent_wallet',agent.user_id,NULL,'agent-credit-payment:'||p_operation_id::text,ARRAY['agents']);
   PERFORM set_config('app.ledger_club_id',agent.club_id::text,true);
   PERFORM set_config('app.ledger_autoskip_club_members','0',true);
   PERFORM set_config('app.ledger_autoskip_clubs','0',true);
   IF p_method='wallet' THEN
    deducted:=public.atomic_deduct_wallet_and_log(agent.user_id,p_amount,'settlement','Agent Wallet Top-Up: '||p_invoice_id::text,NULL,NULL,p_invoice_id);
    IF deducted IS DISTINCT FROM true THEN
     FOR setting_key IN SELECT jsonb_object_keys(ctx) LOOP PERFORM set_config(setting_key,ctx->>setting_key,true); END LOOP;
     RETURN jsonb_build_object('ok',false,'success',false,'reason','insufficient_balance');
    END IF;
   ELSE
    SELECT chip_treasury INTO bank FROM public.clubs WHERE id=agent.club_id FOR UPDATE;
    IF bank IS NULL OR bank::text IN('NaN','Infinity','-Infinity') OR bank<>round(bank,2) OR bank<p_amount THEN
     FOR setting_key IN SELECT jsonb_object_keys(ctx) LOOP PERFORM set_config(setting_key,ctx->>setting_key,true); END LOOP;
     RETURN jsonb_build_object('ok',false,'success',false,'reason','insufficient_club_bank');
    END IF;
    UPDATE public.clubs SET chip_treasury=chip_treasury-p_amount WHERE id=agent.club_id;
   END IF;
   UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance+p_amount,updated_at=now() WHERE id=agent.id;
   FOR setting_key IN SELECT jsonb_object_keys(ctx) LOOP PERFORM set_config(setting_key,ctx->>setting_key,true); END LOOP;
 ELSIF p_method='wallet' THEN
   old_club:=current_setting('app.ledger_club_id',true);
   PERFORM set_config('app.ledger_club_id',agent.club_id::text,true);
   deducted:=public.atomic_deduct_wallet_and_log(agent.user_id,p_amount,'settlement','Credit Invoice Payment: '||p_invoice_id::text,NULL,NULL,p_invoice_id);
   PERFORM set_config('app.ledger_club_id',COALESCE(old_club,''),true);
   IF deducted IS DISTINCT FROM true THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','insufficient_balance'); END IF;
 END IF;
 remaining:=remaining-p_amount;
 new_status:=CASE WHEN remaining=0 THEN 'paid' ELSE 'partial' END;
 UPDATE public.credit_invoices SET amount_paid=amount_paid+p_amount,amount_remaining=remaining,status=new_status,
  paid_at=CASE WHEN remaining=0 THEN now() ELSE paid_at END WHERE id=p_invoice_id;
 IF NOT tracking THEN UPDATE public.agents SET credit_used=credit_used-p_amount,updated_at=now() WHERE id=agent.id; END IF;
 INSERT INTO public.credit_payments(invoice_id,amount,payment_method,transaction_id,operation_id,payer_user_id,payment_reference)
  VALUES(p_invoice_id,p_amount,p_method,p_operation_id::text,p_operation_id,actor,NULLIF(btrim(p_reference),'')) RETURNING * INTO pay;
 -- The existing payment trigger creates the invoice and both delivery receipts.
 UPDATE public.settlement_invoices SET status=CASE WHEN remaining=0 THEN 'paid' ELSE 'generated' END,updated_at=now()
  WHERE source_credit_invoice_id=p_invoice_id;
 RETURN jsonb_build_object('ok',true,'success',true,'duplicate',false,'amount',p_amount,'applied',p_amount,
  'invoice_id',p_invoice_id,'status',new_status,'amount_remaining',remaining,'credit_used_after',CASE WHEN tracking THEN agent.credit_used ELSE agent.credit_used-p_amount END,'payment',to_jsonb(pay));
END $function$;

CREATE OR REPLACE FUNCTION public.fn_accounting_credit_document_on_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE a public.agents%ROWTYPE; credit public.credit_invoices%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='credit_invoices' THEN
   SELECT * INTO a FROM public.agents WHERE id=NEW.agent_id;
   INSERT INTO public.settlement_invoices(club_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,
    gross_amount,net_amount,deductions,breakdown,status,chips_transferred,due_at,source_credit_invoice_id,notes)
   VALUES(a.club_id,'transaction_receipt','club',a.club_id::text,'agent',a.user_id::text,
    NEW.debt_owed,NEW.debt_owed,0,jsonb_build_object('kind','credit_invoice','period_start',NEW.period_start,'period_end',NEW.period_end),
    'generated',false,NEW.due_date,NEW.id,CASE WHEN EXISTS(SELECT FROM public.agent_credit_weekly_basis b WHERE b.agent_id=NEW.agent_id AND b.period_end=NEW.period_end) THEN 'Agent Wallet Top-Up Invoice. Credit Line Minus Agent Wallet Before Rakeback.' ELSE 'Drawn Credit Invoice. This Amount Is Due From The Agent To The Club.' END);
 ELSIF TG_TABLE_NAME='credit_payments' THEN
   SELECT * INTO credit FROM public.credit_invoices WHERE id=NEW.invoice_id;
   SELECT * INTO a FROM public.agents WHERE id=credit.agent_id;
   INSERT INTO public.settlement_invoices(club_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,
    gross_amount,net_amount,deductions,breakdown,status,chips_transferred,transferred_at,source_credit_payment_id,notes)
   VALUES(a.club_id,'transaction_receipt','agent',a.user_id::text,'club',a.club_id::text,
    NEW.amount,NEW.amount,0,jsonb_build_object('kind','credit_payment','credit_invoice_id',NEW.invoice_id,'payment_method',NEW.payment_method,'transaction_id',NEW.transaction_id),
    'paid',NEW.payment_method='wallet',NEW.created_at,NEW.id,CASE WHEN EXISTS(SELECT FROM public.agent_credit_weekly_basis b WHERE b.agent_id=credit.agent_id AND b.period_end=credit.period_end) THEN 'Payment Restored The Agent Wallet Against The Referenced Top-Up Invoice.' ELSE 'Credit Payment Recorded Against The Referenced Invoice.' END);
 ELSE RAISE EXCEPTION 'unsupported_credit_document_source'; END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_generate_credit_invoice(p_agent_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_debt_owed numeric, p_due_date timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
 v_agent public.agents%ROWTYPE;
 v_row public.credit_invoices%ROWTYPE;
 v_invoiced numeric;
 v_available numeric; carry_dispute boolean;
BEGIN
 IF p_agent_id IS NULL THEN RAISE EXCEPTION 'agent_required' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_agent FROM public.agents WHERE id=p_agent_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'agent_not_found' USING ERRCODE='22023'; END IF;
 IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR
   (auth.uid()<>v_agent.user_id AND NOT public.fn_is_platform_admin()
    AND NOT public.fn_is_club_admin_uid(v_agent.club_id))) THEN
   RAISE EXCEPTION 'not_authorised' USING ERRCODE='42501';
 END IF;
 IF p_period_start IS NULL OR p_period_end IS NULL OR p_due_date IS NULL
   OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end) OR NOT isfinite(p_due_date)
   OR p_period_start>=p_period_end OR p_period_end>now() OR p_due_date<p_period_end
   OR p_debt_owed IS NULL OR p_debt_owed::text IN ('NaN','Infinity','-Infinity')
   OR p_debt_owed<=0 OR p_debt_owed<>round(p_debt_owed,2) THEN
   RAISE EXCEPTION 'invalid_credit_invoice_terms' USING ERRCODE='22023';
 END IF;
 -- An issued document is immutable. Replay returns its original terms.
 SELECT * INTO v_row FROM public.credit_invoices WHERE agent_id=p_agent_id AND period_end=p_period_end;
 IF FOUND THEN RETURN jsonb_build_object('success',true,'duplicate',true,'invoice',to_jsonb(v_row)); END IF;
 IF COALESCE(v_agent.is_prepaid,false) THEN
   RETURN jsonb_build_object('success',false,'error','prepaid_agent');
 END IF;
 SELECT b.amount_owed INTO v_available FROM public.agent_credit_weekly_basis b
  WHERE b.agent_id=p_agent_id AND b.period_start=p_period_start AND b.period_end=p_period_end;
 IF NOT FOUND THEN RAISE EXCEPTION 'pre_rakeback_credit_basis_required' USING ERRCODE='55000'; END IF;
 IF p_debt_owed IS DISTINCT FROM v_available THEN RAISE EXCEPTION 'credit_invoice_basis_mismatch' USING ERRCODE='23514'; END IF;
 SELECT EXISTS(SELECT FROM public.credit_invoices i WHERE i.agent_id=p_agent_id AND i.status='disputed' AND i.period_end<p_period_end AND EXISTS(SELECT FROM public.agent_credit_weekly_basis b WHERE b.agent_id=i.agent_id AND b.period_end=i.period_end)) INTO carry_dispute;
 -- Older tracking statements describe the same replenishable balance. Preserve
 -- their original amounts and payments, superseding only the unpaid remainder.
 UPDATE public.credit_invoices i SET status='void',amount_remaining=0,
  void_reason='Superseded By Agent Wallet Top-Up Statement Ending '||p_period_end::text
 WHERE i.agent_id=p_agent_id AND i.period_end<p_period_end AND i.status IN('pending','partial','overdue','disputed')
  AND EXISTS(SELECT FROM public.agent_credit_weekly_basis b WHERE b.agent_id=i.agent_id AND b.period_end=i.period_end);
 INSERT INTO public.credit_invoices(agent_id,period_start,period_end,debt_owed,amount_paid,amount_remaining,status,due_date)
 VALUES(p_agent_id,p_period_start,p_period_end,p_debt_owed,0,p_debt_owed,CASE WHEN carry_dispute THEN 'disputed' ELSE 'pending' END,p_due_date)
 RETURNING * INTO v_row;
 RETURN jsonb_build_object('success',true,'duplicate',false,'invoice',to_jsonb(v_row));
END $function$;

CREATE OR REPLACE FUNCTION public.fn_generate_scope_credit_invoices(p_club_id uuid,p_from timestamptz,p_to timestamptz) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_basis record;r jsonb;generated int:=0;duplicates int:=0;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_club_id IS NULL OR p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_from>=p_to OR p_to>now() THEN RAISE EXCEPTION 'invalid_credit_scope' USING ERRCODE='22023'; END IF;
 IF p_to<(SELECT activated_at FROM public.agent_credit_tracking_policy WHERE singleton) THEN RETURN jsonb_build_object('success',true,'generated',0,'duplicate',0,'failed',0,'legacy_period',true); END IF;
 IF NOT EXISTS(SELECT FROM public.agent_credit_weekly_scopes captured WHERE captured.club_id=p_club_id AND captured.period_start=p_from AND captured.period_end=p_to) THEN RAISE EXCEPTION 'pre_rakeback_credit_basis_required' USING ERRCODE='55000'; END IF;
 FOR v_basis IN SELECT * FROM public.agent_credit_weekly_basis WHERE club_id=p_club_id AND period_start=p_from AND period_end=p_to AND amount_owed>0 ORDER BY agent_id LOOP
  r:=public.fn_generate_credit_invoice(v_basis.agent_id,p_from,p_to,v_basis.amount_owed,p_to+interval '2 days');
  IF r->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'credit_invoice_generation_failed' USING DETAIL=r::text; END IF;
  IF r->>'duplicate'='true' THEN duplicates:=duplicates+1; ELSE generated:=generated+1; END IF;
 END LOOP;
 UPDATE public.credit_invoices i SET status='void',amount_remaining=0,void_reason='Superseded By Fully Funded Agent Wallet Statement Ending '||p_to::text WHERE i.period_end<p_to AND i.status IN('pending','partial','overdue','disputed') AND EXISTS(SELECT FROM public.agent_credit_weekly_basis previous_basis WHERE previous_basis.agent_id=i.agent_id AND previous_basis.period_end=i.period_end) AND EXISTS(SELECT FROM public.agent_credit_weekly_basis current_basis WHERE current_basis.agent_id=i.agent_id AND current_basis.club_id=p_club_id AND current_basis.period_start=p_from AND current_basis.period_end=p_to AND current_basis.amount_owed=0);
 RETURN jsonb_build_object('success',true,'generated',generated,'duplicate',duplicates,'failed',0);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_generate_all_credit_invoices(p_period_end timestamptz DEFAULT date_trunc('week',now())) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions' AS $function$
DECLARE c record;r jsonb;generated int:=0;duplicates int:=0;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_period_end IS NULL OR NOT isfinite(p_period_end) OR p_period_end>now() THEN RAISE EXCEPTION 'invalid_period_end' USING ERRCODE='22023'; END IF;
 FOR c IN SELECT DISTINCT club_id FROM public.agents WHERE NOT COALESCE(is_prepaid,false) AND credit_limit>0 LOOP
  r:=public.fn_generate_scope_credit_invoices(c.club_id,p_period_end-interval '7 days',p_period_end);
  generated:=generated+(r->>'generated')::int;duplicates:=duplicates+(r->>'duplicate')::int;
 END LOOP;
 RETURN jsonb_build_object('success',true,'generated',generated,'duplicate',duplicates,'failed',0,'period_end',p_period_end);
END $function$;
REVOKE ALL ON FUNCTION public.fn_accounting_credit_document_on_insert() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_accounting_credit_document_on_insert() TO service_role;
REVOKE ALL ON FUNCTION public.fn_agent_wallet_send_core_20260830(uuid,uuid,numeric,text,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_agent_wallet_send_core_20260830(uuid,uuid,numeric,text,text,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_club_set_member_role(uuid,uuid,text,uuid,numeric,numeric,boolean,numeric) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_club_set_member_role(uuid,uuid,text,uuid,numeric,numeric,boolean,numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_set_member_role(uuid,uuid,text,uuid,numeric,numeric,boolean,numeric) TO service_role;
REVOKE ALL ON FUNCTION public.fn_generate_all_credit_invoices(timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_generate_all_credit_invoices(timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION public.fn_generate_credit_invoice(uuid,timestamp with time zone,timestamp with time zone,numeric,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_generate_credit_invoice(uuid,timestamp with time zone,timestamp with time zone,numeric,timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_generate_credit_invoice(uuid,timestamp with time zone,timestamp with time zone,numeric,timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION public.fn_generate_scope_credit_invoices(uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_generate_scope_credit_invoices(uuid,timestamp with time zone,timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION public.fn_process_credit_invoice_payment(uuid,numeric,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_process_credit_invoice_payment(uuid,numeric,text,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_process_credit_invoice_payment(uuid,numeric,text,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_process_weekly_accounting_scope(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION smarter_private.weekly_payout_eligible_scopes(timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
DO $postimage$ BEGIN IF NOT (md5(pg_get_functiondef('public.fn_agent_wallet_send_core_20260830(uuid,uuid,numeric,text,text,uuid)'::regprocedure))='1ee7dc270ba19bf1b6a4a894900d9b38' AND md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz)'::regprocedure))='ce1a9dd4344c7987918dcf8a82427ef5' AND md5(pg_get_functiondef('public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamptz,timestamptz)'::regprocedure))='4e44bbbaf769aafe445819ab7a6683a4' AND md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))='a68500342f07e0608c6eb69f4cb0739e' AND md5(pg_get_functiondef('smarter_private.weekly_payout_eligible_scopes(timestamptz,timestamptz)'::regprocedure))='fd2603a21dc9c93a234afbda57d6abba' AND md5(pg_get_functiondef('public.fn_club_set_member_role(uuid,uuid,text,uuid,numeric,numeric,boolean,numeric)'::regprocedure))='c0f4657b3a53265b0d7fe03784d1b83b' AND md5(pg_get_functiondef('public.fn_process_credit_invoice_payment(uuid,numeric,text,uuid,text)'::regprocedure))='e99cfa877c5a67d5dde5744ea76b4285' AND md5(pg_get_functiondef('public.fn_accounting_credit_document_on_insert()'::regprocedure))='5a515636d7634d29514c723aa5dcfae2' AND md5(pg_get_functiondef('public.fn_generate_credit_invoice(uuid,timestamptz,timestamptz,numeric,timestamptz)'::regprocedure))='c87928c03ef42c498377c17bbaa51a7f' AND md5(pg_get_functiondef('public.fn_generate_scope_credit_invoices(uuid,timestamptz,timestamptz)'::regprocedure))='851f015057ecefc7ab4162cc36fa522c' AND md5(pg_get_functiondef('public.fn_generate_all_credit_invoices(timestamptz)'::regprocedure))='e1e68666b757cda7b3d314acde7c599b' AND md5(pg_get_functiondef('public.fn_capture_agent_credit_week(uuid[],timestamptz,timestamptz,text,uuid)'::regprocedure))='0d3ab6e7532fc9a3ee245658c617d79a' AND NOT has_function_privilege('authenticated','public.fn_capture_agent_credit_week(uuid[],timestamptz,timestamptz,text,uuid)','EXECUTE') AND NOT has_table_privilege('authenticated','public.agent_credit_weekly_basis','INSERT,UPDATE,DELETE') AND (SELECT relrowsecurity FROM pg_class WHERE oid='public.agent_credit_weekly_basis'::regclass)) THEN RAISE EXCEPTION 'credit_tracking_owner_postimage_changed'; END IF; END $postimage$;
COMMIT;
