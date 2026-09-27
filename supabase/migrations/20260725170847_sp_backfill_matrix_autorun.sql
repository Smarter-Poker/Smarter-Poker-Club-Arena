-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260725170847 "sp_backfill_matrix_autorun"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 934e6918b27cfbd78ce59139bb19e1e5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

create extension if not exists pg_cron;

-- Convert one batch of legacy rows from strategy_matrix_v2 -> strategy_matrix.
-- Self-terminating: once nothing is left it removes its own cron schedule so it
-- costs nothing forever after. Never touches strategy_matrix_v2 (source of truth).
create or replace function sp_backfill_matrix_batch(n int default 1500)
returns int language plpgsql as $fn$
declare done int;
begin
  with b as (
    select ctid from solved_spots_gold
     where strategy_matrix_v2 is not null
       and (strategy_matrix->>'source') is distinct from 'pio_v2'
     limit n
  ), u as (
    update solved_spots_gold t
       set strategy_matrix = sp_v2_to_app_matrix(t.strategy_matrix_v2)
      from b where t.ctid = b.ctid
    returning 1
  )
  select count(*) into done from u;

  if done = 0 then
    begin
      perform cron.unschedule('sp_backfill_matrix');
    exception when others then null;
    end;
  end if;
  return done;
end $fn$;
