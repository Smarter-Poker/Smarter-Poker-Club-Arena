-- CHIP MINT (Dan 2026-08-21, BINDING): "UNIONS ARE WHERE ALL THE CHIPS FLOW
-- FROM. EVERY UNION SHOULD HAVE ITS OWN MINT - CONVERT DIAMONDS INTO CHIPS,
-- 100 DIAMONDS EQUALS 10,000 CHIPS. CREATE A CHIP MINT INSIDE OF ALL UNION
-- WALLETS, AND ALL STANDALONE CLUBS. IF A CLUB EVER JOINS THE UNION, THEIR
-- CHIP MINT GETS TURNED OFF AND REVOKED."
--
-- Applied to production via Supabase MCP apply_migration on 2026-08-21 in two
-- steps (fn_mint_chips_from_diamonds, then _v2 routing the diamond burn
-- through the whitelisted deduct_diamonds after the profiles guard refused
-- direct writes). This file records the FINAL state.
--
-- Also whitelists fn_mint_chips_from_diamonds in guard_wallet_balance_write
-- (clubs.chip_pool trigger guard).
--
-- Rate: 1 diamond = 100 chips. Routing by clubs.union_id:
--   NULL  -> standalone club mint (owner/co_owner/admin) into clubs.chip_pool
--   SET   -> club mint REVOKED; union owner/union_admins mint into
--            union_wallets.chip_balance (the union bank)
--
-- Verified live 2026-08-21: two 1-diamond mints as the union owner credited
-- union_wallets.chip_balance +100 each and burned exactly 2 diamonds.
--
-- ROLLBACK: drop function public.fn_mint_chips_from_diamonds(uuid, numeric);
--           remove the name from guard_wallet_balance_write's allowlist.

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

revoke all on function public.fn_mint_chips_from_diamonds(uuid, numeric) from public;
revoke all on function public.fn_mint_chips_from_diamonds(uuid, numeric) from anon;
grant execute on function public.fn_mint_chips_from_diamonds(uuid, numeric) to authenticated;
grant execute on function public.fn_mint_chips_from_diamonds(uuid, numeric) to service_role;
