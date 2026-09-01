-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829161117; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- fn_requeue_unbanked_fees predates the weighted-rake law: when it rebuilt a
-- queue row from a financial_alerts payload it dropped rake_method and
-- returned_uncalled, so a re-driven hand that was PLAYED weighted got
-- re-banked as DEALT_EQUAL (4 hands on 2026-08-29, requeued 16:02:26 UTC).
-- The alert context has carried both fields since the weighted-rake engine
-- deploy — copy them through, and repair the rows the gap already mislabeled.

-- 1. The requeuer carries the methodology.
CREATE OR REPLACE FUNCTION public.fn_requeue_unbanked_fees(p_apply boolean DEFAULT false, p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  a record; v_pending uuid; v_accounted boolean;
  v_requeued int := 0; v_already int := 0; v_skipped int := 0;
  v_rake numeric := 0; v_bbj numeric := 0;
  v_open_before int; v_open_after int;
BEGIN
  SELECT count(*) INTO v_open_before FROM public.financial_alerts
   WHERE source = 'FeeReconciler.queue_failed' AND resolved IS NOT TRUE;

  FOR a IN
    SELECT f.id AS alert_id, f.context AS c
      FROM public.financial_alerts f
     WHERE f.source = 'FeeReconciler.queue_failed'
       AND f.resolved IS NOT TRUE
       AND f.context->>'kind' IS NOT NULL
       AND f.context->>'tableId' IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.fee_requeue_log l WHERE l.alert_id = f.id)
     ORDER BY f.created_at ASC
     LIMIT GREATEST(p_limit, 1)
  LOOP
    v_accounted := public.fn_fee_is_accounted_for(
      a.c->>'kind',
      (a.c->>'tableId')::uuid,
      NULLIF(a.c->>'handId', '')::uuid,
      COALESCE((a.c->>'handNumber')::bigint, 0));

    IF v_accounted THEN
      IF p_apply THEN
        INSERT INTO public.fee_requeue_log
          (alert_id, kind, table_id, hand_number, rake, bbj, outcome)
        VALUES (a.alert_id, a.c->>'kind', (a.c->>'tableId')::uuid,
                COALESCE((a.c->>'handNumber')::bigint, 0),
                COALESCE((a.c->>'rake')::numeric, 0),
                COALESCE((a.c->>'bbj')::numeric, 0), 'already_accounted')
        ON CONFLICT (alert_id) DO NOTHING;
        UPDATE public.financial_alerts
           SET resolved = true, resolved_at = now() WHERE id = a.alert_id;
      END IF;
      v_already := v_already + 1;
      CONTINUE;
    END IF;

    IF NOT p_apply THEN
      v_requeued := v_requeued + 1;
      v_rake := v_rake + COALESCE((a.c->>'rake')::numeric, 0);
      v_bbj  := v_bbj  + COALESCE((a.c->>'bbj')::numeric, 0);
      CONTINUE;
    END IF;

    INSERT INTO public.pending_fee_distributions
      (table_id, club_id, hand_id, hand_number, rake, bbj, pot, num_players,
       contributions, tournament_id, big_blind, kind, last_error,
       rake_method, returned_uncalled)
    VALUES (
      (a.c->>'tableId')::uuid,
      NULLIF(a.c->>'clubId', '')::uuid,
      NULLIF(a.c->>'handId', '')::uuid,
      COALESCE((a.c->>'handNumber')::bigint, 0),
      COALESCE((a.c->>'rake')::numeric, 0),
      COALESCE((a.c->>'bbj')::numeric, 0),
      COALESCE((a.c->>'pot')::numeric, 0),
      COALESCE((a.c->>'numPlayers')::int, 0),
      COALESCE(a.c->'contributions', '{}'::jsonb),
      NULLIF(a.c->>'tournamentId', '')::uuid,
      NULLIF(a.c->>'bigBlind', '')::numeric,
      a.c->>'kind',
      'requeued from financial_alerts by fn_requeue_unbanked_fees',
      -- WEIGHTED CONTRIBUTED RAKE (2026-08-29): a re-driven hand keeps the
      -- methodology it was played under. Alerts older than the weighted
      -- engine have no rakeMethod; NULL correctly re-drives as DEALT_EQUAL.
      NULLIF(a.c->>'rakeMethod', ''),
      CASE WHEN jsonb_typeof(a.c->'returnedUncalled') = 'object'
           THEN a.c->'returnedUncalled' ELSE NULL END)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_pending;

    INSERT INTO public.fee_requeue_log
      (alert_id, pending_id, kind, table_id, hand_number, rake, bbj, outcome)
    VALUES (a.alert_id, v_pending, a.c->>'kind', (a.c->>'tableId')::uuid,
            COALESCE((a.c->>'handNumber')::bigint, 0),
            COALESCE((a.c->>'rake')::numeric, 0),
            COALESCE((a.c->>'bbj')::numeric, 0),
            CASE WHEN v_pending IS NULL THEN 'already_queued' ELSE 'requeued' END)
    ON CONFLICT (alert_id) DO NOTHING;

    UPDATE public.financial_alerts
       SET resolved = true, resolved_at = now() WHERE id = a.alert_id;

    IF v_pending IS NULL THEN
      v_skipped := v_skipped + 1;
    ELSE
      v_requeued := v_requeued + 1;
      v_rake := v_rake + COALESCE((a.c->>'rake')::numeric, 0);
      v_bbj  := v_bbj  + COALESCE((a.c->>'bbj')::numeric, 0);
    END IF;
  END LOOP;

  SELECT count(*) INTO v_open_after FROM public.financial_alerts
   WHERE source = 'FeeReconciler.queue_failed' AND resolved IS NOT TRUE;

  RETURN jsonb_build_object('ok', true, 'applied', p_apply,
    'requeued', v_requeued, 'rake_requeued', round(v_rake, 2),
    'bbj_requeued', round(v_bbj, 2),
    'already_accounted', v_already, 'already_queued', v_skipped,
    'alerts_open_before', v_open_before, 'alerts_open_after', v_open_after);
