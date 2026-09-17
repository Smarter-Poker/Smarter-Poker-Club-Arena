-- SOURCE ONLY / UNRUN. Exact retained catalog preimages; no customer data.

-- Load after full captured schema/access and supplemental baselines, before all 33 components.

CREATE TABLE public.chip_escrow (

 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "cashout_request_id" uuid NOT NULL,
 "player_id" uuid NOT NULL,
 "amount" numeric(15,2) NOT NULL,
 "locked_at" timestamp with time zone DEFAULT now(),
 "released_at" timestamp with time zone,
 "release_type" text,
 "club_id" uuid,
 "table_id" uuid

);

ALTER TABLE public.chip_escrow OWNER TO postgres;

ALTER TABLE public.chip_escrow ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.chip_escrow ADD CONSTRAINT "chip_escrow_cashout_request_id_fkey" FOREIGN KEY (cashout_request_id) REFERENCES cashout_requests(id) ON DELETE CASCADE;

ALTER TABLE public.chip_escrow ADD CONSTRAINT "chip_escrow_cashout_request_id_key" UNIQUE (cashout_request_id);

ALTER TABLE public.chip_escrow ADD CONSTRAINT "chip_escrow_pkey" PRIMARY KEY (id);

ALTER TABLE public.chip_escrow ADD CONSTRAINT "chip_escrow_player_id_fkey" FOREIGN KEY (player_id) REFERENCES auth.users(id);

ALTER TABLE public.chip_escrow ADD CONSTRAINT "chip_escrow_release_type_check" CHECK (release_type = ANY (ARRAY['completed'::text, 'cancelled'::text, 'rejected'::text, 'expired'::text]));

ALTER TABLE public.chip_escrow ADD CONSTRAINT "fk_chip_escrow_player_id_profiles" FOREIGN KEY (player_id) REFERENCES profiles(id) ON DELETE CASCADE;

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
$function$;

