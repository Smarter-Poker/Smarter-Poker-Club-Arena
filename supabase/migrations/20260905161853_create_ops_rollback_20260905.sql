-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905161853; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260905161853   (the stamp IS the apply time, UTC: 2026-09-05 16:18:53)
--   name        create_ops_rollback_20260905
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 2195 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260905161853 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     TABLE          ops_rollback.index_drops_20260905, ops_rollback.policy_changes_20260905, ops_rollback.replica_identity_20260905
--     POLICY         %I
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

create schema if not exists ops_rollback;

create table if not exists ops_rollback.index_drops_20260905 (
  id bigserial primary key,
  schemaname text, tbl text, idx text, bytes bigint,
  recreate_ddl text, dropped_at timestamptz
);

create table if not exists ops_rollback.policy_changes_20260905 (
  id bigserial primary key,
  tablename text, policyname text, original_ddl text, changed_at timestamptz
);

create table if not exists ops_rollback.replica_identity_20260905 (
  id bigserial primary key,
  tbl text, original_setting text, changed_at timestamptz
);

insert into ops_rollback.index_drops_20260905 (schemaname, tbl, idx, bytes, recreate_ddl)
select s.schemaname, s.relname, s.indexrelname, pg_relation_size(s.indexrelid), pg_get_indexdef(s.indexrelid)
from pg_stat_user_indexes s
join pg_index i on i.indexrelid = s.indexrelid
where s.idx_scan = 0
  and not i.indisunique and not i.indisprimary and not i.indisreplident and not i.indisexclusion
  and not exists (select 1 from pg_constraint c where c.conindid = s.indexrelid)
  and not exists (select 1 from pg_constraint fk where fk.contype='f' and fk.conrelid = s.relid
                  and (fk.conkey::int[])[1] = (i.indkey::int2[])[1]);

insert into ops_rollback.replica_identity_20260905 (tbl, original_setting)
select c.relname, 'FULL'
from pg_publication_tables pt
join pg_class c on c.relname=pt.tablename
join pg_namespace n on n.oid=c.relnamespace and n.nspname=pt.schemaname
where pt.pubname='supabase_realtime' and c.relreplident='f';

insert into ops_rollback.policy_changes_20260905 (tablename, policyname, original_ddl)
select tablename, policyname,
  format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s%s%s;',
    policyname, schemaname, tablename,
    case when permissive='PERMISSIVE' then 'PERMISSIVE' else 'RESTRICTIVE' end,
    cmd, array_to_string(roles,', '),
    coalesce(' USING ('||qual||')',''), coalesce(' WITH CHECK ('||with_check||')',''))
from pg_policies
where schemaname='public'
  and tablename in ('ca_mint_ledger','ad_campaign','club_message_dismissals','ca_hand_player_idx',
                    'ca_mint_policy','ca_mint_policy_changes','cash_seat_moves','cash_game_waitlist','cash_games');
