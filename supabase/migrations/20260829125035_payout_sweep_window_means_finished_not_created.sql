-- ═══════════════════════════════════════════════════════════════════════════
--  THE PAYOUT SWEEP'S WINDOW WAS MEASURING THE WRONG DATE (2026-08-29)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_tournament_payout_sweep selected its candidates with
--
--     AND t.updated_at > now() - make_interval(days => GREATEST(p_days, 1))
--     ORDER BY t.updated_at DESC
--
-- and `tournaments.updated_at` IS NOT MAINTAINED. Nothing in the engine ever
-- writes it; there is no trigger. Measured today across the whole table:
--
--     COMPLETED events                              39,338
--     updated_at >= ended_at                             0
--     updated_at <  ended_at                        39,328
--     completed in the last 2 days                   3,763
--       ... of those, updated_at never moved off
--           created_at                               3,763  (all of them)
--
-- So the column holds the moment the ROW WAS CREATED. For a scheduled
-- recurring event that is when it was put on the calendar, which can be well
-- before it is played. "Look at the last 30 days" therefore means "look at
-- events SCHEDULED in the last 30 days", and an event scheduled 31 days ago
-- and finished yesterday is invisible to the sweep that exists to catch
-- exactly that kind of event.
--
-- The narrow pass loses ~77 of 3,763 events (2%) to this every cycle. The
-- deep pass loses the ones that matter most: the 38 events repaired this
-- morning in 20260829124034_pay_prize_money_outside_the_thirty_day_window,
-- carrying 11,238.80 of prize money that players had earned and never been
-- given, were ALL outside a 30-day updated_at window and none of them had
-- ever been asked.
--
-- The fix is to measure the date the sweep actually means: when the event
-- FINISHED. `coalesce(ended_at, started_at, updated_at)` because ended_at is
-- null on 10 completed rows, and a row with no date at all should still be
-- reachable rather than silently dropped.
--
-- SECOND DEFECT, and it is the reason a previous agent had to pass
-- p_limit = 40000 by hand: the LIMIT binds the SCAN, not the report. A limit
-- below the window's population silently shrinks the window back down, and
-- nothing said so. The result now carries `candidates_matched`,
-- `candidates_scanned` and `truncated`, so a decorative window is visible in
-- the return value instead of being folklore in a comment in
-- RakebackSettlerService.
--
-- Return shape is ADDITIVE. Every key the existing caller reads
-- (tournaments_with_findings, total_top_up, findings, ok, days, applied) is
-- unchanged, so RakebackSettlerService keeps working with or without its
-- companion edit.
--
-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- CREATE OR REPLACE FUNCTION public.fn_tournament_payout_sweep(
--   p_days integer DEFAULT 2, p_apply boolean DEFAULT false, p_limit integer DEFAULT 50)
-- RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
-- AS $rollback$
-- DECLARE r record; v_res jsonb; v_out jsonb := '[]'::jsonb; v_n int := 0; v_topup numeric := 0;
-- BEGIN
--   FOR r IN SELECT t.id FROM tournaments t
--            WHERE t.status = 'COMPLETED'
--              AND t.updated_at > now() - make_interval(days => GREATEST(p_days, 1))
--              AND COALESCE(t.prize_pool, 0) > 0
--              AND COALESCE(t.variant, '') <> 'satellite'
--            ORDER BY t.updated_at DESC LIMIT GREATEST(p_limit, 1)
--   LOOP
--     v_res := fn_tournament_payout_reconcile(r.id, p_apply);
--     IF COALESCE((v_res->>'clean')::boolean, true) = false THEN
--       v_out := v_out || v_res; v_n := v_n + 1;
--       v_topup := v_topup + COALESCE((v_res->>'total_top_up')::numeric, 0);
--     END IF;
--   END LOOP;
--   RETURN jsonb_build_object('ok', true, 'days', p_days, 'applied', p_apply,
--                             'tournaments_with_findings', v_n,
--                             'total_top_up', round(v_topup, 2), 'findings', v_out);
-- END; $rollback$;
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_tournament_payout_sweep(
  p_days  integer DEFAULT 2,
  p_apply boolean DEFAULT false,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r          record;
  v_res      jsonb;
  v_out      jsonb := '[]'::jsonb;
  v_n        int    := 0;
  v_topup    numeric := 0;
  v_matched  int    := 0;
  v_scanned  int    := 0;
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
    v_res := fn_tournament_payout_reconcile(r.id, p_apply);
    IF COALESCE((v_res->>'clean')::boolean, true) = false THEN
      v_out   := v_out || v_res;
      v_n     := v_n + 1;
      v_topup := v_topup + COALESCE((v_res->>'total_top_up')::numeric, 0);
    END IF;
  END LOOP;

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
    'window_column', 'coalesce(ended_at, started_at, updated_at)'
  );
END;
$function$;

COMMENT ON FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer) IS
  'Reconciles COMPLETED tournaments finished within p_days. The window is measured on '
  'coalesce(ended_at, started_at, updated_at) -- NOT updated_at, which is never maintained '
  'and holds row-creation time (2026-08-29). Returns candidates_matched/candidates_scanned/'
  'truncated so a limit that silently shrinks the window is visible to the caller.';

-- ── POST-APPLY ASSERTIONS ────────────────────────────────────────────────
DO $$
DECLARE
  v jsonb;
BEGIN
  -- Dry run only. This function moves money when p_apply is true, so the
  -- assertion never passes true (CLAUDE.md 11.5).
  v := fn_tournament_payout_sweep(2, false, 10);

  IF COALESCE((v->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'sweep did not return ok';
  END IF;
  IF NOT (v ? 'candidates_matched' AND v ? 'candidates_scanned' AND v ? 'truncated') THEN
    RAISE EXCEPTION 'sweep did not report its own truncation';
  END IF;
  -- A 10-row limit against two days of a platform doing ~1,900 events a day
  -- MUST report itself truncated. If this ever stops being true the counting
  -- is wrong, not the platform.
  IF (v->>'truncated')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'a 10-row limit over a 2-day window reported truncated=false (matched %, scanned %)',
      v->>'candidates_matched', v->>'candidates_scanned';
  END IF;

  RAISE NOTICE 'sweep window now covers % completed events in 2 days', v->>'candidates_matched';
END $$;
