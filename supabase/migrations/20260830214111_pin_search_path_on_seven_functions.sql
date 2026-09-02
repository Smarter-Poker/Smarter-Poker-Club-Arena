-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830214111; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- 2026-08-30 advisor cleanup (function_search_path_mutable): seven functions
-- ran with a role-mutable search_path - a caller who can set search_path can
-- redirect any unqualified reference inside them. Pin all seven to public.
-- Uses ALTER FUNCTION so bodies stay exactly as deployed.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure::text as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('fn_gto_texture_class','fn_rake_shares_for_record',
                         'fn_gto_texture_class_any','pnm_primary_venue_issue',
                         'pnm_venue_missing_fields','pnm_basic_location_status',
                         'fn_gto_board_flush_suit')
  loop
    execute format('alter function %s set search_path to public', f.sig);
  end loop;
end $$;
