-- ═══════════════════════════════════════════════════════════════════════════
--  CLUB BANK CASHIER — HARDENING PASS (Dan 2026-08-23)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- APPLIED TO PRODUCTION via Supabase MCP as `club_bank_idempotency_and_reversal`.
-- Follows 20260823140000_club_bank_cashier.sql. Mirror of what ran.
--
-- 1. IDEMPOTENCY. Every credit in this codebase carries a key, because a credit
--    that COMMITTED but timed out is otherwise paid twice - the 2026-07-24,
--    2026-07-28 and 2026-08-22 incidents are all that one bug at a different
--    site (tests/config/walletCreditIntegrity.test.ts). fn_club_bank_send
--    shipped without one: a double tap, a retried fetch or a flaky connection
--    could move the money twice and write two ledger rows.
--
--    A UNIQUE INDEX, not a SELECT-then-INSERT. Two concurrent calls with the
--    same op_id both pass a pre-check; only a constraint stops the second, and
--    the unique_violation handler turns the loser into a replay rather than an
--    error the user sees.
--
--    The 5-arg overload is DROPPED. A caller that has not been updated must
--    fail loudly rather than quietly send without a key.
--
-- 2. REVERSAL. "A FULL TRANSACTION LEDGER FOR EVERY SINGLE CHIP MOVEMENT" is
--    only true if a mistake is a NEW ENTRY rather than an edit. fn_club_bank_reverse
--    moves the chips back and writes a matching row; nothing is ever deleted.
--    It refuses if the recipient has already spent the chips - taking them back
--    then would leave their wallet negative and their downline funded out of
--    nothing, which is a clawback, a different feature with different rules.
--
-- 3. The ledger returns per-row reversibility, the club's own transaction-type
--    list (so the filter can never go stale) and the bank's in/out/net totals.
--
-- VERIFIED LIVE 2026-08-23 against SHARK CLUB with a real owner and a real
-- agent: 1 chip sent (bank 1,477,596.87 -> 1,477,595.87), the same op_id
-- replayed with no second movement, reversed (bank restored exactly), the
-- second reversal refused, and an agent identity refused by both the ledger
-- and the send.
--
-- ROLLBACK:
--   drop function public.fn_club_bank_reverse(uuid, text, uuid);
--   drop index public.chip_transactions_club_bank_op_id_uidx;
--   re-apply 20260823140000_club_bank_cashier.sql parts 1 and 3.

-- ── 1. Idempotency index ────────────────────────────────────────────────────
create unique index if not exists chip_transactions_club_bank_op_id_uidx
  on public.chip_transactions (club_id, ((metadata ->> 'op_id')))
  where transaction_type in ('club_bank_send', 'club_bank_reversal')
    and metadata ? 'op_id';

