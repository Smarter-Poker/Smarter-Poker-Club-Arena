-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825184056; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

create or replace function public.fn_agent_wallet_send(
  p_club_id uuid,
  p_to_user_id uuid,
  p_amount numeric,
  p_destination text default 'player_wallet',
  p_reason text default null,
  p_op_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_dest         text := lower(coalesce(p_destination, 'player_wallet'));
  v_op_id        uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior        record;
  v_agent_id     uuid;
  v_float_before numeric;
  v_float_after  numeric;
  v_to_role      text;
  v_to_agent_id  uuid;
  v_to_after     numeric;
  v_tx_id        uuid;
  v_until        timestamptz;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'agent_wallet_send'
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric);
  end if;

  v_actor_role := public.fn_club_bank_role(p_club_id);
  if v_actor_role is null
     or v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only Staff Or Agents Hold An Agent Wallet');
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
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
    return jsonb_build_object('success', false,
      'error', 'You Cannot Send Chips To Yourself');
  end if;

  if not public.fn_club_cashier_can_transact(p_club_id, v_actor, p_to_user_id) then
    return jsonb_build_object('success', false,
      'error', 'That Member Is Not In Your Downline');
  end if;

  select cm.role into v_to_role
    from club_members cm
   where cm.club_id = p_club_id
     and cm.user_id = p_to_user_id
     and coalesce(cm.status, 'active') in ('active', 'approved')
   for update;
  if v_to_role is null then
    return jsonb_build_object('success', false,
      'error', 'Recipient Is Not An Active Member Of This Club');
  end if;
  if v_dest = 'agent_wallet'
     and v_to_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only Staff Or Agents Hold An Agent Wallet');
  end if;

  select a.id, coalesce(a.agent_wallet_balance, 0)
    into v_agent_id, v_float_before
    from agents a
   where a.club_id = p_club_id and a.user_id = v_actor
   for update;
  if v_agent_id is null then
    return jsonb_build_object('success', false,
      'error', 'Your Agent Wallet Has Not Been Funded Yet');
  end if;
  if v_float_before < p_amount then
    return jsonb_build_object('success', false,
      'error', 'Your Agent Wallet Only Holds '
               || trim(to_char(v_float_before, 'FM999,999,999,990.00')) || ' Chips',
      'balance', v_float_before, 'requested', p_amount);
  end if;

  update agents
     set agent_wallet_balance = coalesce(agent_wallet_balance, 0) - p_amount,
         updated_at = now()
   where id = v_agent_id
   returning agent_wallet_balance into v_float_after;

  if v_dest = 'player_wallet' then
    update club_members
       set chip_balance = coalesce(chip_balance, 0) + p_amount,
           updated_at = now()
     where club_id = p_club_id and user_id = p_to_user_id
     returning chip_balance into v_to_after;
  else
    select a.id into v_to_agent_id
      from agents a
     where a.club_id = p_club_id and a.user_id = p_to_user_id
     for update;
    if v_to_agent_id is null then
      insert into agents (user_id, club_id, role, status, agent_wallet_balance, promo_wallet_balance)
      values (p_to_user_id, p_club_id, v_to_role, 'active', 0, 0)
      returning id into v_to_agent_id;
    end if;
    update agents
       set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + p_amount,
           updated_at = now()
     where id = v_to_agent_id
     returning agent_wallet_balance into v_to_after;
  end if;

  v_until := now() + interval '10 minutes';

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata,
     balance_after, reversible_until)
  values
    (p_club_id, v_actor, p_to_user_id, p_amount, 'agent_wallet_send',
     coalesce(nullif(btrim(p_reason), ''), 'Agent Wallet Send'),
     jsonb_build_object(
       'op_id', v_op_id,
       'destination', v_dest,
       'actor_role', v_actor_role,
       'recipient_role', v_to_role,
       'agent_wallet_before', v_float_before,
       'agent_wallet_after', v_float_after,
       'recipient_balance_after', v_to_after,
       'claimed_back', 0,
       'clawback_window_minutes', 10),
     v_float_after, v_until)
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true, 'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', p_amount,
    'destination', v_dest,
    'agent_wallet_before', v_float_before,
    'agent_wallet_after', v_float_after,
    'recipient_balance_after', v_to_after,
    'reversible_until', v_until);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from chip_transactions
     where club_id = p_club_id
       and transaction_type = 'agent_wallet_send'
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric);
end
$$;

comment on function public.fn_agent_wallet_send(uuid, uuid, numeric, text, text, uuid) is
  'Agent wallet send: debits agents.agent_wallet_balance, credits the downline recipient, writes the ledger row, ten minute clawback window.';

