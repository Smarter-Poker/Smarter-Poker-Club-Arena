-- The authoritative engine lease lives in engine_table_leases. The tables
-- relation no longer carries the retired denormalized lease columns.
-- @live-proof: (SELECT p.prosrc NOT LIKE '%t.engine_lease_owner%' AND p.prosrc NOT LIKE '%t.engine_lease_expires_at%' AND p.prosrc LIKE '%FROM public.engine_table_leases l%' FROM pg_proc p WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_fixture(uuid)'::regprocedure)
BEGIN;

DO $migration$
DECLARE
  v_source text;
  v_rewritten text;
BEGIN
  SELECT pg_get_functiondef(
    'public.fn_ca_prepare_unused_welcome_certification_fixture(uuid)'::regprocedure
  ) INTO v_source;

  IF position('t.engine_lease_owner' IN v_source) <> 0
     OR position('t.engine_lease_expires_at' IN v_source) <> 0 THEN
    v_rewritten := regexp_replace(
      v_source,
      E'\\s+OR t\\.engine_lease_owner IS NOT NULL\\s+OR t\\.engine_lease_expires_at IS NOT NULL',
      '',
      'g'
    );
    IF position('t.engine_lease_owner' IN v_rewritten) <> 0
       OR position('t.engine_lease_expires_at' IN v_rewritten) <> 0 THEN
      RAISE EXCEPTION 'WELCOME_CERTIFICATION_LEGACY_TABLE_LEASE_GUARD_NOT_REWRITTEN';
    END IF;
    EXECUTE v_rewritten;
  END IF;

  SELECT pg_get_functiondef(
    'public.fn_ca_prepare_unused_welcome_certification_fixture(uuid)'::regprocedure
  ) INTO v_source;

  IF position('t.engine_lease_owner' IN v_source) <> 0
     OR position('t.engine_lease_expires_at' IN v_source) <> 0
     OR position('FROM public.engine_table_leases l' IN v_source) = 0 THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_AUTHORITATIVE_LEASE_GUARD_NOT_INSTALLED';
  END IF;
END
$migration$;

COMMIT;
