-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420020305 "phase40_protect_home_post_counters"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7d32861702121d6819a096b2c560201e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Bug 46: commander_home_posts counters (likes_count,
-- comments_count) and created_at are not protected. Authors can UPDATE
-- their own post to inflate metrics, bypassing the trigger-maintained
-- values from update_post_likes_count / update_post_comments_count.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_enforce_home_post_field_permissions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $fn$
BEGIN
    IF auth.role() = 'service_role' OR auth.uid() IS NULL THEN RETURN NEW; END IF;
    IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;

    IF NEW.likes_count    IS DISTINCT FROM OLD.likes_count
       OR NEW.comments_count IS DISTINCT FROM OLD.comments_count
       OR NEW.created_at  IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'IMMUTABLE_OR_COMPUTED_FIELD'
            USING HINT = 'likes_count, comments_count, created_at are '
                       || 'maintained by the system';
    END IF;

    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_enforce_home_post_field_permissions
  ON public.commander_home_posts;
CREATE TRIGGER trg_enforce_home_post_field_permissions
BEFORE UPDATE ON public.commander_home_posts
FOR EACH ROW
EXECUTE FUNCTION public.fn_enforce_home_post_field_permissions();
