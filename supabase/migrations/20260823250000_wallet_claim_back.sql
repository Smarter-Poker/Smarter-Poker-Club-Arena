-- ═══════════════════════════════════════════════════════════════════════════════
-- fn_wallet_claim_back
-- Reverses a send by claiming chips back from a user's wallet into the actor's
-- chosen wallet (Club Bank, Promo Wallet, or Agent Wallet).
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.fn_wallet_claim_back(
  p_club_id uuid,
  p_from_user_id uuid,
  p_amount numeric,
  p_target_wallet text, -- 'club_bank', 'promo_wallet', 'agent_wallet'
  p_source_wallet text default 'player_wallet', -- 'agent_wallet', 'promo_wallet', 'player_wallet'
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_from_role    text;
  v_amount       numeric := round(p_amount, 2);
  v_source       text := lower(coalesce(p_source_wallet, 'player_wallet'));
  v_target       text := lower(coalesce(p_target_wallet, 'club_bank'));
  v_actor_agent  uuid;
  v_from_agent   uuid;
  v_from_before  numeric;
  v_from_after   numeric;
  v_target_after numeric;
  v_first uuid;
  v_second uuid;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;
  if v_amount is null or v_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;
  if v_target not in ('club_bank', 'promo_wallet', 'agent_wallet') then
    return jsonb_build_object('success', false, 'error', 'Unknown Target Wallet');
  end if;
  if v_source not in ('agent_wallet', 'promo_wallet', 'player_wallet') then
    return jsonb_build_object('success', false, 'error', 'Unknown Source Wallet');
  end if;
  if p_from_user_id is null or p_from_user_id = v_actor then
    return jsonb_build_object('success', false, 'error', 'Invalid User');
  end if;

  v_actor_role := public.fn_club_bank_role(p_club_id);
  
  -- Verify actor permissions based on target wallet
  if v_target = 'club_bank' then
    if v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent') then
      return jsonb_build_object('success', false, 'error', 'Your Role Cannot Claim Back Into The Club Bank');
    end if;
  elsif v_target in ('agent_wallet', 'promo_wallet') then
    if v_actor_role not in ('super_agent', 'agent', 'sub_agent', 'owner', 'co_owner', 'admin') then
      return jsonb_build_object('success', false, 'error', 'Your Role Cannot Claim Back Into An Agent Wallet');
    end if;
  end if;

  -- Verify from user
  select role, agent_id into v_from_role, v_from_agent
    from club_members
   where club_id = p_club_id and user_id = p_from_user_id and status = 'active';

  if v_from_role is null then
    return jsonb_build_object('success', false, 'error', 'User Is Not An Active Member');
  end if;

  if v_source in ('agent_wallet', 'promo_wallet') and v_from_role not in ('super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false, 'error', 'User Does Not Have That Wallet');
  end if;

  -- If actor is pulling into their agent/promo wallet, verify downline
  if v_target in ('agent_wallet', 'promo_wallet') and v_actor_role in ('super_agent', 'agent', 'sub_agent') then
    if v_from_agent is distinct from v_actor then
      return jsonb_build_object('success', false, 'error', 'User Is Not In Your Downline');
    end if;
  end if;

  -- Lock ordering to avoid deadlocks
  if v_actor < p_from_user_id then
    v_first := v_actor; v_second := p_from_user_id;
  else
    v_first := p_from_user_id; v_second := v_actor;
  end if;

  perform 1 from club_members where club_id = p_club_id and user_id = v_first for update;
  perform 1 from club_members where club_id = p_club_id and user_id = v_second for update;

  -- Lock clubs if necessary
  if v_target = 'club_bank' then
    perform 1 from clubs where id = p_club_id for update;
  end if;
  
  -- Ensure agents rows exist and lock them
  insert into agents (user_id, club_id, role, status)
    values (v_actor, p_club_id, v_actor_role, 'active')
    on conflict (user_id, club_id) do nothing;
    
  insert into agents (user_id, club_id, role, status)
    values (p_from_user_id, p_club_id, v_from_role, 'active')
    on conflict (user_id, club_id) do nothing;

  perform 1 from agents where club_id = p_club_id and user_id = v_first for update;
  perform 1 from agents where club_id = p_club_id and user_id = v_second for update;

  -- Check balances
  if v_source = 'player_wallet' then
    select coalesce(chip_balance, 0) into v_from_before from club_members where club_id = p_club_id and user_id = p_from_user_id;
  elsif v_source = 'agent_wallet' then
    select coalesce(agent_wallet_balance, 0) into v_from_before from agents where club_id = p_club_id and user_id = p_from_user_id;
  elsif v_source = 'promo_wallet' then
    select coalesce(promo_wallet_balance, 0) into v_from_before from agents where club_id = p_club_id and user_id = p_from_user_id;
  end if;

  if coalesce(v_from_before, 0) < v_amount then
    return jsonb_build_object('success', false, 'error', 'Insufficient Chips', 'balance', coalesce(v_from_before, 0));
  end if;

  -- Deduct from source
  if v_source = 'player_wallet' then
    update club_members set chip_balance = chip_balance - v_amount, updated_at = now()
     where club_id = p_club_id and user_id = p_from_user_id returning chip_balance into v_from_after;
  elsif v_source = 'agent_wallet' then
    update agents set agent_wallet_balance = agent_wallet_balance - v_amount, updated_at = now()
     where club_id = p_club_id and user_id = p_from_user_id returning agent_wallet_balance into v_from_after;
  elsif v_source = 'promo_wallet' then
    update agents set promo_wallet_balance = promo_wallet_balance - v_amount, updated_at = now()
     where club_id = p_club_id and user_id = p_from_user_id returning promo_wallet_balance into v_from_after;
  end if;

  -- Add to target
  if v_target = 'club_bank' then
    update clubs set chip_treasury = coalesce(chip_treasury, 0) + v_amount, updated_at = now()
     where id = p_club_id returning chip_treasury into v_target_after;
  elsif v_target = 'agent_wallet' then
    update agents set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + v_amount, updated_at = now()
     where club_id = p_club_id and user_id = v_actor returning agent_wallet_balance into v_target_after;
  elsif v_target = 'promo_wallet' then
    update agents set promo_wallet_balance = coalesce(promo_wallet_balance, 0) + v_amount, updated_at = now()
     where club_id = p_club_id and user_id = v_actor returning promo_wallet_balance into v_target_after;
  end if;

  -- Log
  insert into chip_transactions (
    club_id,
    from_user_id,
    to_user_id,
    amount,
    transaction_type,
    notes,
    balance_after,
    metadata
  ) values (
    p_club_id,
    p_from_user_id,
    v_actor,
    v_amount,
    case when v_target = 'club_bank' then 'club_bank_claim'
         when v_target = 'promo_wallet' then 'promo_claim'
         else 'agent_claim' end,
    p_reason,
    v_target_after,
    jsonb_build_object(
      'source_wallet', v_source,
      'target_wallet', v_target,
      'from_balance_after', v_from_after
    )
  );

  return jsonb_build_object('success', true, 'balance_after', v_target_after);
end
$$;

revoke all on function public.fn_wallet_claim_back(uuid, uuid, numeric, text, text, text) from public, anon;
grant execute on function public.fn_wallet_claim_back(uuid, uuid, numeric, text, text, text) to authenticated, service_role;
