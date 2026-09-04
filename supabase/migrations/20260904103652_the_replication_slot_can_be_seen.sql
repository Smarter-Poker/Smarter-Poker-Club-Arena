-- ═══════════════════════════════════════════════════════════════════════════
--  THE REPLICATION SLOT CAN BE SEEN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY (2026-09-04)
--
-- The realtime replication slot was 136 MB behind and growing, and NOTHING ON
-- THE PLATFORM COULD SEE IT. The engine host already runs Prometheus, Grafana,
-- Alertmanager and node-exporter, and Prometheus already scrapes the engine's
-- /metrics every 15 seconds. There has simply never been a series for
-- replication lag, so the number was only ever discovered by a human opening a
-- SQL editor and asking.
--
-- That matters more here than it would elsewhere, because logical decoding
-- fails as a SPIRAL rather than a cliff: a slot that falls behind must read WAL
-- from disk instead of from memory, which is slower, so being behind makes it
-- fall further behind. There is no step change to notice. By the time players
-- feel it as stale lobbies and late seat updates, the slot has usually been
-- degrading for hours.
--
-- WHAT THIS IS
--
-- One read-only function so the engine can put the number on a gauge. It
-- returns a row per replication slot: how far behind the slot is in bytes
-- (both the restart horizon and the confirmed-flush horizon), whether the slot
-- is active, and the absolute WAL position so Prometheus can differentiate it
-- into a WAL generation rate with rate(). The rate is deliberately NOT computed
-- here - a gauge should hand over a reading, not a derivative.
--
-- WHY IT NEEDS TO BE A FUNCTION AT ALL
--
-- The engine has no direct Postgres connection. Every query it makes goes
-- through PostgREST as service_role (server/src/services/supabase/client.ts),
-- and PostgREST cannot select from pg_catalog. A SECURITY DEFINER function is
-- the only route from the engine to pg_replication_slots.
--
-- SECURITY
--
-- It reads and never writes, and EXECUTE is granted to service_role ONLY -
-- revoked from PUBLIC, anon and authenticated, which is what a default grant
-- would otherwise have left open. So neither rule in
-- scripts/ci/check-definer-authorization.mjs applies: it is not a writer a
-- browser can reach, and anon cannot execute it. A browser has no business
-- knowing the shape of the estate's replication topology.
--
-- SAFETY
--
-- pg_current_wal_lsn() raises on a standby, so the whole thing returns NULL
-- lags while in recovery rather than erroring; an inactive slot with a NULL
-- restart_lsn yields NULL rather than a bogus zero. NULL is rendered as an
-- ABSENT series by the collector, never as 0 - a lag of zero is the perfect
-- score and must never be faked (the SpinMetrics precedent).
--
-- COST
--
-- pg_replication_slots is an in-memory shared-state view; this is microseconds
-- and touches no user table. It is called once every 60 seconds by one engine,
-- on its own collector, deliberately not folded into fn_spin_metrics - a slow
-- or failing catalog read must never be able to blind the spin fairness
-- gauges, and vice versa.
--
-- ROLLBACK
--
--   DROP FUNCTION IF EXISTS public.fn_replication_slot_metrics();
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_replication_slot_metrics()
RETURNS TABLE (
  slot_name          text,
  slot_type          text,
  active             boolean,
  restart_lag_bytes  bigint,
  flush_lag_bytes    bigint,
  wal_position_bytes bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    s.slot_name::text,
    s.slot_type::text,
    s.active,
    CASE
      WHEN pg_is_in_recovery() OR s.restart_lsn IS NULL THEN NULL
      ELSE (pg_current_wal_lsn() - s.restart_lsn)::bigint
    END,
    CASE
      WHEN pg_is_in_recovery() OR s.confirmed_flush_lsn IS NULL THEN NULL
      ELSE (pg_current_wal_lsn() - s.confirmed_flush_lsn)::bigint
    END,
    CASE
      WHEN pg_is_in_recovery() THEN NULL
      ELSE (pg_current_wal_lsn() - '0/0'::pg_lsn)::bigint
    END
  FROM pg_replication_slots s
$$;

COMMENT ON FUNCTION public.fn_replication_slot_metrics() IS
  'Replication slot lag in bytes, per slot, for the engine''s Prometheus gauges. Read-only; service_role only. NULL rather than 0 when the reading is unavailable (standby, or an inactive slot with no restart_lsn) - a lag of zero is the perfect score and must never be faked. See server/src/services/ReplicationMetrics.ts and infra/monitoring/alert-rules.yml.';

REVOKE ALL ON FUNCTION public.fn_replication_slot_metrics() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_replication_slot_metrics() FROM anon;
REVOKE ALL ON FUNCTION public.fn_replication_slot_metrics() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_replication_slot_metrics() TO service_role;

DO $$
DECLARE
  v_rows int;
BEGIN
  SELECT count(*) INTO v_rows FROM public.fn_replication_slot_metrics();

  IF v_rows = 0 THEN
    RAISE EXCEPTION
      'post-condition failed: fn_replication_slot_metrics() returned no rows. This database has logical replication slots (supabase_realtime), so zero rows means the function cannot see pg_replication_slots and the gauges would silently read as healthy.';
  END IF;

  RAISE NOTICE 'fn_replication_slot_metrics() sees % slot(s).', v_rows;
END $$;
