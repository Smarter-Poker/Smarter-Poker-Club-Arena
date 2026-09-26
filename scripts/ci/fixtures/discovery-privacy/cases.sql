\set ON_ERROR_STOP on
-- These are disposable local groups, never production rows or privacy toggles.
-- First assertion is the reproduced regression on the recorded baseline.
UPDATE commander_home_groups SET is_private=true WHERE id='10000000-0000-0000-0000-000000000002';
SET ROLE anon;
DO $$ BEGIN
    IF EXISTS (SELECT FROM public.mv_active_poker_locations WHERE entity_id='10000000-0000-0000-0000-000000000002')
       OR EXISTS (SELECT FROM public.mv_home_groups_trending WHERE group_id='10000000-0000-0000-0000-000000000002') THEN
        RAISE EXCEPTION 'private group remains in public discovery without refresh';
    END IF;
END $$;
RESET ROLE;

UPDATE commander_home_groups SET is_active=false WHERE id='10000000-0000-0000-0000-000000000003';
DELETE FROM commander_home_groups WHERE id='10000000-0000-0000-0000-000000000004';
UPDATE commander_home_groups SET profile_photo_url=null WHERE id='10000000-0000-0000-0000-000000000005';
UPDATE commander_home_groups SET last_activity_at=now()-interval '46 days' WHERE id='10000000-0000-0000-0000-000000000006';
UPDATE commander_home_groups SET location_geog=null WHERE id='10000000-0000-0000-0000-000000000007';
-- Prove the new views use caller RLS, including a future restrictive policy.
CREATE POLICY fixture_restricted_group ON commander_home_groups AS RESTRICTIVE FOR SELECT TO anon,authenticated USING(id <> '10000000-0000-0000-0000-000000000008');
DO $$ BEGIN
    IF (SELECT count(*) FROM discovery_private.mv_home_groups_trending) <> 8 THEN
        RAISE EXCEPTION 'test must keep stale cached rows until explicit refresh';
    END IF;
END $$;

SET ROLE anon;
DO $$ BEGIN
    IF (SELECT count(*) FROM mv_active_poker_locations) <> 2
       OR (SELECT count(*) FROM mv_home_groups_trending) <> 2 THEN
        RAISE EXCEPTION 'fresh eligibility, venue preservation or caller RLS failed';
    END IF;
    IF (SELECT count(*) FROM get_poker_locations_by_state('IL',100)) <> 2
       OR (SELECT count(*) FROM get_poker_locations_by_state('IL',0)) <> 1
       OR (SELECT count(*) FROM get_poker_locations_by_state('XX',100)) <> 0
       OR (SELECT count(*) FROM get_trending_home_groups()) <> 2
       OR (SELECT count(*) FROM get_trending_home_groups(1)) <> 1
       OR (get_public_smarter_poker_metrics()->'platform'->>'total_poker_locations')::int <> 2 THEN
        RAISE EXCEPTION 'public RPC compatibility failed';
    END IF;
    IF has_schema_privilege(current_user,'discovery_private','USAGE')
       OR has_schema_privilege(current_user,'discovery_private','CREATE') THEN
        RAISE EXCEPTION 'cache schema is reachable';
    END IF;
    BEGIN
        PERFORM * FROM discovery_private.mv_active_poker_locations;
        RAISE EXCEPTION 'direct private locations cache was readable';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN
        PERFORM * FROM discovery_private.mv_home_groups_trending;
        RAISE EXCEPTION 'direct private trending cache was readable';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN
        PERFORM fn_refresh_active_poker_locations();
        RAISE EXCEPTION 'anonymous caller refreshed cache';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN
        PERFORM fn_refresh_trending_home_groups();
        RAISE EXCEPTION 'anonymous caller refreshed trending cache';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN
        PERFORM get_smarter_poker_pulse();
        RAISE EXCEPTION 'anonymous caller gained aggregate privilege';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;

