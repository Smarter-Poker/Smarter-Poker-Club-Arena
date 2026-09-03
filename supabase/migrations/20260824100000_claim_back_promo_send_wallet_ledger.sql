-- ═══════════════════════════════════════════════════════════════════════════
--  CLUB BANK CLAIM BACK + PROMO WALLET SEND + MEMBER WALLET LEDGER
--  (Dan 2026-08-24, BINDING)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1. "CLUB BANK NEEDS THE ABILITY TO CLAIM BACK, NOT JUST SEND OUT."
--    fn_club_bank_claim_back pulls chips FROM a member's agent, promo or
--    player wallet INTO clubs.chip_treasury. Same four roles as the send
--    (owner, co_owner, admin, super_agent), same locking, same idempotency
--    discipline, and a ledger row every single time. It refuses to overdraw
--    the holder: a wallet holding less than the claim is refused outright,
--    never taken negative.
--
-- 2. "PROMO WALLET NEEDS THE ABILITY TO SEND TO PLAYER WALLETS OR AGENT
--    WALLETS. IF ITS SENT TO AN AGENT WALLET, IT LANDS IN THEIR PROMO WALLET.
--    IF IT LANDS IN A PLAYER WALLET, ITS JUST AS GOOD AS CASH."
--    fn_promo_wallet_send debits the CALLER's own agents.promo_wallet_balance
--    and credits either club_members.chip_balance (player — spendable in any
--    cash game or tournament) or the recipient agent's promo_wallet_balance.
--
-- 3. "PLAYER WALLET NEEDS TO BE FULLY CLICKABLE AND OPEN TO SEE ALL
--    TRANSACTIONS AND OTHER AVAILABLE DATA."
--    fn_my_wallet_ledger returns the CALLER's own club-scoped transactions,
--    balances and in/out totals. auth.uid() scoped — it can never read
--    someone else's statement, so any active member may call it.
--
-- 4. fn_club_bank_ledger's into-the-bank total now counts 'club_bank_claim',
--    or the bank's own statement would not balance after the first claim.
--
-- IDEMPOTENCY: every mutation carries an op_id; a partial unique index makes
-- the second delivery of the same operation a replay, not a second movement.
-- Same pattern, same reason as 20260823170000.
--
-- ROLLBACK:
--   drop function public.fn_club_bank_claim_back(uuid, uuid, numeric, text, text, uuid);
--   drop function public.fn_promo_wallet_send(uuid, uuid, numeric, text, text, uuid);
--   drop function public.fn_my_wallet_ledger(uuid, int, int);
--   drop index public.chip_transactions_wallet_ops_op_id_uidx;
--   re-apply part 5 of 20260823170000_club_bank_idempotency_and_reversal.sql
--   to restore the previous fn_club_bank_ledger.

-- ── 0. Idempotency index for the two new movement types ─────────────────────
create unique index if not exists chip_transactions_wallet_ops_op_id_uidx
  on public.chip_transactions (club_id, ((metadata ->> 'op_id')))
  where transaction_type in ('club_bank_claim', 'promo_wallet_send')
    and metadata ? 'op_id';

