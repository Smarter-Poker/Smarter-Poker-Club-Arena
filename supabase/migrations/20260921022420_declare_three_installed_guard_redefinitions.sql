-- Record the three omitted declarations for immutable, already-installed
-- 20260912110448, 20260917181100 and 20260917210713.
--
-- WHAT WENT WRONG. Each of these migrations deliberately changed a function on
-- fn_ca_guard_watchlist() and none of them called
-- fn_ca_declare_guard_redefinition in its own transaction, which
-- 20260910143032_a_declared_guard_change_is_recorded_not_raised.sql requires of
-- every migration after it. So fn_ca_guard_defs_watch did exactly what it
-- exists to do: it observed a hash it had not been told about, moved the
-- baseline itself, and opened an INFO notice for a person to close by hand.
-- Three of them, measured on production:
--
--   74f472d8-2b87-4928-9f9b-6b09f0cc86a6  2026-09-12 11:25Z  fn_ca_incident_notify
--   0fe56924-11b8-4b4a-a854-86016f3a1979  2026-09-17 19:25Z  fn_ca_post_correction
--   30a99ff0-d0f6-4569-ab11-1076d2de6cc7  2026-09-17 21:25Z  fn_poker_diamond_tournament_unregister
--
-- All three baselines are already AT the live definition. The first two carry
-- declared_ref IS NULL. The third is the case the watcher cannot express: it
-- carries a NON-NULL declared_ref naming 20260914103912, because
-- fn_ca_guard_defs_watch moves def_hash and updated_at but never clears
-- declared_ref - so a stale ref survives a redefinition it does not own and
-- reads exactly like a current one. Its declared_at (2026-09-14 10:39:12Z)
-- is three days older than the baseline it appears to vouch for, which is the
-- only thing that gives it away. That is the defect this file repairs in all
-- three cases: the audit trail says nobody owns these redefinitions, and three
-- reviewed migrations own them.
--
-- HOW EACH ONE WAS TIED TO ITS MIGRATION. ca-guard-defs-hourly runs at '25 * * * *',
-- so a notice at HH:25 is a change made in the hour before it, and the owner
-- has to be the last migration to touch that function inside that window:
--
--   fn_ca_incident_notify - 20260912110448 (11:04:48Z, inside the 10:25-11:25
--     window) is the LAST migration in the whole history that carries a CREATE
--     OR REPLACE for it, and the live prosrc appears VERBATIM in that migration's
--     installed text. Nothing has edited it since, or the body would not match.
--
--   fn_ca_post_correction - 20260917181100 is likewise the last CREATE OR
--     REPLACE for it, and the live prosrc appears VERBATIM in its installed
--     text. It is 1,669,109 characters and its reserved version (18:11Z) is
--     14 minutes before the 18:25-19:25 window opens; a migration of that size
--     is applied after it is reserved, which is why the notice is at 19:25.
--
--   fn_poker_diamond_tournament_unregister - 20260917210713 (21:07:13Z, inside
--     the 20:25-21:25 window) does NOT carry a CREATE OR REPLACE at all. It is
--     a manifest-driven source-surgery migration, and its manifest names this
--     function's signature together with
--       pre_definition_md5  fd9570d3b373036bd1b93f6d7fbe5673
--       post_definition_md5 39f95b499619cab7a1eb65ff583aa638
--     which are, exactly, the baseline it replaced (ca_guard_def_history 9186,
--     the hash 20260914103912 declared) and the baseline live today
--     (ca_guard_def_history 13983). A migration that states the before and
--     after hashes of the definition it edits is the strongest evidence of
--     ownership available here, so it is what this file asserts.
--
-- WHY THE OMISSION IS NOT FIXED IN THE MIGRATIONS THEMSELVES. They are
-- installed. Adding the call to any of them now would put a statement in this
-- repository that production never ran, and it would still not move
-- declared_ref, because an applied migration is not applied again. The file
-- would claim the declaration happened, the database would disagree, and a
-- rebuild from these files would diverge from production silently. So the
-- installed text is left exactly as it ran and the omission is recorded
-- forward, which is the same shape as
-- 20260921003008_declare_the_two_installed_board_guards.sql and
-- 20260918014359_declare_the_installed_original_club_funding_guard.sql.
--
-- WHAT THIS DOES. It records three declarations and nothing else. It does not
-- touch a function body, a grant, an owner, a trigger, a row of money, the
-- watcher, or the notices themselves. A different installed history, a
-- different live definition, a different owner or ACL, or a baseline somebody
-- else has already declared must make it refuse rather than bless a drift
-- nobody reviewed, so every one of those facts is asserted first - including
-- the PRE-STATE of declared_ref, which is what proves no second declaration
-- raced this one.
--
-- IT CARRIES NO DDL, so the break-window event triggers do not apply to it and
-- it reloads no schema cache. It is still one transaction.
--
-- STILL OWED AFTER THIS, and it is a person's job, not this file's: the three
-- notices above are open on the board and do not close themselves. So are
-- 466ebf15 and f95556fc (declared by 20260921003008) and 662dd994 (declared by
-- 20260918014359) - six in total, all now owned, none self-closing.
--
-- @live-proof: (SELECT count(*) FROM public.ca_guard_defs WHERE proname IN ('fn_ca_incident_notify','fn_ca_post_correction','fn_poker_diamond_tournament_unregister') AND declared_ref LIKE '%20260921022420%') = 3
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $declare_installed_incident_notify$
DECLARE
  v_expected constant text := 'ad9a51b31ec9d8f52a416e5e77a033a2';
  v_declared text;
  v_was text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE version = '20260912110448'
      AND name = 'a_platform_that_is_not_dealing_is_worth_waking_someone'
      AND cardinality(statements) = 1
      AND encode(extensions.digest(convert_to(array_to_string(statements,E'\n'),'UTF8'),'sha256'),'hex')
        = '27e8d1733ae5246ef24fde88cc435c81e3b4a487b1c0f44120b2e26602ff15b3'
  ) THEN
    RAISE EXCEPTION 'incident notify declaration refuses unmatched installed migration history';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='fn_ca_incident_notify') <> 1
    OR NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid=to_regprocedure('public.fn_ca_incident_notify(uuid,text,text,boolean)')
        AND md5(pg_get_functiondef(p.oid))=v_expected
        AND pg_get_userbyid(p.proowner)='postgres'
        AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}'
        AND (SELECT count(*) FROM pg_trigger t WHERE t.tgfoid=p.oid AND NOT t.tgisinternal) = 0
    ) THEN
    RAISE EXCEPTION 'incident notify declaration refuses changed definition, owner, grants, or trigger set';
  END IF;
  -- the body that is live is the body that migration installed, verbatim
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations m, pg_proc p
    WHERE m.version='20260912110448'
      AND p.oid=to_regprocedure('public.fn_ca_incident_notify(uuid,text,text,boolean)')
      AND position(p.prosrc in array_to_string(m.statements,E'\n')) > 0
  ) THEN
    RAISE EXCEPTION 'incident notify declaration refuses: live body is not the text 20260912110448 installed';
  END IF;
  SELECT declared_ref INTO v_was FROM public.ca_guard_defs WHERE proname='fn_ca_incident_notify';
  IF v_was IS NOT NULL THEN
    RAISE EXCEPTION 'incident notify baseline is already declared by %, refusing to overwrite', v_was;
  END IF;
  RAISE NOTICE 'fn_ca_incident_notify baseline was owned by: nobody (the watcher observed it)';
  v_declared := public.fn_ca_declare_guard_redefinition(
    'fn_ca_incident_notify',
    'migration 20260912110448_a_platform_that_is_not_dealing_is_worth_waking_someone; omitted declaration recorded by migration 20260921022420_declare_three_installed_guard_redefinitions'
  );
  IF v_declared IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'incident notify declaration changed during recording';
  END IF;
