BEGIN;
SET LOCAL lock_timeout='3s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_agent_wallet_self_stake(uuid,numeric,text,uuid)'::regprocedure))<>'32d9d3dccec1bd82f314eaad2ca6e7b3' THEN
 RAISE EXCEPTION 'Self-stake definition changed since audit';END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_agent_wallet_self_stake(p_club_id uuid, p_amount numeric, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_prior record;
  v_role text;
  v_wallet_after numeric;
  v_player_after numeric;
  v_tx uuid;
  v_context jsonb;
  v_setting text;
begin
  if v_actor is null then
    return jsonb_build_object('success',false,'error','Not Authenticated');
  end if;
  if p_op_id is null then
    return jsonb_build_object('success',false,'error','A Retry Key Is Required For Every Send');
  end if;
  if p_club_id is null then
    return jsonb_build_object('success',false,'error','That Club Could Not Be Found');
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1e9 or p_amount <> round(p_amount,2) then
    return jsonb_build_object('success',false,'error','Enter A Valid Send Amount');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'agent-wallet-send:'||p_club_id::text||':'||v_actor::text||':'||p_op_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:'||p_club_id::text,0));

  select ct.* into v_prior from public.chip_transactions ct
   where ct.club_id=p_club_id and ct.transaction_type='agent_wallet_self_stake'
     and ct.from_user_id=v_actor and ct.metadata->>'op_id'=p_op_id::text limit 1;
  if found then
    if v_prior.amount is distinct from p_amount then
      return jsonb_build_object('success',false,
        'error','That Retry Key Belongs To A Different Agent Wallet Send');
    end if;
    return jsonb_build_object('success',true,'replayed',true,
      'transaction_id',v_prior.id,'amount',v_prior.amount,
      'agent_wallet_after',(v_prior.metadata->>'agent_wallet_after')::numeric,
      'player_wallet_after',(v_prior.metadata->>'player_wallet_after')::numeric);
  end if;

  perform 1 from public.clubs where id=p_club_id for update;
  if not found then
    return jsonb_build_object('success',false,'error','That Club Could Not Be Found');
  end if;
  perform 1 from public.club_members where club_id=p_club_id and user_id=v_actor for update;

  v_role := public.fn_club_bank_role(p_club_id, v_actor);
  -- Dan 2026-09-02: owners and co-owners hold a player wallet again, and they
  -- have always held an agent wallet, so the rung exists for them too. An
  -- admin holds no player wallet, so there is nowhere for the chips to land.
  if v_role is null or v_role not in ('owner','co_owner','super_agent','agent','sub_agent') then
    return jsonb_build_object('success',false,'error','Only An Agent Wallet Holder With A Player Wallet Can Stake Their Own Seat');
  end if;

  -- CHIP STANDARD 2.4 (2026-09-03): ONE `agent_send` row from the agent's own
  -- float to their own player wallet, keyed and correlated on the op (32
  -- stakes / 320,000.00 in 30d journaled as two suspense legs). The agents
  -- trigger is skipped; the club_members trigger writes the row.
  SELECT jsonb_object_agg(k,coalesce(current_setting(k,true),'')) INTO v_context
   FROM unnest(array['app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_tournament','app.ledger_settlement','app.ledger_idempotency_key','app.ledger_correlation','app.ledger_autoskip_agents']) settings(k);
  PERFORM set_config('app.ledger_tournament','',true);
  PERFORM set_config('app.ledger_settlement','',true);
  perform public.fn_ca_declare_ledger('agent_send', 'agent_wallet', v_actor, null,
    'agent_self_stake:' || p_op_id::text, array['agents']);
  perform set_config('app.ledger_correlation', p_op_id::text, true);

  update public.agents
     set agent_wallet_balance = agent_wallet_balance - p_amount
   where club_id=p_club_id and user_id=v_actor
     and coalesce(status,'active')='active'
     and agent_wallet_balance >= p_amount
   returning agent_wallet_balance into v_wallet_after;
  if v_wallet_after is null then
  FOR v_setting IN SELECT jsonb_object_keys(v_context) LOOP
    PERFORM set_config(v_setting,v_context->>v_setting,true);
  END LOOP;
    return jsonb_build_object('success',false,'error','Your Agent Wallet Cannot Cover That Amount');
  end if;

  update public.club_members
     set chip_balance = coalesce(chip_balance,0) + p_amount
   where club_id=p_club_id and user_id=v_actor
   returning chip_balance into v_player_after;
  FOR v_setting IN SELECT jsonb_object_keys(v_context) LOOP
    PERFORM set_config(v_setting,v_context->>v_setting,true);
  END LOOP;
  if v_player_after is null then
    raise exception 'membership row vanished for % in % after wallet debit', v_actor, p_club_id;
  end if;

  insert into public.chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  values
    (p_club_id, v_actor, v_actor, p_amount, 'agent_wallet_self_stake',
     coalesce(p_reason,'Agent Wallet To Own Player Wallet'),
     jsonb_build_object('op_id',p_op_id::text,'destination','player_wallet',
       'actor_role',v_role,
       'agent_wallet_after',v_wallet_after,'player_wallet_after',v_player_after),
     v_player_after)
  returning id into v_tx;

  return jsonb_build_object('success',true,'transaction_id',v_tx,'amount',p_amount,
    'agent_wallet_after',v_wallet_after,'player_wallet_after',v_player_after);
end
$function$
;
REVOKE ALL ON FUNCTION public.fn_agent_wallet_self_stake(uuid,numeric,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_agent_wallet_self_stake(uuid,numeric,text,uuid) TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
