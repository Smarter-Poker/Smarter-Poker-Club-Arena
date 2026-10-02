-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429010229 "tighten_storage_upload_rls_20260429"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1d1486ae873747e4f32ef43691e9b6e4 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

DROP POLICY IF EXISTS "Authenticated users can upload" ON storage.objects;
CREATE POLICY "Authenticated upload to allowlisted buckets" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id IN ('avatars','live-recordings','messenger_media','social-media','stories','uploads','user-media'));
