-- Phase 3 alert noise, item 1: Lightning latency alerts stop flapping.
--
-- fn_lightning_alert_sweep resolved a latency_regression alert the first
-- minute a single re-measure dipped under the ceiling, and the next pass
-- raised it again: 1,728 raises in the 24h before this change across 35
-- (cluster, leg) keys, median life 244 s, median gap between raises 14 min.
--
-- HYSTERESIS: a latency_regression alert now resolves only when it is at
-- least 15 minutes old AND fn_lightning_latency_regression is clear at
-- v_now, v_now - 5 min and v_now - 10 min. A replay of the last 24h at
-- one-minute ticks gives 1,789 raises under the old rule (matches the
-- observed 1,728) and 588 under the new one.
--
-- Only the resolve condition of the latency_regression branch changes.
-- The function is rewritten from its live definition so nothing else in it
-- (including any concurrent change) is touched; the replace must match
-- exactly once or the migration fails.
DO $mig$
DECLARE
  v_def text := pg_get_functiondef('public.fn_lightning_alert_sweep(timestamp with time zone)'::regprocedure);
  v_old text := $o$        v_resolve := NOT EXISTS (SELECT 1 FROM public.cash_games cg WHERE cg.id::text = a.context ->> 'cluster_id')
                     OR public.fn_lightning_latency_regression((a.context ->> 'cluster_id')::uuid, a.context ->> 'leg',
                          public.fn_lightning_config((a.context ->> 'cluster_id')::uuid), v_now) IS NULL;$o$;
  v_new text := $n$        -- HYSTERESIS (2026-10-31): a latency page resolves only when it is at
        -- least 15 minutes old and the leg is clear now, 5 and 10 minutes ago.
        v_resolve := NOT EXISTS (SELECT 1 FROM public.cash_games cg WHERE cg.id::text = a.context ->> 'cluster_id')
                     OR (a.created_at <= v_now - interval '15 minutes'
                         AND public.fn_lightning_latency_regression((a.context ->> 'cluster_id')::uuid, a.context ->> 'leg',
                               public.fn_lightning_config((a.context ->> 'cluster_id')::uuid), v_now) IS NULL
                         AND public.fn_lightning_latency_regression((a.context ->> 'cluster_id')::uuid, a.context ->> 'leg',
                               public.fn_lightning_config((a.context ->> 'cluster_id')::uuid), v_now - interval '5 minutes') IS NULL
                         AND public.fn_lightning_latency_regression((a.context ->> 'cluster_id')::uuid, a.context ->> 'leg',
                               public.fn_lightning_config((a.context ->> 'cluster_id')::uuid), v_now - interval '10 minutes') IS NULL);$n$;
  v_hits integer;
BEGIN
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'fn_lightning_alert_sweep latency resolve clause matched % times (expected 1); live definition changed', v_hits;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$mig$;