create or replace function public.fn_agent_wallet_claim_back(
  p_club_id uuid,
  p_transaction_id uuid,
  p_amount numeric default null,
  p_reason text default null,
  p_op_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor        uuid := auth.uid();
  v_op_id        uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior        record;
  v_src          record;
  v_claimed      numeric;
  v_remaining    numeric;
  v_take         numeric;
  v_dest         text;
  v_held         numeric;
  v_agent_id     uuid;
  v_float_after  numeric;
  v_holder_after numeric;
  v_tx_id        uuid;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'agent_wallet_claim_back'
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric);
  end if;

  select * into v_src
    from chip_transactions
   where id = p_transaction_id
     and club_id = p_club_id
   for update;
  if v_src is null then
    return jsonb_build_object('success', false, 'error', 'That Send Could Not Be Found');
  end if;
  if v_src.transaction_type <> 'agent_wallet_send' then
    return jsonb_build_object('success', false,
      'error', 'Only An Agent Wallet Send Can Be Claimed Back This Way');
  end if;
  if v_src.from_user_id is distinct from v_actor then
    return jsonb_build_object('success', false,
      'error', 'You Can Only Claim Back Chips You Sent Yourself');
  end if;
  if coalesce(v_src.is_reversed, false) then
    return jsonb_build_object('success', false,
      'error', 'That Send Has Already Been Claimed Back');
  end if;

  if v_src.reversible_until is null or now() > v_src.reversible_until then
    return jsonb_build_object('success', false,
      'error', 'The Ten Minute Window To Claim These Chips Back Has Closed. '
               || 'The Player Must Request A Cash Out Instead');
  end if;

  v_claimed   := coalesce((v_src.metadata ->> 'claimed_back')::numeric, 0);
  v_remaining := v_src.amount - v_claimed;
  if v_remaining <= 0 then
    return jsonb_build_object('success', false,
      'error', 'That Send Has Already Been Claimed Back');
  end if;

  v_take := coalesce(p_amount, v_remaining);
  if v_take <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;
  if v_take > v_remaining then
    return jsonb_build_object('success', false,
      'error', 'Only ' || trim(to_char(v_remaining, 'FM999,999,999,990.00'))
               || ' Chips Of That Send Are Left To Claim Back',
      'remaining', v_remaining, 'requested', v_take);
  end if;

  v_dest := coalesce(v_src.metadata ->> 'destination', 'player_wallet');

  if v_dest = 'player_wallet' then
    select coalesce(chip_balance, 0) into v_held
      from club_members
     where club_id = p_club_id and user_id = v_src.to_user_id
     for update;
  else
    select a.id, coalesce(a.agent_wallet_balance, 0) into v_agent_id, v_held
      from agents a
     where a.club_id = p_club_id and a.user_id = v_src.to_user_id
     for update;
  end if;

  if v_held is null then
    return jsonb_build_object('success', false,
      'error', 'That Wallet Could Not Be Read, So Nothing Was Moved');
  end if;
  if v_held < v_take then
    return jsonb_build_object('success', false,
      'error', 'Those Chips Have Already Been Spent. That Wallet Only Holds '
               || trim(to_char(v_held, 'FM999,999,999,990.00')) || ' Chips',
      'held', v_held, 'requested', v_take);
  end if;

  if v_dest = 'player_wallet' then
    update club_members
       set chip_balance = coalesce(chip_balance, 0) - v_take,
           updated_at = now()
     where club_id = p_club_id and user_id = v_src.to_user_id
     returning chip_balance into v_holder_after;
  else
    update agents
       set agent_wallet_balance = coalesce(agent_wallet_balance, 0) - v_take,
           updated_at = now()
     where id = v_agent_id
     returning agent_wallet_balance into v_holder_after;
  end if;

  update agents
     set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + v_take,
         updated_at = now()
   where club_id = p_club_id and user_id = v_actor
   returning agent_wallet_balance into v_float_after;
  if v_float_after is null then
    raise exception 'agent wallet row vanished for % in club %', v_actor, p_club_id;
  end if;

  update chip_transactions
     set metadata = coalesce(metadata, '{}'::jsonb)
                    || jsonb_build_object('claimed_back', v_claimed + v_take),
         is_reversed = ((v_claimed + v_take) >= v_src.amount),
         clawed_back = ((v_claimed + v_take) >= v_src.amount)
   where id = v_src.id;

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  values
    (p_club_id, v_src.to_user_id, v_actor, v_take, 'agent_wallet_claim_back',
     coalesce(nullif(btrim(p_reason), ''), 'Agent Wallet Claim Back Inside The Ten Minute Window'),
     jsonb_build_object(
       'op_id', v_op_id,
       'source', v_dest,
       'original_transaction_id', v_src.id,
       'holder_balance_after', v_holder_after,
       'agent_wallet_after', v_float_after),
     v_float_after)
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true, 'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', v_take,
    'source', v_dest,
    'holder_balance_after', v_holder_after,
    'agent_wallet_after', v_float_after);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from chip_transactions
     where club_id = p_club_id
       and transaction_type = 'agent_wallet_claim_back'
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric);
end
$$;

