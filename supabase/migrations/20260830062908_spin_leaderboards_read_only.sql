-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830062908; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

create or replace function public.fn_spin_leaderboards(p_days integer default 7)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with win as (
    select greatest(coalesce(p_days, 7), 1) as days
  ),
  spins as (
    select coalesce(nullif(tp.username, ''), 'Player') as username,
           coalesce(t.spin_multiplier, 0)              as multiplier,
           coalesce(t.buy_in_amount, 0)                as buy_in,
           coalesce(tp.prize, 0)                       as prize,
           t.ended_at
      from public.tournaments t
      join public.tournament_players tp on tp.tournament_id = t.id
     cross join win
     where t.variant = 'spin'
       and t.status = 'COMPLETED'
       and t.ended_at is not null
       and t.ended_at >= now() - make_interval(days => win.days)
       and tp.user_id is not null
  ),
  biggest as (
    select s.username, s.multiplier, s.buy_in, s.prize, s.ended_at
      from spins s
     where s.prize > 0
     order by s.multiplier desc, s.ended_at desc
     limit 10
  ),
  most as (
    select s.username, count(*) as spins
      from spins s
     group by s.username
     order by count(*) desc
     limit 10
  ),
  net as (
    select s.username,
           round(sum(s.prize) - sum(s.buy_in), 2) as net,
           count(*)                               as spins
      from spins s
     group by s.username
    having round(sum(s.prize) - sum(s.buy_in), 2) > 0
     order by round(sum(s.prize) - sum(s.buy_in), 2) desc
     limit 10
  )
  select jsonb_build_object(
    'ok', true,
    'days', (select days from win),
    'biggest_hits',
      coalesce((select jsonb_agg(to_jsonb(b) order by b.multiplier desc, b.ended_at desc)
                  from biggest b), '[]'::jsonb),
    'most_spins',
      coalesce((select jsonb_agg(to_jsonb(m) order by m.spins desc) from most m), '[]'::jsonb),
    'best_net',
      coalesce((select jsonb_agg(to_jsonb(n) order by n.net desc) from net n), '[]'::jsonb)
  );
$function$;

revoke all on function public.fn_spin_leaderboards(integer) from public, anon;
grant execute on function public.fn_spin_leaderboards(integer) to authenticated, service_role;

do $assert$
declare
  v_vol text;
  v_ok  boolean;
begin
  select p.provolatile into v_vol
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_spin_leaderboards';

  if v_vol is null then
    raise exception 'fn_spin_leaderboards is missing';
  end if;

  if v_vol <> 's' then
    raise exception 'fn_spin_leaderboards must be STABLE, found provolatile=%', v_vol;
  end if;

  select (public.fn_spin_leaderboards(7) ->> 'ok')::boolean into v_ok;
  if not coalesce(v_ok, false) then
    raise exception 'fn_spin_leaderboards did not return ok';
  end if;
end;
$assert$;
