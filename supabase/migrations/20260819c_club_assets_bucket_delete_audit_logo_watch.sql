-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration: 20260819c_club_assets_bucket_delete_audit_logo_watch.sql
-- Tier 2 (additive: 1 bucket, 3 storage policies, 1 trigger, 1 fn replace)
--
-- 1. THE club-assets BUCKET DID NOT EXIST. CreateClubModal has been calling
--    storage.from('club-assets').upload(...) since club creation shipped;
--    every upload failed and the code fell back to embedding the logo as a
--    data URL. The Club Settings page now offers a logo change, so the
--    bucket becomes real: public read, 2 MB cap, images only. Writes are
--    RLS-scoped to the club-logos/ prefix for authenticated users.
--
-- 2. delete_club was the one settings-page action with no audit row. A
--    BEFORE DELETE trigger records it. club_id is written as NULL on
--    purpose: the FK is ON DELETE SET NULL, so a club_id would be nulled
--    within the same statement anyway — target_id preserves the uuid.
--
-- 3. logo_url joins the watched settings columns (fn + trigger WHEN), so a
--    logo change made from the settings page is auditable like any other.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_audit_club_delete ON public.clubs;
--   DROP FUNCTION IF EXISTS public.fn_audit_club_delete();
--   DROP POLICY IF EXISTS "club assets public read" ON storage.objects;
--   DROP POLICY IF EXISTS "club logos authenticated insert" ON storage.objects;
--   DROP POLICY IF EXISTS "club logos owner update" ON storage.objects;
--   -- (bucket left in place; deleting a bucket with objects is destructive)
--   -- fn_audit_club_settings_change / trigger: re-apply 20260819b to drop logo_url.
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.clubs'::regclass
                   AND tgname = 'trg_audit_club_settings') THEN
    RAISE EXCEPTION 'pre-flight: apply 20260819 and 20260819b first';
  END IF;
END $$;

-- ── 1. Bucket + storage policies ──
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('club-assets', 'club-assets', true, 2097152,
        ARRAY['image/png','image/jpeg','image/webp','image/gif'])
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = 2097152,
      allowed_mime_types = ARRAY['image/png','image/jpeg','image/webp','image/gif'];

DROP POLICY IF EXISTS "club assets public read" ON storage.objects;
CREATE POLICY "club assets public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'club-assets');

DROP POLICY IF EXISTS "club logos authenticated insert" ON storage.objects;
CREATE POLICY "club logos authenticated insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'club-assets' AND name LIKE 'club-logos/%');

-- upsert:true needs UPDATE too; scope to the uploader's own objects.
DROP POLICY IF EXISTS "club logos owner update" ON storage.objects;
CREATE POLICY "club logos owner update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'club-assets' AND owner = auth.uid())
  WITH CHECK (bucket_id = 'club-assets' AND name LIKE 'club-logos/%');

-- ── 2. Audit the one unaudited destructive action: club deletion ──
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
       NULL,  -- FK is ON DELETE SET NULL; it would be nulled this statement anyway
       jsonb_build_object('name', OLD.name, 'member_count', OLD.member_count));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'audit_trail insert failed for club delete %: %', OLD.id, SQLERRM;
  END;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_club_delete ON public.clubs;
CREATE TRIGGER trg_audit_club_delete
  BEFORE DELETE ON public.clubs
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_audit_club_delete();

REVOKE EXECUTE ON FUNCTION public.fn_audit_club_delete() FROM anon, authenticated;

-- ── 3. logo_url joins the watched settings columns ──
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

-- ── Post-apply assertions ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'club-assets') THEN
    RAISE EXCEPTION 'post-apply: club-assets bucket missing';
  END IF;
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
