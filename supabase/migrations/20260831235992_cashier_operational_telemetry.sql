-- CASHIER PHASE 5 - privacy-safe production SLOs, not a transaction log.
-- Money details, recipient identities, notes and free-form error messages are
-- deliberately excluded. Failures are retained completely; routine successes
-- are sampled by the client and weighted back to an estimated event count.

CREATE TABLE IF NOT EXISTS public.cashier_operations (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  club_id        uuid NOT NULL REFERENCES public.clubs (id) ON DELETE CASCADE,
  event          text NOT NULL CHECK (event IN (
                   'roster_page_succeeded', 'roster_page_failed',
                   'batch_succeeded', 'batch_partial', 'batch_failed'
                 )),
  operation      text NOT NULL CHECK (operation IN ('roster', 'send', 'ticket')),
  duration_ms    integer CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 300000),
  item_count     integer CHECK (item_count IS NULL OR item_count BETWEEN 0 AND 1000000),
  page_number    integer CHECK (page_number IS NULL OR page_number BETWEEN 0 AND 100000),
  success_count  integer CHECK (success_count IS NULL OR success_count BETWEEN 0 AND 1000000),
  failure_count  integer CHECK (failure_count IS NULL OR failure_count BETWEEN 0 AND 1000000),
  reason_code    text CHECK (reason_code IS NULL OR reason_code ~ '^[a-z0-9:_-]{1,64}$'),
  sample_weight  smallint NOT NULL DEFAULT 1 CHECK (sample_weight BETWEEN 1 AND 100),
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cashier_operations IS
  'Write-only browser telemetry for cashier roster latency and batch outcomes. Contains no amounts, recipients, notes or error messages.';

CREATE INDEX IF NOT EXISTS cashier_operations_created_idx
  ON public.cashier_operations (created_at DESC);
CREATE INDEX IF NOT EXISTS cashier_operations_event_created_idx
  ON public.cashier_operations (event, created_at DESC);
CREATE INDEX IF NOT EXISTS cashier_operations_club_created_idx
  ON public.cashier_operations (club_id, created_at DESC);

ALTER TABLE public.cashier_operations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cashier_operations_insert_own ON public.cashier_operations;
CREATE POLICY cashier_operations_insert_own
  ON public.cashier_operations
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

REVOKE ALL ON public.cashier_operations FROM PUBLIC, anon, authenticated;
GRANT INSERT ON public.cashier_operations TO authenticated;
GRANT ALL ON public.cashier_operations TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.cashier_operations_id_seq TO authenticated, service_role;

CREATE OR REPLACE VIEW public.v_cashier_health_hourly
WITH (security_invoker = true) AS
SELECT
  date_trunc('hour', created_at) AS hour,
  operation,
  sum(sample_weight) AS estimated_events,
  count(*) FILTER (WHERE event IN ('roster_page_failed', 'batch_partial', 'batch_failed')) AS failures,
  round(
    100.0 * count(*) FILTER (
      WHERE event IN ('roster_page_failed', 'batch_partial', 'batch_failed')
    ) / NULLIF(sum(sample_weight), 0),
    2
  ) AS failure_pct,
  percentile_disc(0.50) WITHIN GROUP (ORDER BY duration_ms)
    FILTER (WHERE duration_ms IS NOT NULL AND event IN ('roster_page_succeeded', 'batch_succeeded')) AS success_p50_ms,
  percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)
    FILTER (WHERE duration_ms IS NOT NULL AND event IN ('roster_page_succeeded', 'batch_succeeded')) AS success_p95_ms,
  sum(coalesce(item_count, 0)) AS observed_items,
  sum(coalesce(success_count, 0)) AS observed_successes,
  sum(coalesce(failure_count, 0)) AS observed_failures
FROM public.cashier_operations
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

CREATE OR REPLACE VIEW public.v_cashier_failures_daily
WITH (security_invoker = true) AS
SELECT
  date_trunc('day', created_at) AS day,
  club_id,
  operation,
  event,
  coalesce(reason_code, 'unknown') AS reason_code,
  count(*) AS failures,
  max(duration_ms) AS worst_duration_ms
FROM public.cashier_operations
WHERE event IN ('roster_page_failed', 'batch_partial', 'batch_failed')
GROUP BY 1, 2, 3, 4, 5
ORDER BY 1 DESC, 6 DESC;

REVOKE ALL ON public.v_cashier_health_hourly FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.v_cashier_failures_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_cashier_health_hourly TO service_role;
GRANT SELECT ON public.v_cashier_failures_daily TO service_role;

CREATE OR REPLACE FUNCTION public.fn_prune_cashier_operations(p_keep_days integer DEFAULT 30)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted bigint;
BEGIN
  IF p_keep_days < 7 OR p_keep_days > 180 THEN
    RAISE EXCEPTION 'p_keep_days must be between 7 and 180';
  END IF;
  DELETE FROM public.cashier_operations
  WHERE created_at < now() - make_interval(days => p_keep_days);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_prune_cashier_operations(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_prune_cashier_operations(integer) TO service_role;
