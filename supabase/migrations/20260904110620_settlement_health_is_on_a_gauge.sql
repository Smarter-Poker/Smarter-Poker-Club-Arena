-- ═══════════════════════════════════════════════════════════════════════════
--  SETTLEMENT HEALTH IS ON A GAUGE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY (2026-09-04)
--
-- Between 21:30 on 2026-09-03 and 10:48 today, 139,153 hands failed to settle -
-- between 25% and 44% of every hand dealt on the platform - and **nothing
-- raised an alert**. The state was written to ca_settlements.state = 'failed'
-- with a full error_detail on every row, and no human and no monitor was ever
-- told. It was found by a query somebody happened to run against a table they
-- were looking at for an unrelated reason.
--
-- The one thing that DID fire was the drift incident on conservation
-- violations - 37 of them, severity 'warning', into financial_alerts, where
-- 164 unresolved rows were already sitting. Conservation violations are the
-- rare failure. The common one, 'seat write failed ... hand write rejected
-- whole', raises nothing at all.
--
-- So the platform could see the symptom, wrote it down 139,153 times, and had
-- no way to say it out loud. That is the gap this closes.
--
-- WHAT IT IS
--
-- One cheap read over a five-minute window, for the engine's Prometheus
-- gauges. Deliberately a WINDOW and not a lifetime total: the incident is
-- visible as a rate, and a lifetime ratio would have shown 7.7% at the moment
-- the true rate was 44%, because three days of healthy history diluted it.
-- That dilution is exactly how this stayed invisible in the one place a human
-- did look.
--
-- COST. Indexed on updated_at, five minutes of rows, called once every 60s by
-- one engine. It is STABLE and reads no user-visible data - counts and one
-- error string only.
--
-- SECURITY. Read-only. EXECUTE to service_role only, revoked from PUBLIC,
-- anon and authenticated: the failure text names table ids and user ids.
--
-- ROLLBACK
--
--   DROP FUNCTION IF EXISTS public.fn_settlement_health(integer);
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_settlement_health(p_window_minutes integer DEFAULT 5)
RETURNS TABLE (
  window_minutes   integer,
  settled          bigint,
  failed           bigint,
  stuck            bigint,
  failure_rate     numeric,
  top_failure      text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH w AS (
    SELECT state, error_detail
    FROM public.ca_settlements
    WHERE updated_at > now() - make_interval(mins => greatest(p_window_minutes, 1))
  ),
  agg AS (
    SELECT
      count(*) FILTER (WHERE state = 'final')  AS settled,
      count(*) FILTER (WHERE state = 'failed') AS failed,
      count(*) FILTER (WHERE state NOT IN ('final','failed')) AS stuck
    FROM w
  )
  SELECT
    greatest(p_window_minutes, 1),
    agg.settled,
    agg.failed,
    agg.stuck,
    CASE WHEN agg.settled + agg.failed = 0 THEN NULL
         ELSE round(agg.failed::numeric / (agg.settled + agg.failed), 4)
    END,
    (SELECT regexp_replace(
              left(coalesce(w2.error_detail, ''), 120),
              '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
              '<uuid>', 'g')
       FROM w w2
      WHERE w2.state = 'failed' AND w2.error_detail IS NOT NULL
      LIMIT 1)
  FROM agg
$$;

COMMENT ON FUNCTION public.fn_settlement_health(integer) IS
  'Hand-settlement health over a short window, for the engine''s Prometheus gauges. A WINDOW, not a lifetime total: on 2026-09-04 the lifetime ratio read 7.7% while the live rate was 44%, because three days of healthy history diluted it - and that dilution is part of why 139,153 failed settlements went unnoticed for thirteen hours. failure_rate is NULL, never 0, when nothing settled in the window: no hands is not the same as no failures. See server/src/services/SettlementMetrics.ts.';

REVOKE ALL ON FUNCTION public.fn_settlement_health(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_settlement_health(integer) FROM anon;
REVOKE ALL ON FUNCTION public.fn_settlement_health(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settlement_health(integer) TO service_role;

DO $$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.fn_settlement_health(5);

  IF r IS NULL THEN
    RAISE EXCEPTION 'post-condition failed: fn_settlement_health returned no row';
  END IF;

  RAISE NOTICE 'settlement health (5m): settled=% failed=% stuck=% rate=%',
    r.settled, r.failed, r.stuck, r.failure_rate;

  -- The revert landed at 10:48. If this is still failing, the diagnosis was
  -- wrong and the gauge must not ship reporting a green board.
  IF r.failure_rate IS NOT NULL AND r.failure_rate > 0.05 THEN
    RAISE EXCEPTION
      'post-condition failed: settlement failure rate is still %%% over the last 5 minutes. The no-op trigger revert was supposed to fix this - re-diagnose before shipping a gauge.',
      round(r.failure_rate * 100, 1);
  END IF;
END $$;
