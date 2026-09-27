-- Public discovery must re-check home-group privacy on every read. A cached
-- public group previously stayed visible until its 15/30-minute refresh after
-- the owner made it private. No production leak was found in the audit.
-- Preserve the four SECURITY INVOKER read RPCs, their signatures and RLS.
-- Keep cached calculation work and the two existing cron schedules unchanged.
-- Qualified on isolated PostgreSQL 17; install only once, outside the DDL guard.
BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = public, extensions;

DO $preflight$
BEGIN
    IF to_regnamespace('discovery_private') IS NOT NULL THEN
        RAISE EXCEPTION 'discovery privacy: target schema already exists; inspect installation history';
    END IF;
    IF (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.mv_home_groups_trending')) IS DISTINCT FROM 'm'
       OR md5(pg_get_viewdef(to_regclass('public.mv_home_groups_trending'), true)) IS DISTINCT FROM '51f5fd54a12e57735c7070ea712875dd' THEN
        RAISE EXCEPTION 'discovery privacy source drift: mv_home_groups_trending';
    END IF;
    IF (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.mv_active_poker_locations')) IS DISTINCT FROM 'm'
       OR md5(pg_get_viewdef(to_regclass('public.mv_active_poker_locations'), true)) IS DISTINCT FROM '3893fbda45383b36f4554b24838d945b' THEN
        RAISE EXCEPTION 'discovery privacy source drift: mv_active_poker_locations';
    END IF;
    IF md5(pg_get_functiondef(to_regprocedure('public.get_smarter_poker_pulse()'))) IS DISTINCT FROM '0a02c2f8a126f55a921a71763112a350' THEN
        RAISE EXCEPTION 'discovery privacy source drift: get_smarter_poker_pulse';
    END IF;
    IF md5(pg_get_functiondef(to_regprocedure('public.get_public_smarter_poker_metrics()'))) IS DISTINCT FROM 'ee6cd83ca4085e89023c252833434148' THEN
        RAISE EXCEPTION 'discovery privacy source drift: get_public_smarter_poker_metrics';
    END IF;
    IF md5(pg_get_functiondef(to_regprocedure('public.fn_refresh_active_poker_locations()'))) IS DISTINCT FROM '6511c67b59a2acf38b9244bf55f71879' THEN
        RAISE EXCEPTION 'discovery privacy source drift: fn_refresh_active_poker_locations';
    END IF;
    IF md5(pg_get_functiondef(to_regprocedure('public.get_poker_locations_by_state(text, integer)'))) IS DISTINCT FROM 'c7282177fd5fb84d9547105f8b0ff531' THEN
        RAISE EXCEPTION 'discovery privacy source drift: get_poker_locations_by_state';
    END IF;
    IF md5(pg_get_functiondef(to_regprocedure('public.fn_refresh_trending_home_groups()'))) IS DISTINCT FROM '3daba6277f32a06e59c5c5bf384a5764' THEN
        RAISE EXCEPTION 'discovery privacy source drift: fn_refresh_trending_home_groups';
    END IF;
    IF md5(pg_get_functiondef(to_regprocedure('public.get_trending_home_groups(integer, numeric, numeric, integer)'))) IS DISTINCT FROM '3f79db65d9bb9976936e665e9a9353b3' THEN
        RAISE EXCEPTION 'discovery privacy source drift: get_trending_home_groups';
    END IF;
    -- Home-group keys come from uuid::text in the hash-bound cache definition.
    -- Refuse unexpected cached keys before the indexed read boundary is created.
    IF (SELECT atttypid FROM pg_attribute
        WHERE attrelid = 'public.commander_home_groups'::regclass
          AND attname = 'id' AND NOT attisdropped) IS DISTINCT FROM 'uuid'::regtype
       OR EXISTS (
           SELECT 1 FROM public.mv_active_poker_locations
           WHERE source = 'home_group' AND (entity_id IS NULL OR entity_id !~
               '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       ) THEN
        RAISE EXCEPTION 'discovery privacy: home-group cache keys are not canonical UUIDs';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
        WHERE d.classid = 'pg_rewrite'::regclass
          AND d.refobjid IN ('public.mv_active_poker_locations'::regclass,
                            'public.mv_home_groups_trending'::regclass)
          AND r.ev_class <> d.refobjid
    ) THEN
        RAISE EXCEPTION 'discovery privacy: an external view dependency needs qualification';
    END IF;
    IF (SELECT count(*) FROM pg_index i
        WHERE i.indexrelid IN (to_regclass('public.mv_active_poker_locations_pk'),
                              to_regclass('public.idx_mv_home_groups_trending_group_id'))
          AND i.indisunique AND i.indisvalid AND i.indisready
          AND i.indpred IS NULL AND i.indexprs IS NULL) <> 2 THEN
        RAISE EXCEPTION 'discovery privacy: concurrent refresh indexes are missing or invalid';
    END IF;
END;
$preflight$;

CREATE SCHEMA discovery_private AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA discovery_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA discovery_private TO service_role;

-- Moving preserves stored rows, OIDs, unique indexes and refresh dependencies.
ALTER MATERIALIZED VIEW public.mv_active_poker_locations SET SCHEMA discovery_private;
ALTER MATERIALIZED VIEW public.mv_home_groups_trending SET SCHEMA discovery_private;
REVOKE ALL ON discovery_private.mv_active_poker_locations,
              discovery_private.mv_home_groups_trending FROM PUBLIC, anon, authenticated;
-- Invoker views require underlying SELECT but DO NOT require schema USAGE.
-- Without schema USAGE a browser cannot resolve/read either cache directly,
-- even if a future API configuration accidentally exposes this schema.
GRANT SELECT ON discovery_private.mv_active_poker_locations,
                discovery_private.mv_home_groups_trending TO anon, authenticated;

CREATE VIEW public.mv_active_poker_locations
WITH (security_invoker = true, security_barrier = true) AS
SELECT cache.*
FROM discovery_private.mv_active_poker_locations cache
WHERE cache.source = 'venue'
   OR (cache.source = 'home_group' AND EXISTS (
       SELECT 1 FROM public.commander_home_groups current_group
       WHERE current_group.id = CASE WHEN cache.source = 'home_group'
                                    THEN cache.entity_id::uuid END
         AND current_group.is_active IS TRUE
         AND current_group.is_private IS FALSE
         AND current_group.profile_photo_url IS NOT NULL
         AND current_group.last_activity_at > now() - interval '45 days'
         AND current_group.location_geog IS NOT NULL
   ));

CREATE VIEW public.mv_home_groups_trending
WITH (security_invoker = true, security_barrier = true) AS
SELECT cache.*
FROM discovery_private.mv_home_groups_trending cache
WHERE EXISTS (
    SELECT 1 FROM public.commander_home_groups current_group
    WHERE current_group.id = cache.group_id
      AND current_group.is_active IS TRUE
      AND current_group.is_private IS FALSE
      AND current_group.profile_photo_url IS NOT NULL
      AND current_group.last_activity_at > now() - interval '45 days'
);

REVOKE ALL ON public.mv_active_poker_locations,
              public.mv_home_groups_trending FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mv_active_poker_locations,
                public.mv_home_groups_trending TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_refresh_active_poker_locations()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v_count bigint; v_duration interval; v_started timestamptz;
BEGIN
    v_started := clock_timestamp();
    REFRESH MATERIALIZED VIEW CONCURRENTLY discovery_private.mv_active_poker_locations;
    v_duration := clock_timestamp() - v_started;
    SELECT COUNT(*) INTO v_count FROM discovery_private.mv_active_poker_locations;
    RETURN jsonb_build_object(
        'success', true, 
        'row_count', v_count,
        'duration_ms', EXTRACT(milliseconds FROM v_duration)
    );
END; $function$;

CREATE OR REPLACE FUNCTION public.fn_refresh_trending_home_groups()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY discovery_private.mv_home_groups_trending;
END;
$function$;

DO $postflight$
BEGIN
    IF has_schema_privilege('anon', 'discovery_private', 'USAGE')
       OR has_schema_privilege('authenticated', 'discovery_private', 'USAGE') THEN
        RAISE EXCEPTION 'discovery privacy: browser cache schema access must remain denied';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_proc
        WHERE oid IN ('public.get_poker_locations_by_state(text,integer)'::regprocedure,
                      'public.get_trending_home_groups(integer,numeric,numeric,integer)'::regprocedure,
                      'public.get_public_smarter_poker_metrics()'::regprocedure,
                      'public.get_smarter_poker_pulse()'::regprocedure,
                      'public.fn_refresh_trending_home_groups()'::regprocedure,
                      'public.fn_refresh_active_poker_locations()'::regprocedure)
          AND prosecdef
    ) THEN
        RAISE EXCEPTION 'discovery privacy: read and refresh RPCs must retain caller rights';
    END IF;
END;
$postflight$;

COMMIT;
