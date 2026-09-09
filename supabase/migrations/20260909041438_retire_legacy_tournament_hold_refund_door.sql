-- Tournament refunds have one entitlement-backed transaction. This 2026-04
-- hold releaser predates that authority, credits the retired global wallet
-- directly, has no caller, and remained executable by service_role. Production
-- has no tournament_register holds to preserve. Freeze the table while proving
-- that precondition, then remove the alternate money door.

BEGIN;

SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '120s';

LOCK TABLE public.chip_escrow_holds IN SHARE ROW EXCLUSIVE MODE;

DO $legacy_hold_guard$
BEGIN
  IF to_regprocedure('public.fn_release_tournament_holds(uuid)') IS NULL THEN
    RAISE EXCEPTION
      'fn_release_tournament_holds(uuid) is already absent; deployment ancestry is incomplete';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.chip_escrow_holds h
     WHERE h.hold_type = 'tournament_register'
  ) THEN
    RAISE EXCEPTION
      'legacy tournament_register holds still exist; classify them before retiring their unsafe refund door'
      USING ERRCODE = '55000';
  END IF;

  -- DROP ... RESTRICT sees catalog dependencies, but PostgreSQL does not record
  -- PL/pgSQL calls as pg_depend edges. Refuse the cutover if a stored function
  -- in any application schema acquired a textual call after this door was
  -- audited. System, temporary, and extension-internal schemas are excluded.
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname <> 'information_schema'
       AND n.nspname !~ '^pg_'
       AND p.oid <> 'public.fn_release_tournament_holds(uuid)'::regprocedure
       AND p.prosrc ~* 'fn_release_tournament_holds[[:space:]]*\('
  ) THEN
    RAISE EXCEPTION
      'a stored function still calls fn_release_tournament_holds(uuid); repoint it before retiring the legacy refund door'
      USING ERRCODE = '2BP01';
  END IF;
END;
$legacy_hold_guard$;

REVOKE ALL ON FUNCTION public.fn_release_tournament_holds(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION public.fn_release_tournament_holds(uuid) RESTRICT;

DO $legacy_hold_absence$
BEGIN
  IF to_regprocedure('public.fn_release_tournament_holds(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'legacy tournament hold refund door survived retirement';
  END IF;
END;
$legacy_hold_absence$;

COMMIT;
