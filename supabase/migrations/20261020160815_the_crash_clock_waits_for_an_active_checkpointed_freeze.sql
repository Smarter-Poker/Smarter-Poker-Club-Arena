-- A prepared thaw receipt does not mean its active freeze has ended.
-- Keep the existing private, read-only clock; change no prize or wallet rule.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
DECLARE p pg_proc;
BEGIN
 SELECT * INTO STRICT p FROM pg_proc WHERE oid='public.fn_crash_flight_ms(timestamptz,timestamptz)'::regprocedure;
 IF md5(pg_get_functiondef(p.oid))<>'e41c5ba1b09d163f112ca9ca27ca649c'
 OR pg_get_userbyid(p.proowner)<>'postgres' OR p.prosecdef OR p.provolatile<>'s'
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
 OR (SELECT array_agg(a::text ORDER BY a::text) FROM unnest(p.proacl) a)
    IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres'] THEN
  RAISE EXCEPTION 'Crash flight clock preimage or private authority changed: hash %, owner %, definer %, volatility %, config %, ACL %', md5(pg_get_functiondef(p.oid)),pg_get_userbyid(p.proowner),p.prosecdef,p.provolatile,p.proconfig,p.proacl;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_crash_flight_ms(p_started timestamptz, p_at timestamptz)
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH frozen AS (
    SELECT t.freeze_started_at AS s,
           t.freeze_started_at + make_interval(secs => t.frozen_seconds::double precision) AS e
      FROM public.engine_maintenance_thaws t
     WHERE t.freeze_started_at < p_at
       AND t.freeze_started_at > p_started - INTERVAL '1 day'
    UNION ALL
    SELECT x.s, p_at
      FROM (SELECT COALESCE(b.break_started_at, b.announced_at + INTERVAL '2 minutes') AS s
              FROM public.engine_maintenance_break b
             WHERE b.enforce_freeze) x
     WHERE x.s < p_at
  ), intervals AS (
    -- A thaw receipt is checkpointed before release and may be extended.
    -- While its break remains active, union both ranges without counting
    -- their shared frozen time twice. A future certified release stays held.
    SELECT s, max(e) AS e FROM frozen GROUP BY s
  )
  SELECT GREATEST(0::numeric,
           floor(extract(epoch FROM (p_at - p_started)) * 1000)
           - COALESCE(sum(GREATEST(0::numeric,
               extract(epoch FROM (LEAST(f.e, p_at) - GREATEST(f.s, p_started))) * 1000)), 0)
         )::bigint
    FROM intervals f
$function$;
COMMIT;