-- ── 1. fn_club_bank_claim_back ───────────────────────────────────────────────
create or replace function public.fn_club_bank_claim_back(
  p_club_id uuid,
  p_from_user_id uuid,
  p_amount numeric,
  p_source text default 'agent_wallet',
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
  v_source       text := lower(coalesce(p_source, 'agent_wallet'));
  v_op_id        uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior        record;
  v_holder_role  text;
  v_held         numeric;
  v_agent_id     uuid;
  v_holder_after numeric;
  v_bank_after   numeric;
  v_tx_id        uuid;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;

  v_actor_role := public.fn_club_bank_role(p_club_id);
  if v_actor_role is null or v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only An Owner, Co Owner, Admin Or Super Agent May Claim Chips Back Into The Club Bank');
  end if;

  -- REPLAY. Same discipline as fn_club_bank_send: the caller generated the
  -- op_id before the first attempt, so a retry finds the original.
  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'club_bank_claim'
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'source', v_prior.metadata ->> 'source',
      'bank_after', (v_prior.metadata ->> 'bank_after')::numeric,
      'holder_balance_after', (v_prior.metadata ->> 'holder_balance_after')::numeric);
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount Must Be Greater Than Zero');
  end if;
  if p_amount > 1e9 then
    return jsonb_build_object('success', false, 'error', 'Amount Exceeds The Single Claim Limit');
  end if;
  if v_source not in ('agent_wallet', 'promo_wallet', 'player_wallet') then
    return jsonb_build_object('success', false, 'error', 'Unknown Source Wallet');
  end if;
  if p_from_user_id is null then
    return jsonb_build_object('success', false, 'error', 'Choose Whose Wallet To Claim From');
  end if;

  -- Membership status carries two words - see 20260823180000.
  select cm.role into v_holder_role
    from club_members cm
   where cm.club_id = p_club_id
     and cm.user_id = p_from_user_id
     and coalesce(cm.status, 'active') in ('active', 'approved')
   for update;
  if v_holder_role is null then
    return jsonb_build_object('success', false, 'error', 'That Person Is Not An Active Member Of This Club');
  end if;

  -- Lock the source wallet and check what it actually holds. A claim NEVER
  -- takes a wallet negative — if the chips are gone, the claim is refused.
  if v_source = 'player_wallet' then
    select coalesce(chip_balance, 0) into v_held
      from club_members
     where club_id = p_club_id and user_id = p_from_user_id
     for update;
  else
    if v_holder_role not in ('super_agent', 'agent', 'sub_agent') then
      return jsonb_build_object('success', false,
        'error', 'Only An Agent, Sub Agent Or Super Agent Holds An Agent Wallet');
    end if;
    select a.id, coalesce(case when v_source = 'promo_wallet'
                               then a.promo_wallet_balance
                               else a.agent_wallet_balance end, 0)
      into v_agent_id, v_held
      from agents a
     where a.club_id = p_club_id and a.user_id = p_from_user_id
     for update;
    if v_agent_id is null then
      return jsonb_build_object('success', false,
        'error', 'That Member Has Never Been Funded, So There Is Nothing To Claim');
    end if;
  end if;

  if v_held < p_amount then
    return jsonb_build_object('success', false,
      'error', 'That Wallet Only Holds ' || trim(to_char(v_held, 'FM999,999,999,990.00')) || ' Chips',
      'held', v_held, 'requested', p_amount);
  end if;

  -- Debit the holder, credit the bank, in this order under both locks.
  if v_source = 'player_wallet' then
    update club_members
       set chip_balance = coalesce(chip_balance, 0) - p_amount,
           updated_at = now()
     where club_id = p_club_id and user_id = p_from_user_id
     returning chip_balance into v_holder_after;
  elsif v_source = 'promo_wallet' then
    update agents
       set promo_wallet_balance = coalesce(promo_wallet_balance, 0) - p_amount,
           updated_at = now()
     where id = v_agent_id
     returning promo_wallet_balance into v_holder_after;
  else
    update agents
       set agent_wallet_balance = coalesce(agent_wallet_balance, 0) - p_amount,
           updated_at = now()
     where id = v_agent_id
     returning agent_wallet_balance into v_holder_after;
  end if;

  update clubs
     set chip_treasury = coalesce(chip_treasury, 0) + p_amount,
         updated_at = now()
   where id = p_club_id
   returning chip_treasury into v_bank_after;
  if v_bank_after is null then
    raise exception 'club % not found while crediting the bank', p_club_id;
  end if;

  -- THE LEDGER. Money flowed holder -> bank; from_user_id is the holder and
  -- to_user_id is the actor who stood at the bank, so the row answers both
  -- "whose chips" and "who took them". metadata.direction says which way.
  insert into chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  values
    (p_club_id, p_from_user_id, v_actor, p_amount, 'club_bank_claim',
     coalesce(nullif(btrim(p_reason), ''), 'Club Bank Claim Back'),
     jsonb_build_object(
       'op_id', v_op_id,
       'source', v_source,
       'direction', 'into_bank',
       'actor_role', v_actor_role,
       'holder_role', v_holder_role,
       'bank_after', v_bank_after,
       'holder_balance_after', v_holder_after),
     v_bank_after)
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true, 'replayed', false,
    'transaction_id', v_tx_id,
    'op_id', v_op_id,
    'amount', p_amount,
    'source', v_source,
    'bank_after', v_bank_after,
    'holder_balance_after', v_holder_after);
exception
  when unique_violation then
    select id, amount, metadata into v_prior
      from chip_transactions
     where club_id = p_club_id
       and transaction_type = 'club_bank_claim'
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'source', v_prior.metadata ->> 'source',
      'bank_after', (v_prior.metadata ->> 'bank_after')::numeric,
      'holder_balance_after', (v_prior.metadata ->> 'holder_balance_after')::numeric);
end
$$;

revoke all on function public.fn_club_bank_claim_back(uuid, uuid, numeric, text, text, uuid) from public, anon;
grant execute on function public.fn_club_bank_claim_back(uuid, uuid, numeric, text, text, uuid) to authenticated, service_role;

