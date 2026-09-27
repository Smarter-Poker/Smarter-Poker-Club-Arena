-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260725171042 "sp_solver_planning_rpcs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 07c9e0c7070aa5aec2bed28d0941fbe4 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ---------------------------------------------------------------------------
-- Planning helpers for the solver farm.
-- Purpose: collapse "which phases still have work?" from up to 529 HTTP round
-- trips per planning pass (each capable of returning 50,000 scenario_hashes)
-- down to 1 tiny read + 1 small RPC per phase that actually has work.
-- ---------------------------------------------------------------------------

-- 1. Cheap cache of (game_type, stack_depth) that still owe v2 rows.
create table if not exists sp_pending_family_cache(
  game_type   text   not null,
  stack_depth int    not null,
  n           bigint not null,
  refreshed_at timestamptz not null default now(),
  primary key (game_type, stack_depth)
);

create or replace function sp_refresh_pending_families()
returns int language plpgsql as $fn$
declare cnt int;
begin
  create temp table _pf on commit drop as
    select g.game_type, g.stack_depth, count(*) as n
      from solved_spots_gold g
     where g.strategy_matrix_v2 is null
       and g.game_type is not null
       and g.stack_depth is not null
     group by 1,2;

  delete from sp_pending_family_cache c
   where not exists (select 1 from _pf p
                      where p.game_type = c.game_type
                        and p.stack_depth = c.stack_depth);

  insert into sp_pending_family_cache(game_type, stack_depth, n, refreshed_at)
  select game_type, stack_depth, n, now() from _pf
  on conflict (game_type, stack_depth)
  do update set n = excluded.n, refreshed_at = excluded.refreshed_at;

  select count(*) into cnt from _pf;
  return cnt;
end $fn$;

-- 2. The flops one phase still owes rows for, resolved server-side.
--    Mirrors boards_for() exactly: a flop qualifies if its own row is unsolved
--    OR any of its turn rows is unsolved (the turn row is only ever written
--    while its parent flop is being solved, so the parent must be re-queued).
create or replace function sp_pending_boards(
  p_gt        text,
  p_stack     int,
  p_prefix    text default '',
  p_positions text[] default '{}',
  p_turn      boolean default false,
  p_limit     int default 20000)
returns table(board text)
language plpgsql stable as $fn$
declare pats text[];
begin
  select array_agg(coalesce(p_prefix,'') || p_gt || '_' || x || '_' || p_stack || 'bb_%')
    into pats from unnest(p_positions) x;
  if p_turn then
    pats := pats || (select array_agg('turn_' || p_gt || '_' || x || '_' || p_stack || 'bb_%')
                       from unnest(p_positions) x);
  end if;
  if pats is null then return; end if;

  return query
    select distinct substr(regexp_replace(g.scenario_hash, '^.*_', ''), 1, 6)
      from solved_spots_gold g
     where g.game_type = p_gt
       and g.stack_depth = p_stack
       and g.strategy_matrix_v2 is null
       and g.scenario_hash like any (pats)
     order by 1
     limit p_limit;
end $fn$;

-- 3. Batched "is this row present / already solved?" for a whole board at once.
create or replace function sp_solved_state(p_hashes text[])
returns table(scenario_hash text, solved boolean)
language sql stable as $fn$
  select g.scenario_hash, (g.solved_v2_at is not null)
    from solved_spots_gold g
   where g.scenario_hash = any(p_hashes);
$fn$;
