-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260914004129 "declare_versioned_tournament_prize_contract"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 9b3e7425fc4ce7a9362b7b16fea228e5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Reserved by scripts/reserve-migration-version.sh.
-- Records the declaration omitted from the first support installation and
-- restates the existing internal-reader ACL; no grant or economic rule expands.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_tournament_place_amounts(uuid)'::regprocedure)
      IS DISTINCT FROM 'b42f1423bb5a4c0e8b054bb18a180ae8'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_guard_tournament_prize_math_contract()'::regprocedure)
      IS DISTINCT FROM 'e0720811394779899a238abd3ac8ba07'
     OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournaments'::regclass
       AND tgname='tournament_prize_math_contract' AND tgtype=23 AND tgenabled='O'
       AND tgfoid='public.fn_guard_tournament_prize_math_contract()'::regprocedure) THEN
    RAISE EXCEPTION 'Prize declaration refuses an unreviewed installed contract';
  END IF;
END;
$guard$;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_place_amounts(uuid) FROM PUBLIC,anon,authenticated;
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)
VALUES ('tournaments','tournament_prize_math_contract',
  'Freezes explicitly versioned prize arithmetic and denomination after entry or launch; derives future units from the club; legacy version1 economics and routing remain under existing guards.')
ON CONFLICT(table_name,trigger_name) DO UPDATE SET note=EXCLUDED.note;
COMMIT;

