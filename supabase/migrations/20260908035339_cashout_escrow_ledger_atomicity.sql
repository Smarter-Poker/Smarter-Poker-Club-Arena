BEGIN;
SET LOCAL lock_timeout = '3s';
DO $precondition$ BEGIN
 IF md5(pg_get_functiondef('public.fn_cashout_request(uuid,numeric,text,uuid)'::regprocedure)) <> 'f73ecc6c90db6d04734001b0361089b9' THEN
  RAISE EXCEPTION 'fn_cashout_request changed since inspection';
 END IF;
END $precondition$;
CREATE OR REPLACE FUNCTION public.fn_cashout_request(p_club_id uuid, p_amount numeric, p_note text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor   uuid := auth.uid();
  v_op_id   uuid := coalesce(p_op_id, gen_random_uuid());
  v_old_category text := current_setting('app.ledger_category', true);
  v_old_counterparty text := current_setting('app.ledger_counterparty', true);
  v_old_entity text := current_setting('app.ledger_counterparty_entity', true);
  v_old_key text := current_setting('app.ledger_idempotency_key', true);
  v_prior   record;
  v_agent   uuid;
  v_before  numeric;
  v_after   numeric;
  v_cashout uuid := gen_random_uuid();
  v_escrow_id uuid := gen_random_uuid();
  v_name    text;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  -- Serialize a caller's retries before consulting the committed receipt.
  perform pg_advisory_xact_lock(hashtextextended('cashout-op:' || v_actor::text || ':' || v_op_id::text, 0));

  select id, amount, related_cashout_id, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'cashout_request_escrow'
     and from_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    if v_prior.amount is distinct from p_amount then
      raise exception 'Operation ID belongs to a different cashout amount' using errcode = '22023';
    end if;
    return jsonb_build_object('success', true, 'replayed', true,
      'cashout_id', v_prior.related_cashout_id,
      'amount', v_prior.amount,
      'agent_id', v_prior.metadata ->> 'agent_id');
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;
  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('success', false, 'error', 'Chips Move In Hundredths At Most');
  end if;
  if p_amount > 1e9 then
    return jsonb_build_object('success', false, 'error', 'Amount Exceeds The Single Request Limit');
  end if;

  select coalesce(cm.chip_balance, 0), cm.agent_id
    into v_before, v_agent
    from club_members cm
   where cm.club_id = p_club_id
     and cm.user_id = v_actor
     and coalesce(cm.status, 'active') in ('active', 'approved')
   for update;
  if v_before is null then
    return jsonb_build_object('success', false,
      'error', 'You Are Not An Active Member Of This Club');
  end if;
  if v_before < p_amount then
    return jsonb_build_object('success', false,
      'error', 'You Only Hold ' || trim(to_char(v_before, 'FM999,999,999,990.00')) || ' Chips',
      'balance', v_before, 'requested', p_amount);
  end if;

  if v_agent is null then
    select c.owner_id into v_agent from clubs c where c.id = p_club_id;
  end if;
  if v_agent is null then
    select cm.user_id into v_agent
      from club_members cm
     where cm.club_id = p_club_id
       and cm.role in ('owner', 'co_owner', 'admin', 'super_agent', 'agent')
     order by case cm.role
                when 'owner' then 1 when 'co_owner' then 2 when 'admin' then 3
                when 'super_agent' then 4 else 5 end
     limit 1;
  end if;
  if v_agent is null then
    return jsonb_build_object('success', false,
      'error', 'This Club Has Nobody Who Can Approve A Cash Out');
  end if;
  if v_agent = v_actor then
    return jsonb_build_object('success', false,
      'error', 'You Cannot Request A Cash Out From Yourself');
  end if;

  if exists (select 1 from cashout_requests
              where club_id = p_club_id and player_id = v_actor and status = 'pending') then
    return jsonb_build_object('success', false,
      'error', 'You Already Have A Cash Out Waiting. Wait For It Or Cancel It First');
  end if;

  perform public.fn_ca_declare_ledger('escrow_hold', 'escrow', v_escrow_id, null,
    'cashout:' || v_cashout::text || ':hold', null);

  update club_members
     set chip_balance = coalesce(chip_balance, 0) - p_amount,
         updated_at = now()
   where club_id = p_club_id and user_id = v_actor
   returning chip_balance into v_after;

  perform set_config('app.ledger_category', coalesce(v_old_category, ''), true);
  perform set_config('app.ledger_counterparty', coalesce(v_old_counterparty, ''), true);
  perform set_config('app.ledger_counterparty_entity', coalesce(v_old_entity, ''), true);
  perform set_config('app.ledger_idempotency_key', coalesce(v_old_key, ''), true);

  insert into cashout_requests (id, club_id, player_id, agent_id, amount, status, player_note)
  values (v_cashout, p_club_id, v_actor, v_agent, p_amount, 'pending', nullif(btrim(p_note), ''))
  returning id into v_cashout;

  insert into chip_escrow (id, cashout_request_id, player_id, amount, club_id, locked_at)
  values (v_escrow_id, v_cashout, v_actor, p_amount, p_club_id, now());

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes,
     related_cashout_id, metadata, balance_after)
  values
    (p_club_id, v_actor, v_agent, p_amount, 'cashout_request_escrow',
     coalesce(nullif(btrim(p_note), ''), 'Cash Out Requested. Chips Held In Escrow'),
     v_cashout,
     jsonb_build_object('op_id', v_op_id, 'agent_id', v_agent,
                        'player_balance_after', v_after),
     v_after);

  select coalesce(nullif(btrim(pr.display_name), ''),
                  nullif(btrim(pr.alias), ''),
                  nullif(btrim(pr.username), ''), 'A Player')
    into v_name
    from profiles pr where pr.id = v_actor;

  insert into notifications (user_id, type, title, message, metadata, actor_id)
  values (v_agent, 'settlement', 'Cash Out Requested',
          coalesce(v_name, 'A Player') || ' Requested To Cash Out '
            || trim(to_char(p_amount, 'FM999,999,999,990')) || ' Chips',
          jsonb_build_object('clubId', p_club_id, 'cashoutId', v_cashout,
                             'amount', p_amount, 'playerName', v_name),
          v_actor);

  return jsonb_build_object('success', true, 'replayed', false,
    'cashout_id', v_cashout, 'agent_id', v_agent, 'amount', p_amount,
    'player_name', v_name,
    'player_balance_after', v_after);
