-- ═══════════════════════════════════════════════════════════════════════════
--  THE FOUR MONEY PATHS THAT COULD RUN TWICE, AND THE ONE THAT DESTROYED CHIPS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Applied to production 2026-08-26 in five parts, each proved inside a
-- self-rolling-back transaction before this file was written. Recorded here so
-- the repo history matches the database.
--
-- ─────────────────────────────────────────────────────────────────────────
-- A. A SEND COULD DESTROY CHIPS IN THE ROUNDING
--
-- p_amount is unbounded-scale numeric, and the two sides of a transfer do NOT
-- share a scale: agents.agent_wallet_balance is numeric(18,4) and
-- club_members.chip_balance is numeric(20,2). An amount like 10.00005 was
-- debited as 10.0001 and credited as 10.00 - a ten-thousandth of a chip gone
-- on every call, and invisible to reconcile_ledger_nightly, which compares the
-- ledger against stored balances that were both written by the same rounded
-- arithmetic.
--
-- The cashier refuses fractions, but a dropdown is not a rule: anything
-- holding a session calls the RPC directly. Two decimal places is the coarser
-- of the two columns, so a value that survives the guard survives both stores
-- intact.
--
-- PROVED LIVE, ROLLED BACK:
--   10.00005 -> {"error": "Chips Move In Hundredths At Most", "success": false}
--   10.25    -> success, amount 10.25
--
-- ─────────────────────────────────────────────────────────────────────────
-- B. THREE MONEY TYPES SAT OUTSIDE EVERY IDEMPOTENCY INDEX
--
-- Three partial unique indexes already made a replay safe for the agent
-- wallet, the club bank and the promo wallet. admin_removal, mint and
-- cashout_expired_refund were in none of them, so a retry after a lost
-- response moved chips twice.
--
-- Note the type name: the mint writes 'mint', not 'chip_mint'. 'chip_mint' is
-- the CATEGORY deduct_diamonds stamps on the diamond side. An index on a type
-- nobody writes protects nothing, which is why this file drops and recreates
-- the index rather than adding a second one.
--
-- ─────────────────────────────────────────────────────────────────────────
-- C. fn_admin_remove_player_chips - THE ONE STAFF PATH WITH NO KEY
--
-- Every sibling took p_op_id and settled a replay on a unique index; this one
-- did not, so a response lost on the way back was indistinguishable from a
-- pull that never happened and the natural retry took the chips again.
--
-- The four-argument version is DROPPED rather than left beside the new one: an
-- overload would keep the unguarded body live for every caller that did not
-- know to pass a key. p_op_id defaults to null, so a client still passing four
-- named arguments resolves here and simply gets a generated key.
--
-- Also added while the body was open: the same hundredths guard as (A), since
-- club_members.chip_balance and clubs.chip_treasury do not share a scale
-- either, and a notification - staff pulling chips is the one movement that
-- happens to a member without them asking for it.
--
-- PROVED LIVE, ROLLED BACK:
--   call 1 : {"removed": 300, "success": true, "replayed": false, ...}
--   retry  : {"removed": 300.00, "success": true, "replayed": true, ...}
--   fraction 1.005 : {"error": "Chips Move In Hundredths At Most"}
--   player balance 377258.21 -> 376958.21 (delta -300.00)
--   ledger rows for this op_id: 1
--
-- ─────────────────────────────────────────────────────────────────────────
-- D. fn_mint_chips_from_diamonds - A RETRY BURNED THE DIAMONDS AGAIN
--
-- No idempotency key at all, on a function that burns diamonds and creates
-- chips.
--
-- WHY AN ADVISORY LOCK AND NOT JUST THE UNIQUE INDEX. Every other money path
-- writes its ledger row and lets a unique_violation tell it that it was
-- second. That is not enough here: deduct_diamonds runs BEFORE the ledger
-- insert, and an exception caught inside a sub-block rolls back only to the
-- start of that block - the diamonds would already be gone. So two callers
-- carrying the same op id serialise on an advisory lock taken before the
-- deduction, and the second finds the first's committed row. The unique index
-- stays as the backstop.
--
-- PROVED LIVE, ROLLED BACK (union branch - all three production clubs are in
-- unions, so the standalone branch has no fixture and was reasoned about
-- rather than executed):
--   call 1 : {"chips": 100, "success": true, "replayed": false, ...}
--   retry  : {"chips": 100.00, "success": true, "replayed": true, ...}
--   minter diamonds 493239 -> 493238 (delta -1, not -2)
--   union bank 139746.28 -> 139846.28 (delta +100.00, not +200)
--   ledger rows for this op_id: 1
--
-- ─────────────────────────────────────────────────────────────────────────
-- E. THE SUPERSEDED CASHIER WAS STILL CALLABLE BY ANY SESSION
--
-- fn_cashier_send_chips and fn_cashier_claim_back are the OLD cashier: they
-- move club_members.chip_balance to club_members.chip_balance and never touch
-- agents.agent_wallet_balance at all. Dan's rule is that every send and every
-- claim back transacts from the agent wallet.
--
-- The client stopped calling them and two test files pin them as dead. Dead in
-- the client is not dead: both still carried EXECUTE for `authenticated`, so
-- any session could move chips along a path with no agent wallet, no ten
-- minute window and no downline edge. A rule enforced only by which function
-- the UI happens to call is not enforced.
--
-- REVOKE rather than DROP: dropping loses the body, and the ledger rows they
-- wrote still reference their vocabulary. service_role keeps EXECUTE; nothing
-- in server/ or the World Hub API calls either one.

