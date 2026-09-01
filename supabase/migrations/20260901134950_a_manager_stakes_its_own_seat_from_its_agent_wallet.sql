-- =============================================================================
-- a_manager_stakes_its_own_seat_from_its_agent_wallet
-- Applied to production via Supabase MCP 2026-09-01 13:49 UTC.
--
-- Dan, 2026-09-01, verbatim: "AGENTS THEN SEND CHIPS TO THERE PLAYERS, AND
-- MOVE CHIPS FROM THERE AGENT WALLET TO THERE PLAYER WALLETS."
--
-- The move he describes had NO path: fn_agent_wallet_send refuses a send to
-- yourself ("Choose Another Active Member"), which is why the original
-- Deep Stack funding paid each manager's own 10,000 from its PARENT instead.
-- fn_club_bank_send permits self-send but only for the four bank roles.
--
-- This adds the missing rung: fn_agent_wallet_self_stake moves chips from
-- the caller's OWN agent wallet into the caller's OWN player wallet, with
-- the same guards as the send it mirrors: authenticated actor, mandatory
-- retry key with replay semantics, advisory locks, row locks, active
-- agent-wallet role required, no overdraft. Both balance changes ride the
-- existing autoledgers (agents + club_members), so the chip_ledger records
-- the two legs without any hand-written rows.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.fn_agent_wallet_self_stake(
  p_club_id uuid,
  p_amount numeric,
  p_reason text DEFAULT NULL,
  p_op_id uuid DEFAULT NULL
) RETURNS jsonb
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
  if v_role is null or v_role not in ('super_agent','agent','sub_agent') then
    return jsonb_build_object('success',false,'error','Only An Agent Wallet Holder Can Stake Their Own Seat');
  end if;

  update public.agents
     set agent_wallet_balance = agent_wallet_balance - p_amount
   where club_id=p_club_id and user_id=v_actor
     and coalesce(status,'active')='active'
     and agent_wallet_balance >= p_amount
   returning agent_wallet_balance into v_wallet_after;
  if v_wallet_after is null then
    return jsonb_build_object('success',false,'error','Your Agent Wallet Cannot Cover That Amount');
  end if;

  update public.club_members
     set chip_balance = coalesce(chip_balance,0) + p_amount
   where club_id=p_club_id and user_id=v_actor
   returning chip_balance into v_player_after;
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
$function$;

REVOKE ALL ON FUNCTION public.fn_agent_wallet_self_stake(uuid,numeric,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_agent_wallet_self_stake(uuid,numeric,text,uuid) TO authenticated, service_role;
