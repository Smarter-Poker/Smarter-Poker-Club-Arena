-- 20260909232821_a_marker_stamp_does_not_rebuild_a_days_reporting.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- ca_reporting_wallet_change fired AFTER UPDATE FOR EACH ROW on
-- wallet_transactions, for ANY update, and each firing rebuilt every Club Data
-- rollup for the row's whole day (ca_refresh_reporting_rollups: three DELETEs
-- and a full re-aggregation - 5.5 s for today measured 2026-09-09 23:27 UTC,
-- more for a busier day). The journal is append-only, so the only UPDATE the
-- table ever sees is a marker stamp: fn_stamp_tournament_terminal_evidence_
-- markers sets terminal_closed_at on every wallet row of an event the moment
-- the event goes terminal. A stamp changes no fact a rollup reads. It fired
-- the rebuild once per row anyway: a 24-entrant event cancelled = 24 rebuilds
-- of the same day = over 120 s, inside atomic_cancel_tournament's own
-- statement_timeout and under the terminal-settlement advisory lock that
-- every tournament seat and settlement waits on. Measured live in a
-- rolled-back probe: "canceling statement due to statement timeout" in
-- ca_refresh_reporting_rollups_base, called from the marker stamp, called
-- from the CANCELLED status write. The same stamp runs on every completion.
--
-- THE FIX, AT THE ROOT: the trigger fires on DELETE, and on UPDATE only when
-- a column a rollup actually reads is in the SET list (user_id, amount, type,
-- category, table_id, related_entity_id, created_at) - and the function
-- itself returns early when none of those values changed, since UPDATE OF is
-- about the SET list, not about the value. A marker stamp now costs a marker
-- stamp. Maintenance edits that change a fact still rebuild the day exactly
-- as before.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.trg_ca_reporting_repair_changed_day()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old date;
  v_new date;
BEGIN
  -- A rollup reads who, how much, which way, what kind, which table, which
  -- event and when. An UPDATE that changes none of those (a terminal marker,
  -- a note) has nothing to repair.
  IF TG_OP = 'UPDATE'
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.amount IS NOT DISTINCT FROM OLD.amount
     AND NEW.type IS NOT DISTINCT FROM OLD.type
     AND NEW.category IS NOT DISTINCT FROM OLD.category
     AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id
     AND NEW.related_entity_id IS NOT DISTINCT FROM OLD.related_entity_id
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN
    RETURN NULL;
  END IF;
  v_old := (OLD.created_at AT TIME ZONE 'UTC')::date;
  v_new := CASE WHEN TG_OP = 'UPDATE'
                THEN (NEW.created_at AT TIME ZONE 'UTC')::date ELSE v_old END;
  PERFORM public.ca_refresh_reporting_rollups(LEAST(v_old, v_new), GREATEST(v_old, v_new));
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Club Data changed-ledger repair failed on %: %', TG_TABLE_NAME, SQLERRM;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS ca_reporting_wallet_change ON public.wallet_transactions;
CREATE TRIGGER ca_reporting_wallet_change
  AFTER DELETE OR UPDATE OF user_id, amount, type, category, table_id, related_entity_id, created_at
  ON public.wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION public.trg_ca_reporting_repair_changed_day();

COMMENT ON TRIGGER ca_reporting_wallet_change ON public.wallet_transactions IS
  'Rebuilds the Club Data rollups for a changed day. Fires on DELETE and on UPDATE of a fact column only; a marker stamp (terminal_closed_at) never rebuilds a day.';

COMMIT;
