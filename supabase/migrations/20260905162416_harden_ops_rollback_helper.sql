-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905162416; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260905162416   (the stamp IS the apply time, UTC: 2026-09-05 16:24:16)
--   name        harden_ops_rollback_helper
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 1133 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260905162416 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       ops_rollback.drop_unused_batch
--     DROP           INDEX if
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

create or replace function ops_rollback.drop_unused_batch(p_limit int default 75)
returns table(dropped int, skipped int, remaining int)
language plpgsql
security invoker
set search_path = pg_catalog, ops_rollback
as $$
declare r record; d int := 0; s int := 0;
begin
  perform set_config('lock_timeout','2s',true);
  for r in
    select id, schemaname, idx from ops_rollback.index_drops_20260905
    where status='pending' order by bytes asc limit p_limit
  loop
    begin
      execute format('drop index if exists %I.%I', r.schemaname, r.idx);
      update ops_rollback.index_drops_20260905
         set status='dropped', dropped_at=now() where id=r.id;
      d := d + 1;
    exception when others then
      update ops_rollback.index_drops_20260905
         set status='skipped', err=sqlerrm where id=r.id;
      s := s + 1;
    end;
  end loop;
  return query select d, s, (select count(*)::int from ops_rollback.index_drops_20260905 where status='pending');
end $$;

revoke all on function ops_rollback.drop_unused_batch(int) from public, anon, authenticated;
revoke all on schema ops_rollback from public, anon, authenticated;
