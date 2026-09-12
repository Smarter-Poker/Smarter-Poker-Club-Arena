\set ON_ERROR_STOP on
DO $$ BEGIN
 IF current_database()<>'poker_diamond_phase6_test' OR inet_server_addr() IS NOT NULL
 OR current_setting('port')<>'55472' THEN RAISE EXCEPTION 'isolated phase6 fixture only'; END IF;
END $$;
-- The staff doors call fn_is_platform_admin(), the estate's own authority,
-- which is not part of this synthetic fixture. Stand in a refusing one: that
-- function is certified by its own tests, and what this fixture is for is the
-- admission change underneath the door.
CREATE OR REPLACE FUNCTION public.fn_is_platform_admin() RETURNS boolean
 LANGUAGE sql STABLE AS $fn$ SELECT false $fn$;
-- The fixture's `tables` is a SUBSET of production's; the door reads rake_cap_bb.
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS rake_cap_bb numeric DEFAULT 0;
UPDATE public.tables SET rake_cap_bb=0 WHERE rake_cap_bb IS NULL;
\ir ../../supabase/migrations/20260912013000_a_diamond_table_may_straddle.sql
\ir ../../supabase/migrations/20260912014500_the_admission_door_reads_an_unset_column_the_way_the_engine_does.sql
\ir ../../supabase/migrations/20260912022000_a_diamond_table_may_run_it_twice.sql
