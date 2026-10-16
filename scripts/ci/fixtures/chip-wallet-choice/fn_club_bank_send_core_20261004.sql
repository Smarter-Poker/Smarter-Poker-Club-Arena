CREATE OR REPLACE FUNCTION public.fn_club_bank_send_core_20261004(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'agent_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_dest         text := lower(coalesce(p_destination, 'agent_wallet'));
  v_op_id        uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior        record;
  v_bank_before  numeric;
  v_bank_after   numeric;
  v_to_role      text;
  v_to_after     numeric;
  v_agent_id     uuid;
  v_tx_id        uuid;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  v_actor_role := public.fn_club_bank_role(p_club_id);
  if v_actor_role is null or v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only An Owner, Co Owner, Admin Or Super Agent May Send From The Club Bank');
  end if;

  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'club_bank_send'
     and from_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'bank_after', (v_prior.metadata ->> 'bank_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric);
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
  if v_dest not in ('agent_wallet', 'promo_wallet', 'player_wallet') then
    return jsonb_build_object('success', false, 'error', 'Unknown Destination Wallet');
  end if;
  if p_to_user_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose A Recipient');
  end if;

  select cm.role into v_to_role
    from club_members cm
   where cm.club_id = p_club_id
     and cm.user_id = p_to_user_id
     and coalesce(cm.status, 'active') in ('active', 'approved')
   for update;
  if v_to_role is null then
    return jsonb_build_object('success', false, 'error', 'Recipient Is Not An Active Member Of This Club');
  end if;
  if v_dest in ('agent_wallet', 'promo_wallet')
     and v_to_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only Staff Or Agents Hold An Agent Wallet');
  end if;
  -- Dan 2026-09-02: "ALL CLUB OWNERS AND CO-OWNERS SHOULD HAVE A PLAYER
  -- WALLET (ADMIN'S SHOULD NOT)". A player-wallet credit to an admin lands in
  -- a balance no surface shows them, so it is refused here rather than
  -- stranded.
  if v_dest = 'player_wallet' and v_to_role = 'admin' then
    return jsonb_build_object('success', false,
      'error', 'An Admin Does Not Hold A Player Wallet');
  end if;

  if p_to_user_id <> v_actor
     and not public.fn_club_cashier_can_transact(p_club_id, v_actor, p_to_user_id) then
    return jsonb_build_object('success', false,
      'error', 'That Member Is Not In Your Downline');
  end if;

  select coalesce(c.chip_treasury, 0) into v_bank_before
    from clubs c where c.id = p_club_id for update;
  if v_bank_before is null then
    return jsonb_build_object('success', false, 'error', 'Club Not Found');
  end if;
  if v_bank_before < p_amount then
    return jsonb_build_object('success', false, 'error', 'Insufficient Club Bank Balance',
      'balance', v_bank_before, 'requested', p_amount);
  end if;

  -- CHIP STANDARD 2.4 (2026-09-03): a club bank send is ONE journal row from
  -- the bank to the wallet that receives it. Undeclared, the two balance
  -- writes landed as `adjustment club_treasury -> settlement_suspense` plus
  -- `adjustment settlement_suspense -> agent_wallet` (or `table_stack ->
  -- player_wallet`), unkeyed and uncorrelated (3,750,000.00 on 2026-09-01
  -- 14:02:19 journaled exactly so). The clubs trigger is skipped for this
  -- write; the receiving wallet's trigger writes the row with the bank as its
  -- counterparty, keyed and correlated on the op. Never a refusal: a journal
  -- miss falls back inside the trigger, the money moves as before.
  perform public.fn_ca_declare_ledger('club_bank_send', 'club_treasury', p_club_id, null,
    'club_bank_send:' || v_op_id::text, array['clubs']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);

  update clubs
     set chip_treasury = coalesce(chip_treasury, 0) - p_amount,
         updated_at = now()
   where id = p_club_id
   returning chip_treasury into v_bank_after;

  if v_dest = 'player_wallet' then
    update club_members
       set chip_balance = coalesce(chip_balance, 0) + p_amount,
           updated_at = now()
     where club_id = p_club_id and user_id = p_to_user_id
     returning chip_balance into v_to_after;
  else
    v_agent_id := public.fn_ensure_agent_row(p_club_id, p_to_user_id, v_to_role);
    if v_agent_id is null then
      raise exception 'could not ensure agents row for % in club %', p_to_user_id, p_club_id;
    end if;

    if v_dest = 'agent_wallet' then
      update agents
         set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + p_amount,
             updated_at = now()
       where id = v_agent_id
       returning agent_wallet_balance into v_to_after;
    else
      update agents
         set promo_wallet_balance = coalesce(promo_wallet_balance, 0) + p_amount,
             updated_at = now()
       where id = v_agent_id
       returning promo_wallet_balance into v_to_after;
    end if;
  end if;
  perform set_config('app.ledger_autoskip_clubs', '', true);

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata,
     balance_after, reversible_until)
  values
    (p_club_id, v_actor, p_to_user_id, p_amount, 'club_bank_send',
     coalesce(nullif(btrim(p_reason), ''), 'Club Bank Send'),
     jsonb_build_object(
       'op_id', v_op_id,
       'destination', v_dest,
       'actor_role', v_actor_role,
       'recipient_role', v_to_role,
       'bank_before', v_bank_before,
       'bank_after', v_bank_after,
       'recipient_balance_after', v_to_after),
     v_bank_after, now() + interval '7 days')
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true,
    'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', p_amount,
    'destination', v_dest,
    'bank_before', v_bank_before,
    'bank_after', v_bank_after,
    'recipient_balance_after', v_to_after);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from chip_transactions
     where club_id = p_club_id
       and transaction_type = 'club_bank_send'
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
      'bank_after', (v_prior.metadata ->> 'bank_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric);
end
$function$;
