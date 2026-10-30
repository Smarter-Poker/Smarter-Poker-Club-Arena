-- Reserved through scripts/reserve-migration-version.sh on 2026-10-30.
-- The live head, tail and missing-rollup branches materialized all positive
-- club attributions before filtering to the authorized downline. KingFish's
-- week view exceeded PostgREST's statement deadline. Restrict each branch to
-- the exact existing everyone(player_id,club_id) set before materialization.
-- The later join, launch gate, rollups, per-row cent rounding, authorization,
-- function identity/defaults/owner/ACL and all financial records are unchanged.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $patch$
DECLARE d text; old_clause constant text := 'a.rake_amount > 0 AND a.player_id IS NOT NULL';
 new_clause constant text := 'a.rake_amount > 0 AND a.player_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM everyone e
                    WHERE e.player_id = a.player_id AND e.club_id = a.club_id)';
BEGIN
 SELECT pg_get_functiondef('public.fn_agent_downline_rake(uuid,uuid,timestamptz,timestamptz,text,integer)'::regprocedure) INTO d;
 IF md5(d) <> 'c950d72d7b9db73b8fdb1a706441291c' THEN
   RAISE EXCEPTION 'Downline rake target definition drift';
 END IF;
 IF (length(d)-length(replace(d,old_clause,'')))/length(old_clause) <> 3 THEN
   RAISE EXCEPTION 'Expected exactly three live attribution branches';
 END IF;
 EXECUTE replace(d,old_clause,new_clause);
END $patch$;
COMMIT;