-- ── 2. fn_club_bank_send, now keyed ─────────────────────────────────────────
create or replace function public.fn_club_bank_send(
  p_club_id uuid,
  p_to_user_id uuid,
  p_amount numeric,
  p_destination text default 'agent_wallet',
  p_reason text default null,
  p_op_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  -- REPLAY. The caller generated this op_id before the first attempt, so a
  -- retry after a timeout finds the original and reports it rather than
  -- sending a second time.
  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'club_bank_send'
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
  if p_amount > 1e9 then
    return jsonb_build_object('success', false, 'error', 'Amount Exceeds The Single Send Limit');
  end if;
  if v_dest not in ('agent_wallet', 'promo_wallet', 'player_wallet') then
    return jsonb_build_object('success', false, 'error', 'Unknown Destination Wallet');
  end if;
  if p_to_user_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose A Recipient');
  end if;

  -- Membership status carries two words - see 20260823180000.
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
     and v_to_role not in ('super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only An Agent, Sub Agent Or Super Agent Holds An Agent Wallet');
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
    select a.id into v_agent_id
      from agents a
     where a.club_id = p_club_id and a.user_id = p_to_user_id
     for update;

    if v_agent_id is null then
      insert into agents (user_id, club_id, role, status, agent_wallet_balance, promo_wallet_balance)
      values (p_to_user_id, p_club_id, v_to_role, 'active', 0, 0)
      returning id into v_agent_id;
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
    -- Lost the race on the op_id index: the other caller did the work.
    select id, amount, metadata into v_prior
      from chip_transactions
     where club_id = p_club_id
       and transaction_type = 'club_bank_send'
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'bank_after', (v_prior.metadata ->> 'bank_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric);
end
$$;

drop function if exists public.fn_club_bank_send(uuid, uuid, numeric, text, text);

revoke all on function public.fn_club_bank_send(uuid, uuid, numeric, text, text, uuid) from public, anon;
grant execute on function public.fn_club_bank_send(uuid, uuid, numeric, text, text, uuid) to authenticated, service_role;

-- ── 3. fn_club_bank_reverse ─────────────────────────────────────────────────
create or replace function public.fn_club_bank_reverse(
  p_transaction_id uuid,
  p_reason text default null,
  p_op_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_op_id      uuid := coalesce(p_op_id, gen_random_uuid());
  v_tx         record;
  v_dest       text;
  v_held       numeric;
  v_agent_id   uuid;
  v_bank_after numeric;
  v_to_after   numeric;
  v_new_id     uuid;
  v_prior      record;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  select id, club_id, from_user_id, to_user_id, amount, transaction_type,
         coalesce(metadata, '{}'::jsonb) as metadata,
         coalesce(is_reversed, false) as is_reversed, reversible_until
    into v_tx
    from chip_transactions
   where id = p_transaction_id
   for update;
  if v_tx.id is null then
    return jsonb_build_object('success', false, 'error', 'That Ledger Entry Was Not Found');
  end if;

  v_actor_role := public.fn_club_bank_role(v_tx.club_id);
  if v_actor_role is null or v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only An Owner, Co Owner, Admin Or Super Agent May Reverse A Club Bank Send');
  end if;

  select id into v_prior from chip_transactions
   where club_id = v_tx.club_id
     and transaction_type = 'club_bank_reversal'
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object('success', true, 'replayed', true, 'transaction_id', v_prior.id);
  end if;

  if v_tx.transaction_type <> 'club_bank_send' then
    return jsonb_build_object('success', false,
      'error', 'Only A Club Bank Send Can Be Reversed Here');
  end if;
  if v_tx.is_reversed then
    return jsonb_build_object('success', false, 'error', 'That Send Has Already Been Reversed');
  end if;
  if v_tx.reversible_until is not null and now() > v_tx.reversible_until then
    return jsonb_build_object('success', false,
      'error', 'That Send Is Outside Its Seven Day Reversal Window');
  end if;

  v_dest := coalesce(v_tx.metadata ->> 'destination', 'agent_wallet');

  -- Take the chips back only if they are still there.
  if v_dest = 'player_wallet' then
    select coalesce(chip_balance, 0) into v_held
      from club_members
     where club_id = v_tx.club_id and user_id = v_tx.to_user_id
     for update;
  else
    select a.id, coalesce(case when v_dest = 'promo_wallet'
                               then a.promo_wallet_balance
                               else a.agent_wallet_balance end, 0)
      into v_agent_id, v_held
      from agents a
     where a.club_id = v_tx.club_id and a.user_id = v_tx.to_user_id
     for update;
  end if;

  if v_held is null then
    return jsonb_build_object('success', false, 'error', 'That Wallet No Longer Exists');
  end if;
  if v_held < v_tx.amount then
    return jsonb_build_object('success', false,
      'error', 'Those Chips Have Already Been Spent, So The Send Cannot Be Reversed',
      'held', v_held, 'required', v_tx.amount);
  end if;

  if v_dest = 'player_wallet' then
    update club_members set chip_balance = chip_balance - v_tx.amount, updated_at = now()
     where club_id = v_tx.club_id and user_id = v_tx.to_user_id
     returning chip_balance into v_to_after;
  elsif v_dest = 'promo_wallet' then
    update agents set promo_wallet_balance = promo_wallet_balance - v_tx.amount, updated_at = now()
     where id = v_agent_id returning promo_wallet_balance into v_to_after;
  else
    update agents set agent_wallet_balance = agent_wallet_balance - v_tx.amount, updated_at = now()
     where id = v_agent_id returning agent_wallet_balance into v_to_after;
  end if;

  update clubs set chip_treasury = coalesce(chip_treasury, 0) + v_tx.amount, updated_at = now()
   where id = v_tx.club_id returning chip_treasury into v_bank_after;

  update chip_transactions
     set is_reversed = true, clawed_back = true
   where id = v_tx.id;

  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  values
    (v_tx.club_id, v_tx.to_user_id, v_tx.from_user_id, v_tx.amount, 'club_bank_reversal',
     coalesce(nullif(btrim(p_reason), ''), 'Club Bank Send Reversed'),
     jsonb_build_object(
       'op_id', v_op_id,
       'reverses', v_tx.id,
       'destination', v_dest,
       'actor_role', v_actor_role,
       'bank_after', v_bank_after,
       'recipient_balance_after', v_to_after),
     v_bank_after)
  returning id into v_new_id;

  return jsonb_build_object(
    'success', true, 'replayed', false,
    'transaction_id', v_new_id, 'reversed', v_tx.id,
    'amount', v_tx.amount, 'bank_after', v_bank_after,
    'recipient_balance_after', v_to_after);
end
$$;

revoke all on function public.fn_club_bank_reverse(uuid, text, uuid) from public, anon;
grant execute on function public.fn_club_bank_reverse(uuid, text, uuid) to authenticated, service_role;

-- ── 4. Guard allowlist ──────────────────────────────────────────────────────
do $mig$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'guard_wallet_balance_write';
  if v_def is null or position('fn_club_bank_reverse' in v_def) > 0 then return; end if;
  v_def := replace(v_def, '''fn_club_bank_send''', '''fn_club_bank_send'',
    ''fn_club_bank_reverse''');
  execute v_def;
end $mig$;

-- ── 5. Ledger: reversibility, type list, and the bank's own totals ──────────
create or replace function public.fn_club_bank_ledger(
  p_club_id uuid,
  p_limit int default 50,
  p_offset int default 0,
  p_types text[] default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
  v_rows jsonb;
  v_types jsonb;
  v_in numeric;
  v_out numeric;
begin
  if not public.fn_can_use_club_bank(p_club_id) then
    return jsonb_build_object('authorized', false,
      'error', 'The Club Bank Ledger Is Restricted To Owners, Co Owners, Admins And Super Agents');
  end if;

  select count(*) into v_total
    from chip_transactions t
   where t.club_id = p_club_id
     and (p_types is null or t.transaction_type = any (p_types));

  -- Every type this club has ever recorded, so the filter offers real options
  -- rather than a hard-coded list that goes stale.
  select coalesce(jsonb_agg(x.transaction_type order by x.transaction_type), '[]'::jsonb)
    into v_types
    from (select distinct transaction_type from chip_transactions where club_id = p_club_id) x;

  -- What went INTO the bank and what came OUT of it. Scoped to the movements
  -- the bank itself makes; a peer transfer between two members never touches
  -- clubs.chip_treasury and would make this figure a lie.
  select
    coalesce(sum(t.amount) filter (
      where t.transaction_type in ('mint', 'club_bank_reversal', 'treasury_credit')), 0),
    coalesce(sum(t.amount) filter (
      where t.transaction_type in ('club_bank_send', 'treasury_debit')
        and coalesce(t.is_reversed, false) = false), 0)
    into v_in, v_out
    from chip_transactions t
   where t.club_id = p_club_id;

  select coalesce(jsonb_agg(r order by r->>'created_at' desc), '[]'::jsonb) into v_rows
  from (
    select jsonb_build_object(
             'id', t.id,
             'created_at', t.created_at,
             'amount', round(coalesce(t.amount, 0), 2),
             'transaction_type', t.transaction_type,
             'notes', t.notes,
             'balance_after', t.balance_after,
             'metadata', coalesce(t.metadata, '{}'::jsonb),
             'is_reversed', coalesce(t.is_reversed, false),
             'reversible',
               t.transaction_type = 'club_bank_send'
               and coalesce(t.is_reversed, false) = false
               and (t.reversible_until is null or now() <= t.reversible_until),
             'from_user_id', t.from_user_id,
             'to_user_id', t.to_user_id,
             'from_name', coalesce(pf.display_name, pf.username, pf.full_name),
             'to_name', coalesce(pt.display_name, pt.username, pt.full_name)
           ) as r
      from chip_transactions t
      left join profiles pf on pf.id = t.from_user_id
      left join profiles pt on pt.id = t.to_user_id
     where t.club_id = p_club_id
       and (p_types is null or t.transaction_type = any (p_types))
     order by t.created_at desc
     limit v_limit offset v_offset
  ) s;

  return jsonb_build_object(
    'authorized', true,
    'total', v_total,
    'limit', v_limit,
    'offset', v_offset,
    'types', v_types,
    'totals', jsonb_build_object('into_bank', round(v_in, 2), 'out_of_bank', round(v_out, 2),
                                 'net', round(v_in - v_out, 2)),
    'rows', v_rows);
end
$$;

revoke all on function public.fn_club_bank_ledger(uuid, int, int, text[]) from public, anon;
grant execute on function public.fn_club_bank_ledger(uuid, int, int, text[]) to authenticated, service_role;

-- ── POST-APPLY ASSERTIONS ───────────────────────────────────────────────────
do $assert$
declare v_src text; v_bad int := 0;
begin
  if to_regprocedure('public.fn_club_bank_send(uuid,uuid,numeric,text,text,uuid)') is null then
    raise exception 'keyed fn_club_bank_send missing';
  end if;
  if to_regprocedure('public.fn_club_bank_send(uuid,uuid,numeric,text,text)') is not null then
    raise exception 'the unkeyed 5-arg overload still exists - a caller could send without a key';
  end if;
  if to_regprocedure('public.fn_club_bank_reverse(uuid,text,uuid)') is null then
    raise exception 'fn_club_bank_reverse missing';
  end if;
  if not exists (select 1 from pg_indexes
                  where schemaname='public' and indexname='chip_transactions_club_bank_op_id_uidx') then
    raise exception 'op_id unique index missing - idempotency is not enforced';
  end if;
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='fn_club_bank_ledger';
  if position('reversible' in v_src) = 0 or position('into_bank' in v_src) = 0 then
    raise warning 'ledger did not gain reversibility/totals';
    v_bad := v_bad + 1;
  end if;
  if v_bad > 0 then raise exception 'club bank hardening failed % assertion(s)', v_bad; end if;
end $assert$;
