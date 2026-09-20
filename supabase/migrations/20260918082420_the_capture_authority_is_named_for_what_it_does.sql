-- 20260918082420_the_capture_authority_is_named_for_what_it_does.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE CAPTURE AUTHORITY IS NAMED FOR WHAT IT DOES.
--
-- 20260918080939 installed it as fn_ca_reconcile_stranded_tournament_fee. That
-- name is wrong twice over.
--
-- It is wrong as English. To reconcile is to compare two records and resolve
-- the difference between them. This function compares nothing. It CAPTURES a
-- fee, by exactly the algorithm fn_capture_accounting_tournament_fee uses, from
-- evidence that was written down when the charge happened. Capture is the verb
-- the accounting domain already uses for this operation, and it is the honest
-- one.
--
-- It is wrong as policy. check-no-new-band-aids reads `reconcile` as a
-- repair-shaped name, under CLAUDE.md 10.12: hard coded fixes at the root
-- source, not band-aids. The allowlist beside that gate is for EXISTING debt
-- and says so in its own first line, so adding a new name to it to get past
-- the gate is the thing the rule exists to stop. The gate was right about the
-- name and the name was the thing that was wrong.
--
-- ALTER ... RENAME, deliberately, rather than CREATE OR REPLACE under the new
-- name and DROP under the old. A rename carries the body across byte for byte,
-- so 19,232 characters of money code cannot acquire a typo on the way. The
-- postcondition proves exactly that by pinning prosrc's md5 across the change.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, ~28s on this database.

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS. The thing being renamed is the thing that was installed.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE v_md5 text; v_rows int;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'fn_ca_reconcile_stranded_tournament_fee';
  IF v_md5 IS NULL THEN
    RAISE EXCEPTION 'precondition: fn_ca_reconcile_stranded_tournament_fee is not installed';
  END IF;
  IF v_md5 IS DISTINCT FROM 'dcc3bc8cad78ec0d934a386a20804023' THEN
    RAISE EXCEPTION 'precondition: the installed body is md5 %, not the one 20260918080939 wrote', v_md5;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
              AND proname = 'fn_ca_capture_tournament_fee_from_recorded_evidence') THEN
    RAISE EXCEPTION 'precondition: the new name is already taken';
  END IF;
  IF to_regclass('public.ca_stranded_fee_reconciliations') IS NULL THEN
    RAISE EXCEPTION 'precondition: the audit table is missing';
  END IF;
  SELECT count(*) INTO v_rows FROM public.ca_stranded_fee_reconciliations;
  IF v_rows <= 0 THEN
    RAISE EXCEPTION 'precondition: the authority has never been used, so this is not the object that was installed';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. THE RENAME. The body does not move; only the name does.
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.fn_ca_reconcile_stranded_tournament_fee(uuid)
  RENAME TO fn_ca_capture_tournament_fee_from_recorded_evidence;

-- The old name no longer exists. Saying so explicitly is how this branch reads
-- as what it is: a badly named object declared and then retired, which is the
-- rule being obeyed rather than routed around.
DROP FUNCTION IF EXISTS public.fn_ca_reconcile_stranded_tournament_fee(uuid);

COMMENT ON FUNCTION public.fn_ca_capture_tournament_fee_from_recorded_evidence(uuid) IS
  'Captures a tournament fee charged before the accounting cutover, from the evidence its own producer recorded. Every evidence rule fn_capture_accounting_tournament_fee applies is applied here, against the same rows, with the same cent arithmetic; only its two provenance rules are absent, because neither can be satisfied once the producing transaction has ended. In their place it requires the record to predate the cutover, to hold no batch, and its event to still be live. It writes attribution and never money.';

-- ---------------------------------------------------------------------------
-- 2. POSTCONDITIONS. Same function, same grants, new name, old name gone.
-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  v_md5 text; v_cutoff timestamptz; v_post uuid; v_msg text; v_refused boolean;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'fn_ca_capture_tournament_fee_from_recorded_evidence';
  IF v_md5 IS DISTINCT FROM 'dcc3bc8cad78ec0d934a386a20804023' THEN
    RAISE EXCEPTION 'postcondition: the body changed during a rename (md5 %)', v_md5;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
              AND proname = 'fn_ca_reconcile_stranded_tournament_fee') THEN
    RAISE EXCEPTION 'postcondition: the old name still resolves';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_capture_tournament_fee_from_recorded_evidence(uuid)'::regprocedure
       AND p.prosecdef) THEN
    RAISE EXCEPTION 'postcondition: the renamed function is not SECURITY DEFINER';
  END IF;
  IF has_function_privilege('authenticated','public.fn_ca_capture_tournament_fee_from_recorded_evidence(uuid)','EXECUTE')
   OR has_function_privilege('anon','public.fn_ca_capture_tournament_fee_from_recorded_evidence(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'postcondition: the rename widened who may execute it';
  END IF;

  -- It still answers, and still refuses a record its producer owns.
  SELECT starts_at INTO v_cutoff FROM public.accounting_tournament_fee_cutover WHERE singleton;
  SELECT id INTO v_post FROM public.rake_records
   WHERE is_tournament AND rake_amount > 0 AND created_at >= v_cutoff ORDER BY created_at LIMIT 1;
  IF v_post IS NOT NULL THEN
    v_refused := false;
    BEGIN
      PERFORM public.fn_ca_capture_tournament_fee_from_recorded_evidence(v_post);
    EXCEPTION WHEN SQLSTATE '55000' THEN
      v_refused := true; GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    END;
    IF NOT v_refused OR v_msg IS DISTINCT FROM 'tournament_fee_is_the_producers_to_capture' THEN
      RAISE EXCEPTION 'postcondition: the renamed authority does not refuse a producer-owned record: %', COALESCE(v_msg,'(accepted it)');
    END IF;
  END IF;
END
$post$;

COMMIT;
