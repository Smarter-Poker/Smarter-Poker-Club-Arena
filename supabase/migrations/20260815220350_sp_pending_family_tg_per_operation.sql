-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815220350 "sp_pending_family_tg_per_operation"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d4a76c1f2260554842039fec5de18452 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix: transition tables only exist for the operation that declares them.
-- INSERT has no old_rows; DELETE has no new_rows. Referencing a missing
-- transition table raises, and the exception guard would have swallowed it —
-- meaning INSERTs and DELETEs would silently never update the counter while
-- appearing to work. Branch on TG_OP so each path only touches the tables it has.
-- (plpgsql plans a statement when it first executes it, so an un-taken branch
-- referencing a non-existent transition table is never planned.)

create or replace function public.sp_pending_family_tg()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare _delta jsonb;
begin
  if TG_OP = 'INSERT' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'game_type', game_type, 'stack_depth', stack_depth, 'd', c)), '[]'::jsonb)
      into _delta
      from (select game_type, stack_depth, count(*)::bigint as c
              from new_rows
             where strategy_matrix_v2 is null
               and game_type is not null and stack_depth is not null
             group by 1,2) a;

  elsif TG_OP = 'DELETE' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'game_type', game_type, 'stack_depth', stack_depth, 'd', -c)), '[]'::jsonb)
      into _delta
      from (select game_type, stack_depth, count(*)::bigint as c
              from old_rows
             where strategy_matrix_v2 is null
               and game_type is not null and stack_depth is not null
             group by 1,2) r;

  else -- UPDATE: net of rows that became pending minus rows that stopped being
    with removed as (
      select game_type, stack_depth, count(*)::bigint as c
        from old_rows
       where strategy_matrix_v2 is null and game_type is not null and stack_depth is not null
       group by 1,2),
    added as (
      select game_type, stack_depth, count(*)::bigint as c
        from new_rows
       where strategy_matrix_v2 is null and game_type is not null and stack_depth is not null
       group by 1,2)
    select coalesce(jsonb_agg(jsonb_build_object(
             'game_type', game_type, 'stack_depth', stack_depth, 'd', d)), '[]'::jsonb)
      into _delta
      from (select coalesce(a.game_type, r.game_type)     as game_type,
                   coalesce(a.stack_depth, r.stack_depth) as stack_depth,
                   coalesce(a.c,0) - coalesce(r.c,0)      as d
              from added a full outer join removed r
                on a.game_type = r.game_type and a.stack_depth = r.stack_depth) x
     where d <> 0;
  end if;

  if _delta is not null and _delta <> '[]'::jsonb then
    perform sp_pending_family_apply_delta(_delta);
  end if;
  return null;
exception when others then
  -- Never block a write to solved_spots_gold over a dashboard counter.
  return null;
end $$;
