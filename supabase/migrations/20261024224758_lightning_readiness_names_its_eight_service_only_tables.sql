-- @live-proof: (SELECT position('lightning_horse_fill' IN pg_get_functiondef('public.fn_lightning_rollout_readiness(uuid)'::regprocedure))>0)
-- 20261024224758_lightning_readiness_names_its_eight_service_only_tables.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- fn_lightning_rollout_readiness reports the invariant `seven_tables`: every
-- lightning_* table is readable by service_role and by nobody else. It was
-- written as `count(*) = 7`. The Midway fill work (20261023213842) added an
-- eighth service-only table, lightning_horse_fill, with exactly the same
-- posture, so the count became 8 and the invariant has read FALSE since: every
-- Lightning cluster's readiness answers NO_GO on a security check that is in
-- fact satisfied, and post-deploy Client browser verification fails on it
-- (run 40132784246, "readiness invariant seven_tables").
--
-- Read from production 2026-10-24 22:40 UTC: eight lightning_* tables, all with
-- service_role SELECT, none granted to anon, authenticated or PUBLIC.
--
-- The invariant now compares the EXACT set of table names, so a ninth table
-- still turns it false until it is named here on purpose, and a grant to anon,
-- authenticated or PUBLIC still turns it false exactly as before. The output
-- key stays `seven_tables` because the operator client and its tests read it.
--
-- Proven on production in one rolled-back DO block: the qualified body compiled
-- into pg_temp answers seven_tables=true for a Midway Must Move cluster where
-- the live body answers false; every other invariant is unchanged.
--
-- Applied as an md5-guarded text replacement of the live definition, so a
-- drifted source aborts instead of overwriting another change. Function only:
-- no table lock.

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $source$
DECLARE s text; n text;
BEGIN
  s := pg_get_functiondef('public.fn_lightning_rollout_readiness(uuid)'::regprocedure);
  IF md5(s) <> '7823860d05675c9e6e95725391d2814c' THEN
    RAISE EXCEPTION 'Lightning readiness source changed; requalify the table-set invariant';
  END IF;
  n := replace(s, 'SELECT count(*) = 7 FROM information_schema.role_table_grants',
    $x$SELECT coalesce(array_agg(DISTINCT table_name::text ORDER BY table_name::text)
                  = ARRAY['lightning_blind_ledger', 'lightning_hand', 'lightning_hand_player',
                          'lightning_horse_fill', 'lightning_instance', 'lightning_pool_session',
                          'lightning_pool_slot', 'lightning_reservation']::text[], false)
                FROM information_schema.role_table_grants$x$);
  IF n = s OR position('lightning_horse_fill' IN n) = 0 THEN
    RAISE EXCEPTION 'Lightning readiness table-count anchor changed; requalify';
  END IF;
  EXECUTE n;
END $source$;

COMMIT;