end
$function$
;
REVOKE ALL ON FUNCTION public.fn_cashout_request(uuid,numeric,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cashout_request(uuid,numeric,text,uuid) TO authenticated, service_role;

DO $precondition$ BEGIN
 IF md5(pg_get_functiondef('public.fn_cashout_approve(uuid,text,uuid)'::regprocedure)) <> '0cc5466119858650b17d39d93c0eadb6' THEN
  RAISE EXCEPTION 'fn_cashout_approve changed since inspection';
 END IF;
END $precondition$;
CREATE OR REPLACE FUNCTION public.fn_cashout_approve(p_cashout_id uuid, p_note text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor    uuid := auth.uid();
  v_op_id    uuid := coalesce(p_op_id, gen_random_uuid());
  v_old_category text := current_setting('app.ledger_category', true);
  v_old_counterparty text := current_setting('app.ledger_counterparty', true);
  v_old_entity text := current_setting('app.ledger_counterparty_entity', true);
  v_old_key text := current_setting('app.ledger_idempotency_key', true);
  v_prior    record;
  v_req      record;
  v_escrow   record;
  v_role     text;
  v_agent_id uuid;
  v_after    numeric;
  v_name     text;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  -- Serialize a caller's retries before consulting the committed receipt.
  perform pg_advisory_xact_lock(hashtextextended('cashout-op:' || v_actor::text || ':' || v_op_id::text, 0));

  select id, amount, related_cashout_id, metadata into v_prior
    from chip_transactions
   where transaction_type = 'cashout_approved'
     and to_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    if v_prior.related_cashout_id is distinct from p_cashout_id then
      raise exception 'Operation ID belongs to a different cashout' using errcode = '22023';
    end if;
    return jsonb_build_object('success', true, 'replayed', true,
      'cashout_id', v_prior.related_cashout_id, 'amount', v_prior.amount);
  end if;

  select * into v_req from cashout_requests where id = p_cashout_id for update;
  if v_req is null then
    return jsonb_build_object('success', false, 'error', 'That Cash Out Could Not Be Found');
  end if;
  if v_req.status <> 'pending' then
    return jsonb_build_object('success', false,
      'error', 'That Cash Out Has Already Been Dealt With',
      'current_status', v_req.status);
  end if;

  v_role := public.fn_club_bank_role(v_req.club_id);
  if v_role is null then
    return jsonb_build_object('success', false,
      'error', 'You Are Not A Member Of That Club');
  end if;
  if v_req.agent_id <> v_actor
     and not public.fn_club_cashier_can_transact(v_req.club_id, v_actor, v_req.player_id) then
    return jsonb_build_object('success', false,
      'error', 'That Cash Out Belongs To A Different Agent');
  end if;

  select * into v_escrow
    from chip_escrow
   where cashout_request_id = p_cashout_id
   for update;
  if v_escrow is null or v_escrow.released_at is not null then
    return jsonb_build_object('success', false,
      'error', 'Those Chips Are Not Held In Escrow, So Nothing Can Be Released');
  end if;
  if v_escrow.amount <> v_req.amount then
    return jsonb_build_object('success', false,
      'error', 'The Escrowed Amount Does Not Match The Request');
  end if;

  v_agent_id := public.fn_ensure_agent_row(v_req.club_id, v_actor, v_role);
  if v_agent_id is null then
    raise exception 'could not ensure agents row for % in club %', v_actor, v_req.club_id;
  end if;

  perform public.fn_ca_declare_ledger('escrow_release', 'escrow', v_escrow.id, null,
    'cashout:' || p_cashout_id::text || ':release', null);

  update agents
     set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + v_req.amount,
         updated_at = now()
   where id = v_agent_id
   returning agent_wallet_balance into v_after;
  if not found then
    raise exception 'Cashout destination wallet is missing' using errcode = '23503';
  end if;

  perform set_config('app.ledger_category', coalesce(v_old_category, ''), true);
  perform set_config('app.ledger_counterparty', coalesce(v_old_counterparty, ''), true);
  perform set_config('app.ledger_counterparty_entity', coalesce(v_old_entity, ''), true);
  perform set_config('app.ledger_idempotency_key', coalesce(v_old_key, ''), true);

  update chip_escrow
     set released_at = now(), release_type = 'completed'
   where id = v_escrow.id;

  update cashout_requests
     set status = 'approved',
         agent_note = coalesce(nullif(btrim(p_note), ''), agent_note),
         acknowledged_at = now(),
         completed_at = now(),
         updated_at = now()
   where id = p_cashout_id;

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes,
     related_cashout_id, metadata, balance_after)
  values
    (v_req.club_id, v_req.player_id, v_actor, v_req.amount, 'cashout_approved',
     coalesce(nullif(btrim(p_note), ''), 'Cash Out Approved. Escrow Released Into The Agent Wallet'),
     p_cashout_id,
     jsonb_build_object('op_id', v_op_id, 'assigned_agent_id', v_req.agent_id,
                        'approved_by', v_actor, 'approver_role', v_role,
                        'agent_wallet_after', v_after),
     v_after);

  select coalesce(nullif(btrim(pr.display_name), ''),
                  nullif(btrim(pr.alias), ''),
                  nullif(btrim(pr.username), ''), 'Your Agent')
    into v_name
    from profiles pr where pr.id = v_actor;

  insert into notifications (user_id, type, title, message, metadata, actor_id)
  values (v_req.player_id, 'settlement', 'Cash Out Approved',
          coalesce(v_name, 'Your Agent') || ' Approved Your Cash Out Of '
            || trim(to_char(v_req.amount, 'FM999,999,999,990')) || ' Chips',
          jsonb_build_object('clubId', v_req.club_id, 'cashoutId', p_cashout_id,
                             'amount', v_req.amount),
          v_actor);

  return jsonb_build_object('success', true, 'replayed', false,
    'cashout_id', p_cashout_id, 'amount', v_req.amount,
    'club_id', v_req.club_id,
    'player_id', v_req.player_id, 'agent_wallet_after', v_after);
end
$function$
;
REVOKE ALL ON FUNCTION public.fn_cashout_approve(uuid,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cashout_approve(uuid,text,uuid) TO authenticated, service_role;

DO $precondition$ BEGIN
 IF md5(pg_get_functiondef('public.fn_cashout_release(uuid,text,uuid)'::regprocedure)) <> '3e70a8d5fc7ea64851c0763894c3bc11' THEN
  RAISE EXCEPTION 'fn_cashout_release changed since inspection';
 END IF;
END $precondition$;
CREATE OR REPLACE FUNCTION public.fn_cashout_release(p_cashout_id uuid, p_note text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor     uuid := auth.uid();
  v_op_id     uuid := coalesce(p_op_id, gen_random_uuid());
  v_old_category text := current_setting('app.ledger_category', true);
  v_old_counterparty text := current_setting('app.ledger_counterparty', true);
  v_old_entity text := current_setting('app.ledger_counterparty_entity', true);
  v_old_key text := current_setting('app.ledger_idempotency_key', true);
  v_prior     record;
  v_req       record;
  v_escrow    record;
  v_is_player boolean;
  v_type      text;
  v_status    text;
  v_after     numeric;
  v_name      text;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  -- Serialize a caller's retries before consulting the committed receipt.
  perform pg_advisory_xact_lock(hashtextextended('cashout-op:' || v_actor::text || ':' || v_op_id::text, 0));

  select id, amount, related_cashout_id into v_prior
    from chip_transactions
   where transaction_type in ('cashout_denied', 'cashout_cancelled')
     and from_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    if v_prior.related_cashout_id is distinct from p_cashout_id then
      raise exception 'Operation ID belongs to a different cashout' using errcode = '22023';
    end if;
    return jsonb_build_object('success', true, 'replayed', true,
      'cashout_id', v_prior.related_cashout_id, 'amount', v_prior.amount);
  end if;

  select * into v_req from cashout_requests where id = p_cashout_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'That Cash Out Could Not Be Found');
  end if;
  if v_req.status <> 'pending' then
    return jsonb_build_object('success', false,
      'error', 'That Cash Out Has Already Been Dealt With',
      'current_status', v_req.status);
  end if;

  v_is_player := (v_req.player_id = v_actor);
  if not v_is_player
     and v_req.agent_id <> v_actor
     and not public.fn_club_cashier_can_transact(v_req.club_id, v_actor, v_req.player_id) then
    return jsonb_build_object('success', false,
      'error', 'That Cash Out Belongs To A Different Agent');
  end if;

  select * into v_escrow from chip_escrow where cashout_request_id = p_cashout_id for update;
  if not found or v_escrow.released_at is not null then
    return jsonb_build_object('success', false,
      'error', 'Those Chips Are Not Held In Escrow, So Nothing Can Be Returned');
  end if;

  if v_escrow.amount is distinct from v_req.amount then
    return jsonb_build_object('success', false,
      'error', 'That Cash Out Does Not Match The Chips Held For It');
  end if;

  v_type   := case when v_is_player then 'cashout_cancelled' else 'cashout_denied' end;
  v_status := case when v_is_player then 'cancelled' else 'rejected' end;

  perform public.fn_ca_declare_ledger('escrow_release', 'escrow', v_escrow.id, null,
    'cashout:' || p_cashout_id::text || ':release', null);

  update club_members
     set chip_balance = coalesce(chip_balance, 0) + v_escrow.amount,
         updated_at = now()
   where club_id = v_req.club_id and user_id = v_req.player_id
   returning chip_balance into v_after;
  if v_after is null then
    insert into club_members (club_id, user_id, role, chip_balance, status, is_active)
    values (v_req.club_id, v_req.player_id, 'player', v_escrow.amount, 'active', true)
    on conflict (club_id, user_id) do update
      set chip_balance = coalesce(club_members.chip_balance, 0) + excluded.chip_balance,
          updated_at = now()
    returning chip_balance into v_after;
  end if;

  perform set_config('app.ledger_category', coalesce(v_old_category, ''), true);
  perform set_config('app.ledger_counterparty', coalesce(v_old_counterparty, ''), true);
  perform set_config('app.ledger_counterparty_entity', coalesce(v_old_entity, ''), true);
  perform set_config('app.ledger_idempotency_key', coalesce(v_old_key, ''), true);

  update chip_escrow
     set released_at = now(),
         release_type = case when v_is_player then 'cancelled' else 'rejected' end
   where id = v_escrow.id;

  update cashout_requests
     set status = v_status,
         agent_note  = case when v_is_player then agent_note
                            else coalesce(nullif(btrim(p_note), ''), agent_note) end,
         player_note = case when v_is_player
                            then coalesce(nullif(btrim(p_note), ''), player_note)
                            else player_note end,
         cancelled_at = now(),
         updated_at = now()
   where id = p_cashout_id;

  insert into chip_transactions
      (club_id, from_user_id, to_user_id, amount, transaction_type, notes,
       related_cashout_id, metadata, balance_after)
    values
      (v_req.club_id, v_actor, v_req.player_id, v_escrow.amount, v_type,
       coalesce(nullif(btrim(p_note), ''), 'Cash Out Closed. Chips Returned From Escrow'),
       p_cashout_id,
       jsonb_build_object('op_id', v_op_id, 'closed_by', v_actor,
                          'player_balance_after', v_after),
       v_after);


  if not v_is_player then
    select coalesce(nullif(btrim(pr.display_name), ''),
                    nullif(btrim(pr.alias), ''),
                    nullif(btrim(pr.username), ''), 'Your Agent')
      into v_name
      from profiles pr where pr.id = v_actor;

    insert into notifications (user_id, type, title, message, metadata, actor_id)
    values (v_req.player_id, 'settlement', 'Cash Out Declined',
            coalesce(v_name, 'Your Agent') || ' Declined Your Cash Out. '
              || trim(to_char(v_escrow.amount, 'FM999,999,999,990')) || ' Chips Are Back In Your Wallet',
            jsonb_build_object('clubId', v_req.club_id, 'cashoutId', p_cashout_id,
                               'amount', v_escrow.amount),
            v_actor);

  elsif v_req.agent_id is not null then
    select coalesce(nullif(btrim(pr.display_name), ''),
                    nullif(btrim(pr.alias), ''),
                    nullif(btrim(pr.username), ''), 'A Player')
      into v_name
      from profiles pr where pr.id = v_req.player_id;

    insert into notifications (user_id, type, title, message, metadata, actor_id)
    values (v_req.agent_id, 'settlement', 'Cash Out Withdrawn',
            coalesce(v_name, 'A Player') || ' Withdrew A Cash Out Request For '
              || trim(to_char(v_escrow.amount, 'FM999,999,999,990')) || ' Chips',
            jsonb_build_object('clubId', v_req.club_id, 'cashoutId', p_cashout_id,
                               'amount', v_escrow.amount),
            v_req.player_id);
  end if;

  return jsonb_build_object('success', true, 'replayed', false,
    'cashout_id', p_cashout_id, 'amount', v_escrow.amount,
    'club_id', v_req.club_id,
    'player_id', v_req.player_id,
    'agent_id', v_req.agent_id,
    'cancelled_by_player', v_is_player,
    'player_balance_after', v_after);
end
$function$
;
REVOKE ALL ON FUNCTION public.fn_cashout_release(uuid,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cashout_release(uuid,text,uuid) TO authenticated, service_role;

COMMIT;
