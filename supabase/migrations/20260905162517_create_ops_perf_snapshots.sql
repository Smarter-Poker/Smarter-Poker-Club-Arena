-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905162517; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260905162517   (the stamp IS the apply time, UTC: 2026-09-05 16:25:17)
--   name        create_ops_perf_snapshots
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 1656 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260905162517 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       ops_rollback.take_snapshot
--     TABLE          ops_rollback.perf_snapshots
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

create table if not exists ops_rollback.perf_snapshots (
  id bigserial primary key,
  taken_at timestamptz default now(),
  label text,
  realtime_decode_total_s numeric,
  realtime_decode_calls bigint,
  realtime_decode_mean_ms numeric,
  wal_lsn pg_lsn,
  db_size_bytes bigint,
  index_bytes bigint,
  deadlocks bigint,
  rollbacks bigint,
  commits bigint,
  temp_bytes bigint,
  cache_hit_pct numeric
);

create or replace function ops_rollback.take_snapshot(p_label text)
returns void language plpgsql security invoker
set search_path = pg_catalog, extensions, ops_rollback, public as $$
begin
  insert into ops_rollback.perf_snapshots(
    label, realtime_decode_total_s, realtime_decode_calls, realtime_decode_mean_ms,
    wal_lsn, db_size_bytes, index_bytes, deadlocks, rollbacks, commits, temp_bytes, cache_hit_pct)
  select p_label,
    round((s.total_exec_time/1000)::numeric,1), s.calls, round(s.mean_exec_time::numeric,2),
    pg_current_wal_lsn(),
    pg_database_size(current_database()),
    (select sum(pg_relation_size(indexrelid)) from pg_stat_user_indexes),
    d.deadlocks, d.xact_rollback, d.xact_commit, d.temp_bytes,
    round((100.0*d.blks_hit/nullif(d.blks_hit+d.blks_read,0))::numeric,2)
  from pg_stat_database d
  left join lateral (
    select total_exec_time, calls, mean_exec_time from extensions.pg_stat_statements
    where query like 'SELECT wal->>%' order by total_exec_time desc limit 1) s on true
  where d.datname = current_database();
end $$;

revoke all on function ops_rollback.take_snapshot(text) from public, anon, authenticated;
revoke all on table ops_rollback.perf_snapshots from public, anon, authenticated;
