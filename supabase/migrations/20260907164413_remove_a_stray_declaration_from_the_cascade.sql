-- REMOVE A STRAY DECLARATION FROM THE CASCADE
-- =============================================================================
-- 20260907164234 left an editing artefact in the DECLARE block of
-- fn_union_settlement_cascade:
--
--     FUNCTION_BODY_MARKER boolean := true;
--
-- It is inert - an unused variable - and every assertion in that migration
-- passed with it present, including the live test that a floored period is now
-- refused. It is removed anyway: a money function should not carry a variable
-- named after a scaffolding marker, and the repo copy and production must be
-- byte-identical.
--
-- Removed by exact text substitution on the live definition rather than by
-- retyping 7.5 KB of settlement logic, so the only thing that can change is the
-- two lines being deleted.
-- =============================================================================

BEGIN;

DO $migrate$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc
   WHERE proname = 'fn_union_settlement_cascade'
     AND pronamespace = 'public'::regnamespace;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_union_settlement_cascade not found';
  END IF;

  v_new := replace(v_def,
E'\n  -- A round has "failed" unless it succeeded, or it is telling us its money\n  -- already moved. Anything else stops the cascade.\n  FUNCTION_BODY_MARKER boolean := true;',
    '');

  IF v_new = v_def THEN
    RAISE EXCEPTION 'the stray declaration was not found in the expected form';
  END IF;

  EXECUTE v_new;
END
$migrate$;

DO $assert$
DECLARE v_src text; v_res jsonb;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_union_settlement_cascade' AND pronamespace='public'::regnamespace;

  IF v_src LIKE '%FUNCTION_BODY_MARKER%' THEN
    RAISE EXCEPTION 'the stray declaration is still there';
  END IF;

  IF v_src NOT LIKE '%before_settlement_floor%'
     OR v_src NOT LIKE '%round1_failed%'
     OR v_src NOT LIKE '%round2_failed%'
     OR v_src NOT LIKE '%round3_failed%'
     OR v_src NOT LIKE '%weekly_invoices_enabled%'
     OR v_src NOT LIKE '%fn_union_weekly_rakeback_close%'
     OR v_src NOT LIKE '%fn_settle_round2_club_to_agents%'
     OR v_src NOT LIKE '%fn_settle_round3_agents_to_players%' THEN
    RAISE EXCEPTION 'the cleanup lost something from the cascade';
  END IF;

  v_res := public.fn_union_settlement_cascade(
             'fade0000-0000-0000-0000-000000000001',
             '2026-08-24 07:00:00+00', '2026-08-31 07:00:00+00');
  IF (v_res->>'success')::boolean IS NOT FALSE
     OR v_res->>'error' <> 'before_settlement_floor' THEN
    RAISE EXCEPTION 'a floored period is no longer refused: %', v_res::text;
  END IF;
  IF EXISTS (SELECT 1 FROM union_settlement_rounds
              WHERE period_start='2026-08-24 07:00:00+00' AND period_end='2026-08-31 07:00:00+00') THEN
    RAISE EXCEPTION 'the refused period wrote round rows';
  END IF;
END
$assert$;

COMMIT;
