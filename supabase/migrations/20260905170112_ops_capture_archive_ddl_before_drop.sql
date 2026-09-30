-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905170112; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260905170112   (the stamp IS the apply time, UTC: 2026-09-05 17:01:12)
--   name        ops_capture_archive_ddl_before_drop
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 856 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260905170112 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     TABLE          ops_rollback.dropped_tables_20260905
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

create table if not exists ops_rollback.dropped_tables_20260905 (
  id bigserial primary key,
  schemaname text, tblname text, row_count bigint, bytes bigint,
  column_ddl text, dropped_at timestamptz
);

insert into ops_rollback.dropped_tables_20260905 (schemaname, tblname, row_count, bytes, column_ddl)
select n.nspname, c.relname, s.n_live_tup, pg_total_relation_size(c.oid),
       'CREATE TABLE '||n.nspname||'.'||c.relname||' ('||
       string_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod),
                  ', ' order by a.attnum)||');'
from pg_class c
join pg_namespace n on n.oid=c.relnamespace and n.nspname='zz_archive'
join pg_stat_user_tables s on s.relid=c.oid
join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
where c.relkind='r' and s.n_live_tup=0
group by n.nspname, c.relname, s.n_live_tup, c.oid;
