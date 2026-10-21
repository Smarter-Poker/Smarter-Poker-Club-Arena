-- Provider-assigned migration identity, read back from schema_migrations.
-- Complete the explicit role boundary after native qualification. The creation
-- migration also declares this boundary so any fresh installation is complete.
-- @live-proof: NOT has_table_privilege('service_role', 'public.club_entry_news_receipts', 'INSERT') AND NOT has_table_privilege('service_role', 'public.club_entry_news_receipts', 'UPDATE') AND NOT has_table_privilege('service_role', 'public.club_entry_news_receipts', 'DELETE')
BEGIN;
REVOKE ALL ON public.club_entry_news_receipts FROM service_role;
COMMIT;