-- ── A ─────────────────────────────────────────────────────────────────────
do $migrate$
declare
  v_fn text; v_def text; v_new text; v_anchor text; v_added text;
  v_patched int := 0;
begin
  v_anchor :=
    '  if p_amount is null or p_amount <= 0 then' || E'\n' ||
    '    return jsonb_build_object(''success'', false, ''error'', ''Amount Must Be Greater Than Zero'');' || E'\n' ||
    '  end if;';

  v_added := v_anchor || E'\n\n' ||
    '  if p_amount <> round(p_amount, 2) then' || E'\n' ||
    '    return jsonb_build_object(''success'', false,' || E'\n' ||
    '      ''error'', ''Chips Move In Hundredths At Most'');' || E'\n' ||
    '  end if;';

  foreach v_fn in array array['fn_agent_wallet_send', 'fn_club_bank_send', 'fn_promo_wallet_send']
  loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fn;
    if v_def is null then
      raise exception '% not found - refusing to guess', v_fn;
    end if;
    if position('Chips Move In Hundredths At Most' in v_def) > 0 then
      continue;   -- already carrying it; do not double-insert
    end if;
    if position(v_anchor in v_def) = 0 then
      raise exception 'amount guard not found in % - refusing to patch blind', v_fn;
    end if;
    v_new := replace(v_def, v_anchor, v_added);
    if v_new = v_def then
      raise exception 'replacement was a no-op in % - refusing to ship an unchanged function', v_fn;
    end if;
    execute v_new;
    v_patched := v_patched + 1;
  end loop;
end
$migrate$;

-- ── B ─────────────────────────────────────────────────────────────────────
drop index if exists public.chip_transactions_staff_ops_op_id_uidx;

create unique index chip_transactions_staff_ops_op_id_uidx
  on public.chip_transactions (club_id, ((metadata ->> 'op_id')))
  where transaction_type = any (array['admin_removal', 'mint', 'cashout_expired_refund'])
    and metadata ? 'op_id';

-- ── E ─────────────────────────────────────────────────────────────────────
revoke execute on function public.fn_cashier_send_chips(uuid, uuid, numeric, text, text) from authenticated;
revoke execute on function public.fn_cashier_claim_back(uuid, uuid, numeric, text, text) from authenticated;

-- ── C ─────────────────────────────────────────────────────────────────────
drop function if exists public.fn_admin_remove_player_chips(uuid, uuid, numeric, text);

