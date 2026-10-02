-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260725145055 "commander_missing_rpc_functions"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 74e42eec92e42a2ee3cb0454a292c77e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Commander audit 2026-07-25: six RPCs referenced by production code that
-- never existed. Signatures match the existing call sites exactly.
-- Tier 2: new functions only.

-- 1. Atomic hand-count increment (pages/api/dealer/hand-count.js)
create or replace function public.increment_table_hands(p_table_id uuid)
returns integer
language sql
security definer
set search_path = public
as $$
  update commander_tables
     set hands_dealt = coalesce(hands_dealt, 0) + 1
   where id = p_table_id
  returning hands_dealt;
$$;

-- 2. Leaderboard rank recompute (pages/api/leaderboards/[id]/entries.js)
create or replace function public.update_leaderboard_rankings(lb_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update commander_leaderboard_entries e
     set rank = r.rnk
    from (
      select id, rank() over (order by score desc nulls last) as rnk
        from commander_leaderboard_entries
       where leaderboard_id = lb_id
    ) r
   where e.id = r.id;
$$;

-- 3. Manual comp issue/adjustment (pages/api/comps/transactions.js)
create or replace function public.issue_manual_comp(
  p_venue_id integer,
  p_player_id uuid,
  p_amount numeric,
  p_description text,
  p_staff_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance commander_comp_balances%rowtype;
  v_before numeric := 0;
  v_after numeric := 0;
  v_txn_id uuid;
begin
  if p_amount = 0 then
    raise exception 'Amount must be non-zero';
  end if;

  select * into v_balance
    from commander_comp_balances
   where venue_id = p_venue_id and player_id = p_player_id
   for update;

  if found then
    if v_balance.is_frozen then
      raise exception 'Player comp balance is frozen';
    end if;
    v_before := coalesce(v_balance.current_balance, 0);
    v_after := v_before + p_amount;
    if v_after < 0 then
      raise exception 'Insufficient comp balance for adjustment';
    end if;
    update commander_comp_balances
       set current_balance = v_after,
           lifetime_earned = coalesce(lifetime_earned,0) + greatest(p_amount, 0),
           lifetime_adjusted = coalesce(lifetime_adjusted,0) + least(p_amount, 0),
           last_earned_at = case when p_amount > 0 then now() else last_earned_at end,
           updated_at = now()
     where id = v_balance.id;
  else
    if p_amount < 0 then
      raise exception 'Insufficient comp balance for adjustment';
    end if;
    v_before := 0;
    v_after := p_amount;
    insert into commander_comp_balances (venue_id, player_id, current_balance, lifetime_earned, last_earned_at, updated_at)
    values (p_venue_id, p_player_id, p_amount, p_amount, now(), now())
    returning * into v_balance;
  end if;

  insert into commander_comp_transactions
    (venue_id, player_id, balance_id, transaction_type, amount, balance_before, balance_after,
     source_type, approved_by, description, created_at)
  values
    (p_venue_id, p_player_id, v_balance.id,
     case when p_amount >= 0 then 'manual' else 'adjustment' end,
     p_amount, v_before, v_after, 'manual', p_staff_id, p_description, now())
  returning id into v_txn_id;

  return v_txn_id;
end;
$$;

-- 4. Comp redemption (pages/api/comps/redeem.js)
create or replace function public.redeem_comps(
  p_venue_id integer,
  p_player_id uuid,
  p_amount numeric,
  p_redemption_type text,
  p_description text,
  p_staff_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance commander_comp_balances%rowtype;
  v_before numeric;
  v_after numeric;
  v_txn_id uuid;
  v_redemption_id uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be positive';
  end if;

  select * into v_balance
    from commander_comp_balances
   where venue_id = p_venue_id and player_id = p_player_id
   for update;

  if not found then
    raise exception 'Insufficient comp balance';
  end if;
  if v_balance.is_frozen then
    raise exception 'Player comp balance is frozen';
  end if;
  v_before := coalesce(v_balance.current_balance, 0);
  if v_before < p_amount then
    raise exception 'Insufficient comp balance (available: %)', v_before;
  end if;
  v_after := v_before - p_amount;

  update commander_comp_balances
     set current_balance = v_after,
         lifetime_redeemed = coalesce(lifetime_redeemed,0) + p_amount,
         last_redeemed_at = now(),
         updated_at = now()
   where id = v_balance.id;

  insert into commander_comp_transactions
    (venue_id, player_id, balance_id, transaction_type, amount, balance_before, balance_after,
     source_type, approved_by, description, created_at)
  values
    (p_venue_id, p_player_id, v_balance.id, 'redemption', -p_amount, v_before, v_after,
     'redemption', p_staff_id, p_description, now())
  returning id into v_txn_id;

  insert into commander_comp_redemptions
    (transaction_id, venue_id, player_id, redemption_type, comp_amount, cash_value,
     description, processed_by, processed_at, status, created_at)
  values
    (v_txn_id, p_venue_id, p_player_id, p_redemption_type, p_amount, p_amount,
     p_description, p_staff_id, now(), 'completed', now())
  returning id into v_redemption_id;

  return v_redemption_id;
end;
$$;

-- 5. Home game completion stats (pages/api/home-games/events/[id].js)
create or replace function public.increment_home_game_stats(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group_id uuid;
  v_host_id uuid;
begin
  select group_id, host_id into v_group_id, v_host_id
    from commander_home_games where id = p_game_id;
  if v_group_id is null then
    return;
  end if;

  -- Attendance for confirmed yes-RSVPs
  update commander_home_members m
     set games_attended = coalesce(m.games_attended,0) + 1,
         last_attended = now()
   where m.group_id = v_group_id
     and m.user_id in (
       select r.user_id from commander_home_rsvps r
        where r.game_id = p_game_id and r.response = 'yes'
     );

  -- Host credit
  update commander_home_members m
     set games_hosted = coalesce(m.games_hosted,0) + 1
   where m.group_id = v_group_id and m.user_id = v_host_id;

  update commander_home_groups g
     set games_hosted = coalesce(g.games_hosted,0) + 1,
         last_activity_at = now()
   where g.id = v_group_id;
end;
$$;

-- 6. Health metric recording (commander-shared errorMonitoring.js)
create or replace function public.record_health_metric(
  p_venue_id integer,
  p_metric_type text,
  p_metric_value numeric,
  p_metric_unit text default 'count',
  p_endpoint text default null,
  p_details jsonb default null
) returns void
language sql
security definer
set search_path = public
as $$
  insert into commander_system_health (venue_id, metric_type, metric_value, metric_unit, endpoint, details, recorded_at)
  values (p_venue_id, p_metric_type, p_metric_value, p_metric_unit, p_endpoint, p_details, now());
$$;

do $$
declare fn text;
begin
  foreach fn in array array['increment_table_hands','update_leaderboard_rankings','issue_manual_comp','redeem_comps','increment_home_game_stats','record_health_metric'] loop
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=fn) then
      raise exception 'function % was not created', fn;
    end if;
  end loop;
end $$;
