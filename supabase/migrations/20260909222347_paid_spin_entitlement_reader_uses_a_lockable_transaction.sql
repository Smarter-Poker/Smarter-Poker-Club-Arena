-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260909222347; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260909222347   (the stamp IS the apply time, UTC: 2026-09-09 22:23:47)
--   name        paid_spin_entitlement_reader_uses_a_lockable_transaction
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 3281 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260909222347 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     (no CREATE/DROP of a named object; see the body)

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

-- 20260909222153_paid_spin_entitlement_reader_uses_a_lockable_transaction.sql
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-09 22:21:53 UTC.
--
-- The narrow paid-Spin reader was first declared STABLE because its body only
-- reads immutable evidence. PostgREST consequently opened POST /rpc in a
-- read-only transaction, but the existing tournament-manager pre-request
-- fence takes SELECT FOR SHARE on the exact lease generation. The first live
-- protocol-2 smoke request was correctly refused with SQLSTATE 25006 before
-- the RPC body ran. This function is transaction-volatile by design: its
-- authority boundary must lock the manager lease for the duration of the read.
-- No data, ACL, table privilege, or function body changes here.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
DECLARE
  v_oid regprocedure :=
    'public.fn_ca_paid_spin_launch_entitlements(uuid,uuid[])'::regprocedure;
BEGIN
  IF v_oid IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc p
        WHERE p.oid = v_oid
          AND p.prosecdef
          AND p.provolatile = 's'
     ) THEN
    RAISE EXCEPTION
      'paid Spin entitlement reader volatility correction requires the exact sealed STABLE reader';
  END IF;
END;
$preflight$;

ALTER FUNCTION public.fn_ca_paid_spin_launch_entitlements(uuid, uuid[])
  VOLATILE;

DO $verify$
DECLARE
  v_oid regprocedure :=
    'public.fn_ca_paid_spin_launch_entitlements(uuid,uuid[])'::regprocedure;
  v_source text;
  v_config text[];
  v_security_definer boolean;
  v_volatility "char";
BEGIN
  SELECT p.prosrc, p.proconfig, p.prosecdef, p.provolatile
    INTO v_source, v_config, v_security_definer, v_volatility
    FROM pg_catalog.pg_proc p
   WHERE p.oid = v_oid;

  IF v_source IS NULL
     OR v_security_definer IS DISTINCT FROM true
     OR v_volatility IS DISTINCT FROM 'v'
     OR NOT (v_config @> ARRAY[
          'search_path=""',
          'row_security=off',
          'statement_timeout=5s'
        ]::text[])
     OR v_source NOT LIKE
          '%auth.role() IS DISTINCT FROM ''service_role''%'
     OR v_source NOT LIKE
          '%v_actor IS DISTINCT FROM ''tournament-manager''%'
     OR v_source NOT LIKE
          '%v_context_tournament IS DISTINCT FROM p_tournament_id::text%'
     OR v_source NOT LIKE
          '%FROM public.tournament_refund_entitlements e%'
     OR v_source ~* '\m(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\M'
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc p
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
         ) privilege
        WHERE p.oid = v_oid
          AND privilege.grantee = 0
          AND privilege.privilege_type = 'EXECUTE'
     )
     OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
     OR has_table_privilege(
          'service_role',
          'public.tournament_refund_entitlements',
          'SELECT'
        ) THEN
    RAISE EXCEPTION
      'paid Spin entitlement reader did not become a lockable, narrow service-only request';
  END IF;
END;
$verify$;

COMMIT;