create or replace function public.fn_admin_remove_player_chips(
  p_club_id uuid,
  p_player_id uuid,
  p_amount numeric,
  p_reason text default null::text,
  p_op_id uuid default null::uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_actor      uuid := auth.uid();
  v_op_id      uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior      record;
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

  -- The same rounding trap the send functions carry: club_members.chip_balance
  -- is numeric(20,2) and clubs.chip_treasury is not, so an amount finer than a
  -- hundredth is debited and credited at different scales.
  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('success', false, 'error', 'Chips Move In Hundredths At Most');
  end if;

  select id, amount, metadata into v_prior
    from chip_transactions
   where transaction_type = 'admin_removal'
     and club_id = p_club_id
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object('success', true, 'replayed', true,
      'removed', v_prior.amount,
      'balance_after', (v_prior.metadata ->> 'holder_balance_after')::numeric,
      'bank_after', (v_prior.metadata ->> 'bank_after')::numeric);
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

  begin
    insert into chip_transactions
      (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
    values
      (p_club_id, p_player_id, v_actor, p_amount, 'admin_removal',
       coalesce(nullif(btrim(p_reason), ''), 'Chips Pulled By Club Staff'),
       jsonb_build_object(
         'op_id', v_op_id,
         'source', 'player_wallet',
         'direction', 'into_bank',
         'actor_role', v_actor_role,
         'holder_balance_after', v_after,
         'bank_after', v_bank_after),
       v_bank_after);
  exception when unique_violation then
    select id, amount, metadata into v_prior
      from chip_transactions
     where transaction_type = 'admin_removal'
       and club_id = p_club_id
       and metadata ->> 'op_id' = v_op_id::text
     limit 1;
    return jsonb_build_object('success', true, 'replayed', true,
      'removed', v_prior.amount,
      'balance_after', (v_prior.metadata ->> 'holder_balance_after')::numeric,
      'bank_after', (v_prior.metadata ->> 'bank_after')::numeric);
  end;

  -- The member is told. Staff pulling chips is the one movement that happens
  -- to a player without them asking for it.
  insert into notifications (user_id, type, title, message, metadata, actor_id)
  values (p_player_id, 'settlement', 'Chips Removed By Club Staff',
          trim(to_char(p_amount, 'FM999,999,999,990')) || ' Chips Were Removed From Your Wallet',
          jsonb_build_object('clubId', p_club_id, 'amount', p_amount,
                             'balanceAfter', v_after),
          v_actor);

  return jsonb_build_object('success', true, 'replayed', false, 'removed', p_amount,
    'balance_before', v_before, 'balance_after', v_after, 'bank_after', v_bank_after);
end
$function$;

grant execute on function public.fn_admin_remove_player_chips(uuid, uuid, numeric, text, uuid) to authenticated;

-- ── D ─────────────────────────────────────────────────────────────────────
drop function if exists public.fn_mint_chips_from_diamonds(uuid, numeric);

create or replace function public.fn_mint_chips_from_diamonds(
  p_club_id uuid,
  p_diamonds numeric,
  p_op_id uuid default null::uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_actor uuid := auth.uid();
  v_op_id uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior record;
  v_diamonds numeric;
  v_chips numeric;
  v_deduct jsonb;
  v_diamonds_after numeric;
  v_club record;
  v_is_union_minter boolean := false;
  v_pool_after numeric;
  v_union_bank_after numeric;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;
  if p_diamonds is null or p_diamonds <= 0 or p_diamonds <> floor(p_diamonds) then
    return jsonb_build_object('success', false, 'error', 'Diamonds Must Be A Positive Whole Number');
  end if;
  if p_diamonds > 1000000 then
    return jsonb_build_object('success', false, 'error', 'Maximum 1,000,000 Diamonds Per Mint');
  end if;

  -- Serialise anyone carrying this op id, BEFORE a single diamond is spent.
  -- Held to commit, so the second caller waits and then reads the first's row.
  perform pg_advisory_xact_lock(hashtextextended(p_club_id::text || ':' || v_op_id::text, 0));

  select amount, transaction_type, metadata, balance_after into v_prior
    from chip_transactions
   where transaction_type = 'mint'
     and club_id = p_club_id
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object('success', true, 'replayed', true,
      'scope', v_prior.metadata ->> 'scope',
      'chips', v_prior.amount,
      'diamonds_spent', (v_prior.metadata ->> 'diamonds_spent')::numeric,
      'diamonds_after', (select coalesce(diamonds, 0) from profiles where id = v_actor),
      'club_pool_after', case when (v_prior.metadata ->> 'scope') = 'club'
                              then v_prior.balance_after end,
      'union_bank_after', case when (v_prior.metadata ->> 'scope') = 'union'
                               then v_prior.balance_after end);
  end if;

  v_diamonds := p_diamonds;
  v_chips := v_diamonds * 100; -- THE RATE: 100 diamonds = 10,000 chips

  select id, name, union_id, owner_id into v_club
    from clubs where id = p_club_id for update;
  if v_club.id is null then
    return jsonb_build_object('success', false, 'error', 'That Club Could Not Be Found');
  end if;

  if v_club.union_id is not null then
    -- UNION CLUB: the club's own mint is revoked. Chips flow from the union.
    if exists (select 1 from unions u where u.id = v_club.union_id and u.owner_id = v_actor)
       or exists (select 1 from union_admins ua where ua.union_id = v_club.union_id and ua.user_id = v_actor) then
      v_is_union_minter := true;
    end if;
    if not v_is_union_minter then
      return jsonb_build_object('success', false,
        'error', 'Chip Mint Is Revoked For Clubs In A Union. Chips Flow From The Union. Ask Your Union Owner');
    end if;

    v_deduct := deduct_diamonds(
      v_actor, v_diamonds::integer,
      'Chip Mint: ' || v_chips::text || ' chips minted to union bank',
      'chip_mint', 'chip_mint',
      jsonb_build_object('club_id', p_club_id, 'union_id', v_club.union_id,
                         'chips', v_chips, 'op_id', v_op_id),
      null, 0);
    if coalesce((v_deduct->>'success')::boolean, false) = false then
      return jsonb_build_object('success', false,
        'error', coalesce(v_deduct->>'error', 'That Diamond Deduction Did Not Go Through'));
    end if;
    select coalesce(diamonds, 0) into v_diamonds_after from profiles where id = v_actor;

    insert into union_wallets (union_id, chip_balance)
    values (v_club.union_id, v_chips)
    on conflict (union_id)
    do update set chip_balance = coalesce(union_wallets.chip_balance, 0) + v_chips,
                  updated_at = now();
    select chip_balance into v_union_bank_after
      from union_wallets where union_id = v_club.union_id;

    insert into chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
    values (p_club_id, v_actor, null, v_chips, 'mint',
            'Union Chip Mint: ' || v_chips::text || ' chips from ' || v_diamonds::text || ' diamonds',
            jsonb_build_object('op_id', v_op_id, 'scope', 'union',
                               'diamonds_spent', v_diamonds, 'union_id', v_club.union_id),
            v_union_bank_after);

    return jsonb_build_object('success', true, 'replayed', false, 'scope', 'union',
      'chips', v_chips, 'diamonds_spent', v_diamonds,
      'diamonds_after', v_diamonds_after, 'union_bank_after', v_union_bank_after);
  else
    -- STANDALONE CLUB: owner / co_owner / admin may mint into the club's pool.
    if not (v_club.owner_id = v_actor
            or exists (select 1 from club_members cm
                        where cm.club_id = p_club_id and cm.user_id = v_actor
                          and cm.role in ('owner', 'co_owner', 'admin')
                          and cm.status = 'active')) then
      return jsonb_build_object('success', false,
        'error', 'Only The Club Owner Or An Admin May Mint Chips');
    end if;

    v_deduct := deduct_diamonds(
      v_actor, v_diamonds::integer,
      'Chip Mint: ' || v_chips::text || ' chips minted to club bank',
      'chip_mint', 'chip_mint',
      jsonb_build_object('club_id', p_club_id, 'chips', v_chips, 'op_id', v_op_id),
      null, 0);
    if coalesce((v_deduct->>'success')::boolean, false) = false then
      return jsonb_build_object('success', false,
        'error', coalesce(v_deduct->>'error', 'That Diamond Deduction Did Not Go Through'));
    end if;
    select coalesce(diamonds, 0) into v_diamonds_after from profiles where id = v_actor;

    update clubs set chip_treasury = coalesce(chip_treasury, 0) + v_chips, updated_at = now()
     where id = p_club_id
     returning chip_treasury into v_pool_after;

    insert into chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
    values (p_club_id, v_actor, null, v_chips, 'mint',
            'Chip Mint: ' || v_chips::text || ' chips from ' || v_diamonds::text || ' diamonds',
            jsonb_build_object('op_id', v_op_id, 'scope', 'club',
                               'diamonds_spent', v_diamonds),
            v_pool_after);

    return jsonb_build_object('success', true, 'replayed', false, 'scope', 'club',
      'chips', v_chips, 'diamonds_spent', v_diamonds,
      'diamonds_after', v_diamonds_after, 'club_pool_after', v_pool_after);
  end if;
end
$function$;

grant execute on function public.fn_mint_chips_from_diamonds(uuid, numeric, uuid) to authenticated;

-- ── Proof, in the same transaction as the change ──────────────────────────
do $verify$
declare v_fn text; v_def text;
begin
  foreach v_fn in array array['fn_agent_wallet_send', 'fn_club_bank_send', 'fn_promo_wallet_send']
  loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fn;
    if position('round(p_amount, 2)' in v_def) = 0 then
      raise exception '% can still destroy chips in the rounding', v_fn;
    end if;
    if position('Amount Must Be Greater Than Zero' in v_def) = 0 then
      raise exception 'the zero guard was lost from %', v_fn;
    end if;
  end loop;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'chip_transactions_staff_ops_op_id_uidx'
       and indexdef like '%''mint''%'
  ) then
    raise exception 'the staff idempotency index does not cover the type the mint writes';
  end if;

  foreach v_fn in array array['fn_cashier_send_chips', 'fn_cashier_claim_back']
  loop
    if exists (
      select 1 from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace,
        lateral aclexplode(p.proacl) a
       where n.nspname = 'public' and p.proname = v_fn
         and a.grantee = 'authenticated'::regrole
         and a.privilege_type = 'EXECUTE'
    ) then
      raise exception '% is still callable by any session', v_fn;
    end if;
  end loop;
end
$verify$;
