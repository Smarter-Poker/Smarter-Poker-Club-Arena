-- ═══════════════════════════════════════════════════════════════════════════
--  fn_spin_leaderboards HAS NO BUSINESS WRITING ANYTHING (2026-08-30)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The first cut of this function collected its window into a TEMP table and
-- then read that three times:
--
--     create temp table if not exists _spin_lb (...) on commit drop;
--     delete from _spin_lb;
--     insert into _spin_lb (...) select ...
--
-- `check-definer-authorization` blocked the push, and it was RIGHT to. What
-- it sees is a SECURITY DEFINER function that a browser role can execute,
-- that runs INSERT and DELETE, and that never asks auth.uid() who is calling.
-- The guard cannot tell a temp table from a real one, and a guard that tried
-- to would be the wrong kind of clever: the shape it is looking for is
-- "definer + writes + reachable from a browser + no idea who is asking", and
-- that shape was genuinely present.
--
-- The honest answer is not an allowlist entry. It is that this function
-- should never have written anything. It is a leaderboard: three aggregates
-- over one window. CTEs express that directly, the temp table was only ever
-- a way of avoiding repeating the join, and one CTE avoids it just as well
-- without a DDL statement, a DELETE and an INSERT on every single call.
--
-- Behaviour is UNCHANGED - same window, same three boards, same ordering,
-- same shape. Still no `is_horse` filter anywhere: HORSES ARE PLAYERS
-- (CLAUDE.md 10.5), and a leaderboard is exactly where that gets "tidied up".

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
  -- BIGGEST HIT: the largest multiplier actually won.
  biggest as (
    select s.username, s.multiplier, s.buy_in, s.prize, s.ended_at
      from spins s
     where s.prize > 0
     order by s.multiplier desc, s.ended_at desc
     limit 10
  ),
  -- MOST SPINS: volume over the window.
  most as (
    select s.username, count(*) as spins
      from spins s
     group by s.username
     order by count(*) desc
     limit 10
  ),
  -- BEST NET: prizes won minus buy-ins paid.
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

-- Unchanged from the original: a player reads their own room's boards, so
-- `authenticated` may execute; anon may not, because the boards carry names.
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

  -- STABLE, not VOLATILE: a function Postgres knows cannot write is the
  -- machine-checkable version of the claim this migration is making.
  if v_vol <> 's' then
    raise exception 'fn_spin_leaderboards must be STABLE, found provolatile=%', v_vol;
  end if;

  -- And it still answers.
  select (public.fn_spin_leaderboards(7) ->> 'ok')::boolean into v_ok;
  if not coalesce(v_ok, false) then
    raise exception 'fn_spin_leaderboards did not return ok';
  end if;
end;
$assert$;
