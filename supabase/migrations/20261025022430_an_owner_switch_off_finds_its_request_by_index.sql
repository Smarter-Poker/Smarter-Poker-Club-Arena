-- 20261025022430_an_owner_switch_off_finds_its_request_by_index.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- THE CAUSE. fn_cash_game_switch_off (the owner's Switch Off door) first
-- looks for an earlier answer to the same request:
--   SELECT * FROM public.cash_cluster_events e
--    WHERE e.game_id = p_game_id AND e.kind = 'game_switched_off_by_owner'
--      AND e.request_id = p_request_id LIMIT 1;
-- The only usable index is cash_cluster_events_by_game (game_id, at DESC),
-- so Postgres reads EVERY event the game ever logged and filters them. The
-- log is 4 GB and about 5.0M rows. The two Lightning pilot games alone hold
-- about 24% and 14% of it (pg_stats), roughly 1.2M and 680k events, so the
-- lookup alone ran past the 8 s statement budget.
-- 20261024213143 (switch off the pilot games) was refused twice for exactly
-- this, at 00:32Z and 01:02Z on 2026-10-25 (ERROR 57014 inside that SELECT).
-- The same door times out for any busy game's owner, from the console too.
--
-- THE FIX. A partial index on exactly that lookup: (game_id, request_id) for
-- kind = 'game_switched_off_by_owner'. Only switch-off events are indexed,
-- so it is a few rows, not 5M. It is built CONCURRENTLY, the maintained
-- applier's supported nonblocking preamble, so no writer to the event log is
-- blocked while it scans. The transaction below only proves the built index
-- is valid, ready and exactly this definition.
--
-- PINNED BY tests/an-owner-switch-off-finds-its-request-by-index.law.test.ts.
--
-- @live-proof: EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.cash_cluster_events_owner_switch_off_request') AND i.indisvalid AND i.indisready)

CREATE INDEX CONCURRENTLY IF NOT EXISTS cash_cluster_events_owner_switch_off_request
 ON public.cash_cluster_events (game_id, request_id)
 WHERE kind = 'game_switched_off_by_owner';

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $index_guard$
DECLARE actual_definition text; valid boolean; ready boolean;
BEGIN
  SELECT pg_get_indexdef(i.indexrelid), i.indisvalid, i.indisready
    INTO actual_definition, valid, ready
    FROM pg_index i
   WHERE i.indexrelid = to_regclass('public.cash_cluster_events_owner_switch_off_request')
     AND i.indrelid = 'public.cash_cluster_events'::regclass;
  IF valid IS DISTINCT FROM true OR ready IS DISTINCT FROM true
     OR regexp_replace(actual_definition, '\s+', '', 'g') IS DISTINCT FROM
        regexp_replace($expected$CREATE INDEX cash_cluster_events_owner_switch_off_request ON public.cash_cluster_events USING btree (game_id, request_id) WHERE (kind = 'game_switched_off_by_owner'::text)$expected$, '\s+', '', 'g') THEN
    RAISE EXCEPTION 'owner switch-off request index missing, invalid or definition differs: %', actual_definition;
  END IF;
END $index_guard$;

COMMIT;
