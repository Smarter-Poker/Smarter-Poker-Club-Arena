-- ═══════════════════════════════════════════════════════════════════════════
--  CUSTOMIZATION OPERATIONS — MEASUREMENT, NOT AN EVENT LAKE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Table Studio already emitted product analytics, but an operator could not
-- answer the production questions that matter: are applies slow, are cosmetic
-- purchases failing, is Realtime recovering, or are rapid-tap conflicts being
-- suppressed? This narrow, typed sink and its two aggregate views are the
-- dashboard. There is no free-form payload and no player-facing read policy.

CREATE TABLE IF NOT EXISTS public.customization_operations (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  event        text NOT NULL CHECK (event IN (
                 'appearance_saved', 'appearance_failed',
                 'purchase_succeeded', 'purchase_failed',
                 'realtime_failed', 'realtime_recovered',
                 'conflict_suppressed'
               )),
  surface      text NOT NULL CHECK (surface IN ('table-studio', 'table-runtime', 'avatar-gallery')),
  category     text CHECK (category IS NULL OR category ~ '^[a-z0-9:_-]{1,64}$'),
  duration_ms  integer CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 300000),
  reason_code  text CHECK (reason_code IS NULL OR reason_code ~ '^[a-z0-9:_-]{1,64}$'),
  sample_weight smallint NOT NULL DEFAULT 1 CHECK (sample_weight BETWEEN 1 AND 100),
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.customization_operations IS
  'Sampled success and complete failure/recovery telemetry for Table Studio customization. No free-form payload or cosmetic choice is stored.';

CREATE INDEX IF NOT EXISTS customization_operations_created_idx
  ON public.customization_operations (created_at DESC);
CREATE INDEX IF NOT EXISTS customization_operations_event_created_idx
  ON public.customization_operations (event, created_at DESC);

ALTER TABLE public.customization_operations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS customization_operations_insert_own ON public.customization_operations;
CREATE POLICY customization_operations_insert_own
  ON public.customization_operations
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

REVOKE ALL ON public.customization_operations FROM PUBLIC, anon, authenticated;
GRANT INSERT ON public.customization_operations TO authenticated;
GRANT ALL ON public.customization_operations TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.customization_operations_id_seq TO authenticated, service_role;

CREATE OR REPLACE VIEW public.v_customization_health_hourly
WITH (security_invoker = true) AS
SELECT
  date_trunc('hour', created_at) AS hour,
  sum(sample_weight) FILTER (WHERE event IN ('appearance_saved', 'appearance_failed')) AS appearance_estimated_attempts,
  count(*) FILTER (WHERE event = 'appearance_failed') AS appearance_failures,
  round(
    100.0 * count(*) FILTER (WHERE event = 'appearance_failed') /
    NULLIF(sum(sample_weight) FILTER (WHERE event IN ('appearance_saved', 'appearance_failed')), 0),
    2
  ) AS appearance_failure_pct,
  percentile_disc(0.50) WITHIN GROUP (ORDER BY duration_ms)
    FILTER (WHERE event = 'appearance_saved' AND duration_ms IS NOT NULL) AS apply_p50_ms,
  percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)
    FILTER (WHERE event = 'appearance_saved' AND duration_ms IS NOT NULL) AS apply_p95_ms,
  sum(sample_weight) FILTER (WHERE event IN ('purchase_succeeded', 'purchase_failed')) AS purchase_estimated_attempts,
  count(*) FILTER (WHERE event = 'purchase_failed') AS purchase_failures,
  count(*) FILTER (WHERE event = 'realtime_failed') AS realtime_failures,
  count(*) FILTER (WHERE event = 'realtime_recovered') AS realtime_recoveries,
  count(*) FILTER (WHERE event = 'conflict_suppressed') AS conflicts_suppressed
FROM public.customization_operations
GROUP BY 1
ORDER BY 1 DESC;

CREATE OR REPLACE VIEW public.v_customization_health_daily
WITH (security_invoker = true) AS
SELECT
  date_trunc('day', created_at) AS day,
  surface,
  coalesce(category, 'uncategorized') AS category,
  event,
  count(*) AS sampled_rows,
  sum(sample_weight) AS estimated_events,
  percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)
    FILTER (WHERE duration_ms IS NOT NULL) AS p95_ms
FROM public.customization_operations
GROUP BY 1, 2, 3, 4
ORDER BY 1 DESC, 2, 3, 4;

COMMENT ON VIEW public.v_customization_health_hourly IS
  'Hourly customization SLO dashboard: apply latency/failure, purchase failure, Realtime recovery and suppressed conflicts.';
COMMENT ON VIEW public.v_customization_health_daily IS
  'Daily customization operations grouped by surface/category/event for diagnosis.';

REVOKE ALL ON public.v_customization_health_hourly FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.v_customization_health_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_customization_health_hourly TO service_role;
GRANT SELECT ON public.v_customization_health_daily TO service_role;

-- Retention is explicit and service-role-only. The dashboard needs trends,
-- not an unbounded event history.
CREATE OR REPLACE FUNCTION public.fn_prune_customization_operations(p_keep_days integer DEFAULT 30)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted bigint;
BEGIN
  IF p_keep_days < 7 OR p_keep_days > 180 THEN
    RAISE EXCEPTION 'p_keep_days must be between 7 and 180';
  END IF;
  DELETE FROM public.customization_operations
  WHERE created_at < now() - make_interval(days => p_keep_days);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_prune_customization_operations(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_prune_customization_operations(integer) TO service_role;
