-- Rollback for 20260917202659_the_fleet_reports_what_it_cannot_finish.sql
-- Removes the read the HorseFleetMetrics collector asks for. The collector
-- then keeps its last good snapshot and poker_horse_fleet_metrics_stale_seconds
-- climbs, which is the designed way for these gauges to go blind.

BEGIN;
DROP FUNCTION IF EXISTS public.fn_ca_horse_fleet_metrics(integer);
COMMIT;
