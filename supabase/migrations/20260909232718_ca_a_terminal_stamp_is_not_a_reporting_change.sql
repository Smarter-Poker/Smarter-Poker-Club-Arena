-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260909232718; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260909232718   (the stamp IS the apply time, UTC: 2026-09-09 23:27:18)
--   name        ca_a_terminal_stamp_is_not_a_reporting_change
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 6468 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260909232718 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     TRIGGER        ca_reporting_wallet_change_upd, ca_reporting_wallet_change_del, ca_reporting_rake_change_upd, ca_reporting_rake_change_del
--     FUNCTION       public.trg_ca_reporting_repair_changed_days
--     DROP           TRIGGER ca_reporting_wallet_change, TRIGGER ca_reporting_rake_change, FUNCTION public.trg_ca_reporting_repair_changed_day
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

-- ca_a_terminal_stamp_is_not_a_reporting_change
--
-- WHAT WAS WRONG (2026-09-09, Morning Free Buy a9be040d, 200 entrants):
--
-- fn_complete_tournament_terminal reached its final UPDATE tournaments SET
-- status = 'COMPLETED' and was cancelled by its own 45s statement_timeout.
-- The status change fires fn_stamp_tournament_terminal_evidence_markers,
-- which stamps terminal_closed_at on every wallet_transactions row of the
-- event (213 rows here) and every rake_records row. Each of those row
-- updates fired ca_reporting_wallet_change / ca_reporting_rake_change:
-- AFTER UPDATE FOR EACH ROW, no column list, calling
-- ca_refresh_reporting_rollups(day, day) - a platform-wide rebuild of three
-- Club Data rollup tables over every ledger row of that day (71,216 rows
-- across the two days this event spanned). Two hundred and thirteen full
-- rebuilds, serially, inside the one transaction that pays the prizes.
--
-- A statement_timeout is QUERY_CANCELED, which the trigger's
-- EXCEPTION WHEN OTHERS does not catch, so the cancel unwound the whole
-- terminal settlement. The engine saw a lost response, replayed five times,
-- asked the serialized outcome resolver, and stopped every table engine of
-- the event with "Tournament.atomic_finish_outcome_unknown". A 459-chip
-- prize pool sat unpaid with the winner holding 2,630,000 chips at level 303.
--
-- THE RULE: a reporting rollup is never on the money path. Stamping a
-- terminal marker changes no reported figure; the rollup reads amount, type,
-- category, user_id, table_id, related_entity_id and created_at from the
-- wallet journal, and rake_amount, created_at, tournament_id, is_tournament,
-- metadata and club_id from rake_records. Only a change to one of those
-- names a day that has to be rebuilt, and a statement names each day once.
--
-- This is the same shape trg_ca_club_rake_daily_change already has on
-- rake_records (statement-level, transition tables, filter inside because a
-- transition-table trigger cannot carry a column list).

BEGIN;

CREATE OR REPLACE FUNCTION public.trg_ca_reporting_repair_changed_days()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r record;
BEGIN
  IF TG_TABLE_NAME = 'wallet_transactions' THEN
    IF TG_OP = 'UPDATE' THEN
      FOR r IN
        SELECT DISTINCT x.d FROM (
          SELECT (o.created_at AT TIME ZONE 'UTC')::date AS d
            FROM old_rows o JOIN new_rows n ON n.id = o.id
           WHERE o.amount IS DISTINCT FROM n.amount
              OR o.type IS DISTINCT FROM n.type
              OR o.category IS DISTINCT FROM n.category
              OR o.user_id IS DISTINCT FROM n.user_id
              OR o.table_id IS DISTINCT FROM n.table_id
              OR o.related_entity_id IS DISTINCT FROM n.related_entity_id
              OR o.created_at IS DISTINCT FROM n.created_at
          UNION
          SELECT (n.created_at AT TIME ZONE 'UTC')::date
            FROM old_rows o JOIN new_rows n ON n.id = o.id
           WHERE o.created_at IS DISTINCT FROM n.created_at
        ) x
        ORDER BY x.d
      LOOP
        PERFORM public.ca_refresh_reporting_rollups(r.d, r.d);
      END LOOP;
    ELSE
      FOR r IN
        SELECT DISTINCT (o.created_at AT TIME ZONE 'UTC')::date AS d
          FROM old_rows o ORDER BY 1
      LOOP
        PERFORM public.ca_refresh_reporting_rollups(r.d, r.d);
      END LOOP;
    END IF;
  ELSIF TG_TABLE_NAME = 'rake_records' THEN
    IF TG_OP = 'UPDATE' THEN
      FOR r IN
        SELECT DISTINCT x.d FROM (
          SELECT (o.created_at AT TIME ZONE 'UTC')::date AS d
            FROM old_rows o JOIN new_rows n ON n.id = o.id
           WHERE o.rake_amount IS DISTINCT FROM n.rake_amount
              OR o.created_at IS DISTINCT FROM n.created_at
              OR o.tournament_id IS DISTINCT FROM n.tournament_id
              OR o.is_tournament IS DISTINCT FROM n.is_tournament
              OR o.metadata IS DISTINCT FROM n.metadata
              OR o.club_id IS DISTINCT FROM n.club_id
          UNION
          SELECT (n.created_at AT TIME ZONE 'UTC')::date
            FROM old_rows o JOIN new_rows n ON n.id = o.id
           WHERE o.created_at IS DISTINCT FROM n.created_at
        ) x
        ORDER BY x.d
      LOOP
        PERFORM public.ca_refresh_reporting_rollups(r.d, r.d);
      END LOOP;
    ELSE
      FOR r IN
        SELECT DISTINCT (o.created_at AT TIME ZONE 'UTC')::date AS d
          FROM old_rows o ORDER BY 1
      LOOP
        PERFORM public.ca_refresh_reporting_rollups(r.d, r.d);
      END LOOP;
    END IF;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data changed-ledger repair failed on %: %', TG_TABLE_NAME, SQLERRM;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_ca_reporting_repair_changed_days() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS ca_reporting_wallet_change ON public.wallet_transactions;
DROP TRIGGER IF EXISTS ca_reporting_rake_change ON public.rake_records;

CREATE TRIGGER ca_reporting_wallet_change_upd
  AFTER UPDATE ON public.wallet_transactions
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.trg_ca_reporting_repair_changed_days();
CREATE TRIGGER ca_reporting_wallet_change_del
  AFTER DELETE ON public.wallet_transactions
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.trg_ca_reporting_repair_changed_days();
CREATE TRIGGER ca_reporting_rake_change_upd
  AFTER UPDATE ON public.rake_records
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.trg_ca_reporting_repair_changed_days();
CREATE TRIGGER ca_reporting_rake_change_del
  AFTER DELETE ON public.rake_records
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.trg_ca_reporting_repair_changed_days();

-- The per-row function has no caller left. Nothing may quietly re-attach it.
DROP FUNCTION IF EXISTS public.trg_ca_reporting_repair_changed_day();

COMMENT ON FUNCTION public.trg_ca_reporting_repair_changed_days() IS
  'Club Data rollup repair for changed or deleted ledger rows. Statement-level: rebuilds each affected UTC day once, and only when a column the rollup reads changed. A terminal_closed_at stamp, a description edit or a hand relink names no day. 2026-09-09: the per-row predecessor ran 213 full-day rebuilds inside one terminal settlement and cancelled it.';

COMMIT;
