-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827011524; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- CASHIER SEND OUT / CLAIM BACK — AUDIT FIXES (2026-08-26)
-- ───────────────────────────────────────────────────────────────────────────
-- Every defect below was CONFIRMED against production inside transactions
-- that were rolled back (scripts/dev/probe-rpc.sql pattern; zero chips moved).
-- Full narrative in the repo migration file of the same name and in
-- .agent/audits/2026-08-26-cashier-send-claim-back-audit.md (club-arena).
--  1. 23502 on first send to a never-funded agent (agents auto-insert missing
--     NOT NULL commission_rate / player_rakeback_rate) — fn_ensure_agent_row.
--  2. Chip request approval could debit the approver and credit nobody when
--     the requester had left — approval now delegates to fn_agent_wallet_send
--     (agent wallet source, per the 2026-08-25 cashier law).
--  3. Ticket cancel destroyed escrow when the issuer had left — now refuses.
--  4. status='active'-only membership tests locked out 'approved' members in
--     fn_request_chips / fn_respond_chip_request / fn_wallet_claim_back.
--  5. Ticket issue refused depth-2+ downline the roster offers — now uses
--     fn_club_cashier_can_transact.
--  6. Promo send: no downline rule; refused staff promo floats — both fixed.
--  7. Ticket redemption invisible to the club ledger — chip_transactions row.
--  8. op_id replay lookups not pinned to the caller — now caller-pinned.
--  9. Sub-cent amounts in fn_request_chips / fn_issue_tournament_ticket.

-- ── 1. The one place an agents row is minted by a money path ────────────────
create or replace function public.fn_ensure_agent_row(
  p_club_id uuid, p_user_id uuid, p_role text
) returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_id    uuid;
  v_union uuid;
  v_min   numeric;
begin
  select a.id into v_id
    from agents a
   where a.club_id = p_club_id and a.user_id = p_user_id
   for update;
  if v_id is not null then
    return v_id;
  end if;

  select coalesce(uc.union_id, c.union_id) into v_union
    from clubs c
    left join union_clubs uc on uc.club_id = c.id
   where c.id = p_club_id
   limit 1;
  v_min := case when v_union is null then 0
                else public.fn_union_setting(v_union, 'min_agent_commission', 0) end;

  insert into agents (user_id, club_id, role, status,
                      agent_wallet_balance, promo_wallet_balance,
                      commission_rate, player_rakeback_rate)
  values (p_user_id, p_club_id, p_role, 'active', 0, 0, v_min, 0)
  on conflict (user_id, club_id) do nothing;

  select a.id into v_id
    from agents a
   where a.club_id = p_club_id and a.user_id = p_user_id
   for update;
  return v_id;
end
$$;

revoke all on function public.fn_ensure_agent_row(uuid, uuid, text) from public;
revoke all on function public.fn_ensure_agent_row(uuid, uuid, text) from anon;
revoke all on function public.fn_ensure_agent_row(uuid, uuid, text) from authenticated;

-- ── 2. fn_agent_wallet_send: ensure-row fix + caller-pinned replays ─────────
create or replace function public.fn_agent_wallet_send(
  p_club_id uuid, p_to_user_id uuid, p_amount numeric,
  p_destination text default 'player_wallet',
  p_reason text default null, p_op_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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
     and from_user_id = v_actor
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

  if v_to_role in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    v_dest := 'agent_wallet';
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
    v_to_agent_id := public.fn_ensure_agent_row(p_club_id, p_to_user_id, v_to_role);
    if v_to_agent_id is null then
      raise exception 'could not ensure agents row for % in club %', p_to_user_id, p_club_id;
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
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric);
end
$function$;

-- ── 3. fn_agent_wallet_claim_back: caller-pinned replays ────────────────────
create or replace function public.fn_agent_wallet_claim_back(
  p_club_id uuid, p_transaction_id uuid, p_amount numeric default null,
  p_reason text default null, p_op_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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
     and to_user_id = v_actor
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
       and to_user_id = v_actor
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    if v_prior.id is null then
      raise;
    end if;
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric);
end
$function$;

