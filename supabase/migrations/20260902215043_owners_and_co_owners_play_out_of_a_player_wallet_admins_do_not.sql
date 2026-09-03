-- =============================================================================
-- owners_and_co_owners_play_out_of_a_player_wallet_admins_do_not
-- Applied to production via Supabase MCP 2026-09-02 (see changelog).
--
-- Dan, 2026-09-02, verbatim: "ALL CLUB OWNERS AND CO-OWNERS SHOULD HAVE A
-- PLAYER WALLET (ADMIN'S SHOULD NOT) I KNOW WE'VE SAID THEY SHOULDN'T
-- PREVIOUSLY, BUT NOW IM SEEING THE VALUE IN IT."
--
-- The client half is walletRows.ts (owner / co_owner rows gain player_wallet,
-- admin loses it). This is the database half, two rungs:
--
--   1. fn_agent_wallet_self_stake admits owner and co_owner. They have always
--      held an agent wallet (canHoldAgentWallet), and now hold the player
--      wallet the chips move into. Admin stays refused: no player wallet.
--   2. fn_club_bank_send refuses destination = player_wallet when the
--      recipient is an admin. Otherwise the chips land in a club_members
--      chip_balance that no wallet surface shows an admin, which is the
--      stranded-chips class of bug.
--
-- Both are CREATE OR REPLACE of functions already in the schema manifest;
-- no new objects, so no manifest fragment. Every other line of both bodies
-- is byte-identical to production as read back on 2026-09-02.
-- =============================================================================

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

CREATE OR REPLACE FUNCTION public.fn_club_bank_send(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'agent_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
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
