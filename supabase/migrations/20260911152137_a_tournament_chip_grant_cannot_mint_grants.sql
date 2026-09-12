-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260911152137; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260911152137   (the stamp IS the apply time, UTC: 2026-09-11 15:21:37)
--   name        a_tournament_chip_grant_cannot_mint_grants
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 2416 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260911152137 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     (no CREATE/DROP of a named object; see the body)
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- Grants half of 20260911145935_a_tournament_chip_grant_cannot_mint.sql.
-- REVOKE ALL ... FROM PUBLIC does not remove a grant a role holds DIRECTLY,
-- and this project's default privileges grant EXECUTE on new functions to
-- anon and authenticated, so the first apply left fn_ca_tournament_felt_total
-- callable by anon and all three new functions callable by authenticated.
-- All four are SECURITY DEFINER and none is an RLS policy helper (checked
-- against pg_policy). GRANT/REVOKE do not fire pgrst_ddl_watch, so this costs
-- no schema-cache reload.
BEGIN;

REVOKE ALL ON FUNCTION public.fn_ca_tournament_chip_supply(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_chip_supply(uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_ca_tournament_felt_total(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_felt_total(uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_ca_assert_tournament_chip_grant(
  uuid,uuid,uuid,numeric,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_assert_tournament_chip_grant(
  uuid,uuid,uuid,numeric,text) TO service_role;

REVOKE ALL ON FUNCTION public.fn_tournament_chip_conservation_check(numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_chip_conservation_check(numeric)
  TO service_role;

DO $assert$
DECLARE
  v_open text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_open
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname IN ('fn_ca_tournament_chip_supply',
                       'fn_ca_tournament_felt_total',
                       'fn_ca_assert_tournament_chip_grant',
                       'fn_tournament_chip_conservation_check')
     AND ( has_function_privilege('anon', p.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', p.oid, 'EXECUTE') );
  IF v_open IS NOT NULL THEN
    RAISE EXCEPTION
      'ABORT: still reachable without service authority: %', v_open;
  END IF;

  -- and the engine must not have lost its own access in the process
  IF NOT has_function_privilege('service_role',
        'public.fn_ca_assert_tournament_chip_grant(uuid,uuid,uuid,numeric,text)',
        'EXECUTE') THEN
    RAISE EXCEPTION 'ABORT: service_role can no longer assert a chip grant';
  END IF;
END;
$assert$;

COMMIT;