-- ── 2. fn_promo_wallet_send ──────────────────────────────────────────────────
create or replace function public.fn_promo_wallet_send(
  p_club_id uuid,
  p_to_user_id uuid,
  p_amount numeric,
  p_destination text default 'player_wallet',
  p_reason text default null,
  p_op_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  -- REPLAY.
  select id, amount, metadata into v_prior
    from chip_transactions
   where club_id = p_club_id
     and transaction_type = 'promo_wallet_send'
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

  -- The sender spends THEIR OWN promo float. No row, or not enough — refused.
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

  -- Recipient must be an active member of THIS club.
  select cm.role into v_to_role
    from club_members cm
   where cm.club_id = p_club_id
     and cm.user_id = p_to_user_id
     and coalesce(cm.status, 'active') in ('active', 'approved')
   for update;
  if v_to_role is null then
    return jsonb_build_object('success', false, 'error', 'Recipient Is Not An Active Member Of This Club');
  end if;
  if v_dest = 'agent_wallet' and v_to_role not in ('super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false,
      'error', 'Only An Agent, Sub Agent Or Super Agent Holds A Promo Wallet');
  end if;

  -- Debit the sender's promo float.
  update agents
     set promo_wallet_balance = coalesce(promo_wallet_balance, 0) - p_amount,
         updated_at = now()
   where id = v_sender_id
   returning promo_wallet_balance into v_sender_after;

  -- Credit the destination.
  if v_dest = 'player_wallet' then
    -- Dan 2026-08-24: promo chips landing in a player wallet are JUST AS GOOD
    -- AS CASH — they credit chip_balance, the wallet buy-ins come out of, and
    -- are spendable in any cash game or tournament.
    update club_members
       set chip_balance = coalesce(chip_balance, 0) + p_amount,
           updated_at = now()
     where club_id = p_club_id and user_id = p_to_user_id
     returning chip_balance into v_to_after;
  else
    -- Dan 2026-08-24: promo chips sent to an agent land in THEIR promo wallet.
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
       set promo_wallet_balance = coalesce(promo_wallet_balance, 0) + p_amount,
           updated_at = now()
     where id = v_to_agent_id
     returning promo_wallet_balance into v_to_after;
  end if;

  -- THE LEDGER. One row, every time. balance_after is null on purpose: this
  -- movement never touches clubs.chip_treasury, and that column is the BANK's
  -- running balance. The wallet figures ride in metadata.
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
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    return jsonb_build_object(
      'success', true, 'replayed', true,
      'transaction_id', v_prior.id,
      'amount', v_prior.amount,
      'destination', v_prior.metadata ->> 'destination',
      'sender_promo_after', (v_prior.metadata ->> 'sender_promo_after')::numeric,
      'recipient_balance_after', (v_prior.metadata ->> 'recipient_balance_after')::numeric);
end
$$;

revoke all on function public.fn_promo_wallet_send(uuid, uuid, numeric, text, text, uuid) from public, anon;
grant execute on function public.fn_promo_wallet_send(uuid, uuid, numeric, text, text, uuid) to authenticated, service_role;

-- ── 3. fn_my_wallet_ledger — a member's OWN statement ────────────────────────
-- auth.uid() scoped. It reads only rows the caller is a party to, so any
-- active member may call it — there is nothing here that is not already
-- theirs. Powers the Player Wallet detail view.
create or replace function public.fn_my_wallet_ledger(
  p_club_id uuid,
  p_limit int default 40,
  p_offset int default 0
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid := auth.uid();
  v_limit   int := least(greatest(coalesce(p_limit, 40), 1), 200);
  v_offset  int := greatest(coalesce(p_offset, 0), 0);
  v_role    text;
  v_chips   numeric := 0;
  v_agent_wallet numeric := 0;
  v_promo_wallet numeric := 0;
  v_total   bigint;
  v_in      numeric;
  v_out     numeric;
  v_rows    jsonb;
begin
  if v_actor is null then
    return jsonb_build_object('authorized', false, 'error', 'Not Authenticated');
  end if;

  select cm.role, coalesce(cm.chip_balance, 0) into v_role, v_chips
    from club_members cm
   where cm.club_id = p_club_id
     and cm.user_id = v_actor
     and coalesce(cm.status, 'active') in ('active', 'approved')
   limit 1;
  if v_role is null then
    -- The club's own owner_id counts even without a membership row, the same
    -- precedence fn_club_bank_role gives it.
    if exists (select 1 from clubs c where c.id = p_club_id and c.owner_id = v_actor) then
      v_role := 'owner';
    else
      return jsonb_build_object('authorized', false,
        'error', 'You Are Not An Active Member Of This Club');
    end if;
  end if;

  select coalesce(a.agent_wallet_balance, 0), coalesce(a.promo_wallet_balance, 0)
    into v_agent_wallet, v_promo_wallet
    from agents a
   where a.club_id = p_club_id and a.user_id = v_actor;

  select count(*),
         coalesce(sum(t.amount) filter (where t.to_user_id = v_actor), 0),
         coalesce(sum(t.amount) filter (where t.from_user_id = v_actor), 0)
    into v_total, v_in, v_out
    from chip_transactions t
   where t.club_id = p_club_id
     and (t.from_user_id = v_actor or t.to_user_id = v_actor);

  select coalesce(jsonb_agg(r order by r->>'created_at' desc), '[]'::jsonb) into v_rows
  from (
    select jsonb_build_object(
             'id', t.id,
             'created_at', t.created_at,
             'amount', round(coalesce(t.amount, 0), 2),
             'transaction_type', t.transaction_type,
             'notes', t.notes,
             'metadata', coalesce(t.metadata, '{}'::jsonb),
             'is_reversed', coalesce(t.is_reversed, false),
             'direction', case when t.to_user_id = v_actor then 'in' else 'out' end,
             'from_name', coalesce(pf.display_name, pf.username, pf.full_name),
             'to_name', coalesce(pt.display_name, pt.username, pt.full_name)
           ) as r
      from chip_transactions t
      left join profiles pf on pf.id = t.from_user_id
      left join profiles pt on pt.id = t.to_user_id
     where t.club_id = p_club_id
       and (t.from_user_id = v_actor or t.to_user_id = v_actor)
     order by t.created_at desc
     limit v_limit offset v_offset
  ) s;

  return jsonb_build_object(
    'authorized', true,
    'role', v_role,
    'total', v_total,
    'limit', v_limit,
    'offset', v_offset,
    'balances', jsonb_build_object(
      'player_wallet', round(v_chips, 2),
      'agent_wallet', round(v_agent_wallet, 2),
      'promo_wallet', round(v_promo_wallet, 2)),
    'totals', jsonb_build_object(
      'received', round(v_in, 2),
      'sent', round(v_out, 2),
      'net', round(v_in - v_out, 2)),
    'rows', v_rows);
end
$$;

revoke all on function public.fn_my_wallet_ledger(uuid, int, int) from public, anon;
grant execute on function public.fn_my_wallet_ledger(uuid, int, int) to authenticated, service_role;

-- ── 4. The bank's own totals must count claims as money INTO the bank ────────
do $mig$
declare
  v_def text;
  v_old text := $q$'mint', 'club_bank_reversal', 'treasury_credit'$q$;
  v_new text := $q$'mint', 'club_bank_reversal', 'treasury_credit', 'club_bank_claim'$q$;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_club_bank_ledger';
  if v_def is null then
    raise exception 'fn_club_bank_ledger not found';
  end if;
  if position('club_bank_claim' in v_def) > 0 then
    raise notice 'ledger already counts club_bank_claim - nothing to do';
    return;
  end if;
  if position(v_old in v_def) = 0 then
    raise exception 'into-the-bank filter not found in fn_club_bank_ledger - refusing to patch';
  end if;
  v_def := replace(v_def, v_old, v_new);
  execute v_def;
end $mig$;

-- ── 5. Guard allowlist ───────────────────────────────────────────────────────
do $mig$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'guard_wallet_balance_write';
  if v_def is null or position('fn_club_bank_claim_back' in v_def) > 0 then return; end if;
  v_def := replace(v_def, '''fn_club_bank_send''', '''fn_club_bank_send'',
    ''fn_club_bank_claim_back'', ''fn_promo_wallet_send''');
  execute v_def;
end $mig$;

-- ── POST-APPLY ASSERTIONS ────────────────────────────────────────────────────
do $assert$
declare v_src text; v_bad int := 0;
begin
  if to_regprocedure('public.fn_club_bank_claim_back(uuid,uuid,numeric,text,text,uuid)') is null then
    raise exception 'fn_club_bank_claim_back missing';
  end if;
  if to_regprocedure('public.fn_promo_wallet_send(uuid,uuid,numeric,text,text,uuid)') is null then
    raise exception 'fn_promo_wallet_send missing';
  end if;
  if to_regprocedure('public.fn_my_wallet_ledger(uuid,int,int)') is null then
    raise exception 'fn_my_wallet_ledger missing';
  end if;
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public'
                    and indexname = 'chip_transactions_wallet_ops_op_id_uidx') then
    raise exception 'wallet ops op_id unique index missing - idempotency is not enforced';
  end if;
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_club_bank_ledger';
  if position('club_bank_claim' in v_src) = 0 then
    raise warning 'bank ledger does not count club_bank_claim as into-the-bank';
    v_bad := v_bad + 1;
  end if;
  if v_bad > 0 then
    raise exception 'claim back / promo send migration failed % assertion(s)', v_bad;
  end if;
end $assert$;
