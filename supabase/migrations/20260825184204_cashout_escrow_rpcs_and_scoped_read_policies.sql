-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825184204; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

drop policy if exists "cashout_insert" on public.cashout_requests;
drop policy if exists "cashout_update" on public.cashout_requests;
drop policy if exists "Users can read own cashout requests" on public.cashout_requests;
drop policy if exists "cashout_read_scoped" on public.cashout_requests;

create policy "cashout_read_scoped" on public.cashout_requests
  for select to authenticated
  using (
    player_id = (select auth.uid())
    or agent_id = (select auth.uid())
    or public.fn_club_bank_role(club_id) in ('owner', 'co_owner', 'admin')
    or public.fn_club_is_in_downline(club_id, (select auth.uid()), player_id)
  );

drop policy if exists "escrow_read_scoped" on public.chip_escrow;
create policy "escrow_read_scoped" on public.chip_escrow
  for select to authenticated
  using (
    player_id = (select auth.uid())
    or exists (
      select 1 from public.cashout_requests cr
       where cr.id = chip_escrow.cashout_request_id
         and (cr.agent_id = (select auth.uid())
              or public.fn_club_bank_role(cr.club_id) in ('owner', 'co_owner', 'admin'))
    )
  );

create or replace function public.fn_cashout_request(
  p_club_id uuid,
  p_amount numeric,
  p_note text default null,
  p_op_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor   uuid := auth.uid();
  v_op_id   uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior   record;
  v_agent   uuid;
  v_before  numeric;
  v_after   numeric;
  v_cashout uuid;
  v_name    text;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  select id, amount, related_cashout_id, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'cashout_request_escrow'
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object('success', true, 'replayed', true,
      'cashout_id', v_prior.related_cashout_id,
      'amount', v_prior.amount,
      'agent_id', v_prior.metadata ->> 'agent_id');
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
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

  update club_members
     set chip_balance = coalesce(chip_balance, 0) - p_amount,
         updated_at = now()
   where club_id = p_club_id and user_id = v_actor
   returning chip_balance into v_after;

  insert into cashout_requests (club_id, player_id, agent_id, amount, status, player_note)
  values (p_club_id, v_actor, v_agent, p_amount, 'pending', nullif(btrim(p_note), ''))
  returning id into v_cashout;

  insert into chip_escrow (cashout_request_id, player_id, amount, club_id, locked_at)
  values (v_cashout, v_actor, p_amount, p_club_id, now());

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
exception
  when unique_violation then
    return jsonb_build_object('success', false,
      'error', 'You Already Have A Cash Out Waiting. Wait For It Or Cancel It First');
end
$$;

comment on function public.fn_cashout_request(uuid, numeric, text, uuid) is
  'Player asks to cash out: debits their balance into escrow, opens the request, notifies the agent.';

create or replace function public.fn_cashout_approve(
  p_cashout_id uuid,
  p_note text default null,
  p_op_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor    uuid := auth.uid();
  v_op_id    uuid := coalesce(p_op_id, gen_random_uuid());
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

  select id, amount, related_cashout_id, metadata into v_prior
    from chip_transactions
   where transaction_type = 'cashout_approved'
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
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

  select a.id into v_agent_id
    from agents a
   where a.club_id = v_req.club_id and a.user_id = v_actor
   for update;
  if v_agent_id is null then
    insert into agents (user_id, club_id, role, status, agent_wallet_balance, promo_wallet_balance)
    values (v_actor, v_req.club_id, v_role, 'active', 0, 0)
    returning id into v_agent_id;
  end if;

  update agents
     set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + v_req.amount,
         updated_at = now()
   where id = v_agent_id
   returning agent_wallet_balance into v_after;

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
$$;

comment on function public.fn_cashout_approve(uuid, text, uuid) is
  'Agent accepts a cash out: releases escrow into the approvers agent wallet, writes the ledger row, notifies the player.';

create or replace function public.fn_cashout_release(
  p_cashout_id uuid,
  p_note text default null,
  p_op_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor     uuid := auth.uid();
  v_op_id     uuid := coalesce(p_op_id, gen_random_uuid());
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

  select id, amount, related_cashout_id into v_prior
    from chip_transactions
   where transaction_type in ('cashout_denied', 'cashout_cancelled')
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
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

  v_is_player := (v_req.player_id = v_actor);
  if not v_is_player
     and v_req.agent_id <> v_actor
     and not public.fn_club_cashier_can_transact(v_req.club_id, v_actor, v_req.player_id) then
    return jsonb_build_object('success', false,
      'error', 'That Cash Out Belongs To A Different Agent');
  end if;

  select * into v_escrow from chip_escrow where cashout_request_id = p_cashout_id for update;
  if v_escrow is null or v_escrow.released_at is not null then
    return jsonb_build_object('success', false,
      'error', 'Those Chips Are Not Held In Escrow, So Nothing Can Be Returned');
  end if;

  v_type   := case when v_is_player then 'cashout_cancelled' else 'cashout_denied' end;
  v_status := case when v_is_player then 'cancelled' else 'rejected' end;

  update club_members
     set chip_balance = coalesce(chip_balance, 0) + v_req.amount,
         updated_at = now()
   where club_id = v_req.club_id and user_id = v_req.player_id
   returning chip_balance into v_after;
  if v_after is null then
    insert into club_members (club_id, user_id, role, chip_balance, status, is_active)
    values (v_req.club_id, v_req.player_id, 'player', v_req.amount, 'active', true)
    on conflict (club_id, user_id) do update
      set chip_balance = coalesce(club_members.chip_balance, 0) + excluded.chip_balance,
          updated_at = now()
    returning chip_balance into v_after;
  end if;

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
    (v_req.club_id, v_actor, v_req.player_id, v_req.amount, v_type,
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
              || trim(to_char(v_req.amount, 'FM999,999,999,990')) || ' Chips Are Back In Your Wallet',
            jsonb_build_object('clubId', v_req.club_id, 'cashoutId', p_cashout_id,
                               'amount', v_req.amount),
            v_actor);
  end if;

  return jsonb_build_object('success', true, 'replayed', false,
    'cashout_id', p_cashout_id, 'amount', v_req.amount,
    'club_id', v_req.club_id,
    'player_id', v_req.player_id,
    'cancelled_by_player', v_is_player,
    'player_balance_after', v_after);
end
$$;

comment on function public.fn_cashout_release(uuid, text, uuid) is
  'Deny (agent or staff) or cancel (the player): escrow returns to the player wallet and the ledger says which it was.';

create or replace function public.fn_cashout_queue(
  p_club_id uuid default null,
  p_status text default 'pending'
) returns table (
  id uuid,
  club_id uuid,
  player_id uuid,
  player_name text,
  player_avatar text,
  agent_id uuid,
  amount numeric,
  status text,
  player_note text,
  agent_note text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select cr.id, cr.club_id, cr.player_id,
         coalesce(
           nullif(btrim(pr.display_name), ''),
           nullif(btrim(pr.alias), ''),
           nullif(btrim(pr.username), ''),
           'Player'
         )::text,
         coalesce(nullif(btrim(pr.arena_avatar_url), ''), nullif(btrim(pr.avatar_url), ''), '')::text,
         cr.agent_id, cr.amount, cr.status, cr.player_note, cr.agent_note, cr.created_at
    from cashout_requests cr
    left join profiles pr on pr.id = cr.player_id
   where auth.uid() is not null
     and (p_club_id is null or cr.club_id = p_club_id)
     and (p_status is null or cr.status = p_status)
     and (
       cr.agent_id = auth.uid()
       or public.fn_club_bank_role(cr.club_id) in ('owner', 'co_owner', 'admin')
       or public.fn_club_is_in_downline(cr.club_id, auth.uid(), cr.player_id)
     )
   order by cr.created_at desc
   limit 200;
$$;

comment on function public.fn_cashout_queue(uuid, text) is
  'Cash out requests the caller may act on: their own downline, or every request in a club they run.';

revoke all on function public.fn_cashout_request(uuid, numeric, text, uuid) from public, anon;
revoke all on function public.fn_cashout_approve(uuid, text, uuid) from public, anon;
revoke all on function public.fn_cashout_release(uuid, text, uuid) from public, anon;
revoke all on function public.fn_cashout_queue(uuid, text) from public, anon;
grant execute on function public.fn_cashout_request(uuid, numeric, text, uuid) to authenticated, service_role;
grant execute on function public.fn_cashout_approve(uuid, text, uuid) to authenticated, service_role;
grant execute on function public.fn_cashout_release(uuid, text, uuid) to authenticated, service_role;
grant execute on function public.fn_cashout_queue(uuid, text) to authenticated, service_role;
