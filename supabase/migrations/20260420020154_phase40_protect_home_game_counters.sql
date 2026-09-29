-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420020154 "phase40_protect_home_game_counters"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e10c9c17f0446c0f5a1ee54e90fdf323 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Bug 45: commander_home_games has no protection on the
-- counter columns (rsvp_yes, rsvp_maybe, rsvp_no, waitlist_count) and
-- created_at against direct UPDATE. The games UPDATE RLS policy has no
-- WITH CHECK, so any host/owner/admin can mutate arbitrary columns via
-- PostgREST — including computed counters that triggers are supposed to
-- own.
--
-- Fix: BEFORE UPDATE trigger that raises if counter/immutable fields
-- change at pg_trigger_depth()=1 (user-initiated). Depth>=2 is always
-- the legitimate nested-trigger path (update_home_game_rsvp_counts fires
-- from rsvps INSERT/UPDATE/DELETE).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_enforce_home_game_field_permissions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $fn$
BEGIN
    -- Service role and unauthenticated bypass
    IF auth.role() = 'service_role' OR auth.uid() IS NULL THEN
      RETURN NEW;
    END IF;

    -- Nested-trigger bypass for legitimate recompute paths
    IF pg_trigger_depth() > 1 THEN
      RETURN NEW;
    END IF;

    IF NEW.rsvp_yes       IS DISTINCT FROM OLD.rsvp_yes
       OR NEW.rsvp_maybe  IS DISTINCT FROM OLD.rsvp_maybe
       OR NEW.rsvp_no     IS DISTINCT FROM OLD.rsvp_no
       OR NEW.waitlist_count IS DISTINCT FROM OLD.waitlist_count
       OR NEW.created_at  IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'IMMUTABLE_OR_COMPUTED_FIELD'
            USING HINT = 'rsvp_yes/maybe/no, waitlist_count, and created_at '
                       || 'are maintained by the system; modify via RSVP RPCs';
    END IF;

    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_enforce_home_game_field_permissions
  ON public.commander_home_games;
CREATE TRIGGER trg_enforce_home_game_field_permissions
BEFORE UPDATE ON public.commander_home_games
FOR EACH ROW
EXECUTE FUNCTION public.fn_enforce_home_game_field_permissions();

COMMENT ON FUNCTION public.fn_enforce_home_game_field_permissions IS
  'Phase 40 Bug 45: blocks direct user UPDATEs to rsvp counters and '
  'created_at, while allowing nested trigger-driven recomputes through '
  'pg_trigger_depth()>1.';
