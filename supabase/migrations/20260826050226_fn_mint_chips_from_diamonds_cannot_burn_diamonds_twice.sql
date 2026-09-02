-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826050226; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- A mint burns diamonds and creates chips. It had no idempotency key at all,
-- so a response lost on the way back was indistinguishable from a mint that
-- never ran, and the retry a user naturally makes burned the diamonds and
-- created the chips a second time.
--
-- WHY AN ADVISORY LOCK AND NOT JUST THE UNIQUE INDEX. The other money paths
-- write their ledger row and let a unique_violation tell them they were
-- second. That is not enough here: deduct_diamonds runs BEFORE the ledger
-- insert, and an exception caught inside a sub-block rolls back only to the
-- start of that block - the diamonds would already be gone. So two callers
-- carrying the same op id are serialised on an advisory lock taken before the
-- deduction, and the second one finds the first's committed row and returns
-- it. The unique index stays as the backstop.
--
-- The old two-argument version is dropped rather than left beside the new one:
-- an overload would keep the unguarded body live for every caller that did not
-- know to pass a key.
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
