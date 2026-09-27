-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260823140329 "club_bank_ledger_and_mint_to_bank"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f1bda6a458017ff6bb2de79ce008f6df of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Club Bank Cashier (Dan 2026-08-23). Parts 2-5 of 20260823140000_club_bank_cashier.sql

-- 2. Standalone mint credits the CLUB BANK (clubs.chip_treasury), not chip_pool.
do $mig$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_mint_chips_from_diamonds';
  if v_def is null then
    raise exception 'fn_mint_chips_from_diamonds not found';
  end if;

  v_old := 'update clubs set chip_pool = coalesce(chip_pool, 0) + v_chips, updated_at = now()
     where id = p_club_id
     returning chip_pool into v_pool_after;';

  v_new := 'update clubs set chip_treasury = coalesce(chip_treasury, 0) + v_chips, updated_at = now()
     where id = p_club_id
     returning chip_treasury into v_pool_after;';

  if position(v_old in v_def) = 0 then
    if position('returning chip_treasury into v_pool_after' in v_def) > 0 then
      raise notice 'standalone mint already credits chip_treasury - nothing to do';
      return;
    end if;
    raise exception 'standalone mint UPDATE not found - refusing to patch';
  end if;

  v_def := replace(v_def, v_old, v_new);
  v_def := replace(v_def, 'chips minted to club pool', 'chips minted to club bank');
  execute v_def;
end $mig$;

-- 3. Full ledger, role-gated.
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
begin
  if not public.fn_can_use_club_bank(p_club_id) then
    return jsonb_build_object('authorized', false,
      'error', 'The Club Bank Ledger Is Restricted To Owners, Co Owners, Admins And Super Agents');
  end if;

  select count(*) into v_total
    from chip_transactions t
   where t.club_id = p_club_id
     and (p_types is null or t.transaction_type = any (p_types));

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
    'rows', v_rows);
end
$$;

revoke all on function public.fn_club_bank_ledger(uuid, int, int, text[]) from public, anon;
grant execute on function public.fn_club_bank_ledger(uuid, int, int, text[]) to authenticated, service_role;

-- 4. Panel returns club_rake_treasury for STANDALONE clubs.
do $mig$
declare
  v_def text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_club_money_panel';
  if v_def is null then
    raise exception 'fn_club_money_panel not found';
  end if;

  if position('club_rake_treasury' in v_def) > 0 then
    raise notice 'panel already returns club_rake_treasury - nothing to do';
    return;
  end if;

  v_old := '  IF v_union_id IS NULL THEN RETURN v_out; END IF;';

  v_new :=
'  IF v_union_id IS NULL THEN
    IF v_is_club_staff THEN
      SELECT round(COALESCE(w.period_rake_collected, 0), 2) INTO v_club_rake
        FROM club_wallets w WHERE w.club_id = p_club_id;
      IF FOUND THEN
        v_out := v_out || jsonb_build_object(''club_rake_treasury'', v_club_rake);
      END IF;
    END IF;
    RETURN v_out;
  END IF;';

  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'standalone early-return not found exactly once - refusing to patch';
  end if;

  v_def := replace(v_def, v_old, v_new);
  execute v_def;
end $mig$;

-- 5. Guard allowlist.
do $mig$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'guard_wallet_balance_write';
  if v_def is null then
    raise notice 'guard_wallet_balance_write not found - skipping allowlist update';
    return;
  end if;
  if position('fn_club_bank_send' in v_def) > 0 then
    raise notice 'already allowlisted';
    return;
  end if;
  v_def := replace(v_def,
    '''fn_mint_chips_from_diamonds''',
    '''fn_mint_chips_from_diamonds'',
    -- added 2026-08-23 with the Club Bank Cashier (Dan directive)
    ''fn_club_bank_send''');
  execute v_def;
end $mig$;

-- POST-APPLY ASSERTIONS
do $assert$
declare
  v_src text;
  v_bad int := 0;
begin
  if to_regprocedure('public.fn_club_bank_send(uuid,uuid,numeric,text,text)') is null then
    raise exception 'fn_club_bank_send missing';
  end if;
  if to_regprocedure('public.fn_club_bank_ledger(uuid,int,int,text[])') is null then
    raise exception 'fn_club_bank_ledger missing';
  end if;
  if to_regprocedure('public.fn_can_use_club_bank(uuid)') is null then
    raise exception 'fn_can_use_club_bank missing';
  end if;

  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_mint_chips_from_diamonds';
  if position('chip_treasury' in v_src) = 0 then
    raise warning 'standalone mint does not credit chip_treasury';
    v_bad := v_bad + 1;
  end if;
  if position('union_wallets' in v_src) = 0 then
    raise warning 'union mint branch was lost';
    v_bad := v_bad + 1;
  end if;

  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_club_money_panel';
  if position('club_rake_treasury' in v_src) = 0 then
    raise warning 'panel does not return club_rake_treasury';
    v_bad := v_bad + 1;
  end if;
  if position('union_rake_weekly' in v_src) = 0 then
    raise warning 'panel lost the rollup read from 20260823120000';
    v_bad := v_bad + 1;
  end if;

  if v_bad > 0 then
    raise exception 'club bank cashier migration failed % assertion(s)', v_bad;
  end if;
end $assert$;
