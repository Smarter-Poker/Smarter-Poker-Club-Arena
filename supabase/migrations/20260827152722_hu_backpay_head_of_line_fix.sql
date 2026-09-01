-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827152722; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- HEADS-UP BACK-PAY — HEAD-OF-LINE BLOCKING FIX (2026-08-27, phase 3c)
-- Full rationale in repo: supabase/migrations/20260827_hu_backpay_head_of_line_fix.sql
-- The sweep starved: 95 of every 100 selected rows owed nothing, never received
-- a back-pay credit, and so stayed permanently at the head of the oldest-first
-- queue. 672 winners repaid, then zero, with 213,306 chips still owed.

CREATE OR REPLACE FUNCTION public.fn_backpay_hu_winner_shortfalls(
  p_limit integer DEFAULT 100
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row record;
  v_paid integer := 0; v_chips numeric := 0; v_scanned integer := 0;
  v_unpayable integer := 0; v_ok boolean;
BEGIN
  FOR v_row IN
    WITH candidate AS (
      SELECT t.id, t.name, t.ended_at,
             public.fn_tournament_conservation_delta(t.id) AS delta,
             (SELECT count(*) FROM public.tournament_players tp
               WHERE tp.tournament_id = t.id
                 AND (tp.status = 'winner' OR tp.position = 1)) AS winners
        FROM public.tournaments t
       WHERE t.status = 'COMPLETED'
         AND COALESCE(t.variant, '') = 'sng'
         AND COALESCE(t.max_players, 0) <= 2
         AND COALESCE(t.guaranteed_prize, 0) = 0
         AND t.ended_at < '2026-08-28T00:00:00Z'
         AND t.ended_at > '2026-08-01T00:00:00Z'
         AND NOT EXISTS (
           SELECT 1 FROM public.wallet_transactions w
            WHERE w.related_entity_id = t.id AND w.type = 'credit'
              AND w.category = 'prize'
              AND w.description LIKE 'Heads-Up winner shortfall%')
       ORDER BY t.ended_at ASC
       LIMIT 4000
    )
    SELECT c.id, c.name, c.delta,
           (SELECT (array_agg(tp.user_id ORDER BY tp.user_id))[1]
              FROM public.tournament_players tp
             WHERE tp.tournament_id = c.id
               AND (tp.status = 'winner' OR tp.position = 1)) AS winner
      FROM candidate c
     WHERE c.delta > 0.01
       AND c.winners = 1
     ORDER BY c.ended_at ASC
     LIMIT GREATEST(p_limit, 1)
  LOOP
    v_scanned := v_scanned + 1;

    v_ok := public.fn_credit_and_log(
      v_row.winner, v_row.delta,
      'tourney:' || v_row.id || ':prize:' || v_row.winner || ':hu_shortfall',
      'prize',
      'Heads-Up winner shortfall back-pay (' || COALESCE(v_row.name, 'sng') || ')',
      v_row.id);

    IF COALESCE(v_ok, false) THEN
      v_paid := v_paid + 1;
      v_chips := v_chips + v_row.delta;
      UPDATE public.tournament_players
         SET prize = round(COALESCE(prize, 0) + v_row.delta, 2)
       WHERE tournament_id = v_row.id AND user_id = v_row.winner;
      UPDATE public.tournaments
         SET prize_pool = round(COALESCE(prize_pool, 0) + v_row.delta, 2)
       WHERE id = v_row.id;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_unpayable
    FROM public.tournaments t
   WHERE t.status = 'COMPLETED'
     AND COALESCE(t.variant, '') = 'sng'
     AND COALESCE(t.max_players, 0) <= 2
     AND COALESCE(t.guaranteed_prize, 0) = 0
     AND t.ended_at < '2026-08-28T00:00:00Z'
     AND t.ended_at > '2026-08-01T00:00:00Z'
     AND (SELECT count(*) FROM public.tournament_players tp
           WHERE tp.tournament_id = t.id
             AND (tp.status = 'winner' OR tp.position = 1)) <> 1
     AND public.fn_tournament_conservation_delta(t.id) > 0.01;

  IF v_unpayable > 0 THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'warning', 'fn_backpay_hu_winner_shortfalls',
           v_unpayable || ' Heads-Up event(s) owe a shortfall but have no single '
             || 'identifiable winner — needs a human decision',
           jsonb_build_object('unpayable_events', v_unpayable)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts
        WHERE source = 'fn_backpay_hu_winner_shortfalls'
          AND resolved IS NOT TRUE
          AND context ? 'unpayable_events');
  END IF;

  RETURN jsonb_build_object('ok', true, 'scanned', v_scanned,
    'paid', v_paid, 'chips', round(v_chips, 2), 'unpayable', v_unpayable);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_backpay_hu_winner_shortfalls(integer) FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF pg_get_functiondef('public.fn_backpay_hu_winner_shortfalls(integer)'::regprocedure)
       NOT LIKE '%c.delta > 0.01%' THEN
    RAISE EXCEPTION 'ASSERT FAILED: back-pay still selects rows that owe nothing';
  END IF;
  IF pg_get_functiondef('public.fn_backpay_hu_winner_shortfalls(integer)'::regprocedure)
       NOT LIKE '%c.winners = 1%' THEN
    RAISE EXCEPTION 'ASSERT FAILED: back-pay can still select unpayable rows';
  END IF;
END $$;
