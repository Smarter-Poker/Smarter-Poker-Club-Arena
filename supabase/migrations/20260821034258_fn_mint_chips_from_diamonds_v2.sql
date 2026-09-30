-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821034258 "fn_mint_chips_from_diamonds_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 50b0bfea66b26bfad534522e6df6e3f1 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- CHIP MINT v2 (Dan 2026-08-21): profiles.diamonds is protected by its own
-- server-managed guard - diamond debits must flow through the whitelisted
-- deduct_diamonds(). v1 wrote profiles directly and 42501'd. v2 routes the
-- burn through deduct_diamonds (which also writes the diamond_transactions
-- audit row itself). Chip-side logic unchanged: 1 diamond = 100 chips;
-- standalone club -> clubs.chip_pool; union club -> union owner/admin only,
-- into union_wallets.chip_balance; member-club mint revoked.
-- ROLLBACK: drop function public.fn_mint_chips_from_diamonds(uuid, numeric);

create or replace function public.fn_mint_chips_from_diamonds(
  p_club_id uuid,
  p_diamonds numeric
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
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
    return jsonb_build_object('success', false, 'error', 'not authenticated');
  end if;
  if p_diamonds is null or p_diamonds <= 0 or p_diamonds <> floor(p_diamonds) then
    return jsonb_build_object('success', false, 'error', 'diamonds must be a positive whole number');
  end if;
  if p_diamonds > 1000000 then
    return jsonb_build_object('success', false, 'error', 'maximum 1,000,000 diamonds per mint');
  end if;
  v_diamonds := p_diamonds;
  v_chips := v_diamonds * 100; -- THE RATE: 100 diamonds = 10,000 chips

  select id, name, union_id, owner_id into v_club
    from clubs where id = p_club_id for update;
  if v_club.id is null then
    return jsonb_build_object('success', false, 'error', 'club not found');
  end if;

  if v_club.union_id is not null then
    -- UNION CLUB: the club's own mint is revoked. Chips flow from the union.
    if exists (select 1 from unions u where u.id = v_club.union_id and u.owner_id = v_actor)
       or exists (select 1 from union_admins ua where ua.union_id = v_club.union_id and ua.user_id = v_actor) then
      v_is_union_minter := true;
    end if;
    if not v_is_union_minter then
      return jsonb_build_object('success', false,
        'error', 'Chip Mint is revoked for clubs in a union - chips flow from the union. Ask your union owner.');
    end if;

    v_deduct := deduct_diamonds(
      v_actor, v_diamonds::integer,
      'Chip Mint: ' || v_chips::text || ' chips minted to union bank',
      'chip_mint', 'chip_mint',
      jsonb_build_object('club_id', p_club_id, 'union_id', v_club.union_id, 'chips', v_chips),
      null, 0);
    if coalesce((v_deduct->>'success')::boolean, false) = false then
      return jsonb_build_object('success', false,
        'error', coalesce(v_deduct->>'error', 'diamond deduction failed'));
    end if;
    select coalesce(diamonds, 0) into v_diamonds_after from profiles where id = v_actor;

    insert into union_wallets (union_id, chip_balance)
    values (v_club.union_id, v_chips)
    on conflict (union_id)
    do update set chip_balance = coalesce(union_wallets.chip_balance, 0) + v_chips,
                  updated_at = now();
    select chip_balance into v_union_bank_after
      from union_wallets where union_id = v_club.union_id;

    insert into chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after)
    values (p_club_id, v_actor, null, v_chips, 'mint',
            'Union Chip Mint: ' || v_chips::text || ' chips from ' || v_diamonds::text || ' diamonds',
            v_union_bank_after);

    return jsonb_build_object('success', true, 'scope', 'union',
      'chips', v_chips, 'diamonds_spent', v_diamonds,
      'diamonds_after', v_diamonds_after, 'union_bank_after', v_union_bank_after);
  else
    -- STANDALONE CLUB: owner / co_owner / admin may mint into the club's pool.
    if not (v_club.owner_id = v_actor
            or exists (select 1 from club_members cm
                        where cm.club_id = p_club_id and cm.user_id = v_actor
                          and cm.role in ('owner', 'co_owner', 'admin')
                          and cm.status = 'active')) then
      return jsonb_build_object('success', false, 'error', 'only the club owner or an admin may mint chips');
    end if;

    v_deduct := deduct_diamonds(
      v_actor, v_diamonds::integer,
      'Chip Mint: ' || v_chips::text || ' chips minted to club pool',
      'chip_mint', 'chip_mint',
      jsonb_build_object('club_id', p_club_id, 'chips', v_chips),
      null, 0);
    if coalesce((v_deduct->>'success')::boolean, false) = false then
      return jsonb_build_object('success', false,
        'error', coalesce(v_deduct->>'error', 'diamond deduction failed'));
    end if;
    select coalesce(diamonds, 0) into v_diamonds_after from profiles where id = v_actor;

    update clubs set chip_pool = coalesce(chip_pool, 0) + v_chips, updated_at = now()
     where id = p_club_id
     returning chip_pool into v_pool_after;

    insert into chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after)
    values (p_club_id, v_actor, null, v_chips, 'mint',
            'Chip Mint: ' || v_chips::text || ' chips from ' || v_diamonds::text || ' diamonds',
            v_pool_after);

    return jsonb_build_object('success', true, 'scope', 'club',
      'chips', v_chips, 'diamonds_spent', v_diamonds,
      'diamonds_after', v_diamonds_after, 'club_pool_after', v_pool_after);
  end if;
end
$$;
