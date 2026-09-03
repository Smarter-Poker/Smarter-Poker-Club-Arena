-- One player the sweep cannot credit stopped every payout in the pass.
--
-- fn_tournament_payout_sweep loops over completed tournaments calling
-- fn_tournament_payout_reconcile on each, and the loop had NO exception
-- handler. So a single tournament that raises does not get skipped: the
-- function aborts, and every top-up the pass had already applied is rolled
-- back with it.
--
-- That stopped being theoretical at 03:52 on 2026-09-01. Two consecutive
-- hourly runs failed, on two DIFFERENT players, one second into the pass:
--
--   03:52  ERROR: No club wallet resolves for Club Arena credit to player
--          6313dbdb-f274-430b-8c98-acdfc07ca816   (dss-087)
--   04:52  ERROR: No club wallet resolves for Club Arena credit to player
--          04910a99-8757-4581-8c84-12ba8a454a75   (dss-388)
--
-- Both are among 417 `dss-*` accounts created in a 19-minute window that hold
-- no club_members row at all. The sweep is now walking into them one an hour
-- and paying nobody in the meantime. Owed players wait for a pass that happens
-- to find no unpayable account ahead of them in the queue.
--
-- The accounts are somebody else's to resolve and this migration does not touch
-- them. What it fixes is the part that turned one bad row into a total outage:
-- the sweep now isolates each tournament, so a failure costs that tournament
-- and nothing else. The sibling sweep has done this since it was written, and
-- its comment says why:
--
--   EXCEPTION WHEN OTHERS THEN
--     -- Loud, never fatal: one stuck game must not stop the rest being freed.
--
-- fn_tournament_payout_sweep is the one that pays PLAYERS, and it was the one
-- without the handler.
--
-- Loud, not silent: failures are counted, the first twenty ids are returned to
-- the caller, and a single deduped financial alert is raised for the pass. One
-- alert rather than one per failure, because 417 candidate accounts could
-- otherwise flood the table with the same finding.
--
-- Nothing about which players get paid, or how much, changes here.

CREATE OR REPLACE FUNCTION public.fn_tournament_payout_sweep(
  p_days integer DEFAULT 2,
  p_apply boolean DEFAULT false,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '600s'
AS $function$
DECLARE
  r          record;
  v_res      jsonb;
  v_out      jsonb := '[]'::jsonb;
  v_n        int    := 0;
  v_topup    numeric := 0;
  v_matched  int    := 0;
  v_scanned  int    := 0;
  v_failed   int    := 0;
  v_fail_ids uuid[] := ARRAY[]::uuid[];
  v_first_err text;
  v_limit    int    := GREATEST(p_limit, 1);
  v_since    timestamptz := now() - make_interval(days => GREATEST(p_days, 1));
BEGIN
  -- How many events the window actually holds, BEFORE the limit is applied.
  -- Cheap next to the reconcile loop, and it is the only way the caller can
  -- tell a complete pass from a truncated one.
  SELECT count(*) INTO v_matched
    FROM tournaments t
   WHERE t.status = 'COMPLETED'
     AND COALESCE(t.ended_at, t.started_at, t.updated_at) > v_since
     AND COALESCE(t.prize_pool, 0) > 0
     AND COALESCE(t.variant, '') <> 'satellite';

  FOR r IN
    SELECT t.id
      FROM tournaments t
     WHERE t.status = 'COMPLETED'
       AND COALESCE(t.ended_at, t.started_at, t.updated_at) > v_since
       AND COALESCE(t.prize_pool, 0) > 0
       AND COALESCE(t.variant, '') <> 'satellite'
     -- Newest first, so a truncated pass keeps the events most likely to be
     -- unreconciled rather than an arbitrary slice.
     ORDER BY COALESCE(t.ended_at, t.started_at, t.updated_at) DESC
     LIMIT v_limit
  LOOP
    v_scanned := v_scanned + 1;
    BEGIN
      v_res := fn_tournament_payout_reconcile(r.id, p_apply);
      IF COALESCE((v_res->>'clean')::boolean, true) = false THEN
        v_out   := v_out || v_res;
        v_n     := v_n + 1;
        v_topup := v_topup + COALESCE((v_res->>'total_top_up')::numeric, 0);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Loud, never fatal: one tournament that cannot be reconciled must not
      -- roll back the payouts this pass has already made for everyone else.
      v_failed := v_failed + 1;
      IF v_first_err IS NULL THEN v_first_err := SQLERRM; END IF;
      IF array_length(v_fail_ids, 1) IS NULL OR array_length(v_fail_ids, 1) < 20 THEN
        v_fail_ids := v_fail_ids || r.id;
      END IF;
    END;
  END LOOP;

  -- One alert for the pass, deduped against an unresolved twin, so a standing
  -- cause cannot flood the table.
  IF v_failed > 0 THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'warning',
           'fn_tournament_payout_sweep',
           format('Payout sweep could not reconcile %s of %s tournament(s) in this '
                  'pass; the rest were paid. First error: %s',
                  v_failed, v_scanned, COALESCE(v_first_err, 'unknown')),
           jsonb_build_object('failed', v_failed, 'scanned', v_scanned,
                              'first_error', v_first_err,
                              'sample_tournaments', to_jsonb(v_fail_ids))
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.source = 'fn_tournament_payout_sweep'
          AND fa.resolved IS NOT TRUE);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'days', p_days,
    'applied', p_apply,
    'tournaments_with_findings', v_n,
    'total_top_up', round(v_topup, 2),
    'findings', v_out,
    -- Added 2026-08-29. `truncated` true means the window is decorative: the
    -- limit, not p_days, decided what was examined.
    'candidates_matched', v_matched,
    'candidates_scanned', v_scanned,
    'truncated', v_matched > v_scanned,
    'window_column', 'coalesce(ended_at, started_at, updated_at)',
    -- Added 2026-09-02: a pass that skipped work must say so, or "ok: true"
    -- means "nothing raised" rather than "everything was reconciled".
    'failed', v_failed,
    'failed_tournaments', to_jsonb(v_fail_ids),
    'first_error', v_first_err
  );
END;
$function$;

-- A CREATE OR REPLACE on a fresh database inherits the default PUBLIC EXECUTE
-- grant, so a migration that only ASSERTS the surface is closed would leave it
-- open on replay. Production already carries exactly these grants; stating them
-- here is what makes the migration self-contained. PUBLIC is named alongside the
-- roles deliberately: revoking anon and authenticated while PUBLIC still holds
-- execute reads as a fix and does nothing.
REVOKE ALL ON FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer)
  FROM anon;
REVOKE ALL ON FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer)
  FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer)
  TO service_role;

DO $$
BEGIN
  IF has_function_privilege('anon',
       'public.fn_tournament_payout_sweep(integer, boolean, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute the payout sweep';
  END IF;
  IF has_function_privilege('authenticated',
       'public.fn_tournament_payout_sweep(integer, boolean, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can execute the payout sweep';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.fn_tournament_payout_sweep(integer, boolean, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost execute on the payout sweep';
  END IF;
END $$;
