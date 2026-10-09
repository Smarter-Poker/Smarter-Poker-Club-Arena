-- 20261009152834_drop_operational_alerts_pagers.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Drop the triggers that send operational alerts to the owner's phone.
-- The alerts will still land in the store. This leaves the pager functions in place,
-- but they are no longer triggered, preventing phone notifications.

BEGIN;

DROP TRIGGER IF EXISTS zz_a_real_alert_reaches_the_owner ON public.operational_alert_events;
DROP TRIGGER IF EXISTS zz_owner_route_reader_silence ON public.operational_notification_destinations;

COMMIT;
-- @live-proof: (SELECT count(*) = 0 FROM pg_trigger WHERE tgname IN ('zz_a_real_alert_reaches_the_owner', 'zz_owner_route_reader_silence'))
