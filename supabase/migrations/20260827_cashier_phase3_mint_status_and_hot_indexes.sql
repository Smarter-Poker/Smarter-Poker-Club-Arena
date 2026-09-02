-- ═══════════════════════════════════════════════════════════════════════════
-- CASHIER PHASE 3 — MINT STATUS FIX + HOT-PATH INDEXES (2026-08-27)
-- ───────────────────────────────────────────────────────────────────────────
-- Phase 3 of the send-out/claim-back audit. Companion client changes in the
-- same PR rewire the classic cashier's promo/distribute surfaces onto the
-- canonical RPCs (see .agent/audits/2026-08-27-cashier-phase3-audit.md).
--
--  1. fn_mint_chips_from_diamonds gated its standalone-club staff check on
--     status = 'active' alone — the same pre-2026-07-22 'approved' trap fixed
--     across five other functions in phases 1 and 2. A co-owner or admin whose
--     membership row carries the legacy word could not mint; the owner only
--     escaped it via clubs.owner_id. Both membership words now pass.
--
--  2. chip_transactions had NO club-scoped index: 221,955 rows and every
--     fn_club_bank_ledger page, every count and every type-filtered read did
--     a parallel seq scan (measured: 70ms, 15,487 buffers for one 40-row
--     page). (club_id, created_at desc) turns ledger paging into an index
--     walk.
--
--  3. tournament_tickets had holder- and club-scoped indexes but nothing on
--     issued_by, so the Tickets tab's issuer half (and the issuer Cancel
--     lookup in fn_cancel/fn_issue replay checks) scanned. Mirrored the
--     holder index.
--
-- ROLLBACK: drop the two indexes; restore the previous
-- fn_mint_chips_from_diamonds from 20260823_club_bank_cashier history.
-- ═══════════════════════════════════════════════════════════════════════════

create index if not exists idx_chip_tx_club_created
  on public.chip_transactions (club_id, created_at desc);

create index if not exists tournament_tickets_issuer_idx
  on public.tournament_tickets (issued_by, status, created_at desc);

create or replace function public.fn_mint_chips_from_diamonds(
  p_club_id uuid, p_diamonds numeric, p_op_id uuid default null
) returns jsonb
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
    -- BOTH membership words (2026-08-27): status='active' alone refused the
    -- ~98% of production rows still carrying the pre-2026-07-22 'approved',
    -- so a legacy-status co-owner or admin could never mint.
    if not (v_club.owner_id = v_actor
            or exists (select 1 from club_members cm
                        where cm.club_id = p_club_id and cm.user_id = v_actor
                          and cm.role in ('owner', 'co_owner', 'admin')
                          and coalesce(cm.status, 'active') in ('active', 'approved'))) then
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

-- ── Post-apply assertions ───────────────────────────────────────────────────
do $assert$
declare v_src text;
begin
  if not exists (select 1 from pg_indexes where indexname='idx_chip_tx_club_created') then
    raise exception 'ASSERT FAILED: idx_chip_tx_club_created missing';
  end if;
  if not exists (select 1 from pg_indexes where indexname='tournament_tickets_issuer_idx') then
    raise exception 'ASSERT FAILED: tournament_tickets_issuer_idx missing';
  end if;
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='fn_mint_chips_from_diamonds';
  if v_src not like '%in (''active'', ''approved'')%' then
    raise exception 'ASSERT FAILED: fn_mint_chips_from_diamonds still refuses approved staff';
  end if;
end $assert$;
