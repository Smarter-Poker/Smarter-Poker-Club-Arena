-- 20260926072551_lightning_remediation_two_b_cluster_events_carry_a_version_a.sql
--
-- LIGHTNING REMEDIATION TWO, FILE B OF FOUR: CLUSTER EVENTS CARRY A VERSION AND
-- A REQUEST.
--
-- Two columns on public.cash_cluster_events, alone in their own transaction,
-- because every tick pass writes this table and ADD COLUMN holds ACCESS
-- EXCLUSIVE on it until COMMIT. One ADD COLUMN per ALTER. event_version's
-- default is a constant, so both are catalogue-only changes with no rewrite.
-- Nothing else is touched. Two seconds of lock wait, then a clean refusal.
--
-- event_version is 1 for every kind written today. request_id carries the
-- request of the call that wrote the event where the caller has one: the
-- formation's p_request_id, and the conversion's (with the epoch it opened).
-- File C writes both.
--
-- @live-proof: (SELECT count(*) = 2 FROM pg_attribute a WHERE a.attrelid = 'public.cash_cluster_events'::regclass AND NOT a.attisdropped AND ((a.attname = 'event_version' AND a.attnotnull AND a.atttypid = 'smallint'::regtype) OR (a.attname = 'request_id' AND a.atttypid = 'uuid'::regtype)))
-- @live-proof: (SELECT pg_get_expr(d.adbin, d.adrelid) = '1' FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attrelid = 'public.cash_cluster_events'::regclass AND a.attname = 'event_version')

BEGIN;

SET LOCAL lock_timeout = '2s';

ALTER TABLE public.cash_cluster_events ADD COLUMN IF NOT EXISTS event_version smallint NOT NULL DEFAULT 1;
ALTER TABLE public.cash_cluster_events ADD COLUMN IF NOT EXISTS request_id uuid;

COMMENT ON COLUMN public.cash_cluster_events.event_version IS
  'The version of the payload shape of this event kind. 1 for every kind written today.';
COMMENT ON COLUMN public.cash_cluster_events.request_id IS
  'The request id of the call that wrote this event, when the caller supplied one: the formation''s p_request_id, the conversion''s p_request_id (and the epoch it opened). NULL otherwise.';

COMMIT;
