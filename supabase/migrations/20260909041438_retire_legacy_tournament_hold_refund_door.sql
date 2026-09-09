-- Tournament refunds have one entitlement-backed transaction. This 2026-04
-- hold releaser predates that authority, credits the retired global wallet
-- directly, has no caller, and remained executable by service_role. Production
-- has no tournament_register holds to preserve. Freeze the table while proving
-- that precondition, then remove the alternate money door.

BEGIN;

SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '120s';

-- This migration moves no money, but it proves the legacy hold population is
-- empty while retiring a formerly executable refund door. Serialize that
-- catalog and evidence transition with terminal settlement and live entry
-- purchases before taking the hold relation lock.
SELECT pg_advisory_xact_lock(
  hashtextextended('ca:tournament-terminal-settlement:v1',0));
SELECT pg_advisory_xact_lock_shared(530090,1);

-- The freeze predicate is executable cutover authority, not a name to trust.
-- Authenticate its exact body and the statement trigger that serializes every
-- maintenance-row writer before using either the live or pristine branch.
DO $authenticate_entry_freeze_authority$
DECLARE
  v_break_relation oid := to_regclass('public.engine_maintenance_break');
  v_predicate oid := to_regprocedure('public.fn_entry_purchases_frozen()');
  v_writer oid :=
    to_regprocedure('public.fn_serialize_engine_maintenance_break_write()');
  v_relation_owner oid;
BEGIN
  IF v_break_relation IS NULL OR v_predicate IS NULL OR v_writer IS NULL THEN
    RAISE EXCEPTION 'canonical maintenance entry-freeze authority is missing'
      USING ERRCODE = '55000';
  END IF;

  SELECT c.relowner INTO STRICT v_relation_owner
    FROM pg_class c WHERE c.oid = v_break_relation;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_language l ON l.oid = p.prolang
     WHERE p.oid = v_predicate
       AND md5(p.prosrc) = 'cff283a255830f34ad7488bbfbf70bc6'
       AND p.proowner = v_relation_owner
       AND p.prokind = 'f' AND p.provolatile = 'v'
       AND NOT p.prosecdef AND NOT p.proretset
       AND p.prorettype = 'boolean'::regtype
       AND p.pronargs = 0 AND p.pronargdefaults = 0
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       AND l.lanname = 'sql'
  ) THEN
    RAISE EXCEPTION 'maintenance entry-freeze predicate is not canonical'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_language l ON l.oid = p.prolang
     WHERE p.oid = v_writer
       AND md5(p.prosrc) = '084ed24f99e9d08765bd86ff8b920284'
       AND p.proowner = v_relation_owner
       AND p.prokind = 'f' AND p.provolatile = 'v'
       AND NOT p.prosecdef AND NOT p.proretset
       AND p.prorettype = 'trigger'::regtype
       AND p.pronargs = 0 AND p.pronargdefaults = 0
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       AND l.lanname = 'plpgsql'
  ) THEN
    RAISE EXCEPTION 'maintenance-row serialization function is not canonical'
      USING ERRCODE = '55000';
  END IF;

  IF (
    SELECT count(*)
      FROM pg_trigger tg
     WHERE tg.tgrelid = v_break_relation
       AND tg.tgname = 'aa_serialize_maintenance_break_write'
       AND tg.tgfoid = v_writer
       AND NOT tg.tgisinternal
       AND tg.tgenabled = 'O'
       AND tg.tgtype = 62
       AND tg.tgattr::text = ''
       AND tg.tgqual IS NULL
       AND tg.tgnargs = 0
  ) <> 1 THEN
    RAISE EXCEPTION 'maintenance-row serialization trigger is not canonical and enabled'
      USING ERRCODE = '55000';
  END IF;
END;
$authenticate_entry_freeze_authority$;

-- Clean schema replay has no engine to publish a maintenance row. Permit only
-- the exact source-controlled pristine shape; any account, club, tournament,
-- table, journal leg or ticket makes this a live-shaped database that must be
-- inside the serialized entry freeze before the retirement can continue.
DO $require_live_legacy_hold_retirement_freeze$
DECLARE
  v_database_is_pristine boolean;
BEGIN
  IF to_regprocedure('public.fn_entry_purchases_frozen()') IS NULL THEN
    RAISE EXCEPTION
      'legacy tournament hold retirement requires the serialized maintenance predicate first';
  END IF;

  SELECT NOT (
       EXISTS (SELECT 1 FROM auth.users)
    OR EXISTS (SELECT 1 FROM public.clubs)
    OR EXISTS (SELECT 1 FROM public.tournaments)
    OR EXISTS (SELECT 1 FROM public.tables)
    OR EXISTS (SELECT 1 FROM public.chip_ledger)
    OR EXISTS (SELECT 1 FROM public.tournament_tickets)
  ) INTO v_database_is_pristine;

  IF NOT v_database_is_pristine
     AND NOT public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'legacy tournament hold retirement live cutover requires the maintenance entry freeze'
      USING ERRCODE = '55006';
  END IF;
END;
$require_live_legacy_hold_retirement_freeze$;

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

DO $verify_live_legacy_hold_retirement_freeze_still_held$
BEGIN
  IF (
       EXISTS (SELECT 1 FROM auth.users)
    OR EXISTS (SELECT 1 FROM public.clubs)
    OR EXISTS (SELECT 1 FROM public.tournaments)
    OR EXISTS (SELECT 1 FROM public.tables)
    OR EXISTS (SELECT 1 FROM public.chip_ledger)
    OR EXISTS (SELECT 1 FROM public.tournament_tickets)
  ) AND NOT public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION
      'legacy tournament hold retirement live cutover freeze expired before commit'
      USING ERRCODE = '55006';
  END IF;
END;
$verify_live_legacy_hold_retirement_freeze_still_held$;

COMMIT;
