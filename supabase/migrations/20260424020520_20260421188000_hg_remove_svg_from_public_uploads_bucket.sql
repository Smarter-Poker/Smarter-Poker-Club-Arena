-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424020520 "20260421188000_hg_remove_svg_from_public_uploads_bucket"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e37084059a5bb36c54fc025107d37118 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- SECURITY: image/svg+xml in a public user-writable bucket is an XSS
-- vector. SVG can contain <script> tags that execute when the file is
-- loaded via <iframe>, <object>, or direct URL navigation. <img> tags
-- don't execute SVG scripts, so basic rendering is safe — but any
-- "view full size" link or linkshare would open direct, executing in
-- the storage origin.
--
-- Supabase docs recommend: disallow SVG in public user-upload buckets.
-- Legitimate SVG uploads (icons, admin-curated logos) should use a
-- separate admin-writable bucket.
--
-- Remove svg+xml from the uploads bucket's allowed mimetypes.

UPDATE storage.buckets
   SET allowed_mime_types = ARRAY[
     'image/png','image/jpeg','image/jpg','image/gif','image/webp'
     -- removed: 'image/svg+xml'
   ]
 WHERE name = 'uploads';

-- Verify
SELECT name, allowed_mime_types FROM storage.buckets WHERE name = 'uploads';
