CREATE OR REPLACE FUNCTION public.fn_club_promo_send_core_20261004(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_dest         text := lower(coalesce(p_destination, 'player_wallet'));
  v_op_id        uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior        record;
  v_pot_before   numeric;
  v_pot_after    numeric;
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
      'error', 'Only An Owner, Co Owner, Admin Or Super Agent May Send From The Club Promo Wallet');
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;
  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('success', false, 'error', 'Chips Move In Hundredths At Most');
  end if;
  if p_amount > 1e9 then
    return jsonb_build_object('success', false, 'error', 'Amount Exceeds The Single Send Limit');
  end if;
  if v_dest not in ('player_wallet', 'agent_wallet') then
    return jsonb_build_object('success', false, 'error', 'Unknown Destination Wallet');
  end if;
  if p_to_user_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose A Recipient');
  end if;

  select coalesce(c.promo_balance, 0) into v_pot_before
    from clubs c where c.id = p_club_id for update;
  if v_pot_before is null then
    return jsonb_build_object('success', false, 'error', 'Club Not Found');
  end if;

  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'club_promo_send'
     and from_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'pot_after', (v_prior.metadata ->> 'pot_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric);
  end if;

  if v_pot_before < p_amount then
    return jsonb_build_object('success', false, 'error', 'Insufficient Club Promo Wallet Balance',
      'balance', v_pot_before, 'requested', p_amount);
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
  if v_dest = 'agent_wallet'
     and v_to_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false, 'error', 'Only Staff Or Agents Hold A Promo Wallet');
  end if;
  if v_dest = 'player_wallet' and v_to_role = 'admin' then
    return jsonb_build_object('success', false, 'error', 'An Admin Does Not Hold A Player Wallet');
  end if;
  if p_to_user_id <> v_actor
     and not public.fn_club_cashier_can_transact(p_club_id, v_actor, p_to_user_id) then
    return jsonb_build_object('success', false, 'error', 'That Member Is Not In Your Downline');
  end if;

  perform public.fn_ca_declare_ledger('promo_send', 'promo_wallet', p_club_id, null,
    'club_promo_send:' || v_op_id::text, array['clubs']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);

  update clubs
     set promo_balance = coalesce(promo_balance, 0) - p_amount,
         updated_at = now()
   where id = p_club_id
   returning promo_balance into v_pot_after;

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
    update agents
       set promo_wallet_balance = coalesce(promo_wallet_balance, 0) + p_amount,
           updated_at = now()
     where id = v_agent_id
     returning promo_wallet_balance into v_to_after;
  end if;
  if v_to_after is null then
    raise exception 'club promo credit landed nowhere for % in %', p_to_user_id, p_club_id;
  end if;
  perform set_config('app.ledger_autoskip_clubs', '', true);

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  values
    (p_club_id, v_actor, p_to_user_id, p_amount, 'club_promo_send',
     coalesce(nullif(btrim(p_reason), ''), 'Club Promo Wallet Send'),
     jsonb_build_object(
       'op_id', v_op_id,
       'destination', v_dest,
       'source', 'club_promo_wallet',
       'actor_role', v_actor_role,
       'recipient_role', v_to_role,
       'pot_before', v_pot_before,
       'pot_after', v_pot_after,
       'recipient_balance_after', v_to_after),
     v_pot_after)
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true, 'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', p_amount,
    'destination', v_dest,
    'pot_before', v_pot_before,
    'pot_after', v_pot_after,
    'recipient_balance_after', v_to_after);
end
$function$
