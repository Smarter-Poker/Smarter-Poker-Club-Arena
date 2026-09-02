-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826045457; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

create or replace function public.fn_cashout_release(
  p_cashout_id uuid,
  p_note text default null::text,
  p_op_id uuid default null::uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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

  begin
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
  exception when unique_violation then
    select id, amount, related_cashout_id into v_prior
      from chip_transactions
     where transaction_type in ('cashout_denied', 'cashout_cancelled')
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    return jsonb_build_object('success', true, 'replayed', true,
      'cashout_id', v_prior.related_cashout_id, 'amount', v_prior.amount);
  end;

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
