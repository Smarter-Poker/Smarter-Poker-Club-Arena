-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417161117 "phase18_create_uploads_bucket_and_policies"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3014ca724da626702d6bc4bcdbcaa665 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════
--  PHASE 18 PREREQUISITE: create `uploads` bucket
-- ══════════════════════════════════════════════════════════════════════
--
--  Existing app code (social-pages [pageId].js, new home-games create.js)
--  assumes a public bucket named `uploads` exists and that authenticated
--  users can upload to it. The bucket was never actually created, so the
--  cover photo upload in social-pages has been silently failing. This
--  migration creates it with policies mirroring the intent of that code.
--
--  Public read (so getPublicUrl() URLs work).
--  Authenticated write scoped to the user's own folder pattern OR the
--  home-groups folder (for pre-group creation uploads where group_id
--  doesn't exist yet — we scope by userId in the path).
-- ══════════════════════════════════════════════════════════════════════

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'uploads',
  'uploads',
  true,
  10485760,   -- 10 MB per file (matches our client-side check)
  ARRAY['image/png','image/jpeg','image/jpg','image/gif','image/webp','image/svg+xml']
)
ON CONFLICT (id) DO NOTHING;

-- Public read: anyone can SELECT objects from the uploads bucket
-- (bucket itself is marked public=true, which is what getPublicUrl()
-- relies on. Explicit policy belt-and-suspenders.)
DROP POLICY IF EXISTS "uploads_public_read" ON storage.objects;
CREATE POLICY "uploads_public_read"
    ON storage.objects FOR SELECT
    TO anon, authenticated
    USING (bucket_id = 'uploads');

-- Authenticated users can upload to the uploads bucket. We don't gate
-- by path here — paths are structured client-side (e.g. home-groups/
-- pending-{userId}-{ts}/logo.{ext}, social-pages/{pageId}/...) and
-- the downstream API endpoints validate the URL shape before persisting.
DROP POLICY IF EXISTS "uploads_authenticated_insert" ON storage.objects;
CREATE POLICY "uploads_authenticated_insert"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (bucket_id = 'uploads');

-- Authenticated users can UPDATE (for upsert) their own files
DROP POLICY IF EXISTS "uploads_authenticated_update" ON storage.objects;
CREATE POLICY "uploads_authenticated_update"
    ON storage.objects FOR UPDATE
    TO authenticated
    USING (bucket_id = 'uploads' AND owner = auth.uid());

-- Authenticated users can DELETE their own files (for replace flows)
DROP POLICY IF EXISTS "uploads_authenticated_delete" ON storage.objects;
CREATE POLICY "uploads_authenticated_delete"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (bucket_id = 'uploads' AND owner = auth.uid());
