-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819164215 "club_delete_audit_and_logo_watch"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b2561bd7f53bb39bdb8678b758226511 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

SET LOCAL lock_timeout = '4s';

CREATE OR REPLACE FUNCTION public.fn_audit_club_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RETURN OLD;
  END IF;
  BEGIN
    INSERT INTO public.audit_trail
      (actor_id, actor_role, action, target_type, target_id, club_id, before_state)
    VALUES
      (v_actor,
       CASE WHEN v_actor = OLD.owner_id THEN 'owner' ELSE 'system' END,
       'delete_club', 'club', OLD.id,
       NULL,
       jsonb_build_object('name', OLD.name, 'member_count', OLD.member_count));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'audit_trail insert failed for club delete %: %', OLD.id, SQLERRM;
  END;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_audit_club_settings_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor   uuid := auth.uid();
  v_before  jsonb := '{}'::jsonb;
  v_after   jsonb := '{}'::jsonb;
  v_old     jsonb;
  v_new     jsonb;
  v_key     text;
  v_watched text[] := ARRAY[
    'name','description','is_public','requires_approval',
    'default_rake_percent','rake_cap',
    'allow_straddle','allow_run_it_twice','allow_rabbit_hunt',
    'min_buyin_bb','max_buyin_bb','logo_url'];
BEGIN
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);
  FOREACH v_key IN ARRAY v_watched LOOP
    IF (v_old -> v_key) IS DISTINCT FROM (v_new -> v_key) THEN
      v_before := v_before || jsonb_build_object(v_key, v_old -> v_key);
      v_after  := v_after  || jsonb_build_object(v_key, v_new -> v_key);
    END IF;
  END LOOP;

  IF v_after = '{}'::jsonb THEN
    RETURN NEW;
  END IF;

  BEGIN
    INSERT INTO public.audit_trail
      (actor_id, actor_role, action, target_type, target_id, club_id,
       before_state, after_state)
    VALUES
      (v_actor, public.fn_audit_actor_role(NEW.id, v_actor),
       'update_club_settings', 'club', NEW.id, NEW.id,
       v_before, v_after);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'audit_trail insert failed for club %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_club_delete ON public.clubs;
CREATE TRIGGER trg_audit_club_delete
  BEFORE DELETE ON public.clubs
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_audit_club_delete();

REVOKE EXECUTE ON FUNCTION public.fn_audit_club_delete() FROM anon, authenticated;

DROP TRIGGER IF EXISTS trg_audit_club_settings ON public.clubs;
CREATE TRIGGER trg_audit_club_settings
  AFTER UPDATE ON public.clubs
  FOR EACH ROW
  WHEN (
    OLD.name                 IS DISTINCT FROM NEW.name OR
    OLD.description          IS DISTINCT FROM NEW.description OR
    OLD.is_public            IS DISTINCT FROM NEW.is_public OR
    OLD.requires_approval    IS DISTINCT FROM NEW.requires_approval OR
    OLD.default_rake_percent IS DISTINCT FROM NEW.default_rake_percent OR
    OLD.rake_cap             IS DISTINCT FROM NEW.rake_cap OR
    OLD.allow_straddle       IS DISTINCT FROM NEW.allow_straddle OR
    OLD.allow_run_it_twice   IS DISTINCT FROM NEW.allow_run_it_twice OR
    OLD.allow_rabbit_hunt    IS DISTINCT FROM NEW.allow_rabbit_hunt OR
    OLD.min_buyin_bb         IS DISTINCT FROM NEW.min_buyin_bb OR
    OLD.max_buyin_bb         IS DISTINCT FROM NEW.max_buyin_bb OR
    OLD.logo_url             IS DISTINCT FROM NEW.logo_url
  )
  EXECUTE FUNCTION public.fn_audit_club_settings_change();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.clubs'::regclass
                   AND tgname = 'trg_audit_club_delete') THEN
    RAISE EXCEPTION 'post-apply: trg_audit_club_delete missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.clubs'::regclass
                   AND tgname = 'trg_audit_club_settings') THEN
    RAISE EXCEPTION 'post-apply: trg_audit_club_settings missing';
  END IF;
END $$;
