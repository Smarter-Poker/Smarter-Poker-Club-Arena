-- CASHIER PHASE 1: CENT-CONSERVING CLAIM BACK + REPLAY-SAFE BALANCE GUARDS
--
-- Two production protections are made reproducible here:
--   1. fn_agent_wallet_claim_back may move only whole chip cents. The player
--      wallet is numeric(...,2), while an agent wallet keeps four decimals;
--      accepting 0.0049 repeatedly credited the agent and rounded the player
--      debit back to zero.
--   2. The browser balance guards that were hot-fixed on 2026-08-27 were
--      documented by a SELECT 1 migration rather than executable DDL. A clean
--      replay therefore did not recreate the protection.

begin;

create or replace function public.fn_block_browser_balance_writes()
returns trigger
language plpgsql
security invoker
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_changed text;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_table_name = 'club_members' then
    if new.chip_balance is distinct from old.chip_balance then
      v_changed := 'chip_balance';
    elsif new.held_chips is distinct from old.held_chips then
      v_changed := 'held_chips';
    elsif new.locked_chips is distinct from old.locked_chips then
      v_changed := 'locked_chips';
    elsif new.promo_balance is distinct from old.promo_balance then
      v_changed := 'promo_balance';
    end if;
  elsif tg_table_name = 'clubs' then
    if new.chip_treasury is distinct from old.chip_treasury then
      v_changed := 'chip_treasury';
    elsif new.chip_pool is distinct from old.chip_pool then
      v_changed := 'chip_pool';
    end if;
  end if;

  if v_changed is null then
    return new;
  end if;

  raise exception
    'Direct balance mutation of %.% from the browser is forbidden. Chips move only through the money RPCs.',
    tg_table_name, v_changed
    using errcode = 'insufficient_privilege';
end
$function$;

create or replace function public.fn_block_browser_balance_inserts()
returns trigger
language plpgsql
security invoker
set search_path to 'public', 'pg_temp'
as $function$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if coalesce(new.chip_balance, 0) <> 0
     or coalesce(new.promo_balance, 0) <> 0
     or coalesce(new.held_chips, 0) <> 0
     or coalesce(new.locked_chips, 0) <> 0 then
    raise exception 'A membership created from the browser must start with zero chips.'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$function$;

revoke all on function public.fn_block_browser_balance_writes()
  from public, anon, authenticated;
revoke all on function public.fn_block_browser_balance_inserts()
  from public, anon, authenticated;

drop trigger if exists trg_block_browser_balance_inserts on public.club_members;
create trigger trg_block_browser_balance_inserts
before insert on public.club_members
for each row execute function public.fn_block_browser_balance_inserts();

drop trigger if exists trg_block_browser_balance_writes on public.club_members;
create trigger trg_block_browser_balance_writes
before update on public.club_members
for each row execute function public.fn_block_browser_balance_writes();

