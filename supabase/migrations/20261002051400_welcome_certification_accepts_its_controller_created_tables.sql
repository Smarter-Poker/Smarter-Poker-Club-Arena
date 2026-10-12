-- The cash cluster controller records the package owner's UUID as created_by
-- on tables it materializes. That is still exact package provenance: the table
-- belongs to one of the nine package cash games and the creator is the reserved
-- certification club owner. Keep refusing every other creator.
-- @live-proof: (SELECT p.prosrc LIKE '%t.created_by IS DISTINCT FROM v_club.owner_id%' FROM pg_proc p WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_fixture(uuid)'::regprocedure)
BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

DO $migration$
DECLARE
  v_source text;
  v_rewritten text;
  v_old text := 't.created_by IS NOT NULL';
  v_new text := '(t.created_by IS NOT NULL AND t.created_by IS DISTINCT FROM v_club.owner_id)';
BEGIN
  SELECT pg_get_functiondef(
    'public.fn_ca_prepare_unused_welcome_certification_fixture(uuid)'::regprocedure
  ) INTO v_source;

  IF position(v_new IN v_source) = 0 THEN
    IF position(v_old IN v_source) = 0 THEN
      RAISE EXCEPTION 'WELCOME_CERTIFICATION_CONTROLLER_PROVENANCE_GUARD_NOT_FOUND';
    END IF;
    v_rewritten := replace(v_source, v_old, v_new);
    EXECUTE v_rewritten;
  END IF;

  SELECT pg_get_functiondef(
    'public.fn_ca_prepare_unused_welcome_certification_fixture(uuid)'::regprocedure
  ) INTO v_source;
  IF position(v_new IN v_source) = 0 THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_CONTROLLER_PROVENANCE_GUARD_NOT_INSTALLED';
  END IF;
END
$migration$;

COMMIT;
