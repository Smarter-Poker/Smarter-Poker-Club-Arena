-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819164143 "club_assets_bucket_and_policies"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7621284972dfc18cf5c7573d67ea20a3 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

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

DROP POLICY IF EXISTS "club logos owner update" ON storage.objects;
CREATE POLICY "club logos owner update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'club-assets' AND owner = auth.uid())
  WITH CHECK (bucket_id = 'club-assets' AND name LIKE 'club-logos/%');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'club-assets') THEN
    RAISE EXCEPTION 'post-apply: club-assets bucket missing';
  END IF;
END $$;