comment on function public.fn_agent_wallet_claim_back(uuid, uuid, numeric, text, uuid) is
  'The ten minute mistake eraser: claim back chips YOU sent from your agent wallet, only while the originating row is still reversible.';

create or replace function public.fn_agent_wallet_reversible(p_club_id uuid)
returns table (
  transaction_id uuid,
  to_user_id uuid,
  to_name text,
  amount numeric,
  claimed_back numeric,
  remaining numeric,
  destination text,
  created_at timestamptz,
  reversible_until timestamptz,
  seconds_left int
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select t.id,
         t.to_user_id,
         coalesce(
           nullif(btrim(pr.display_name), ''),
           nullif(btrim(pr.alias), ''),
           nullif(btrim(pr.username), ''),
           'Member'
         )::text,
         t.amount,
         coalesce((t.metadata ->> 'claimed_back')::numeric, 0),
         t.amount - coalesce((t.metadata ->> 'claimed_back')::numeric, 0),
         coalesce(t.metadata ->> 'destination', 'player_wallet'),
         t.created_at,
         t.reversible_until,
         greatest(0, ceil(extract(epoch from (t.reversible_until - now()))))::int
    from chip_transactions t
    left join profiles pr on pr.id = t.to_user_id
   where t.club_id = p_club_id
     and t.transaction_type = 'agent_wallet_send'
     and t.from_user_id = auth.uid()
     and coalesce(t.is_reversed, false) = false
     and t.reversible_until is not null
     and t.reversible_until > now()
     and t.amount - coalesce((t.metadata ->> 'claimed_back')::numeric, 0) > 0
   order by t.created_at desc
   limit 50;
$$;

comment on function public.fn_agent_wallet_reversible(uuid) is
  'The callers own agent wallet sends still inside their ten minute clawback window.';

create or replace function public.fn_admin_remove_player_chips(
  p_club_id uuid,
  p_player_id uuid,
  p_amount numeric,
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_before     numeric;
  v_after      numeric;
  v_bank_after numeric;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;

  v_actor_role := public.fn_club_bank_role(p_club_id);
  if v_actor_role is null or v_actor_role not in ('owner', 'co_owner', 'admin') then
    return jsonb_build_object('success', false,
      'error', 'Only An Owner, Co Owner Or Admin May Pull Chips From A Member. '
               || 'An Agent Must Wait For A Cash Out Request');
  end if;

  select chip_balance into v_before
    from club_members
   where club_id = p_club_id and user_id = p_player_id
   for update;
  if v_before is null then
    return jsonb_build_object('success', false,
      'error', 'That Person Is Not A Member Of This Club');
  end if;
  if v_before < p_amount then
    return jsonb_build_object('success', false,
      'error', 'That Wallet Only Holds ' || trim(to_char(v_before, 'FM999,999,999,990.00')) || ' Chips',
      'balance', v_before, 'requested', p_amount);
  end if;

  update club_members
     set chip_balance = coalesce(chip_balance, 0) - p_amount,
         updated_at = now()
   where club_id = p_club_id and user_id = p_player_id
   returning chip_balance into v_after;

  update clubs
     set chip_treasury = coalesce(chip_treasury, 0) + p_amount,
         updated_at = now()
   where id = p_club_id
   returning chip_treasury into v_bank_after;

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  values
    (p_club_id, p_player_id, v_actor, p_amount, 'admin_removal',
     coalesce(nullif(btrim(p_reason), ''), 'Chips Pulled By Club Staff'),
     jsonb_build_object(
       'source', 'player_wallet',
       'direction', 'into_bank',
       'actor_role', v_actor_role,
       'holder_balance_after', v_after,
       'bank_after', v_bank_after),
     v_bank_after);

  return jsonb_build_object('success', true, 'removed', p_amount,
    'balance_before', v_before, 'balance_after', v_after, 'bank_after', v_bank_after);
end
$$;

revoke all on function public.fn_agent_wallet_send(uuid, uuid, numeric, text, text, uuid) from public, anon;
revoke all on function public.fn_agent_wallet_claim_back(uuid, uuid, numeric, text, uuid) from public, anon;
revoke all on function public.fn_agent_wallet_reversible(uuid) from public, anon;
grant execute on function public.fn_agent_wallet_send(uuid, uuid, numeric, text, text, uuid) to authenticated, service_role;
grant execute on function public.fn_agent_wallet_claim_back(uuid, uuid, numeric, text, uuid) to authenticated, service_role;
grant execute on function public.fn_agent_wallet_reversible(uuid) to authenticated, service_role;
