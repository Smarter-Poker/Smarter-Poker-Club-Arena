-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260904110947; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260904110947   (the stamp IS the apply time, UTC: 2026-09-04 11:09:47)
--   name        settlement_health_is_on_a_gauge
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 2766 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260904110947 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_settlement_health
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

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
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.fn_settlement_health(5);
  IF r IS NULL THEN
    RAISE EXCEPTION 'post-condition failed: fn_settlement_health returned no row';
  END IF;
  RAISE NOTICE 'settlement health (5m): settled=% failed=% stuck=% rate=%',
    r.settled, r.failed, r.stuck, r.failure_rate;
  IF r.failure_rate IS NOT NULL AND r.failure_rate > 0.05 THEN
    RAISE EXCEPTION
      'post-condition failed: settlement failure rate is still % over the last 5 minutes. The no-op trigger revert was supposed to fix this - re-diagnose before shipping a gauge.',
      round(r.failure_rate * 100, 1);
  END IF;
END $$;