ALTER FUNCTION public.fn_cashout_approve(uuid,text,uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_cashout_approve(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_cashout_approve(uuid,text,uuid) TO authenticated,service_role;

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
$function$;

ALTER FUNCTION public.fn_cashout_release(uuid,text,uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_cashout_release(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_cashout_release(uuid,text,uuid) TO authenticated,service_role;

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
$function$;

ALTER FUNCTION public.fn_cashout_request(uuid,numeric,text,uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_cashout_request(uuid,numeric,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_cashout_request(uuid,numeric,text,uuid) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_ensure_agent_row(p_club_id uuid, p_user_id uuid, p_role text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_id    uuid;
  v_union uuid;
  v_min   numeric;
  v_role  text;
  v_staff boolean;
begin
  select a.id into v_id
    from agents a
   where a.club_id = p_club_id and a.user_id = p_user_id
   for update;
  if v_id is not null then
    return v_id;
  end if;

  -- agents.role CHECK still admits only the three agent tiers, so a staff
  -- wallet holder is stored as 'super_agent'. The data lies about who holds the
  -- wallet; club_members.role is the truth and every rule reads it. Recorded as
  -- P3 debt for phase 7, not fixed here, because relaxing that CHECK is a table
  -- lock on agents and this migration deliberately takes none.
  v_role := case when p_role in ('super_agent', 'agent', 'sub_agent') then p_role
                 else 'super_agent' end;

  v_staff := exists (
    select 1 from club_members cm
     where cm.club_id = p_club_id and cm.user_id = p_user_id
       and cm.role in ('co_owner', 'admin'));

  select coalesce(uc.union_id, c.union_id) into v_union
    from clubs c
    left join union_clubs uc on uc.club_id = c.id
   where c.id = p_club_id
   limit 1;

  -- A rate nobody chose is the bug phase 0 removed from the promotion path.
  -- Staff earn nothing by law, so minting them at the union minimum invented a
  -- commission AND tripped the band on the way back down to zero.
  v_min := case when v_staff then 0
                when v_union is null then 0
                else public.fn_union_setting(v_union, 'min_agent_commission', 0) end;

  -- Prepaid with no line: a wallet that appears because somebody was sent chips
  -- must not also arrive able to borrow. A credit line is granted deliberately,
  -- through the promotion screen or the agent panel, never as a side effect.
  insert into agents (user_id, club_id, role, status,
                      agent_wallet_balance, promo_wallet_balance,
                      commission_rate, player_rakeback_rate,
                      credit_limit, credit_used, is_prepaid)
  values (p_user_id, p_club_id, v_role, 'active', 0, 0, v_min, 0, 0, 0, true)
  on conflict (user_id, club_id) do nothing;

  select a.id into v_id
    from agents a
   where a.club_id = p_club_id and a.user_id = p_user_id
   for update;
  return v_id;
end
$function$;

ALTER FUNCTION public.fn_ensure_agent_row(uuid,uuid,text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_ensure_agent_row(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_ensure_agent_row(uuid,uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_expire_stale_cashouts(p_ttl_hours integer DEFAULT 72)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_expired integer := 0;
  r         record;
  v_escrow  record;
  v_after   numeric;
begin
  for r in
    select id, club_id, player_id, amount
      from public.cashout_requests
     where status = 'pending'
       and created_at < now() - make_interval(hours => p_ttl_hours)
     for update
  loop
    select * into v_escrow
      from public.chip_escrow
     where cashout_request_id = r.id
     for update;

    if not found or v_escrow.released_at is not null then
      update public.cashout_requests
         set status = 'expired', updated_at = now()
       where id = r.id;
      continue;
    end if;

    update public.club_members
       set chip_balance = coalesce(chip_balance, 0) + v_escrow.amount,
           updated_at   = now()
     where club_id = r.club_id and user_id = r.player_id
     returning chip_balance into v_after;
    if v_after is null then
      insert into public.club_members (club_id, user_id, role, chip_balance, status, is_active)
      values (r.club_id, r.player_id, 'player', v_escrow.amount, 'active', true)
      on conflict (club_id, user_id) do update
        set chip_balance = coalesce(club_members.chip_balance, 0) + excluded.chip_balance,
            updated_at = now()
      returning chip_balance into v_after;
    end if;

    update public.chip_escrow
       set released_at  = now(),
           release_type = 'expired'
     where id = v_escrow.id;

    update public.cashout_requests
       set status     = 'expired',
           updated_at = now(),
           agent_note = coalesce(agent_note, '')
                        || ' [Auto Expired After ' || p_ttl_hours::text || 'h. Escrow Refunded]'
     where id = r.id;

    insert into public.chip_transactions (
      id, club_id, from_user_id, to_user_id, amount,
      transaction_type, notes, related_cashout_id, metadata, balance_after, created_at
    ) values (
      gen_random_uuid(), r.club_id, null, r.player_id, v_escrow.amount,
      'cashout_expired_refund',
      'Cash Out Expired After ' || p_ttl_hours::text || 'h. Escrowed Chips Returned To Player',
      r.id,
      jsonb_build_object('op_id', v_escrow.id, 'expired_after_hours', p_ttl_hours),
      v_after,
      now()
    );

    insert into public.notifications (user_id, type, title, message, metadata)
    values (r.player_id, 'settlement', 'Cash Out Expired',
            'Your Cash Out Request Expired And '
              || trim(to_char(v_escrow.amount, 'FM999,999,999,990'))
              || ' Chips Are Back In Your Wallet',
            jsonb_build_object('clubId', r.club_id, 'cashoutId', r.id,
                               'amount', v_escrow.amount));

    v_expired := v_expired + 1;
  end loop;

  return v_expired;
end;
$function$;

ALTER FUNCTION public.fn_expire_stale_cashouts(integer) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_expire_stale_cashouts(integer) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_expire_stale_cashouts(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_guard_retired_club_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_club_id uuid;
  v_old_club_id uuid;
  v_maintenance boolean :=
    auth.uid() IS NULL
    AND coalesce(current_setting('app.club_retirement_maintenance', true), '') = 'on';
BEGIN
  IF v_maintenance THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'unions' THEN
      v_club_id := OLD.id;
    ELSIF TG_TABLE_NAME = 'table_seats' THEN
      SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = OLD.table_id;
    ELSIF TG_TABLE_NAME IN ('tournament_players', 'tournament_escrow') THEN
      SELECT t.club_id INTO v_club_id FROM public.tournaments t
       WHERE t.id = OLD.tournament_id;
    ELSIF TG_TABLE_NAME = 'chip_escrow' THEN
      SELECT cr.club_id INTO v_club_id FROM public.cashout_requests cr
       WHERE cr.id = OLD.cashout_request_id;
    ELSIF TG_TABLE_NAME = 'credit_invoices' THEN
      SELECT a.club_id INTO v_club_id FROM public.agents a WHERE a.id = OLD.agent_id;
    ELSE
      v_club_id := OLD.club_id;
    END IF;
  ELSE
    IF TG_TABLE_NAME = 'unions' THEN
      v_club_id := NEW.id;
    ELSIF TG_TABLE_NAME = 'table_seats' THEN
      SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = NEW.table_id;
    ELSIF TG_TABLE_NAME IN ('tournament_players', 'tournament_escrow') THEN
      SELECT t.club_id INTO v_club_id FROM public.tournaments t
       WHERE t.id = NEW.tournament_id;
    ELSIF TG_TABLE_NAME = 'chip_escrow' THEN
      SELECT cr.club_id INTO v_club_id FROM public.cashout_requests cr
       WHERE cr.id = NEW.cashout_request_id;
    ELSIF TG_TABLE_NAME = 'credit_invoices' THEN
      SELECT a.club_id INTO v_club_id FROM public.agents a WHERE a.id = NEW.agent_id;
    ELSE
      v_club_id := NEW.club_id;
    END IF;

    -- On UPDATE, check the source scope too. Moving a retained row to an active
    -- club must not become an escape hatch from a retired club's write freeze.
    IF TG_OP = 'UPDATE' THEN
      IF TG_TABLE_NAME = 'unions' THEN
        v_old_club_id := OLD.id;
      ELSIF TG_TABLE_NAME = 'table_seats' THEN
        SELECT t.club_id INTO v_old_club_id FROM public.tables t WHERE t.id = OLD.table_id;
      ELSIF TG_TABLE_NAME IN ('tournament_players', 'tournament_escrow') THEN
        SELECT t.club_id INTO v_old_club_id FROM public.tournaments t
         WHERE t.id = OLD.tournament_id;
      ELSIF TG_TABLE_NAME = 'chip_escrow' THEN
        SELECT cr.club_id INTO v_old_club_id FROM public.cashout_requests cr
         WHERE cr.id = OLD.cashout_request_id;
      ELSIF TG_TABLE_NAME = 'credit_invoices' THEN
        SELECT a.club_id INTO v_old_club_id FROM public.agents a WHERE a.id = OLD.agent_id;
      ELSE
        v_old_club_id := OLD.club_id;
      END IF;
    END IF;
  END IF;

  -- A union row can use a club UUID without an FK back to clubs. Serialize
  -- that conversion with the retirement RPC so it cannot create a union
  -- identity from a club that became retired in the same instant.
  IF TG_TABLE_NAME = 'unions' AND v_club_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('cashier-hierarchy:' || v_club_id::text, 0)
    );
  END IF;

  IF (v_club_id IS NOT NULL OR v_old_club_id IS NOT NULL) AND EXISTS (
    SELECT 1 FROM public.clubs c
     WHERE c.id IN (v_club_id, v_old_club_id) AND c.lifecycle_status = 'retired'
  ) THEN
    RAISE EXCEPTION 'CLUB_RETIRED: gameplay and cashier records are read-only'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.fn_guard_retired_club_mutation() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_guard_retired_club_mutation() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_guard_retired_club_mutation() TO service_role;

CREATE OR REPLACE FUNCTION public.fn_notify_agent_on_cashout()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_player_name TEXT;
    v_club_name TEXT;
BEGIN
    -- Get player name
    SELECT display_name INTO v_player_name
    FROM profiles
    WHERE id = NEW.player_id;

    -- Get club name
    SELECT name INTO v_club_name
    FROM clubs
    WHERE id = NEW.club_id;

    -- Create notification for agent
    INSERT INTO notifications (user_id, type, title, message, data, created_at)
    VALUES (
        NEW.agent_id,
        'cashout_request',
        'Cashout Request',
        v_player_name || ' requested a cashout of ' || NEW.amount || ' chips in ' || v_club_name,
        jsonb_build_object(
            'cashout_id', NEW.id,
            'player_id', NEW.player_id,
            'club_id', NEW.club_id,
            'amount', NEW.amount
        ),
        NOW()
    );

    -- Create a club message notification for agent
    INSERT INTO messages (
        conversation_id,
        sender_id,
        receiver_id,
        content,
        is_read,
        created_at
    )
    SELECT 
        c.id,
        NEW.player_id,
        NEW.agent_id,
        'Cashout Request: ' || NEW.amount || ' Chips. Please Review In Your Agent Dashboard.',
        FALSE,
        NOW()
    FROM conversations c
    WHERE c.participant_ids @> ARRAY[NEW.player_id, NEW.agent_id]
      AND c.club_id = NEW.club_id
      AND c.category = 'club'
    LIMIT 1;

    RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_notify_agent_on_cashout() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_notify_agent_on_cashout() FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.fn_notify_agent_on_cashout() TO service_role;

CREATE POLICY "chip_escrow_service_only" ON public.chip_escrow AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);

CREATE POLICY "escrow_read" ON public.chip_escrow AS PERMISSIVE FOR SELECT TO PUBLIC USING ((player_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY "escrow_read_scoped" ON public.chip_escrow AS PERMISSIVE FOR SELECT TO "authenticated" USING (((player_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM cashout_requests cr
  WHERE ((cr.id = chip_escrow.cashout_request_id) AND ((cr.agent_id = ( SELECT auth.uid() AS uid)) OR (fn_club_bank_role(cr.club_id) = ANY (ARRAY['owner'::text, 'co_owner'::text, 'admin'::text]))))))));

REVOKE ALL ON public.chip_escrow FROM PUBLIC,anon,authenticated,service_role;

GRANT SELECT,REFERENCES,TRIGGER ON public.chip_escrow TO anon,authenticated;

GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN ON public.chip_escrow TO service_role;

DROP TRIGGER IF EXISTS tr_notify_agent_on_cashout ON public.cashout_requests;

CREATE TRIGGER tr_notify_agent_on_cashout AFTER INSERT ON cashout_requests FOR EACH ROW WHEN (new.status = 'pending'::text) EXECUTE FUNCTION fn_notify_agent_on_cashout();

CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON chip_escrow FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation();

-- Retained actual legacy route writer captured 2026-09-15 04:46:07.43764+00
CREATE OR REPLACE FUNCTION public.fn_approve_cashout_atomic(p_cashout_id uuid, p_agent_id uuid, p_agent_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_cashout record;
  v_escrow  record;
  v_role    text;
  v_agent_row uuid;
  v_after   numeric;
BEGIN
  SELECT * INTO v_cashout FROM cashout_requests WHERE id = p_cashout_id FOR UPDATE;
  IF v_cashout IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'cashout not found');
  END IF;

  IF v_cashout.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'cashout not in pending status',
                              'current_status', v_cashout.status);
  END IF;

  SELECT role INTO v_role
    FROM club_members
   WHERE club_id = v_cashout.club_id
     AND user_id = p_agent_id
     AND role IN ('agent','sub_agent','super_agent','owner','co_owner','admin');
  IF v_role IS NULL AND EXISTS (
       SELECT 1 FROM clubs WHERE id = v_cashout.club_id AND owner_id = p_agent_id) THEN
    v_role := 'owner';
  END IF;
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to approve for this club');
  END IF;

  -- Release the hold if there is one. A request created before 2026-08-25 has
  -- no chip_escrow row (see fn_request_cashout above) but its chips were still
  -- debited, so a missing hold is legacy rather than fraud; an ALREADY RELEASED
  -- hold is neither, and must stop here.
  SELECT * INTO v_escrow FROM chip_escrow WHERE cashout_request_id = p_cashout_id FOR UPDATE;
  IF v_escrow.id IS NOT NULL AND v_escrow.released_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'those chips have already been released');
  END IF;

  -- THE AGENT WALLET, not the approver's playing balance. This used to credit
  -- club_members.chip_balance, which is the approver's PLAYER wallet: an agent
  -- who accepted a cash out found the chips in the account they buy in from.
  SELECT id INTO v_agent_row
    FROM agents WHERE club_id = v_cashout.club_id AND user_id = p_agent_id FOR UPDATE;
  IF v_agent_row IS NULL THEN
    INSERT INTO agents (user_id, club_id, role, status, agent_wallet_balance, promo_wallet_balance)
    VALUES (p_agent_id, v_cashout.club_id, v_role, 'active', 0, 0)
    RETURNING id INTO v_agent_row;
  END IF;

  UPDATE agents
     SET agent_wallet_balance = COALESCE(agent_wallet_balance, 0) + v_cashout.amount,
         updated_at = NOW()
   WHERE id = v_agent_row
  RETURNING agent_wallet_balance INTO v_after;

  IF v_escrow.id IS NOT NULL THEN
    UPDATE chip_escrow SET released_at = NOW(), release_type = 'completed' WHERE id = v_escrow.id;
  END IF;

  UPDATE cashout_requests
     SET status = 'approved',
         agent_note = COALESCE(p_agent_note, agent_note),
         updated_at = NOW(),
         acknowledged_at = NOW(),
         completed_at = NOW()
   WHERE id = p_cashout_id;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, related_cashout_id, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), v_cashout.club_id, v_cashout.player_id, p_agent_id, v_cashout.amount,
    'cashout_approved',
    COALESCE(p_agent_note, 'Cash Out Approved. Escrow Released Into The Agent Wallet'),
    p_cashout_id, v_after, NOW()
  );

  INSERT INTO notifications (user_id, type, title, message, metadata, actor_id)
  VALUES (v_cashout.player_id, 'settlement', 'Cash Out Approved',
          'Your Cash Out Of ' || trim(to_char(v_cashout.amount, 'FM999,999,999,990'))
            || ' Chips Was Approved',
          jsonb_build_object('clubId', v_cashout.club_id, 'cashoutId', p_cashout_id,
                             'amount', v_cashout.amount),
          p_agent_id);

  RETURN jsonb_build_object('success', true, 'cashout_id', p_cashout_id,
                            'amount', v_cashout.amount, 'agent_wallet_after', v_after);
END;
$function$;
ALTER FUNCTION public.fn_approve_cashout_atomic(uuid,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_approve_cashout_atomic(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_approve_cashout_atomic(uuid,uuid,text) TO service_role;

-- Retained actual legacy route writer captured 2026-09-15 04:46:07.43764+00
CREATE OR REPLACE FUNCTION public.fn_cancel_cashout_atomic(p_cashout_id uuid, p_user_id uuid, p_is_agent boolean DEFAULT false, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_cashout record;
  v_escrow  record;
  v_new_balance numeric;
BEGIN
  SELECT * INTO v_cashout FROM cashout_requests WHERE id = p_cashout_id FOR UPDATE;

  IF v_cashout IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'cashout not found');
  END IF;

  IF v_cashout.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'cashout not in pending status',
                              'current_status', v_cashout.status);
  END IF;

  IF p_is_agent THEN
    IF NOT EXISTS (
      SELECT 1 FROM club_members
      WHERE club_id = v_cashout.club_id
        AND user_id = p_user_id
        AND role IN ('agent', 'sub_agent', 'super_agent', 'owner', 'co_owner', 'admin')
    ) AND NOT EXISTS (
      SELECT 1 FROM clubs WHERE id = v_cashout.club_id AND owner_id = p_user_id
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'not authorized to cancel for this club');
    END IF;
  ELSE
    IF v_cashout.player_id <> p_user_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'only the requester can self-cancel');
    END IF;
  END IF;

  SELECT * INTO v_escrow FROM chip_escrow WHERE cashout_request_id = p_cashout_id FOR UPDATE;
  IF v_escrow.id IS NOT NULL AND v_escrow.released_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'those chips have already been released');
  END IF;

  UPDATE club_members
  SET chip_balance = COALESCE(chip_balance, 0) + v_cashout.amount,
      updated_at = NOW()
  WHERE club_id = v_cashout.club_id AND user_id = v_cashout.player_id
  RETURNING chip_balance INTO v_new_balance;

  IF v_new_balance IS NULL THEN
    INSERT INTO club_members (club_id, user_id, role, chip_balance, joined_at, created_at, updated_at, status, is_active)
    VALUES (v_cashout.club_id, v_cashout.player_id, 'player', v_cashout.amount, NOW(), NOW(), NOW(), 'active', true)
    ON CONFLICT (club_id, user_id) DO UPDATE
      SET chip_balance = COALESCE(club_members.chip_balance, 0) + EXCLUDED.chip_balance,
          updated_at = NOW()
    RETURNING chip_balance INTO v_new_balance;
  END IF;

  IF v_escrow.id IS NOT NULL THEN
    UPDATE chip_escrow
       SET released_at = NOW(),
           release_type = CASE WHEN p_is_agent THEN 'rejected' ELSE 'cancelled' END
     WHERE id = v_escrow.id;
  END IF;

  UPDATE cashout_requests
  SET status = CASE WHEN p_is_agent THEN 'rejected' ELSE 'cancelled' END,
      agent_note = CASE WHEN p_is_agent THEN COALESCE(p_note, agent_note) ELSE agent_note END,
      player_note = CASE WHEN NOT p_is_agent THEN COALESCE(p_note, player_note) ELSE player_note END,
      cancelled_at = NOW(),
      updated_at = NOW()
  WHERE id = p_cashout_id;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, related_cashout_id, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), v_cashout.club_id, p_user_id, v_cashout.player_id, v_cashout.amount,
    CASE WHEN p_is_agent THEN 'cashout_denied' ELSE 'cashout_cancelled' END,
    COALESCE(p_note, 'Cash Out Closed. Chips Returned From Escrow'),
    p_cashout_id, v_new_balance, NOW()
  );

  IF p_is_agent THEN
    INSERT INTO notifications (user_id, type, title, message, metadata, actor_id)
    VALUES (v_cashout.player_id, 'settlement', 'Cash Out Declined',
            'Your Cash Out Of ' || trim(to_char(v_cashout.amount, 'FM999,999,999,990'))
              || ' Chips Was Declined And The Chips Are Back In Your Wallet',
            jsonb_build_object('clubId', v_cashout.club_id, 'cashoutId', p_cashout_id,
                               'amount', v_cashout.amount),
            p_user_id);
  END IF;

  RETURN jsonb_build_object('success', true, 'cashout_id', p_cashout_id,
                            'amount', v_cashout.amount, 'new_balance', v_new_balance);
END;
$function$;
ALTER FUNCTION public.fn_cancel_cashout_atomic(uuid,uuid,boolean,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_cancel_cashout_atomic(uuid,uuid,boolean,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_cancel_cashout_atomic(uuid,uuid,boolean,text) TO service_role;

-- Retained actual legacy route writer captured 2026-09-15 04:46:07.43764+00
CREATE OR REPLACE FUNCTION public.fn_cancel_cashout(p_cashout_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_cashout RECORD;
BEGIN
  -- Atomically claim the cashout (only if still pending)
  UPDATE cashout_requests SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
  WHERE id = p_cashout_id AND player_id = p_user_id AND status = 'pending'
  RETURNING * INTO v_cashout;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cashout Not Found Or Already Processed');
  END IF;
  -- Return chips to player wallet
  UPDATE wallets SET balance = balance + v_cashout.amount, updated_at = NOW()
  WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
  INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description)
  VALUES (p_user_id, 'PLAYER', 'credit', v_cashout.amount, 'cashout_cancel', 'Cashout Cancelled - Chips Returned');
  RETURN jsonb_build_object('success', true, 'amount', v_cashout.amount);
END; $function$;
ALTER FUNCTION public.fn_cancel_cashout(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_cancel_cashout(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_cancel_cashout(uuid,uuid) TO service_role;

-- Retained actual legacy route writer captured 2026-09-15 04:46:07.43764+00
CREATE OR REPLACE FUNCTION public.fn_request_cashout(p_player_id uuid, p_club_id uuid, p_amount numeric, p_note text DEFAULT NULL::text, p_agent_id uuid DEFAULT NULL::uuid, p_type text DEFAULT 'request'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_cashout_id uuid;
  v_resolved_agent_id uuid;
  v_player_balance numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'cashout amount must be > 0';
  END IF;

  v_resolved_agent_id := p_agent_id;
  IF v_resolved_agent_id IS NULL THEN
    SELECT agent_id INTO v_resolved_agent_id
    FROM club_members
    WHERE club_id = p_club_id AND user_id = p_player_id;
  END IF;

  IF v_resolved_agent_id IS NULL THEN
    SELECT owner_id INTO v_resolved_agent_id FROM clubs WHERE id = p_club_id;
  END IF;

  IF v_resolved_agent_id IS NULL THEN
    SELECT user_id INTO v_resolved_agent_id
    FROM club_members
    WHERE club_id = p_club_id AND role IN ('owner', 'co_owner', 'admin', 'super_agent', 'agent')
    ORDER BY CASE role
      WHEN 'owner' THEN 1 WHEN 'co_owner' THEN 2 WHEN 'admin' THEN 3
      WHEN 'super_agent' THEN 4 ELSE 5 END
    LIMIT 1;
  END IF;

  IF v_resolved_agent_id IS NULL THEN
    RAISE EXCEPTION 'no agent/owner available to approve cashout in club %', p_club_id;
  END IF;

  SELECT chip_balance INTO v_player_balance
  FROM club_members
  WHERE club_id = p_club_id AND user_id = p_player_id FOR UPDATE;

  IF v_player_balance IS NULL THEN
    RAISE EXCEPTION 'player is not a member of this club';
  END IF;

  IF v_player_balance < p_amount THEN
    RAISE EXCEPTION 'insufficient chips: have %, requested %', v_player_balance, p_amount;
  END IF;

  UPDATE club_members
  SET chip_balance = COALESCE(chip_balance, 0) - p_amount,
      updated_at = NOW()
  WHERE club_id = p_club_id AND user_id = p_player_id;

  INSERT INTO cashout_requests (
    id, club_id, player_id, agent_id, amount,
    status, player_note, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_player_id, v_resolved_agent_id, p_amount,
    'pending', p_note, NOW(), NOW()
  ) RETURNING id INTO v_cashout_id;

  -- THE ESCROW ROW WAS MISSING (2026-08-25). This function debited the player
  -- and opened the request but never wrote the hold, so chip_escrow was empty
  -- for every request the World Hub route created and "held in escrow" was a
  -- sentence in the UI rather than a row anywhere. fn_cashout_approve REQUIRES
  -- the hold before it will release anything, so without this the two doors
  -- into the same flow produced incompatible state.
  INSERT INTO chip_escrow (cashout_request_id, player_id, amount, club_id, locked_at)
  VALUES (v_cashout_id, p_player_id, p_amount, p_club_id, NOW())
  ON CONFLICT (cashout_request_id) DO NOTHING;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, related_cashout_id, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_player_id, v_resolved_agent_id, p_amount,
    'cashout_request_escrow', COALESCE(p_note, 'Cash Out Requested. Chips Held In Escrow'),
    v_cashout_id, v_player_balance - p_amount, NOW()
  );

  RETURN v_cashout_id;
END;
$function$;
ALTER FUNCTION public.fn_request_cashout(uuid,uuid,numeric,text,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_request_cashout(uuid,uuid,numeric,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_request_cashout(uuid,uuid,numeric,text,uuid,text) TO service_role;
