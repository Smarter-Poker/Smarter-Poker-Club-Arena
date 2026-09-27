-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819162504 "audit_trail_trigger_when_and_admin_read"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e7b2f0a991db337a4bf8c3b4563af7a5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.clubs'::regclass
                   AND tgname = 'trg_audit_club_settings') THEN
    RAISE EXCEPTION 'pre-flight: trg_audit_club_settings missing — apply 20260819 first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE p.proname = 'is_club_admin' AND n.nspname = 'public') THEN
    RAISE EXCEPTION 'pre-flight: public.is_club_admin missing';
  END IF;
END $$;

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
    OLD.max_buyin_bb         IS DISTINCT FROM NEW.max_buyin_bb
  )
  EXECUTE FUNCTION public.fn_audit_club_settings_change();

DROP POLICY IF EXISTS "club admins read own club rows" ON public.audit_trail;
CREATE POLICY "club admins read own club rows"
  ON public.audit_trail FOR SELECT TO authenticated
  USING (club_id IS NOT NULL AND public.is_club_admin(club_id));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.clubs'::regclass
                   AND tgname = 'trg_audit_club_settings') THEN
    RAISE EXCEPTION 'post-apply: trg_audit_club_settings missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy
                 WHERE polrelid = 'public.audit_trail'::regclass
                   AND polname = 'club admins read own club rows') THEN
    RAISE EXCEPTION 'post-apply: admin read policy missing';
  END IF;
END $$;
