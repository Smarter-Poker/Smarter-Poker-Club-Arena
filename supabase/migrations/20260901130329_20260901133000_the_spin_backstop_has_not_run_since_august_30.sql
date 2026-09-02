-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901130329; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  THE SPIN BACKSTOP HAS NOT COMPLETED A SINGLE RUN SINCE 2026-08-30
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_spin_sweep_unbooked is the only thing standing under "a Spin ran, drew a
-- multiplier, paid its player, and never booked a reserve ledger row". It runs
-- every 15 minutes from Open Claw via /api/cron/spin-sweep.
--
-- On 2026-08-30 the endpoint's lookback was widened from 30 minutes to 14 days,
-- on the reasoning that the settle is idempotent so "a wide window is free".
-- It is not free. The sweep settles the games it finds ONE AT A TIME inside a
-- SINGLE statement, and the caller is service_role, whose statement_timeout is
-- eight seconds. Every run since has died with 57014:
--
--   12:45:11 [WARNING] /api/cron/spin-sweep -> vercel 500 [11.9s]:
--     {"status":"failed","stage":"sweep","error":"canceling statement due to
--      statement timeout", ...}
--
-- and because a timeout rolls the whole statement back, the pass did not even
-- keep the games it had already settled. The backstop has been booking exactly
-- nothing for two days: zero late bookings in the last 24 hours of
-- spin_reserve_ledger, against 112 unbooked Spins sitting in the window.
--
-- The dispatcher then logs `Job ... executed successfully`, because the job
-- ran. Nothing else looked at the body.
--
-- THE FIX IS BOUNDED WORK, NOT A NARROWER WINDOW. A narrow window is what
-- stranded three Spins on 2026-08-23 (migration 20260823060000). A wide window
-- with a per-pass cap keeps both properties: a backlog is reachable forever,
-- and one pass always finishes. The pass reports what it left behind, so the
-- caller and the gauges can tell "nothing to do" from "more to do".
--
-- p_limit defaults to 25: measured, a settle costs ~60ms and the scan ahead of
-- it 1.2s, so 25 lands near 3s and leaves most of the eight-second budget as
-- headroom on a busy database.
--
-- THE OLD ONE-ARGUMENT OVERLOAD IS DROPPED, NOT LEFT BESIDE THIS ONE. A first
-- attempt at this migration kept it, and its own assertion refused: PostgREST
-- resolves `{p_lookback_mins: 20160}` to the exact one-argument match, so the
-- cron would have gone on calling the unbounded version and this fix would
-- have changed nothing while reading as applied.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.fn_spin_sweep_unbooked(integer, integer);
--   -- then re-apply 20260828033000_the_spin_sweep_books_the_seats_that_sold.sql
--   -- which recreates the one-argument form.

DROP FUNCTION IF EXISTS public.fn_spin_sweep_unbooked(integer);

CREATE OR REPLACE FUNCTION public.fn_spin_sweep_unbooked(
  p_lookback_mins integer DEFAULT 180,
  p_limit integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_t record; v_n integer := 0; v_fail integer := 0; v_skipped integer := 0;
  v_res jsonb; v_repair jsonb; v_failures jsonb := '[]'::jsonb;
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 500));
  v_remaining integer := 0;
BEGIN
  BEGIN
    v_repair := public.fn_spin_repair_missing_multiplier(p_lookback_mins);
  EXCEPTION WHEN OTHERS THEN
    v_repair := jsonb_build_object('ok', false, 'reason', SQLERRM);
  END;

  FOR v_t IN
    SELECT t.id, t.club_id, t.buy_in_amount, t.spin_multiplier
    FROM public.tournaments t
    WHERE t.variant = 'spin'
      AND t.status IN ('RUNNING','COMPLETED')
      AND COALESCE(t.buy_in_fee, 0) = 0
      AND COALESCE(t.spin_multiplier, 0) > 0
      AND t.club_id IS NOT NULL
      -- Did anybody actually enter? current_players drains to zero, so test
      -- the rows, not the counter. A spin nobody entered has nothing to book.
      AND EXISTS (SELECT 1 FROM public.tournament_players tp
                   WHERE tp.tournament_id = t.id)
      AND t.started_at > now() - make_interval(mins => p_lookback_mins)
      AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l
                      WHERE l.tournament_id = t.id)
    -- Oldest first. A backlog then drains in a deterministic order instead of
    -- the newest games starving the ones that have been waiting longest.
    ORDER BY t.started_at
    LIMIT v_limit
  LOOP
    BEGIN
      -- SPIN_SEATS = 3, by definition and to match the engine settle path
      -- exactly (TournamentManagerBase forces 3 regardless of row counts).
      v_res := public.fn_spin_settle_game(
        v_t.id, v_t.club_id, v_t.buy_in_amount, 3, v_t.spin_multiplier,
        public.fn_spin_rake_rate(v_t.buy_in_amount));
      IF COALESCE((v_res->>'ok')::boolean, false) THEN
        v_n := v_n + 1;
      ELSE
        v_fail := v_fail + 1;
        v_failures := v_failures || jsonb_build_object(
          'tournament_id', v_t.id, 'reason', COALESCE(v_res->>'reason', 'refused'));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_fail := v_fail + 1;
      v_failures := v_failures || jsonb_build_object(
        'tournament_id', v_t.id, 'sqlstate', SQLSTATE, 'error', SQLERRM);
    END;
  END LOOP;

  -- What this pass could not reach. A caller that sees remaining > 0 knows to
  -- come back sooner than the next quarter hour, and the gauge knows the
  -- difference between a quiet platform and a backlog nobody is draining.
  SELECT count(*) INTO v_remaining
  FROM public.tournaments t
  WHERE t.variant = 'spin'
    AND t.status IN ('RUNNING','COMPLETED')
    AND COALESCE(t.buy_in_fee, 0) = 0
    AND COALESCE(t.spin_multiplier, 0) > 0
    AND t.club_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.tournament_players tp
                 WHERE tp.tournament_id = t.id)
    AND t.started_at > now() - make_interval(mins => p_lookback_mins)
    AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l
                    WHERE l.tournament_id = t.id);

  RETURN jsonb_build_object('ok', true, 'settled', v_n, 'failed', v_fail,
                            'failures', v_failures,
                            'skipped_no_entrants', v_skipped,
                            'lookback_mins', p_lookback_mins,
                            'batch_limit', v_limit,
                            'remaining', v_remaining,
                            'multiplier_repair', v_repair);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_spin_sweep_unbooked(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_sweep_unbooked(integer, integer) TO service_role;

COMMENT ON FUNCTION public.fn_spin_sweep_unbooked(integer, integer) IS
  'Books any Spin that ran without a reserve ledger row. Bounded: settles at '
  'most p_limit games per pass, oldest first, and reports `remaining` so a '
  'backlog is visible rather than silently retried forever. Widening the '
  'window is safe; removing the cap is what made every run since 2026-08-30 '
  'die on the eight-second service_role statement timeout.';

DO $$
DECLARE v_cnt integer;
BEGIN
  SELECT count(*) INTO v_cnt FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'fn_spin_sweep_unbooked';
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'expected exactly one fn_spin_sweep_unbooked overload, found %', v_cnt;
  END IF;
  IF has_function_privilege('anon', 'public.fn_spin_sweep_unbooked(integer, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_spin_sweep_unbooked(integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_spin_sweep_unbooked is reachable from a browser role';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_spin_sweep_unbooked(integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_spin_sweep_unbooked is not reachable by service_role';
  END IF;
END $$;
