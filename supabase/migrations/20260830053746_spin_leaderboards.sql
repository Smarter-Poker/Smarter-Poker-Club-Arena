-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830053746; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  SPIN LEADERBOARDS (2026-08-29, round 15)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Three boards a spin player actually wants: the biggest multiplier hit, who
-- plays the most, and who is up the most. Aggregated HERE rather than in the
-- browser: at ~1,800 spins a day and three seats each, a client-side version
-- would page tens of thousands of rows to rank ten names.
--
-- HORSES ARE PLAYERS (CLAUDE.md 10.5). There is deliberately NO is_horse
-- filter anywhere in this function. A horse pays the same buy-in out of the
-- same club wallet and wins the same prize, so it ranks like anybody else.
--
-- Net is computed from the two facts that actually moved money for the game:
-- the prize credited on tournament_players.prize (the column rounds 9-10 made
-- trustworthy) minus the buy-in the player was charged. Spin fee is 0 by
-- construction, so buy_in_amount IS the price.
--
-- Read-only. SECURITY DEFINER so it can aggregate across players, with a
-- pinned search_path, and it exposes nothing but display names and totals.

create or replace function public.fn_spin_leaderboards(p_days integer default 7)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_since timestamptz := now() - make_interval(days => greatest(coalesce(p_days, 7), 1));
  v_biggest jsonb;
  v_most    jsonb;
  v_net     jsonb;
begin
  -- One pass over the window, reused by all three boards.
  create temp table if not exists _spin_lb (
    user_id uuid, username text, multiplier numeric,
    buy_in numeric, prize numeric, ended_at timestamptz
  ) on commit drop;
  delete from _spin_lb;

  insert into _spin_lb (user_id, username, multiplier, buy_in, prize, ended_at)
  select tp.user_id,
         coalesce(nullif(tp.username, ''), 'Player'),
         coalesce(t.spin_multiplier, 0),
         coalesce(t.buy_in_amount, 0),
         coalesce(tp.prize, 0),
         t.ended_at
    from public.tournaments t
    join public.tournament_players tp on tp.tournament_id = t.id
   where t.variant = 'spin'
     and t.status = 'COMPLETED'
     and t.ended_at is not null
     and t.ended_at >= v_since
     and tp.user_id is not null;

  -- BIGGEST HIT: the largest multiplier actually won (position 1 took it).
  select coalesce(jsonb_agg(x order by x.multiplier desc, x.ended_at desc), '[]'::jsonb)
    into v_biggest
    from (
      select l.username, l.multiplier, l.buy_in, l.prize, l.ended_at
        from _spin_lb l
       where l.prize > 0
       order by l.multiplier desc, l.ended_at desc
       limit 10
    ) x;

  -- MOST SPINS: volume over the window.
  select coalesce(jsonb_agg(x order by x.spins desc), '[]'::jsonb)
    into v_most
    from (
      select l.username, count(*) as spins
        from _spin_lb l
       group by l.username
       order by count(*) desc
       limit 10
    ) x;

  -- BEST NET: prizes won minus buy-ins paid, over the window.
  select coalesce(jsonb_agg(x order by x.net desc), '[]'::jsonb)
    into v_net
    from (
      select l.username,
             round(sum(l.prize) - sum(l.buy_in), 2) as net,
             count(*) as spins
        from _spin_lb l
       group by l.username
      having round(sum(l.prize) - sum(l.buy_in), 2) > 0
       order by round(sum(l.prize) - sum(l.buy_in), 2) desc
       limit 10
    ) x;

  return jsonb_build_object(
    'ok', true,
    'days', greatest(coalesce(p_days, 7), 1),
    'biggest_hits', v_biggest,
    'most_spins', v_most,
    'best_net', v_net
  );
end;
$function$;

-- A player reads their own room's boards, so `authenticated` may execute.
-- anon may not: the boards carry display names.
revoke all on function public.fn_spin_leaderboards(integer) from public, anon;
grant execute on function public.fn_spin_leaderboards(integer) to authenticated, service_role;

do $assert$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'fn_spin_leaderboards'
  ) then
    raise exception 'fn_spin_leaderboards did not get created';
  end if;
end;
$assert$;
