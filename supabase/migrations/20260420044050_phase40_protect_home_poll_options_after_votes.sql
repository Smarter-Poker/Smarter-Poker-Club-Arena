-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420044050 "phase40_protect_home_poll_options_after_votes"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ef1e2add910cf277c2bed990425115af of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Bug 49: commander_home_polls lets the creator/admin UPDATE
-- options, question, and poll_type after votes exist, which either changes
-- what voters meant OR orphans their votes (voter chose 'a'; creator deletes
-- 'a' from options; vote still references a now-nonexistent choice).
--
-- Closing the poll (is_closed=true / closes_at change) is intentionally
-- allowed — hosts need to end polls.
--
-- Fix: BEFORE UPDATE trigger that blocks mutations to question/poll_type/
-- options AFTER at least one vote exists, and blocks created_at/created_by/
-- group_id always. is_closed and closes_at remain mutable.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_enforce_home_poll_field_permissions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $fn$
DECLARE
    v_vote_count int;
BEGIN
    IF auth.role() = 'service_role' OR auth.uid() IS NULL THEN RETURN NEW; END IF;
    IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;

    -- Identity fields always immutable
    IF NEW.group_id  IS DISTINCT FROM OLD.group_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'IMMUTABLE_FIELD'
            USING HINT = 'group_id, created_by, and created_at are immutable';
    END IF;

    -- Options / question / type: frozen once votes exist
    IF NEW.options   IS DISTINCT FROM OLD.options
       OR NEW.question  IS DISTINCT FROM OLD.question
       OR NEW.poll_type IS DISTINCT FROM OLD.poll_type
    THEN
      SELECT COUNT(*) INTO v_vote_count
        FROM commander_home_poll_votes
       WHERE poll_id = NEW.id;

      IF v_vote_count > 0 THEN
        RAISE EXCEPTION 'POLL_HAS_VOTES'
              USING HINT = 'cannot modify question, options, or poll_type after '
                         || 'votes are cast; close the poll and create a new one';
      END IF;
    END IF;

    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_enforce_home_poll_field_permissions
  ON public.commander_home_polls;
CREATE TRIGGER trg_enforce_home_poll_field_permissions
BEFORE UPDATE ON public.commander_home_polls
FOR EACH ROW
EXECUTE FUNCTION public.fn_enforce_home_poll_field_permissions();

COMMENT ON FUNCTION public.fn_enforce_home_poll_field_permissions IS
  'Phase 40 Bug 49: freezes question/options/poll_type once a vote exists. '
  'is_closed and closes_at remain mutable so hosts can still close polls.';
