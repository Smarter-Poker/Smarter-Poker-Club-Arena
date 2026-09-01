-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827152342; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- CONSERVATION SENTINEL — DE-NOISE + SELF-RESOLVE (2026-08-27, phase 3b)
-- Full rationale in repo: supabase/migrations/20260827_conservation_sentinel_denoise_and_selfresolve.sql

CREATE OR REPLACE FUNCTION public.fn_tournament_conservation_delta(p_tournament_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH m AS (
    SELECT t.id, t.ended_at,
      COALESCE(t.prize_pool, 0)  AS pool,
      COALESCE(t.bounty_pool, 0) AS bounty_pool,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'debit'
           AND w.category IN ('tournament_buyin','rebuy','addon')), 0) AS money_in,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'refund'), 0) AS refunds,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'prize'), 0) AS prizes,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'bounty'), 0) AS bounties,
      COALESCE((SELECT sum(r.rake_amount) FROM public.rake_records r
         WHERE r.tournament_id = t.id AND r.is_tournament), 0) AS rake,
      COALESCE((SELECT o.amount FROM public.tournament_guarantee_overlays o
         WHERE o.tournament_id = t.id), 0) AS funded_overlay,
      EXISTS (SELECT 1 FROM public.tournament_guarantee_overlays o
               WHERE o.tournament_id = t.id) AS has_overlay_row
    FROM public.tournaments t WHERE t.id = p_tournament_id
  )
  SELECT round(
      m.money_in - m.refunds - m.rake - m.prizes - m.bounties
    + m.funded_overlay
    + CASE
        WHEN m.ended_at < '2026-08-27T12:00:00Z' AND NOT m.has_overlay_row
        THEN GREATEST(m.pool - (m.money_in - m.refunds - m.rake - m.bounty_pool), 0)
        ELSE 0
      END
  , 2)
  FROM m;
$function$;

REVOKE ALL ON FUNCTION public.fn_tournament_conservation_delta(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_tournament_money_conservation(
  p_since_days integer DEFAULT 7,
  p_tolerance numeric DEFAULT 1.0,
  p_limit integer DEFAULT 500
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row record; v_flagged integer := 0; v_scanned integer := 0;
  v_retained numeric := 0; v_unfunded numeric := 0;
  v_resolved integer := 0; v_delta numeric; v_tol numeric := GREATEST(p_tolerance, 0);
BEGIN
  FOR v_row IN
    SELECT fa.id, (fa.context->>'tournament_id')::uuid AS tid
      FROM public.financial_alerts fa
     WHERE fa.source = 'fn_tournament_money_conservation'
       AND fa.resolved IS NOT TRUE
       AND fa.context->>'tournament_id' IS NOT NULL
     ORDER BY fa.created_at ASC
     LIMIT 1000
  LOOP
    v_delta := public.fn_tournament_conservation_delta(v_row.tid);
    IF v_delta IS NOT NULL AND abs(v_delta) <= v_tol THEN
      UPDATE public.financial_alerts
         SET resolved = true, resolved_at = now()
       WHERE id = v_row.id;
      v_resolved := v_resolved + 1;
    END IF;
  END LOOP;

  FOR v_row IN
    SELECT t.id, t.name, t.variant
      FROM public.tournaments t
     WHERE t.status IN ('COMPLETED','CANCELLED')
       AND t.ended_at > now() - make_interval(days => GREATEST(p_since_days, 1))
       AND t.ended_at < now() - interval '30 minutes'
       AND COALESCE(t.variant, '') NOT IN ('spin', 'satellite')
       AND COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0) > 0
     ORDER BY t.ended_at DESC
     LIMIT GREATEST(p_limit, 1)
  LOOP
    v_scanned := v_scanned + 1;
    v_delta := public.fn_tournament_conservation_delta(v_row.id);
    IF v_delta IS NULL OR abs(v_delta) <= v_tol THEN CONTINUE; END IF;

    IF v_delta > 0 THEN v_retained := v_retained + v_delta;
    ELSE v_unfunded := v_unfunded - v_delta; END IF;
    v_flagged := v_flagged + 1;

    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'warning', 'fn_tournament_money_conservation',
           CASE WHEN v_delta > 0
                THEN 'Tournament retained money it never paid out: '
                ELSE 'Tournament paid out money it never collected: ' END
             || COALESCE(v_row.name, v_row.id::text),
           jsonb_build_object('tournament_id', v_row.id, 'variant', v_row.variant,
                              'delta', v_delta)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts
        WHERE source = 'fn_tournament_money_conservation'
          AND resolved IS NOT TRUE
          AND context->>'tournament_id' = v_row.id::text);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'scanned', v_scanned, 'flagged', v_flagged,
    'auto_resolved', v_resolved,
    'retained_chips', round(v_retained, 2), 'unfunded_chips', round(v_unfunded, 2));
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_tournament_money_conservation(integer, numeric, integer) FROM PUBLIC, anon, authenticated;

UPDATE public.financial_alerts fa
   SET resolved = true, resolved_at = now()
 WHERE fa.source = 'fn_tournament_money_conservation'
   AND fa.resolved IS NOT TRUE
   AND fa.context->>'tournament_id' IS NOT NULL
   AND abs(COALESCE(public.fn_tournament_conservation_delta(
         (fa.context->>'tournament_id')::uuid), 0)) <= 1.0;

DO $$
DECLARE v_freeroll integer; v_preledger integer; v_hu integer;
BEGIN
  IF to_regprocedure('public.fn_tournament_conservation_delta(uuid)') IS NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: fn_tournament_conservation_delta missing';
  END IF;
  IF pg_get_functiondef('public.fn_tournament_money_conservation(integer, numeric, integer)'::regprocedure)
       NOT LIKE '%auto_resolved%' THEN
    RAISE EXCEPTION 'ASSERT FAILED: sentinel cannot self-resolve';
  END IF;

  SELECT count(*) INTO v_freeroll
    FROM public.financial_alerts fa JOIN public.tournaments t
      ON t.id = (fa.context->>'tournament_id')::uuid
   WHERE fa.source = 'fn_tournament_money_conservation' AND fa.resolved IS NOT TRUE
     AND COALESCE(t.buy_in_amount,0) + COALESCE(t.buy_in_fee,0) = 0;
  IF v_freeroll > 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: % freeroll alert(s) still open', v_freeroll;
  END IF;

  SELECT count(*) INTO v_preledger
    FROM public.financial_alerts fa JOIN public.tournaments t
      ON t.id = (fa.context->>'tournament_id')::uuid
   WHERE fa.source = 'fn_tournament_money_conservation' AND fa.resolved IS NOT TRUE
     AND COALESCE(t.max_players, 0) > 2
     AND t.ended_at < '2026-08-27T12:00:00Z';
  IF v_preledger > 5 THEN
    RAISE EXCEPTION 'ASSERT FAILED: % pre-fix alert(s) still open — the inflation term is wrong', v_preledger;
  END IF;
  RAISE NOTICE 'phase 3b: % pre-fix alert(s) remain (genuine unexplained findings)', v_preledger;

  SELECT count(*) INTO v_hu
    FROM public.financial_alerts fa JOIN public.tournaments t
      ON t.id = (fa.context->>'tournament_id')::uuid
   WHERE fa.source = 'fn_tournament_money_conservation' AND fa.resolved IS NOT TRUE
     AND COALESCE(t.variant,'') = 'sng';
  IF v_hu = 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: the Heads-Up backlog was silenced, not repaid';
  END IF;
  RAISE NOTICE 'phase 3b: % HU alert(s) correctly still open, awaiting back-pay', v_hu;
END $$;