END;
$declare_installed_incident_notify$;

DO $declare_installed_post_correction$
DECLARE
  v_expected constant text := '4492ef51ddb64edfac10a0535efb40b5';
  v_declared text;
  v_was text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE version = '20260917181100'
      AND name = 'union_weekly_accounting_atomic_activation_20260917'
      AND cardinality(statements) = 1
      AND encode(extensions.digest(convert_to(array_to_string(statements,E'\n'),'UTF8'),'sha256'),'hex')
        = '89e6e7650022f1c3eb4b5dd575ae935e9110d90b329a29340159c1eff9004f70'
  ) THEN
    RAISE EXCEPTION 'post correction declaration refuses unmatched installed migration history';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='fn_ca_post_correction') <> 1
    OR NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid=to_regprocedure('public.fn_ca_post_correction(text,uuid,text,uuid,numeric,text,uuid,bigint,uuid,uuid,jsonb)')
        AND md5(pg_get_functiondef(p.oid))=v_expected
        AND pg_get_userbyid(p.proowner)='postgres'
        AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}'
        AND (SELECT count(*) FROM pg_trigger t WHERE t.tgfoid=p.oid AND NOT t.tgisinternal) = 0
    ) THEN
    RAISE EXCEPTION 'post correction declaration refuses changed definition, owner, grants, or trigger set';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations m, pg_proc p
    WHERE m.version='20260917181100'
      AND p.oid=to_regprocedure('public.fn_ca_post_correction(text,uuid,text,uuid,numeric,text,uuid,bigint,uuid,uuid,jsonb)')
      AND position(p.prosrc in array_to_string(m.statements,E'\n')) > 0
  ) THEN
    RAISE EXCEPTION 'post correction declaration refuses: live body is not the text 20260917181100 installed';
  END IF;
  SELECT declared_ref INTO v_was FROM public.ca_guard_defs WHERE proname='fn_ca_post_correction';
  IF v_was IS NOT NULL THEN
    RAISE EXCEPTION 'post correction baseline is already declared by %, refusing to overwrite', v_was;
  END IF;
  RAISE NOTICE 'fn_ca_post_correction baseline was owned by: nobody (the watcher observed it)';
  v_declared := public.fn_ca_declare_guard_redefinition(
    'fn_ca_post_correction',
    'migration 20260917181100_union_weekly_accounting_atomic_activation_20260917; omitted declaration recorded by migration 20260921022420_declare_three_installed_guard_redefinitions'
  );
  IF v_declared IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'post correction declaration changed during recording';
  END IF;
