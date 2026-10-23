BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_spin_sweep_unbooked(p_lookback_mins integer DEFAULT 180, p_limit integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t record; v_n integer := 0; v_fail integer := 0;
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
    -- Cheap predicates and "not yet booked" first; the per-row Diamond test
    -- only for what is left (2026-10-22).
    WITH unbooked AS MATERIALIZED (
      SELECT t.id, t.club_id, t.buy_in_amount, t.spin_multiplier,
             COALESCE(t.started_at, t.created_at) AS effective_start
      FROM public.tournaments t
      WHERE t.variant = 'spin'
        AND t.status IN ('RUNNING','COMPLETED')
        AND COALESCE(t.buy_in_fee, 0) = 0
        AND COALESCE(t.spin_multiplier, 0) > 0
        AND t.club_id IS NOT NULL
        -- COALESCE, not a bare started_at: NULL > now() - interval is NULL, which
        -- is not true, so a spin whose start write was lost was invisible here.
        AND COALESCE(t.started_at, t.created_at) > now() - make_interval(mins => p_lookback_mins)
        AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l
                        WHERE l.tournament_id = t.id)
    )
    SELECT u.id, u.club_id, u.buy_in_amount, u.spin_multiplier
    FROM unbooked u
    -- DIAMOND PHASE 9: a Diamond Spin books at its own draw, against its source.
    WHERE NOT public.fn_poker_diamond_tournament(u.id)
      -- Did anybody actually enter? current_players drains to zero, so test the
      -- rows, not the counter. A spin nobody entered has nothing to book.
      AND EXISTS (SELECT 1 FROM public.tournament_players tp
                   WHERE tp.tournament_id = u.id)
    ORDER BY u.effective_start
    LIMIT v_limit
  LOOP
    BEGIN
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

  WITH unbooked AS MATERIALIZED (
    SELECT t.id
    FROM public.tournaments t
    WHERE t.variant = 'spin'
      AND t.status IN ('RUNNING','COMPLETED')
      AND COALESCE(t.buy_in_fee, 0) = 0
      AND COALESCE(t.spin_multiplier, 0) > 0
      AND t.club_id IS NOT NULL
      AND COALESCE(t.started_at, t.created_at) > now() - make_interval(mins => p_lookback_mins)
      AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l
                      WHERE l.tournament_id = t.id)
  )
  SELECT count(*) INTO v_remaining
  FROM unbooked u
  WHERE NOT public.fn_poker_diamond_tournament(u.id)
    AND EXISTS (SELECT 1 FROM public.tournament_players tp
                 WHERE tp.tournament_id = u.id);

  -- `skipped_no_entrants` is GONE, not zero. It was declared, never
  -- incremented, and returned - a field that always read 0 because the entrant
  -- test lives in the WHERE clause now. An absent field is honest; a constant
  -- one is a placeholder an operator can mistake for a measurement.
  RETURN jsonb_build_object('ok', true, 'settled', v_n, 'failed', v_fail,
                            'failures', v_failures,
                            'lookback_mins', p_lookback_mins,
                            'batch_limit', v_limit,
                            'remaining', v_remaining,
                            'multiplier_repair', v_repair);
END;
$function$;

-- Source recovery also repeats the pre-existing service-only ACL, which
-- CREATE OR REPLACE preserves. Read-only production ACL verified 2026-10-23:
-- postgres/service_role only; anon/authenticated cannot execute. This is not
-- present in the historical statement bytes retained in the evidence archive.
REVOKE ALL ON FUNCTION public.fn_spin_sweep_unbooked(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_sweep_unbooked(integer, integer) TO service_role;
COMMIT;
