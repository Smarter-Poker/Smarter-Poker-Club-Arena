-- Record the omitted declaration for immutable, already-installed 20260917230925.
-- No writer, watcher, alert, financial row, or schema is changed. A different
-- installed source or live authority must refuse rather than bless unknown drift.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
DO $declare_installed_funding_guard$
DECLARE
  v_expected constant text := 'e7cae5f2fc19ef0d2c47e528764abd5a';
  v_declared text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE version = '20260917230925'
      AND name = 'cash_funding_retains_original_participant_custody'
      AND cardinality(statements) = 1
      AND encode(extensions.digest(convert_to(array_to_string(statements,E'\n'),'UTF8'),'sha256'),'hex')
        = 'febab308160e36d6adabe8a3cf7e33afe77d06cabfe799ea25e389d957f023a3'
  ) THEN
    RAISE EXCEPTION 'original funding guard declaration refuses unmatched installed migration history';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='fn_club_members_ledger_writer') <> 1
    OR NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid=to_regprocedure('public.fn_club_members_ledger_writer()')
        AND md5(pg_get_functiondef(p.oid))=v_expected
        AND pg_get_userbyid(p.proowner)='postgres'
        AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}'
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid=to_regprocedure('public.fn_ca_declare_guard_redefinition(text,text)')
        AND md5(pg_get_functiondef(p.oid))='3a3746dc6e0a5b7a1db97805588c0eb8'
        AND pg_get_userbyid(p.proowner)='postgres'
        AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}'
    ) THEN
    RAISE EXCEPTION 'original funding guard declaration refuses changed definition, owner, or grants';
  END IF;
  v_declared := public.fn_ca_declare_guard_redefinition(
    'fn_club_members_ledger_writer',
    'migration 20260917230925_cash_funding_retains_original_participant_custody; omitted declaration recorded by migration 20260918014359_declare_the_installed_original_club_funding_guard'
  );
  IF v_declared IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'original funding guard declaration changed during recording';
  END IF;
END;
$declare_installed_funding_guard$;
COMMIT;
