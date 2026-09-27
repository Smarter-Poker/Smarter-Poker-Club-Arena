-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260816152846 "event_trigger_autorevoke_anon_on_privileged_functions"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 0ad322e7d3c45cfdef87758c6dab5e09 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- PREVENTIVE HARDENING: auto-revoke `anon` on new privileged/money functions
-- ═══════════════════════════════════════════════════════════════════════════
-- Postgres grants EXECUTE to PUBLIC on every new function, and this project's
-- default privileges also grant `anon`. Relying on each migration to remember a
-- REVOKE failed three times in a single session, and the audit found five
-- pre-existing CRITICAL leaks that had survived for months.
--
-- CI cannot check this: the Club Arena CI workflow has no Supabase credentials
-- (only SENTRY_AUTH_TOKEN and GITHUB_TOKEN), which is why the existing Supabase
-- invariants run off a checked-in manifest. A manifest check is detective and
-- only as fresh as its last regeneration.
--
-- So enforce it where the fact actually lives: an event trigger that fires on
-- CREATE/ALTER FUNCTION and strips PUBLIC/anon EXECUTE from anything whose name
-- marks it as a money/privileged operation. Preventive, needs no secret, and
-- cannot be forgotten by a future migration.
--
-- Scope is deliberately narrow and safe:
--   * only schema `public`
--   * only names matching the money/privileged patterns
--   * only revokes PUBLIC and `anon` -- `authenticated` and `service_role` are
--     never touched, so no legitimate caller is affected
-- A money function has no legitimate anonymous caller, so this can only remove
-- access that was granted by accident.

CREATE OR REPLACE FUNCTION public.fn_autorevoke_privileged_anon()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  obj record;
  v_name text;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
  LOOP
    IF obj.object_type <> 'function' THEN CONTINUE; END IF;

    SELECT p.proname INTO v_name
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.oid = obj.objid AND n.nspname = 'public';

    IF v_name IS NULL THEN CONTINUE; END IF;
    IF v_name = 'fn_autorevoke_privileged_anon' THEN CONTINUE; END IF;

    -- Same privileged surface as fn_audit_privileged_grants(); st_ excluded so
    -- PostGIS is never touched.
    IF v_name !~ '^st_' AND (
         v_name ~* '(mint_|_mint|chip|wallet|promo|cashout|diamond|rake|bounty|settle|payout|clawback|purchase|treasury|jackpot|bbj)'
      OR v_name ~* '^(credit|debit|transfer|distribute|deduct|atomic|admin)_'
      OR v_name ~* '(promote_member|transfer_club_ownership|remove_player)'
    ) THEN
      BEGIN
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', obj.object_identity);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon',   obj.object_identity);
        RAISE NOTICE '[autorevoke] stripped PUBLIC/anon EXECUTE from privileged function %', obj.object_identity;
      EXCEPTION WHEN OTHERS THEN
        -- Never let hardening break a deployment; the audit function still
        -- reports anything that slips through.
        RAISE WARNING '[autorevoke] could not revoke on %: %', obj.object_identity, SQLERRM;
      END;
    END IF;
  END LOOP;
END;
$function$;

DROP EVENT TRIGGER IF EXISTS trg_autorevoke_privileged_anon;
CREATE EVENT TRIGGER trg_autorevoke_privileged_anon
  ON ddl_command_end
  WHEN TAG IN ('CREATE FUNCTION', 'ALTER FUNCTION')
  EXECUTE FUNCTION public.fn_autorevoke_privileged_anon();

COMMENT ON FUNCTION public.fn_autorevoke_privileged_anon() IS
  'Event-trigger body: strips PUBLIC/anon EXECUTE from newly created or altered money/privileged functions in public. Preventive counterpart to fn_audit_privileged_grants(), which stays as the detective check.';
