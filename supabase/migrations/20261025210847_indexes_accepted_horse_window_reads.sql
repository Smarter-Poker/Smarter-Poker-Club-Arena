-- 20261025210847_indexes_accepted_horse_window_reads.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Current accepted commit metadata has identity indexes but no acceptance-time
-- range index. The explicit private reviewer must enumerate every accepted key
-- in its predeclared window, including commitments at or below 10 BB. Existing
-- daily review queues cannot establish that population. Build the exact ordered
-- read path concurrently; the short transaction below validates its identity.
-- No gameplay, money, acceptance, or retention rule changes.
-- The private offline Phase14 window reader must enumerate accepted keys using
-- committed_at,hand_id, including small pots and explicit missing-source gaps.
-- This concurrent index provides that exact bounded range/order access path.
-- @live-proof: EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.horse_accepted_window_time') AND i.indisvalid AND i.indisready)
CREATE INDEX CONCURRENTLY IF NOT EXISTS horse_accepted_window_time
 ON public.hand_atomic_commits (committed_at, hand_id);
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
DO $index_guard$
DECLARE actual_definition text; valid boolean; ready boolean;
BEGIN
 SELECT pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready
 INTO actual_definition,valid,ready FROM pg_index i
 WHERE i.indexrelid=to_regclass('public.horse_accepted_window_time')
 AND i.indrelid='public.hand_atomic_commits'::regclass;
 IF valid IS DISTINCT FROM true OR ready IS DISTINCT FROM true
 OR regexp_replace(actual_definition,'\s+','','g') IS DISTINCT FROM
 regexp_replace($expected$CREATE INDEX horse_accepted_window_time ON public.hand_atomic_commits USING btree (committed_at, hand_id)$expected$,'\s+','','g') THEN
 RAISE EXCEPTION 'accepted window index missing, invalid or definition differs: %',actual_definition;
 END IF;
END $index_guard$;
COMMIT;
