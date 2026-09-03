-- ───────────────────────────────────────────────────────────────────────────
-- PROMO WALLET CASHIER
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.fn_promo_wallet_send /* stealth */ (
  p_club_id uuid,
  p_to_user_id uuid,
  p_to_club_id uuid,
  p_amount numeric,
  p_destination text default 'player_wallet',
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_dest         text := lower(coalesce(p_destination, 'player_wallet'));
  v_agent_id     uuid;
  v_union_id     uuid;
  v_bank_before  numeric;
  v_bank_after   numeric;
  v_to_role      text;
  v_to_after     numeric;
  v_tx_id        uuid;
  v_recipient_club uuid;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;
  if p_amount > 1e9 then
    return jsonb_build_object('success', false, 'error', 'Amount Exceeds The Single Send Limit');
  end if;
  if v_dest not in ('agent_wallet', 'promo_wallet', 'player_wallet', 'club_bank') then
    return jsonb_build_object('success', false, 'error', 'Unknown Destination Wallet');
  end if;
  if p_to_user_id is null and p_to_club_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose A Recipient');
  end if;
  if p_to_user_id is not null and p_to_club_id is not null then
    return jsonb_build_object('success', false, 'error', 'Choose User OR Club, Not Both');
  end if;

  -- 1. Check sender's agent record
  select a.id, a.promo_wallet_balance, c.union_id 
    into v_agent_id, v_bank_before, v_union_id
    from club_agents a
    join clubs c on c.id = a.club_id
   where a.club_id = p_club_id
     and a.user_id = v_actor;

  if v_agent_id is null then
    return jsonb_build_object('success', false, 'error', 'Only Agents Can Send From Promo Wallet');
  end if;

  if coalesce(v_bank_before, 0) < p_amount then
    return jsonb_build_object('success', false, 'error', 'Insufficient Promo Balance');
  end if;

  -- 2. Verify Recipient
  if p_to_club_id is not null then
    if v_dest != 'club_bank' then
      return jsonb_build_object('success', false, 'error', 'Destination Must Be Club Bank');
    end if;
    if v_union_id is null then
      return jsonb_build_object('success', false, 'error', 'Cannot Send To Another Club When Standalone');
    end if;
    v_recipient_club := p_to_club_id;
    -- Verify recipient club is in the same union
    if not exists (select 1 from clubs where id = p_to_club_id and union_id = v_union_id) then
      return jsonb_build_object('success', false, 'error', 'Club Is Not In Your Union');
    end if;
  else
    if v_dest = 'club_bank' then
      return jsonb_build_object('success', false, 'error', 'Destination Must Be A Club');
    end if;
    
    if v_union_id is not null then
      -- Recipient must be an active member of ANY club in this union.
      select cm.role, cm.club_id into v_to_role, v_recipient_club
        from club_members cm
        join clubs c on c.id = cm.club_id
       where cm.user_id = p_to_user_id
         and c.union_id = v_union_id
         and coalesce(cm.status, 'active') = 'active'
       limit 1;
       
      if v_to_role is null then
        return jsonb_build_object('success', false, 'error', 'Recipient Is Not Active In Your Union');
      end if;
    else
      -- Recipient must be an active member of THIS club.
      select cm.role into v_to_role
        from club_members cm
       where cm.club_id = p_club_id
         and cm.user_id = p_to_user_id
         and coalesce(cm.status, 'active') = 'active';
         
      v_recipient_club := p_club_id;
         
      if v_to_role is null then
        return jsonb_build_object('success', false, 'error', 'Recipient Is Not Active In This Club');
      end if;
    end if;

    if v_dest in ('agent_wallet', 'promo_wallet') then
      if v_to_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent') then
        return jsonb_build_object('success', false, 'error', 'Recipient Must Be An Agent To Hold That Wallet');
      end if;
    end if;
  end if;

  -- 3. Execute Send
  v_bank_after := v_bank_before - p_amount;
  update club_agents
     set promo_wallet_balance = v_bank_after, updated_at = now()
   where id = v_agent_id;

  if p_to_club_id is not null then
    -- Credit club chip treasury
    update clubs
       set chip_treasury = coalesce(chip_treasury, 0) + p_amount, updated_at = now()
     where id = p_to_club_id
     returning chip_treasury into v_to_after;
  else
    if v_dest = 'player_wallet' then
      update club_members
         set chip_balance = coalesce(chip_balance, 0) + p_amount, updated_at = now()
       where club_id = v_recipient_club and user_id = p_to_user_id
       returning chip_balance into v_to_after;
    elsif v_dest = 'agent_wallet' then
      update club_agents
         set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + p_amount, updated_at = now()
       where club_id = v_recipient_club and user_id = p_to_user_id
       returning agent_wallet_balance into v_to_after;
    elsif v_dest = 'promo_wallet' then
      update club_agents
         set promo_wallet_balance = coalesce(promo_wallet_balance, 0) + p_amount, updated_at = now()
       where club_id = v_recipient_club and user_id = p_to_user_id
       returning promo_wallet_balance into v_to_after;
    end if;
  end if;

  -- Log
  insert into chip_transactions (
    club_id,
    from_user_id,
    to_user_id,
    amount,
    transaction_type,
    balance_after,
    notes,
    metadata
  ) values (
    p_club_id,
    v_actor,
    p_to_user_id,
    p_amount,
    'promo_send',
    v_bank_after,
    p_reason,
    jsonb_build_object(
      'destination_wallet', v_dest,
      'destination_club_id', p_to_club_id,
      'recipient_after', v_to_after
    )
  ) returning id into v_tx_id;

  return jsonb_build_object(
    'success', true,
    'balance_after', v_bank_after,
    'transaction_id', v_tx_id
  );
end
$$;