drop trigger if exists trg_block_browser_treasury_writes on public.clubs;
create trigger trg_block_browser_treasury_writes
before update on public.clubs
for each row execute function public.fn_block_browser_balance_writes();

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
as $function$
declare
  v_actor            uuid := auth.uid();
  v_op_id            uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior            record;
  v_src              record;
  v_claimed          numeric;
  v_claimed_after    numeric;
  v_remaining_exact  numeric;
  v_remaining        numeric;
  v_take             numeric;
  v_complete         boolean;
  v_dest             text;
  v_held             numeric;
  v_agent_id         uuid;
  v_float_after      numeric;
  v_holder_after     numeric;
  v_tx_id            uuid;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;
  if p_club_id is null or p_transaction_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose A Recent Agent Wallet Send');
  end if;
  if p_amount is not null and
     (p_amount <= 0 or p_amount > 1e9 or p_amount <> round(p_amount, 2)) then
    return jsonb_build_object(
      'success', false,
      'error', 'Claim Back Amounts Must Be Positive Whole Cents');
  end if;

  -- One caller/op pair is serialized, so two simultaneous retries cannot both
  -- pass the replay read and enter the money section.
  perform pg_advisory_xact_lock(hashtextextended(
    'agent-wallet-claim:' || p_club_id::text || ':' || v_actor::text || ':' || v_op_id::text,
    0
  ));

  select id, amount, metadata into v_prior
    from public.chip_transactions
   where club_id = p_club_id
     and transaction_type = 'agent_wallet_claim_back'
     and to_user_id = v_actor
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    if coalesce(v_prior.metadata ->> 'original_transaction_id', '')
         is distinct from p_transaction_id::text
       or (p_amount is not null and v_prior.amount is distinct from p_amount) then
      return jsonb_build_object(
        'success', false,
        'error', 'That Retry Key Belongs To A Different Claim Back');
    end if;
    return jsonb_build_object(
      'success', true,
      'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric);
  end if;

  select * into v_src
    from public.chip_transactions
   where id = p_transaction_id
     and club_id = p_club_id
   for update;
  if v_src is null then
    return jsonb_build_object('success', false, 'error', 'That Send Could Not Be Found');
  end if;
  if v_src.transaction_type <> 'agent_wallet_send' then
    return jsonb_build_object(
      'success', false,
      'error', 'Only An Agent Wallet Send Can Be Claimed Back This Way');
  end if;
  if v_src.from_user_id is distinct from v_actor then
    return jsonb_build_object(
      'success', false,
      'error', 'You Can Only Claim Back Chips You Sent Yourself');
  end if;
  if coalesce(v_src.is_reversed, false) then
    return jsonb_build_object('success', false, 'error', 'That Send Has Already Been Claimed Back');
  end if;
  if v_src.reversible_until is null or now() > v_src.reversible_until then
    return jsonb_build_object(
      'success', false,
      'error', 'The Ten Minute Window To Claim These Chips Back Has Closed. '
               || 'The Player Must Request A Cash Out Instead');
  end if;

  v_claimed := coalesce((v_src.metadata ->> 'claimed_back')::numeric, 0);
  v_remaining_exact := greatest(v_src.amount - v_claimed, 0);

  -- Round DOWN, never to nearest. A historical 9.9951 remainder can safely
  -- return 9.99; rounding it to 10.00 would create another 0.0049 chips.
  v_remaining := trunc(v_remaining_exact, 2);
  if v_remaining < 0.01 then
    return jsonb_build_object('success', false, 'error', 'That Send Has Already Been Claimed Back');
  end if;

  -- Null means all safely claimable whole cents. This is what the cashier uses
  -- so contaminated historical rows can be closed without echoing sub-cents.
  v_take := coalesce(p_amount, v_remaining);
  if v_take > v_remaining then
    return jsonb_build_object(
      'success', false,
      'error', 'Only ' || trim(to_char(v_remaining, 'FM999,999,999,990.00'))
               || ' Chips Of That Send Are Left To Claim Back',
      'remaining', v_remaining,
      'requested', v_take);
  end if;

  v_dest := coalesce(v_src.metadata ->> 'destination', 'player_wallet');
  if v_dest = 'player_wallet' then
    select coalesce(chip_balance, 0) into v_held
      from public.club_members
     where club_id = p_club_id and user_id = v_src.to_user_id
     for update;
  else
    select a.id, coalesce(a.agent_wallet_balance, 0) into v_agent_id, v_held
      from public.agents a
     where a.club_id = p_club_id and a.user_id = v_src.to_user_id
     for update;
  end if;

  if v_held is null then
    return jsonb_build_object(
      'success', false,
      'error', 'That Wallet Could Not Be Read, So Nothing Was Moved');
  end if;
  if v_held < v_take then
    return jsonb_build_object(
      'success', false,
      'error', 'Those Chips Have Already Been Spent. That Wallet Only Holds '
               || trim(to_char(v_held, 'FM999,999,999,990.00')) || ' Chips',
      'held', v_held,
      'requested', v_take);
  end if;

  if v_dest = 'player_wallet' then
    update public.club_members
       set chip_balance = coalesce(chip_balance, 0) - v_take,
           updated_at = now()
     where club_id = p_club_id and user_id = v_src.to_user_id
     returning chip_balance into v_holder_after;
  else
    update public.agents
       set agent_wallet_balance = coalesce(agent_wallet_balance, 0) - v_take,
           updated_at = now()
     where id = v_agent_id
     returning agent_wallet_balance into v_holder_after;
  end if;

  update public.agents
     set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + v_take,
         updated_at = now()
   where club_id = p_club_id and user_id = v_actor
   returning agent_wallet_balance into v_float_after;
  if v_float_after is null then
    raise exception 'agent wallet row vanished for % in club %', v_actor, p_club_id;
  end if;

  v_claimed_after := v_claimed + v_take;
  v_complete := (v_src.amount - v_claimed_after) < 0.01;
  update public.chip_transactions
     set metadata = coalesce(metadata, '{}'::jsonb)
                    || jsonb_build_object('claimed_back', v_claimed_after),
         is_reversed = v_complete,
         clawed_back = v_complete
   where id = v_src.id;

  insert into public.chip_transactions
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
    'success', true,
    'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', v_take,
    'source', v_dest,
    'holder_balance_after', v_holder_after,
    'agent_wallet_after', v_float_after);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from public.chip_transactions
     where club_id = p_club_id
       and transaction_type = 'agent_wallet_claim_back'
       and to_user_id = v_actor
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    if v_prior.id is null then
      raise;
    end if;
    if coalesce(v_prior.metadata ->> 'original_transaction_id', '')
         is distinct from p_transaction_id::text
       or (p_amount is not null and v_prior.amount is distinct from p_amount) then
      return jsonb_build_object(
        'success', false,
        'error', 'That Retry Key Belongs To A Different Claim Back');
    end if;
    return jsonb_build_object(
      'success', true,
      'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'agent_wallet_after', (v_prior.metadata ->> 'agent_wallet_after')::numeric);
end
$function$;

revoke all on function public.fn_agent_wallet_claim_back(uuid, uuid, numeric, text, uuid)
  from public, anon;
grant execute on function public.fn_agent_wallet_claim_back(uuid, uuid, numeric, text, uuid)
  to authenticated, service_role;

comment on function public.fn_agent_wallet_claim_back(uuid, uuid, numeric, text, uuid) is
  'Cent-conserving ten-minute reversal of one caller-owned agent wallet send. Null amount means all safely claimable whole cents; replay keys are bound to source and amount.';

do $assert$
declare
  v_body text;
  v_trigger_count integer;
begin
  select pg_get_functiondef(
    'public.fn_agent_wallet_claim_back(uuid,uuid,numeric,text,uuid)'::regprocedure
  ) into v_body;
  if v_body not like '%p_amount <> round(p_amount, 2)%'
     or v_body not like '%v_remaining := trunc(v_remaining_exact, 2)%'
     or v_body not like '%That Retry Key Belongs To A Different Claim Back%' then
    raise exception 'claim-back cent or replay guard is missing';
  end if;

  select count(*) into v_trigger_count
    from pg_trigger
   where not tgisinternal
     and tgname in (
       'trg_block_browser_balance_inserts',
       'trg_block_browser_balance_writes',
       'trg_block_browser_treasury_writes'
     );
  if v_trigger_count <> 3 then
    raise exception 'expected three browser balance guards, found %', v_trigger_count;
  end if;
end
$assert$;

commit;