-- ── 4. fn_club_bank_send: ensure-row fix + caller-pinned replays ────────────
create or replace function public.fn_club_bank_send(
  p_club_id uuid, p_to_user_id uuid, p_amount numeric,
  p_destination text default 'agent_wallet',
  p_reason text default null, p_op_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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

-- ── 5. fn_promo_wallet_send: downline rule, staff floats, ensure-row fix ────
create or replace function public.fn_promo_wallet_send(
  p_club_id uuid, p_to_user_id uuid, p_amount numeric,
  p_destination text default 'player_wallet',
  p_reason text default null, p_op_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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
  end if;

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
$function$;

-- ── 6. fn_request_chips: legacy status + scale guard ────────────────────────
create or replace function public.fn_request_chips(
  p_club_id uuid, p_amount numeric, p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_me uuid := auth.uid();
  v_agent uuid;
  v_open int;
begin
  if v_me is null then return jsonb_build_object('success', false, 'error', 'not authenticated'); end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'amount must be > 0');
  end if;
  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('success', false, 'error', 'chips move in hundredths at most');
  end if;
  if p_amount > 1e9 then
    return jsonb_build_object('success', false, 'error', 'amount exceeds limit');
  end if;

  select agent_id into v_agent from club_members
   where club_id = p_club_id and user_id = v_me
     and coalesce(status, 'active') in ('active', 'approved');
  if not found then
    return jsonb_build_object('success', false, 'error', 'you are not an active member of this club');
  end if;

  if v_agent is null then
    select owner_id into v_agent from clubs where id = p_club_id;
  end if;

  select count(*) into v_open from chip_requests
   where club_id = p_club_id and requester_id = v_me and status = 'pending';
  if v_open >= 3 then
    return jsonb_build_object('success', false, 'error', 'you already have 3 open requests');
  end if;

  insert into chip_requests (club_id, requester_id, approver_id, amount, note)
  values (p_club_id, v_me, v_agent, p_amount, nullif(trim(coalesce(p_note,'')), ''));

  return jsonb_build_object('success', true);
end $function$;

-- ── 7. fn_respond_chip_request: approval is a real Send Out now ─────────────
create or replace function public.fn_respond_chip_request(
  p_request_id uuid, p_action text
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_me uuid := auth.uid();
  v_req record;
  v_role text;
  v_send jsonb;
begin
  if v_me is null then return jsonb_build_object('success', false, 'error', 'not authenticated'); end if;
  if p_action not in ('approve','decline','cancel') then
    return jsonb_build_object('success', false, 'error', 'invalid action');
  end if;

  select * into v_req from chip_requests where id = p_request_id for update;
  if not found then return jsonb_build_object('success', false, 'error', 'request not found'); end if;
  if v_req.status <> 'pending' then
    return jsonb_build_object('success', false, 'error', 'request already ' || v_req.status);
  end if;

  if p_action = 'cancel' then
    if v_req.requester_id <> v_me then
      return jsonb_build_object('success', false, 'error', 'only the requester may cancel');
    end if;
    update chip_requests set status = 'cancelled', responded_by = v_me, responded_at = now()
     where id = p_request_id;
    return jsonb_build_object('success', true, 'status', 'cancelled');
  end if;

  v_role := public.fn_club_bank_role(v_req.club_id);
  if v_role is null or v_role not in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
    return jsonb_build_object('success', false, 'error', 'you cannot answer chip requests here');
  end if;
  if v_role in ('super_agent','agent','sub_agent') and v_req.approver_id is distinct from v_me then
    return jsonb_build_object('success', false, 'error', 'this request is not addressed to you');
  end if;

  if p_action = 'decline' then
    update chip_requests set status = 'declined', responded_by = v_me, responded_at = now()
     where id = p_request_id;
    return jsonb_build_object('success', true, 'status', 'declined');
  end if;

  if v_me = v_req.requester_id then
    return jsonb_build_object('success', false, 'error', 'you cannot approve your own request');
  end if;

  v_send := public.fn_agent_wallet_send(
    v_req.club_id, v_req.requester_id, v_req.amount,
    'player_wallet', 'Chip Request Approved', gen_random_uuid());
  if not coalesce((v_send ->> 'success')::boolean, false) then
    return jsonb_build_object('success', false,
      'error', coalesce(v_send ->> 'error', 'the send was refused'));
  end if;

  update chip_requests set status = 'approved', responded_by = v_me, responded_at = now()
   where id = p_request_id;

  return jsonb_build_object('success', true, 'status', 'approved',
                            'your_balance', (v_send ->> 'agent_wallet_after')::numeric,
                            'their_balance', (v_send ->> 'recipient_balance_after')::numeric);
end $function$;

-- ── 8. fn_issue_tournament_ticket: the roster's own downline edge ───────────
create or replace function public.fn_issue_tournament_ticket(
  p_club_id uuid, p_holder_id uuid, p_value numeric,
  p_note text default null, p_idempotency_key text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_me uuid := auth.uid();
  v_role text;
  v_bal numeric;
  v_after numeric;
  v_first uuid; v_second uuid;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_prior jsonb;
begin
  if v_me is null then return jsonb_build_object('success', false, 'error', 'not authenticated'); end if;
  if p_value is null or p_value <= 0 then
    return jsonb_build_object('success', false, 'error', 'ticket value must be > 0');
  end if;
  if p_value <> round(p_value, 2) then
    return jsonb_build_object('success', false, 'error', 'chips move in hundredths at most');
  end if;
  if p_value > 1e9 then
    return jsonb_build_object('success', false, 'error', 'value exceeds limit');
  end if;
  if p_holder_id = v_me then
    return jsonb_build_object('success', false, 'error', 'cannot issue a ticket to yourself');
  end if;

  if v_key is not null then
    select ct.metadata into v_prior
      from chip_transactions ct
     where ct.metadata->>'idempotency_key' = v_key
     limit 1;
    if v_prior is not null then
      return jsonb_build_object(
        'success', true,
        'your_balance', (v_prior->>'issuer_balance_after')::numeric,
        'replayed', true);
    end if;
  end if;

  select role into v_role from club_members
   where club_id = p_club_id and user_id = v_me and status in ('active', 'approved');
  if v_role is null or v_role not in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
    return jsonb_build_object('success', false, 'error', 'your role cannot issue tickets');
  end if;

  perform 1 from club_members
   where club_id = p_club_id and user_id = p_holder_id and status in ('active', 'approved');
  if not found then
    return jsonb_build_object('success', false, 'error', 'recipient is not an active member of this club');
  end if;
  if v_role in ('super_agent','agent','sub_agent')
     and not public.fn_club_cashier_can_transact(p_club_id, v_me, p_holder_id) then
    return jsonb_build_object('success', false, 'error', 'recipient is not in your downline');
  end if;

  if v_me < p_holder_id then v_first := v_me; v_second := p_holder_id;
  else v_first := p_holder_id; v_second := v_me; end if;
  perform 1 from club_members where club_id = p_club_id and user_id = v_first for update;
  perform 1 from club_members where club_id = p_club_id and user_id = v_second for update;

  select coalesce(chip_balance,0) into v_bal from club_members
   where club_id = p_club_id and user_id = v_me;
  if v_bal < p_value then
    return jsonb_build_object('success', false, 'error', 'insufficient chips', 'balance', v_bal);
  end if;

  begin
    update club_members set chip_balance = chip_balance - p_value, updated_at = now()
     where club_id = p_club_id and user_id = v_me returning chip_balance into v_after;

    insert into tournament_tickets (club_id, issued_by, holder_id, value, note)
    values (p_club_id, v_me, p_holder_id, p_value, nullif(trim(coalesce(p_note,'')), ''));

    insert into chip_transactions
      (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, metadata)
    values
      (p_club_id, v_me, p_holder_id, p_value, 'peer_transfer',
       'Tournament ticket issued (escrowed until redeemed)', v_after,
       case when v_key is null then '{}'::jsonb
            else jsonb_build_object(
                   'idempotency_key', v_key,
                   'issuer_balance_after', v_after) end);
  exception when unique_violation then
    select ct.metadata into v_prior
      from chip_transactions ct
     where ct.metadata->>'idempotency_key' = v_key
     limit 1;
    if v_prior is null then raise; end if;
    return jsonb_build_object(
      'success', true,
      'your_balance', (v_prior->>'issuer_balance_after')::numeric,
      'replayed', true);
  end;

  return jsonb_build_object('success', true, 'your_balance', v_after);
end
$function$;

-- ── 9. fn_cancel_tournament_ticket: a refund that lands nowhere refuses ─────
create or replace function public.fn_cancel_tournament_ticket(p_ticket_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_me uuid := auth.uid();
  v_t record;
  v_after numeric;
begin
  if v_me is null then return jsonb_build_object('success', false, 'error', 'not authenticated'); end if;
  select * into v_t from tournament_tickets where id = p_ticket_id for update;
  if not found then return jsonb_build_object('success', false, 'error', 'ticket not found'); end if;
  if v_t.issued_by <> v_me then
    return jsonb_build_object('success', false, 'error', 'only the issuer may cancel a ticket');
  end if;
  if v_t.status <> 'issued' then
    return jsonb_build_object('success', false, 'error', 'ticket already ' || v_t.status);
  end if;

  update club_members set chip_balance = coalesce(chip_balance,0) + v_t.value, updated_at = now()
   where club_id = v_t.club_id and user_id = v_me returning chip_balance into v_after;
  if v_after is null then
    return jsonb_build_object('success', false,
      'error', 'you are no longer a member of that club, so the escrow has nowhere to land');
  end if;
  update tournament_tickets set status = 'cancelled', cancelled_at = now() where id = p_ticket_id;

  insert into chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after)
  values (v_t.club_id, null, v_me, v_t.value, 'peer_transfer', 'Tournament ticket cancelled (escrow refunded)', v_after);

  return jsonb_build_object('success', true, 'refunded', v_t.value, 'your_balance', v_after);
end $function$;

-- ── 10. fn_redeem_tournament_ticket: the club ledger sees the redemption ────
create or replace function public.fn_redeem_tournament_ticket(p_ticket_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_me uuid := auth.uid();
  v_t record;
  v_after numeric;
begin
  if v_me is null then return jsonb_build_object('success', false, 'error', 'not authenticated'); end if;
  select * into v_t from tournament_tickets where id = p_ticket_id for update;
  if not found then return jsonb_build_object('success', false, 'error', 'ticket not found'); end if;
  if v_t.holder_id <> v_me then
    return jsonb_build_object('success', false, 'error', 'this ticket is not yours');
  end if;
  if v_t.status <> 'issued' then
    return jsonb_build_object('success', false, 'error', 'ticket already ' || v_t.status);
  end if;

  update club_members set chip_balance = coalesce(chip_balance,0) + v_t.value, updated_at = now()
   where club_id = v_t.club_id and user_id = v_me returning chip_balance into v_after;
  if v_after is null then
    return jsonb_build_object('success', false, 'error', 'you are no longer a member of that club');
  end if;

  update tournament_tickets set status = 'redeemed', redeemed_at = now() where id = p_ticket_id;

  insert into chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after)
  values (v_t.club_id, null, v_me, v_t.value, 'peer_transfer', 'Tournament ticket redeemed', v_after);

  insert into wallet_transactions (user_id, wallet_type, type, amount, category, description, balance_after)
  values (v_me, 'PLAYER', 'credit', v_t.value, 'transfer', 'Tournament ticket redeemed', v_after);

  return jsonb_build_object('success', true, 'value', v_t.value, 'your_balance', v_after);
end $function$;

-- ── 11. fn_wallet_claim_back: legacy status + the replay handler it promised ─
create or replace function public.fn_wallet_claim_back(
  p_club_id uuid, p_from_user_id uuid, p_amount numeric,
  p_target_wallet text, p_source_wallet text default 'player_wallet',
  p_reason text default null, p_idempotency_key text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_from_role    text;
  v_amount       numeric := round(p_amount, 2);
  v_source       text := lower(coalesce(p_source_wallet, 'player_wallet'));
  v_target       text := lower(coalesce(p_target_wallet, 'club_bank'));
  v_from_agent   uuid;
  v_from_before  numeric;
  v_from_after   numeric;
  v_target_after numeric;
  v_first uuid;
  v_second uuid;
  v_union uuid;
  v_min_comm numeric;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_prior jsonb;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;
  if v_amount is null or v_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;
  if v_target not in ('club_bank', 'promo_wallet', 'agent_wallet') then
    return jsonb_build_object('success', false, 'error', 'Unknown Target Wallet');
  end if;
  if v_source not in ('agent_wallet', 'promo_wallet', 'player_wallet') then
    return jsonb_build_object('success', false, 'error', 'Unknown Source Wallet');
  end if;
  if p_from_user_id is null or p_from_user_id = v_actor then
    return jsonb_build_object('success', false, 'error', 'Invalid User');
  end if;

  v_actor_role := public.fn_club_bank_role(p_club_id);
  if v_actor_role is null or btrim(v_actor_role) = '' then
    return jsonb_build_object('success', false, 'error', 'You Are Not A Member Of This Club');
  end if;

  if v_key is not null then
    select ct.metadata into v_prior from chip_transactions ct
     where ct.metadata->>'idempotency_key' = v_key limit 1;
    if v_prior is not null then
      return jsonb_build_object('success', true,
        'balance_after', (v_prior->>'target_balance_after')::numeric, 'replayed', true);
    end if;
  end if;

  if v_target = 'club_bank' then
    if coalesce(v_actor_role, '') not in ('owner', 'co_owner', 'admin', 'super_agent') then
      return jsonb_build_object('success', false, 'error', 'Your Role Cannot Claim Back Into The Club Bank');
    end if;
    if coalesce(v_actor_role, '') = 'super_agent'
       and not public.fn_club_is_in_downline(p_club_id, v_actor, p_from_user_id) then
      return jsonb_build_object('success', false, 'error', 'Player Is Not In Your Downline');
    end if;
  elsif v_target in ('agent_wallet', 'promo_wallet') then
    if coalesce(v_actor_role, '') not in ('super_agent', 'agent', 'sub_agent', 'owner', 'co_owner', 'admin') then
      return jsonb_build_object('success', false, 'error', 'Your Role Cannot Claim Back Into An Agent Wallet');
    end if;
  end if;

  select role, agent_id into v_from_role, v_from_agent
    from club_members
   where club_id = p_club_id and user_id = p_from_user_id
     and coalesce(status, 'active') in ('active', 'approved');

  if v_from_role is null then
    return jsonb_build_object('success', false, 'error', 'User Is Not An Active Member');
  end if;

  if v_source in ('agent_wallet', 'promo_wallet')
     and v_from_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false, 'error', 'User Does Not Have That Wallet');
  end if;

  if v_target in ('agent_wallet', 'promo_wallet') and coalesce(v_actor_role, '') in ('super_agent', 'agent', 'sub_agent') then
    if not public.fn_club_is_in_downline(p_club_id, v_actor, p_from_user_id) then
      return jsonb_build_object('success', false, 'error', 'User Is Not In Your Downline');
    end if;
  end if;

  if v_actor < p_from_user_id then
    v_first := v_actor; v_second := p_from_user_id;
  else
    v_first := p_from_user_id; v_second := v_actor;
  end if;

  perform 1 from club_members where club_id = p_club_id and user_id = v_first for update;
  perform 1 from club_members where club_id = p_club_id and user_id = v_second for update;

  if v_target = 'club_bank' then
    perform 1 from clubs where id = p_club_id for update;
  end if;

  select coalesce(uc.union_id, c.union_id) into v_union
    from clubs c left join union_clubs uc on uc.club_id = c.id
   where c.id = p_club_id limit 1;
  v_min_comm := case when v_union is null then 0
                     else public.fn_union_setting(v_union, 'min_agent_commission', 0) end;

  if v_target in ('agent_wallet', 'promo_wallet') then
    insert into agents (user_id, club_id, role, status, commission_rate, player_rakeback_rate)
      values (v_actor, p_club_id, v_actor_role, 'active', v_min_comm, 0)
      on conflict (user_id, club_id) do nothing;
  end if;

  if v_source in ('agent_wallet', 'promo_wallet') then
    insert into agents (user_id, club_id, role, status, commission_rate, player_rakeback_rate)
      values (p_from_user_id, p_club_id, v_from_role, 'active', v_min_comm, 0)
      on conflict (user_id, club_id) do nothing;
  end if;

  perform 1 from agents where club_id = p_club_id and user_id = v_first for update;
  perform 1 from agents where club_id = p_club_id and user_id = v_second for update;

  if v_source = 'player_wallet' then
    select coalesce(chip_balance, 0) into v_from_before from club_members where club_id = p_club_id and user_id = p_from_user_id;
  elsif v_source = 'agent_wallet' then
    select coalesce(agent_wallet_balance, 0) into v_from_before from agents where club_id = p_club_id and user_id = p_from_user_id;
  elsif v_source = 'promo_wallet' then
    select coalesce(promo_wallet_balance, 0) into v_from_before from agents where club_id = p_club_id and user_id = p_from_user_id;
  end if;

  if coalesce(v_from_before, 0) < v_amount then
    return jsonb_build_object('success', false, 'error', 'Insufficient Chips', 'balance', coalesce(v_from_before, 0));
  end if;

  if v_source = 'player_wallet' then
    update club_members set chip_balance = chip_balance - v_amount, updated_at = now()
     where club_id = p_club_id and user_id = p_from_user_id returning chip_balance into v_from_after;
  elsif v_source = 'agent_wallet' then
    update agents set agent_wallet_balance = agent_wallet_balance - v_amount, updated_at = now()
     where club_id = p_club_id and user_id = p_from_user_id returning agent_wallet_balance into v_from_after;
  elsif v_source = 'promo_wallet' then
    update agents set promo_wallet_balance = promo_wallet_balance - v_amount, updated_at = now()
     where club_id = p_club_id and user_id = p_from_user_id returning promo_wallet_balance into v_from_after;
  end if;

  if v_target = 'club_bank' then
    update clubs set chip_treasury = coalesce(chip_treasury, 0) + v_amount, updated_at = now()
     where id = p_club_id returning chip_treasury into v_target_after;
  elsif v_target = 'agent_wallet' then
    update agents set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + v_amount, updated_at = now()
     where club_id = p_club_id and user_id = v_actor returning agent_wallet_balance into v_target_after;
  elsif v_target = 'promo_wallet' then
    update agents set promo_wallet_balance = coalesce(promo_wallet_balance, 0) + v_amount, updated_at = now()
     where club_id = p_club_id and user_id = v_actor returning promo_wallet_balance into v_target_after;
  end if;

  insert into chip_transactions (
    club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, metadata
  ) values (
    p_club_id, p_from_user_id, v_actor, v_amount,
    case when v_target = 'club_bank' then 'club_bank_claim'
         when v_target = 'promo_wallet' then 'promo_claim'
         else 'agent_claim' end,
    p_reason,
    v_target_after,
    jsonb_build_object(
      'source_wallet', v_source,
      'target_wallet', v_target,
      'from_balance_after', v_from_after,
      'target_balance_after', v_target_after
    ) || case when v_key is null then '{}'::jsonb
              else jsonb_build_object('idempotency_key', v_key) end
  );

  return jsonb_build_object('success', true, 'balance_after', v_target_after);
exception
  when unique_violation then
    if v_key is null then
      raise;
    end if;
    select ct.metadata into v_prior from chip_transactions ct
     where ct.metadata->>'idempotency_key' = v_key limit 1;
    if v_prior is null then
      raise;
    end if;
    return jsonb_build_object('success', true,
      'balance_after', (v_prior->>'target_balance_after')::numeric, 'replayed', true);
end
$function$;

-- ── Post-apply assertions ───────────────────────────────────────────────────
do $assert$
declare v_src text;
begin
  if to_regprocedure('public.fn_ensure_agent_row(uuid,uuid,text)') is null then
    raise exception 'ASSERT FAILED: fn_ensure_agent_row missing';
  end if;

  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='fn_request_chips';
  if v_src not like '%approved%' then
    raise exception 'ASSERT FAILED: fn_request_chips still refuses approved members';
  end if;

  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='fn_respond_chip_request';
  if v_src not like '%fn_agent_wallet_send%' then
    raise exception 'ASSERT FAILED: fn_respond_chip_request does not delegate to fn_agent_wallet_send';
  end if;

  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='fn_issue_tournament_ticket';
  if v_src not like '%fn_club_cashier_can_transact%' then
    raise exception 'ASSERT FAILED: fn_issue_tournament_ticket still uses the direct-parent test';
  end if;

  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='fn_cancel_tournament_ticket';
  if v_src not like '%nowhere to land%' then
    raise exception 'ASSERT FAILED: fn_cancel_tournament_ticket missing the lost-refund guard';
  end if;

  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='fn_agent_wallet_send';
  if v_src not like '%fn_ensure_agent_row%' then
    raise exception 'ASSERT FAILED: fn_agent_wallet_send missing the ensure-row fix';
  end if;
end $assert$;
