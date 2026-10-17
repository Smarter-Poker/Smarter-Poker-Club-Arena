CREATE OR REPLACE FUNCTION public.fn_promo_wallet_send_core_20261004(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor          uuid := auth.uid();
  v_actor_role     text;
  v_dest           text := lower(coalesce(p_destination, 'player_wallet'));
  v_op_id          uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior          record;
  v_sender_id      uuid;
  v_sender_promo   numeric;
  v_sender_after   numeric;
  v_to_role        text;
  v_to_agent_id    uuid;
  v_to_after       numeric;
  v_tx_id          uuid;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  v_actor_role := public.fn_club_bank_role(p_club_id);
  if v_actor_role is null
     or v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only An Agent Or Club Staff May Send From A Promo Wallet');
  end if;

  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'promo_wallet_send'
     and from_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'sender_promo_after', (v_prior.metadata ->> 'sender_promo_after')::numeric,
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
  if v_dest not in ('player_wallet', 'agent_wallet') then
    return jsonb_build_object('success', false, 'error', 'Unknown Destination Wallet');
  end if;
  if p_to_user_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose A Recipient');
  end if;
  if p_to_user_id = v_actor then
    return jsonb_build_object('success', false, 'error', 'A Promo Wallet Cannot Send To Itself');
  end if;

  if not public.fn_club_cashier_can_transact(p_club_id, v_actor, p_to_user_id) then
    return jsonb_build_object('success', false,
      'error', 'That Member Is Not In Your Downline');
  end if;

  select a.id, coalesce(a.promo_wallet_balance, 0)
    into v_sender_id, v_sender_promo
    from agents a
   where a.club_id = p_club_id and a.user_id = v_actor
   for update;
  if v_sender_id is null then
    return jsonb_build_object('success', false,
      'error', 'You Do Not Hold A Promo Wallet In This Club');
  end if;
  if v_sender_promo < p_amount then
    return jsonb_build_object('success', false, 'error', 'Insufficient Promo Wallet Balance',
      'balance', v_sender_promo, 'requested', p_amount);
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
    return jsonb_build_object('success', false,
      'error', 'Only Staff Or Agents Hold A Promo Wallet');
  end if;

  -- CHIP STANDARD 2.4 (2026-09-03): ONE `promo_send` row from the sender's
  -- promo float to the wallet that receives it, keyed and correlated on the
  -- op. The agents trigger is skipped for both promo writes: a player
  -- recipient's club_members trigger writes the row with the promo float as
  -- counterparty; an agent recipient (both sides in `agents`) gets the row
  -- posted explicitly below. Never a refusal.
  perform public.fn_ca_declare_ledger('promo_send', 'promo_wallet', v_actor, null,
    'promo_send:' || v_op_id::text, array['agents']);
  perform set_config('app.ledger_correlation', v_op_id::text, true);

  update agents
     set promo_wallet_balance = coalesce(promo_wallet_balance, 0) - p_amount,
         updated_at = now()
   where id = v_sender_id
   returning promo_wallet_balance into v_sender_after;

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
    update agents
       set promo_wallet_balance = coalesce(promo_wallet_balance, 0) + p_amount,
           updated_at = now()
     where id = v_to_agent_id
     returning promo_wallet_balance into v_to_after;
    perform set_config('app.ledger_idempotency_key', '', true);
    perform public.fn_ca_post_leg('promo_send', 'promo_wallet', v_actor, 'promo_wallet', p_to_user_id,
      p_amount, p_club_id, 'promo_send:' || v_op_id::text,
      'Promo wallet send to a downline agent promo wallet (fn_promo_wallet_send)');
  end if;

  perform set_config('app.ledger_autoskip_agents', '', true);

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  values
    (p_club_id, v_actor, p_to_user_id, p_amount, 'promo_wallet_send',
     coalesce(nullif(btrim(p_reason), ''), 'Promo Wallet Send'),
     jsonb_build_object(
       'op_id', v_op_id,
       'destination', v_dest,
       'source', 'promo_wallet',
       'actor_role', v_actor_role,
       'recipient_role', v_to_role,
       'sender_promo_after', v_sender_after,
       'recipient_balance_after', v_to_after),
     null)
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true, 'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', p_amount,
    'destination', v_dest,
    'sender_promo_after', v_sender_after,
    'recipient_balance_after', v_to_after);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from chip_transactions
     where club_id = p_club_id
       and transaction_type = 'promo_wallet_send'
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
      'sender_promo_after', (v_prior.metadata ->> 'sender_promo_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric);
end
$function$