SET ROLE authenticated;
SET request.jwt.claim.sub = '20000000-0000-0000-0000-000000000001';
DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM commander_home_groups WHERE id='10000000-0000-0000-0000-000000000002') THEN
        RAISE EXCEPTION 'fixture owner must retain private group RLS access';
    END IF;
    IF (SELECT count(*) FROM get_poker_locations_by_state('IL')) <> 2
       OR (SELECT count(*) FROM get_trending_home_groups()) <> 2
       OR (get_public_smarter_poker_metrics()->'platform'->>'total_poker_locations')::int <> 2
       OR (get_smarter_poker_pulse()->'discovery'->>'active_poker_locations_total')::int <> 2 THEN
        RAISE EXCEPTION 'owner can discover private groups or RPC compatibility changed';
    END IF;
    IF has_schema_privilege(current_user,'discovery_private','USAGE') THEN
        RAISE EXCEPTION 'authenticated cache schema is reachable';
    END IF;
    BEGIN
        PERFORM * FROM discovery_private.mv_home_groups_trending;
        RAISE EXCEPTION 'authenticated caller read direct cache';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN
        PERFORM fn_refresh_active_poker_locations();
        RAISE EXCEPTION 'authenticated caller refreshed cache';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SET request.jwt.claim.sub = '20000000-0000-0000-0000-000000000002';
DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM commander_home_groups WHERE id='10000000-0000-0000-0000-000000000002')
       OR EXISTS (SELECT FROM get_trending_home_groups() WHERE group_id='10000000-0000-0000-0000-000000000002') THEN
        RAISE EXCEPTION 'member private access must not leak into public discovery';
    END IF;
END $$;
RESET ROLE;

-- Existing jobs can still use the same command/function and concurrent indexes.
SET ROLE service_role;
SELECT public.fn_refresh_trending_home_groups();
DO $$ BEGIN
    IF (public.fn_refresh_active_poker_locations()->>'success')::boolean IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'service refresh failed';
    END IF;
END $$;
RESET ROLE;
DO $$ BEGIN
    IF (SELECT count(*) FROM discovery_private.mv_home_groups_trending) <> 3
       OR (SELECT count(*) FROM discovery_private.mv_active_poker_locations) <> 3 THEN
        RAISE EXCEPTION 'refresh did not preserve original cache definitions';
    END IF;
    IF EXISTS (SELECT FROM fixture_function_catalog f JOIN pg_proc p ON p.oid=f.oid
               WHERE md5(pg_get_functiondef(p.oid))<>f.hash OR p.proacl IS DISTINCT FROM f.proacl
                 OR p.prosecdef IS DISTINCT FROM f.prosecdef OR p.proconfig IS DISTINCT FROM f.proconfig)
       OR (SELECT count(*) FROM fixture_function_catalog f JOIN pg_proc p ON p.oid=f.oid) <> 4 THEN
        RAISE EXCEPTION 'a read RPC identity, source or permission changed';
    END IF;
    IF EXISTS (SELECT FROM fixture_columns f FULL JOIN (
                    SELECT c.relname,a.attname,a.atttypid,a.atttypmod,a.attnum
                    FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
                    WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('mv_active_poker_locations','mv_home_groups_trending') AND a.attnum>0 AND NOT a.attisdropped
               ) a USING(relname,attname,atttypid,atttypmod,attnum) WHERE f.attname IS NULL OR a.attname IS NULL) THEN
        RAISE EXCEPTION 'public column contracts changed';
    END IF;
    IF (SELECT count(*) FROM fixture_indexes f JOIN pg_index i USING(indexrelid,indrelid)
        WHERE i.indisunique AND i.indisvalid AND i.indisready) <> 2 THEN
        RAISE EXCEPTION 'refresh index identity or validity changed';
    END IF;
    IF (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace
          AND relname IN ('mv_active_poker_locations','mv_home_groups_trending')
          AND relkind='v' AND reloptions @> ARRAY['security_invoker=true','security_barrier=true']) <> 2 THEN
        RAISE EXCEPTION 'secured views are missing';
    END IF;
    IF NOT EXISTS (SELECT FROM cron.job WHERE jobid=17 AND schedule='*/15 * * * *' AND command='SELECT public.fn_refresh_trending_home_groups();' AND active)
       OR NOT EXISTS (SELECT FROM cron.job WHERE jobid=20 AND schedule='*/30 * * * *' AND command='SELECT public.fn_refresh_active_poker_locations();' AND active) THEN
        RAISE EXCEPTION 'existing cron schedule or command changed';
    END IF;
END $$;
SET ROLE anon;
DO $$ BEGIN
    IF (SELECT count(*) FROM mv_active_poker_locations) <> 2
       OR (SELECT count(*) FROM mv_home_groups_trending) <> 2 THEN
        RAISE EXCEPTION 'caller RLS failed after a concurrent refresh';
    END IF;
END $$;
RESET ROLE;
SELECT 'discovery-privacy-acceptance-passed';
