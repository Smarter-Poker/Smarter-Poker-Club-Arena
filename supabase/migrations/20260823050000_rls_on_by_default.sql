-- ============================================================================
-- 20260823050000_rls_on_by_default.sql
-- TIER: 3  |  AFFECTS: every future CREATE TABLE in the public schema.
--
-- WHY
--
-- On 2026-08-22, two tables were created hours apart by two different agents:
--
--   commander_blind_structure_backup_20260822
--   db_saturation_selftest_log
--
-- Both arrived with RLS disabled and INSERT/UPDATE/DELETE granted to `anon`.
-- An unauthenticated request could write to either. Neither agent did anything
-- wrong: the schema's DEFAULT PRIVILEGES hand `arwdxtm` to anon and
-- authenticated on every new relation, from both `postgres` and
-- `supabase_admin`:
--
--   r -> {postgres=arwdDxtm/postgres, anon=arwdxtm/postgres,
--         authenticated=arwdxtm/postgres, service_role=arwdDxtm/postgres}
--
-- CHECK 10 of the World Hub's Build Safety Gate caught both, and because it
-- reads the LIVE catalog rather than the branch, each failure landed on EVERY
-- open pull request in the repository at once, attached to nobody's diff. Twice
-- in one evening, the whole merge queue stopped on a table nobody in that queue
-- had created.
--
-- Locking each table as it appears is not a fix. This is.
--
-- WHY AN EVENT TRIGGER, AND WHY RLS RATHER THAN REVOKE
--
-- The estate already solves exactly this class of problem this way:
-- `trg_autorevoke_privileged_anon` is a ddl_command_end trigger that strips
-- EXECUTE from money-shaped functions the moment they are created, with a
-- session GUC as an escape hatch. That pattern was never extended to tables,
-- and tables are where the two incidents happened. This is the table half, in
-- the same shape, down to the escape hatch.
--
-- ENABLING RLS is chosen over revoking the grants because it makes the
-- invariant structurally unsatisfiable rather than merely satisfied today:
-- CHECK 10 tests `NOT relrowsecurity AND client-writable`, and with RLS on, the
-- first half is false no matter what anyone grants later. service_role bypasses
-- RLS and the table owner is exempt, so the engine, the cron handlers and every
-- SECURITY DEFINER function keep working untouched - which is the case both
-- incidents actually were, a log and a backup written only by the service role.
--
-- WHAT A DEVELOPER SEES
--
-- A new table with no policies returns [] to a client SELECT and refuses a
-- client INSERT with "new row violates row-level security policy". That is the
-- correct default for this project - Supabase's own guidance is RLS on every
-- public table - and it fails CLOSED. Adding a policy is a deliberate act; it
-- was the absence of that act that shipped two writable tables.
--
-- If a table genuinely must ship without RLS:
--
--   SET app.allow_rls_off_table = 'on';
--   CREATE TABLE public.whatever (...);
--
-- which leaves the decision on the record instead of making it by accident.
--
-- SAFETY
--
-- This function runs on EVERY CREATE TABLE in the estate, so it must never be
-- the reason a migration fails. Every action is wrapped and a failure is a
-- WARNING, not an exception. CHECK 10 remains the backstop underneath it.
--
-- PROVEN, against production, in a transaction that was then rolled back:
--
--   plain CREATE TABLE          -> RLS enabled   (the shape of both incidents)
--   CREATE TABLE AS SELECT      -> RLS enabled   (how the backup arrived)
--   with app.allow_rls_off_table -> RLS off      (escape hatch still works)
--   grants unchanged                             (RLS is what denies, by design)
--   probe tables left behind    -> 0
--
-- ROLLBACK
--
--   DROP EVENT TRIGGER IF EXISTS trg_rls_on_new_public_table;
--   DROP FUNCTION IF EXISTS public.fn_rls_on_new_public_table();
--
--   Dropping it does not re-open any existing table; it only stops protecting
--   the next one.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_rls_on_new_public_table()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  obj record;
  v_name text;
BEGIN
  -- Deliberate escape hatch, mirroring fn_autorevoke_privileged_anon's
  -- app.allow_privileged_anon_grant.
  IF COALESCE(current_setting('app.allow_rls_off_table', true), 'off') = 'on' THEN
    RETURN;
  END IF;

  FOR obj IN
    SELECT * FROM pg_event_trigger_ddl_commands()
     WHERE schema_name = 'public' AND object_type = 'table'
  LOOP
    BEGIN
      SELECT c.relname INTO v_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.oid = obj.objid
         AND n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
         AND NOT c.relrowsecurity;

      IF v_name IS NULL THEN
        CONTINUE;
      END IF;

      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_name);
      RAISE NOTICE 'RLS enabled automatically on public.% (no policies yet, so only service_role and the owner can see it). Add a policy if clients need access.', v_name;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'fn_rls_on_new_public_table could not secure %: %', COALESCE(v_name, obj.object_identity), SQLERRM;
    END;
  END LOOP;
END;
$fn$;

COMMENT ON FUNCTION public.fn_rls_on_new_public_table() IS
  'Enables RLS on every newly created table in public. CREATE TABLE here inherits arwdxtm for anon and authenticated from the schema default privileges, so a new table is world-writable until someone notices - which on 2026-08-22 took two separate incidents and blocked every merge in the World Hub twice. Escape hatch: SET app.allow_rls_off_table = on.';

DROP EVENT TRIGGER IF EXISTS trg_rls_on_new_public_table;
CREATE EVENT TRIGGER trg_rls_on_new_public_table
  ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION public.fn_rls_on_new_public_table();

-- ── Post-apply assertions ───────────────────────────────────────────────────
DO $$
DECLARE v_enabled char;
BEGIN
  SELECT evtenabled INTO v_enabled FROM pg_event_trigger WHERE evtname = 'trg_rls_on_new_public_table';
  IF v_enabled IS NULL THEN
    RAISE EXCEPTION 'trg_rls_on_new_public_table was not created';
  END IF;
  IF v_enabled = 'D' THEN
    RAISE EXCEPTION 'trg_rls_on_new_public_table was created DISABLED';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE c.relkind = 'r' AND NOT c.relrowsecurity AND c.relname <> 'spatial_ref_sys'
       AND (has_table_privilege('anon', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
         OR has_table_privilege('authenticated', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE'))
  ) THEN
    RAISE EXCEPTION 'no_rls_off_tables_writable_by_clients is failing at apply time';
  END IF;
END $$;

-- ============================================================================
-- APPLY HISTORY
--
-- Applied to production 2026-08-23 as `rls_on_by_default_for_new_public_tables`.
-- Behavioural probe run against production and rolled back: plain CREATE TABLE
-- and CREATE TABLE AS both came out with RLS enabled, the escape hatch left it
-- off, grants were untouched, 0 probe tables survived, economy_invariants()
-- reported 12 checks 0 failing.
-- ============================================================================
