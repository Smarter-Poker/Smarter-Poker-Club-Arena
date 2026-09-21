-- Record the two omitted declarations for immutable, already-installed
-- 20260920183008 and 20260920192513.
--
-- WHAT WENT WRONG. Both migrations deliberately redefined a function on
-- fn_ca_guard_watchlist() and neither called
-- fn_ca_declare_guard_redefinition in its own transaction, which
-- 20260910143032_a_declared_guard_change_is_recorded_not_raised.sql requires
-- of every migration after it. So fn_ca_guard_defs_watch did exactly what it
-- exists to do: it observed a hash it had not been told about, moved the
-- baseline itself, and opened an INFO notice for a person to close by hand.
-- Two of them, measured on production:
--
--   466ebf15-8501-4c3f-b052-72b5d3311812  19:25:00Z  fn_ca_incident_escalation_tick
--   f95556fc-e0d4-4f01-b73b-42b1c443f7ae  20:25:00Z  fn_ca_autoledger
--
-- Both baselines are already AT the live definition, and both carry
-- declared_ref IS NULL - which is precisely how you tell a change the watcher
-- observed from one a migration recorded. That NULL is the defect this file
-- repairs: the audit trail says nobody owns those two redefinitions, and two
-- reviewed migrations own them.
--
-- WHY THE OMISSION IS NOT FIXED IN THE MIGRATIONS THEMSELVES. They are
-- installed, byte for byte - schema_migrations holds 36,406 and 36,391
-- characters against the files' 36,407 and 36,392, the difference being the
-- trailing newline the apply transport strips. Adding the call to either file
-- now would put a statement in this repository that production never ran, and
-- it would still not move declared_ref, because the migration has already been
-- applied and is not applied again. The file would claim the declaration
-- happened, the database would disagree, and a rebuild from these files would
-- diverge from production silently. So the installed text is left exactly as
-- it ran and the omission is recorded forward, which is the same shape as
-- 20260918014359_declare_the_installed_original_club_funding_guard.sql.
--
-- WHAT THIS DOES. It records the two declarations and nothing else. It does
-- not touch a function body, a grant, an owner, a trigger, a row of money, the
-- watcher, or the notices themselves. A different installed history or a
-- different live definition must make it refuse rather than bless a drift
-- nobody reviewed, so every one of those facts is asserted first.
--
-- IT CARRIES NO DDL, so the break-window event triggers do not apply to it and
-- it reloads no schema cache. It is still one transaction.
--
-- STILL OWED AFTER THIS, and it is a person's job, not this file's: the two
-- notices above are open on the board and do not close themselves.
--
-- @live-proof: (SELECT count(*) FROM public.ca_guard_defs WHERE proname IN ('fn_ca_incident_escalation_tick','fn_ca_autoledger') AND declared_ref LIKE '%20260921003008%') = 2
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

DO $declare_installed_escalation_tick$
DECLARE
  v_expected constant text := '52bc785feeebef56ff0d4f682168c677';
  v_declared text;
  v_was text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE version = '20260920183008'
      AND name = 'the_board_can_close_and_silence_is_never_a_fix'
      AND cardinality(statements) = 1
      AND encode(extensions.digest(convert_to(array_to_string(statements,E'\n'),'UTF8'),'sha256'),'hex')
        = 'f15d32c009acbd9e6d268aea6ae3831620bca56792c1671b856bb548ff2bb6f8'
  ) THEN
    RAISE EXCEPTION 'escalation tick declaration refuses unmatched installed migration history';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='fn_ca_incident_escalation_tick') <> 1
    OR NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid=to_regprocedure('public.fn_ca_incident_escalation_tick()')
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
    RAISE EXCEPTION 'escalation tick declaration refuses changed definition, owner, or grants';
  END IF;
  SELECT declared_ref INTO v_was FROM public.ca_guard_defs
   WHERE proname='fn_ca_incident_escalation_tick';
  RAISE NOTICE 'fn_ca_incident_escalation_tick baseline was owned by: %', COALESCE(v_was, 'nobody (the watcher observed it)');
  v_declared := public.fn_ca_declare_guard_redefinition(
    'fn_ca_incident_escalation_tick',
    'migration 20260920183008_the_board_can_close_and_silence_is_never_a_fix; omitted declaration recorded by migration 20260921003008_declare_the_two_installed_board_guards'
  );
  IF v_declared IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'escalation tick declaration changed during recording';
  END IF;
END;
$declare_installed_escalation_tick$;

DO $declare_installed_autoledger$
DECLARE
  v_expected constant text := '53f9d85b88cc86b807f7ea5b80d7bd4e';
  v_declared text;
  v_was text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE version = '20260920192513'
      AND name = 'the_journal_leg_names_the_club_the_prize_landed_in'
      AND cardinality(statements) = 1
      AND encode(extensions.digest(convert_to(array_to_string(statements,E'\n'),'UTF8'),'sha256'),'hex')
        = '2284dd4e6e631b9ad1f1cb2a9c77af63a0745b18f978fb61a1b124bf3566bd1f'
  ) THEN
    RAISE EXCEPTION 'autoledger declaration refuses unmatched installed migration history';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='fn_ca_autoledger') <> 1
    OR NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid=to_regprocedure('public.fn_ca_autoledger()')
        AND md5(pg_get_functiondef(p.oid))=v_expected
        AND pg_get_userbyid(p.proowner)='postgres'
        AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}'
        AND (SELECT count(*) FROM pg_trigger t WHERE t.tgfoid=p.oid AND NOT t.tgisinternal) = 11
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid=to_regprocedure('public.fn_ca_declare_guard_redefinition(text,text)')
        AND md5(pg_get_functiondef(p.oid))='3a3746dc6e0a5b7a1db97805588c0eb8'
        AND pg_get_userbyid(p.proowner)='postgres'
        AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}'
    ) THEN
    RAISE EXCEPTION 'autoledger declaration refuses changed definition, owner, grants, or trigger set';
  END IF;
  SELECT declared_ref INTO v_was FROM public.ca_guard_defs WHERE proname='fn_ca_autoledger';
  RAISE NOTICE 'fn_ca_autoledger baseline was owned by: %', COALESCE(v_was, 'nobody (the watcher observed it)');
  v_declared := public.fn_ca_declare_guard_redefinition(
    'fn_ca_autoledger',
    'migration 20260920192513_the_journal_leg_names_the_club_the_prize_landed_in; omitted declaration recorded by migration 20260921003008_declare_the_two_installed_board_guards'
  );
  IF v_declared IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'autoledger declaration changed during recording';
  END IF;
END;
$declare_installed_autoledger$;
COMMIT;