END;
$function$;

-- 2. Repair the rows the gap mislabeled: any rake_records row banked as
-- DEALT_EQUAL whose queue_failed alert proves the hand was played WEIGHTED.
DO $$
DECLARE r record; v_fixed int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT rr.id, rr.hand_id, f.context->'returnedUncalled' AS ret
      FROM public.rake_records rr
      JOIN public.financial_alerts f
        ON f.source = 'FeeReconciler.queue_failed'
       AND f.context->>'rakeMethod' = 'WEIGHTED_CONTRIBUTED'
       AND f.context->>'handNumber' = rr.metadata->>'hand_number'
     WHERE rr.rake_method = 'DEALT_EQUAL'
       AND rr.source = 'atomic_distribute_rake'
       AND rr.created_at > '2026-08-29 14:40+00'::timestamptz
  LOOP
    UPDATE public.rake_records
       SET rake_method = 'WEIGHTED_CONTRIBUTED',
           returned_uncalled = CASE WHEN jsonb_typeof(r.ret) = 'object' THEN r.ret ELSE returned_uncalled END
     WHERE id = r.id;
    DELETE FROM public.rake_attributions WHERE hand_id = r.hand_id;
    v_fixed := v_fixed + 1;
  END LOOP;

  -- Rebuild their ledgers under the corrected method, then prove it.
  PERFORM public.fn_backfill_rake_attributions('2026-08-29 13:00+00'::timestamptz);
  IF (SELECT count(*) FROM public.fn_rake_attribution_drift(6)) <> 0 THEN
    RAISE EXCEPTION 'relabel repair left drift behind';
  END IF;
  RAISE NOTICE 'relabelled % row(s) to WEIGHTED_CONTRIBUTED and rebuilt their ledgers', v_fixed;
END $$;
