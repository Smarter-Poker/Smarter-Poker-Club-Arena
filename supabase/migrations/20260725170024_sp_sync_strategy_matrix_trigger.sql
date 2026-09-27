-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260725170024 "sp_sync_strategy_matrix_trigger"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 131c6821d71db848eb4080839377b798 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Keep the legacy strategy_matrix column (what the trainer + cache seeder read)
-- automatically derived from strategy_matrix_v2 (what the solver pipeline writes).
-- strategy_matrix is now a DERIVED column: it can always be rebuilt from v2.
create or replace function sp_sync_matrix() returns trigger
language plpgsql
as $t$
declare
  conv jsonb;
begin
  if new.strategy_matrix_v2 is not null
     and (tg_op = 'INSERT' or new.strategy_matrix_v2 is distinct from old.strategy_matrix_v2) then
    begin
      conv := sp_v2_to_app_matrix(new.strategy_matrix_v2);
      if conv is not null then
        new.strategy_matrix := conv;
      end if;
    exception when others then
      null;   -- never block a solver write because of a conversion problem
    end;
  end if;
  return new;
end
$t$;

drop trigger if exists trg_sp_sync_matrix on solved_spots_gold;
create trigger trg_sp_sync_matrix
  before insert or update on solved_spots_gold
  for each row execute function sp_sync_matrix();
