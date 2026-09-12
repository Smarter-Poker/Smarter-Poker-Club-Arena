-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905161915; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260905161915   (the stamp IS the apply time, UTC: 2026-09-05 16:19:15)
--   name        realtime_replica_identity_default_unsubscribed
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 812 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260905161915 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     (no CREATE/DROP of a named object; see the body)
--
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

do $$
declare r record; n int := 0;
begin
  for r in
    select c.relname
    from pg_publication_tables pt
    join pg_class c on c.relname = pt.tablename
    join pg_namespace nsp on nsp.oid = c.relnamespace and nsp.nspname = pt.schemaname
    where pt.pubname = 'supabase_realtime'
      and c.relreplident = 'f'
      and exists (select 1 from pg_constraint pc where pc.conrelid = c.oid and pc.contype = 'p')
      and not exists (
        select 1 from realtime.subscription s
        where s.entity = c.oid
      )
  loop
    execute format('alter table public.%I replica identity default', r.relname);
    update ops_rollback.replica_identity_20260905
       set changed_at = now() where tbl = r.relname;
    n := n + 1;
  end loop;
  raise notice 'replica identity set to DEFAULT on % tables', n;
end $$;
