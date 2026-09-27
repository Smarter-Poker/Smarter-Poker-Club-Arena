-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429010225 "add_heic_mime_types_20260429"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 0c42e39fc3ab99c7553454e7c6aa13df of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

UPDATE storage.buckets SET allowed_mime_types = array_append(allowed_mime_types, 'image/heic') WHERE id = 'social-media' AND NOT ('image/heic' = ANY(allowed_mime_types));
UPDATE storage.buckets SET allowed_mime_types = array_append(allowed_mime_types, 'image/heif') WHERE id = 'social-media' AND NOT ('image/heif' = ANY(allowed_mime_types));
UPDATE storage.buckets SET allowed_mime_types = array_append(allowed_mime_types, 'image/heic') WHERE id = 'stories' AND NOT ('image/heic' = ANY(allowed_mime_types));
UPDATE storage.buckets SET allowed_mime_types = array_append(allowed_mime_types, 'image/heif') WHERE id = 'stories' AND NOT ('image/heif' = ANY(allowed_mime_types));