END;
$declare_installed_post_correction$;

DO $declare_installed_diamond_unregister$
DECLARE
  v_expected constant text := '39f95b499619cab7a1eb65ff583aa638';
  v_prior   constant text := 'fd9570d3b373036bd1b93f6d7fbe5673';
  v_stale   constant text := 'migration a_diamond_seat_exit_goes_home_through_its_own_door';
  v_declared text;
  v_was text;
  v_body text;
BEGIN
  SELECT array_to_string(statements,E'\n') INTO v_body
    FROM supabase_migrations.schema_migrations
   WHERE version = '20260917210713'
     AND name = 'mtt_recorded_format_seat_consumers_preparation'
     AND cardinality(statements) = 1
     AND encode(extensions.digest(convert_to(array_to_string(statements,E'\n'),'UTF8'),'sha256'),'hex')
       = 'dacb81f41b5e207fb9e50c49a6c09b26bdfb27f3374ca002b010c9b2bea44a52';
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'diamond unregister declaration refuses unmatched installed migration history';
  END IF;
  -- that migration carries no CREATE OR REPLACE for this function; it states
  -- the before and after definition hashes of the edit it made. Both must be
  -- present, and they must be the two baselines this guard actually moved between.
  IF position(v_prior in v_body) = 0 OR position(v_expected in v_body) = 0
     OR position('public.fn_poker_diamond_tournament_unregister(uuid,uuid,uuid)' in v_body) = 0 THEN
    RAISE EXCEPTION 'diamond unregister declaration refuses: 20260917210713 does not name this signature with both definition hashes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_guard_def_history
                  WHERE proname='fn_poker_diamond_tournament_unregister' AND def_hash=v_prior)
     OR NOT EXISTS (SELECT 1 FROM public.ca_guard_def_history
                  WHERE proname='fn_poker_diamond_tournament_unregister' AND def_hash=v_expected) THEN
    RAISE EXCEPTION 'diamond unregister declaration refuses: the two hashes are not both in this guard''s captured history';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='fn_poker_diamond_tournament_unregister') <> 1
    OR NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid=to_regprocedure('public.fn_poker_diamond_tournament_unregister(uuid,uuid,uuid)')
        AND md5(pg_get_functiondef(p.oid))=v_expected
        AND pg_get_userbyid(p.proowner)='postgres'
        AND p.proacl::text='{postgres=X/postgres}'
        AND (SELECT count(*) FROM pg_trigger t WHERE t.tgfoid=p.oid AND NOT t.tgisinternal) = 0
    ) THEN
    RAISE EXCEPTION 'diamond unregister declaration refuses changed definition, owner, grants, or trigger set';
  END IF;
  SELECT declared_ref INTO v_was FROM public.ca_guard_defs
   WHERE proname='fn_poker_diamond_tournament_unregister';
  IF v_was IS DISTINCT FROM v_stale THEN
    RAISE EXCEPTION 'diamond unregister baseline no longer carries the stale ref this file was written to replace; it carries %', COALESCE(v_was,'NULL');
  END IF;
  RAISE NOTICE 'fn_poker_diamond_tournament_unregister baseline was owned by a STALE ref: % (declared for the earlier hash %)', v_was, v_prior;
  v_declared := public.fn_ca_declare_guard_redefinition(
    'fn_poker_diamond_tournament_unregister',
    'migration 20260917210713_mtt_recorded_format_seat_consumers_preparation; omitted declaration recorded by migration 20260921022420_declare_three_installed_guard_redefinitions (replaces a stale ref left by 20260914103912_a_diamond_seat_exit_goes_home_through_its_own_door)'
  );
  IF v_declared IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'diamond unregister declaration changed during recording';
  END IF;
END;
$declare_installed_diamond_unregister$;
COMMIT;
