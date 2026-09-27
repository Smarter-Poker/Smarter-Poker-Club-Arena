-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820062914 "union_law_single_buyin_implementation"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ceaad788a28bddcfbd4f02eb24a6d453 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- Drop the legacy five-argument overload entirely. Keeping both made the call
-- ambiguous for SQL callers and split PostgREST traffic across two different
-- chip sources. One function with p_club_id DEFAULT NULL serves every caller:
-- PostgREST supplies the defaulted argument automatically, and callers with no
-- club context fall back to fn_seat_club_for_user.
-- Verified before dropping: the only remaining references to the old signature
-- are comments inside retired stubs (fn_seat_player, orb1_buyin_transaction).
DROP FUNCTION IF EXISTS public.atomic_table_buyin(uuid, uuid, integer, numeric, boolean);

