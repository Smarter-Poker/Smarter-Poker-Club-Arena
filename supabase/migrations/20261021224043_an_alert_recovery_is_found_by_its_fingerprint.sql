-- AN ALERT RECOVERY IS FOUND BY ITS FINGERPRINT (2026-10-21)
--
-- The owner's notifications page marks each Alertmanager original as Resolved
-- by finding its recovery event: source 'alertmanager', status 'resolved', the
-- same alertname, and the same payload.alert fingerprint and startsAt
-- (World Hub src/lib/notifications/operationalResolution.mjs). Nothing indexed
-- that lookup. operational_alert_events is 232,521 rows / 858 MB, so each one
-- walked every Alertmanager event and detoasted its payload: 185 ms and 35,331
-- buffers per row, once per alert row on every feed read.
--
-- This partial index answers it directly. The reader now filters with
-- payload->'alert'->>'fingerprint' and ->>'startsAt' equality (the same rows
-- the old jsonb containment matched, since both values are strings), which is
-- exactly the indexed expression. Reads only; no row, money or alert changes.
--
-- @live-proof: (SELECT count(*) = 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'operational_alert_events_alertmanager_recovery_idx')

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE INDEX IF NOT EXISTS operational_alert_events_alertmanager_recovery_idx
  ON public.operational_alert_events (
    alertname,
    ((payload -> 'alert' ->> 'fingerprint')),
    ((payload -> 'alert' ->> 'startsAt'))
  )
  WHERE source = 'alertmanager' AND status = 'resolved';

COMMIT;
