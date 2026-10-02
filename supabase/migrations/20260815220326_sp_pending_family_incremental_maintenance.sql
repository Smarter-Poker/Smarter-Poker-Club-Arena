-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815220326 "sp_pending_family_incremental_maintenance"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 32c13a002055df4291743873b019b6d8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- 2026-08-15 — Stop scanning a 62 GB table every 10 minutes to maintain a
-- small counter. Maintain it incrementally instead.
--
-- BACKGROUND
--
-- sp_refresh_pending_families() full-scanned solved_spots_gold (62 GB, 8.1M
-- rows) on a */10 cron to count rows with strategy_matrix_v2 IS NULL grouped by
-- (game_type, stack_depth). Over 24h that was 11,409 seconds of database time —
-- 3.2 hours, 17x the next worst job — with a 48% failure rate, and it took the
-- poker platform down repeatedly (zero hands dealt platform-wide 20:55-21:01).
--
-- The obvious fix was a matching partial index. That was attempted and the
-- instance could not do it: CREATE INDEX CONCURRENTLY on this table under
-- production load caused a POSTGRES SERVER RESTART. This instance does not have
-- the headroom to index a table that size while serving traffic.
--
-- So: remove the need for the scan entirely.
--
-- APPROACH
--
-- The counter is a pure aggregate over a predicate. Every change to that
-- aggregate is knowable at write time. Statement-level triggers with transition
-- tables let us compute the delta once per statement (not per row), so bulk
-- solver writes cost one small GROUP BY over the changed rows instead of a scan
-- of the whole table.
--
-- SAFETY
--
-- The trigger is exception-guarded. solved_spots_gold is on the GTO solver's
-- write path, and a counter being briefly wrong is enormously preferable to
-- blocking solver writes. If the delta fails for any reason it is swallowed and
-- the periodic reconciliation (now daily, off-peak) corrects the drift.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.sp_pending_family_apply_delta(_d jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- _d is [{game_type, stack_depth, d}] — the net change per family.
  insert into sp_pending_family_cache (game_type, stack_depth, n, refreshed_at)
  select (e->>'game_type')::text, (e->>'stack_depth')::int, (e->>'d')::bigint, now()
    from jsonb_array_elements(_d) e
   where (e->>'d')::bigint <> 0
  on conflict (game_type, stack_depth) do update
    set n = greatest(0, sp_pending_family_cache.n + excluded.n),
        refreshed_at = now();

  -- A family that drops to zero pending is no longer a pending family.
  delete from sp_pending_family_cache where n <= 0;
end $$;

create or replace function public.sp_pending_family_tg()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare _delta jsonb;
begin
  -- Net change per family: +1 for each row that BECAME pending, -1 for each row
  -- that STOPPED being pending. The dominant real case is an UPDATE filling in
  -- strategy_matrix_v2, i.e. -1.
  with removed as (
    select game_type, stack_depth, count(*)::bigint as c
      from old_rows
     where strategy_matrix_v2 is null and game_type is not null and stack_depth is not null
     group by 1,2
  ),
  added as (
    select game_type, stack_depth, count(*)::bigint as c
      from new_rows
     where strategy_matrix_v2 is null and game_type is not null and stack_depth is not null
     group by 1,2
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'game_type', game_type, 'stack_depth', stack_depth, 'd', d)), '[]'::jsonb)
    into _delta
  from (
    select coalesce(a.game_type, r.game_type)     as game_type,
           coalesce(a.stack_depth, r.stack_depth) as stack_depth,
           coalesce(a.c,0) - coalesce(r.c,0)      as d
      from added a full outer join removed r
        on a.game_type = r.game_type and a.stack_depth = r.stack_depth
  ) x
  where d <> 0;

  if _delta <> '[]'::jsonb then
    perform sp_pending_family_apply_delta(_delta);
  end if;
  return null;
exception when others then
  -- NEVER block a write to solved_spots_gold over a dashboard counter.
  -- Drift is corrected by the daily reconciliation.
  return null;
end $$;

-- Separate triggers per operation: transition tables require it, and INSERT has
-- no OLD table while DELETE has no NEW table.
drop trigger if exists sp_pending_family_ins on public.solved_spots_gold;
drop trigger if exists sp_pending_family_upd on public.solved_spots_gold;
drop trigger if exists sp_pending_family_del on public.solved_spots_gold;

create trigger sp_pending_family_ins
  after insert on public.solved_spots_gold
  referencing new table as new_rows
  for each statement execute function public.sp_pending_family_tg();

create trigger sp_pending_family_upd
  after update on public.solved_spots_gold
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.sp_pending_family_tg();

create trigger sp_pending_family_del
  after delete on public.solved_spots_gold
  referencing old table as old_rows
  for each statement execute function public.sp_pending_family_tg();

-- The reconciliation scan still exists as a drift correction, but it needs more
-- than the cluster's 120s statement_timeout — straddling that limit is exactly
-- why it failed 48% of the time. Function-scoped so nothing else is affected.
alter function public.sp_refresh_pending_families() set statement_timeout = '15min';

comment on function public.sp_pending_family_tg() is
  'Incrementally maintains sp_pending_family_cache so the 62GB solved_spots_gold table never needs a periodic full scan. Statement-level with transition tables; exception-guarded so it can never block a solver write. See migration 2026-08-15.';
