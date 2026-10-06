-- A tournament lease heartbeat is a HOT update; the change takes its table
-- lock in bounded attempts.
--
-- Supersedes 20261001200224 (same end state, same guards, same @live-proof
-- lines), which was refused on apply at 20:42Z 2026-10-01 with 55P03
-- "canceling statement due to lock timeout" after 2182 ms and committed
-- nothing. Every PostgREST request on this database takes a lock on
-- public.engine_tournament_leases through
-- smarter_private.fn_smarter_data_api_pre_request, and tournament RPCs hold it
-- for up to ~3 s, so DROP INDEX's ACCESS EXCLUSIVE request almost never sees a
-- 2 s gap. Lengthening one wait would stall every tournament RPC queued
-- behind it for that long. Instead the lock is taken FIRST, alone, in up to
-- 40 attempts of at most 1.5 s each with a 0.4 s pause between them: no
-- tournament RPC ever waits more than 1.5 s behind this migration, and once
-- the lock is held the remaining DDL (drop one index, set fillfactor,
-- unschedule, assertions) takes milliseconds.
--
-- WHY (unchanged from 20261001200224). One-shot pg_cron jobs 381 and 387
-- (`midway-0921-close-once-20261001a/c`, fn_union_settlement_cascade_due()
-- under a 2700-6600 s statement_timeout) held single 38-45 minute
-- transactions on 2026-10-01, pinning the xmin horizon. Every lease heartbeat
-- sets heartbeat_at, which idx_engine_tournament_leases_heartbeat indexed, so
-- 0 of 19.6M heartbeats were HOT; ~142k dead tuples accumulated,
-- heartbeat_tournament_leases_v4 reached 8 s and ~1,650 tournament leases
-- expired at the 20 s proof window.
--   * idx_engine_tournament_leases_heartbeat is dropped: every reader of
--     heartbeat_at reaches the row by its tournament_id primary key (heartbeat
--     v2/v3/v4, claims, f06_authority, fn_smarter_data_api_pre_request,
--     launch, spin, f06 custody); the two range readers
--     (reap_dead_engine_leases, fn_ca_orphaned_running_tournaments) scan a
--     few hundred rows. The index had 84 scans against 143M pkey scans.
--   * fillfactor 50 keeps each HOT chain on its page while a long
--     transaction holds the horizon.
--   * every `midway-0921-close-once-%` one-shot is unscheduled (388, 6600 s,
--     was scheduled into play; `M H D Mon *` fires again every year).
--
-- @live-proof: to_regclass('public.idx_engine_tournament_leases_heartbeat') IS NULL
-- @live-proof: COALESCE((SELECT reloptions FROM pg_class WHERE oid = 'public.engine_tournament_leases'::regclass), '{}'::text[]) @> ARRAY['fillfactor=50']
-- @live-proof: NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname LIKE 'midway-0921-close-once-%')
BEGIN;
-- One bounded wait per attempt: a queued ACCESS EXCLUSIVE request blocks every
-- later lease reader, so no attempt may wait longer than 1.5 s.
SET LOCAL lock_timeout = '1500ms';
SET LOCAL statement_timeout = '120s';

DO $lock$
DECLARE attempt int;
BEGIN
  FOR attempt IN 1..40 LOOP
    BEGIN
      LOCK TABLE public.engine_tournament_leases IN ACCESS EXCLUSIVE MODE;
      RAISE NOTICE 'lease_hot_lock: engine_tournament_leases locked on attempt %', attempt;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      PERFORM pg_sleep(0.4);
    END;
  END LOOP;
  RAISE EXCEPTION 'lease_hot_lock: engine_tournament_leases could not be locked in 40 bounded attempts'
    USING ERRCODE = '55P03';
END
$lock$;

DO $pre$
DECLARE
  t   regclass := 'public.engine_tournament_leases'::regclass;
  hb  regprocedure := 'public.heartbeat_tournament_leases_v4(text,jsonb,integer)'::regprocedure;
  p   record;
  rel record;
  extra text;
BEGIN
  -- The heartbeat this argument depends on is exactly the one read on 2026-10-01.
  SELECT md5(prosrc) AS m, pg_get_userbyid(proowner) AS owner, proacl::text AS acl,
         proconfig::text AS cfg, prosecdef, provolatile
    INTO p FROM pg_proc WHERE oid = hb;
  IF p.m <> '19e8332821e7a9af9605e63917ceadaf'
     OR p.owner <> 'postgres'
     OR p.acl <> '{postgres=X/postgres,service_role=X/postgres}'
     OR p.cfg <> '{"search_path=public, pg_temp"}'
     OR NOT p.prosecdef
     OR p.provolatile <> 'v' THEN
    RAISE EXCEPTION 'lease_hot_preimage: heartbeat_tournament_leases_v4 is not the inspected version (md5 %, owner %, acl %, cfg %, secdef %, vol %)',
      p.m, p.owner, p.acl, p.cfg, p.prosecdef, p.provolatile;
  END IF;

  SELECT pg_get_userbyid(relowner) AS owner, relacl::text AS acl, reloptions
    INTO rel FROM pg_class WHERE oid = t;
  IF rel.owner <> 'postgres'
     OR rel.acl <> '{postgres=arwdDxtm/postgres,anon=rxt/postgres,authenticated=rxt/postgres,service_role=arwdDxtm/postgres}'
     OR NOT (rel.reloptions IS NULL OR rel.reloptions = '{fillfactor=50}'::text[]) THEN
    RAISE EXCEPTION 'lease_hot_preimage: engine_tournament_leases owner/acl/options changed (owner %, acl %, options %)',
      rel.owner, rel.acl, rel.reloptions;
  END IF;

  -- The heartbeat index is either exactly what was inspected, or already gone.
  IF to_regclass('public.idx_engine_tournament_leases_heartbeat') IS NOT NULL
     AND pg_get_indexdef(to_regclass('public.idx_engine_tournament_leases_heartbeat'))
         <> 'CREATE INDEX idx_engine_tournament_leases_heartbeat ON public.engine_tournament_leases USING btree (heartbeat_at)' THEN
    RAISE EXCEPTION 'lease_hot_preimage: idx_engine_tournament_leases_heartbeat is not the inspected definition';
  END IF;

  -- No other index exists that this migration has not reasoned about.
  SELECT string_agg(c.relname, ', ') INTO extra
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = t
     AND c.relname NOT IN ('engine_tournament_leases_pkey', 'idx_engine_tournament_leases_heartbeat');
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'lease_hot_preimage: uninspected index(es) on engine_tournament_leases: %', extra;
  END IF;
END
$pre$;

DROP INDEX IF EXISTS public.idx_engine_tournament_leases_heartbeat;
ALTER TABLE public.engine_tournament_leases SET (fillfactor = 50);

DO $cron$
DECLARE j record;
BEGIN
  FOR j IN SELECT jobid, jobname FROM cron.job WHERE jobname LIKE 'midway-0921-close-once-%' ORDER BY jobid LOOP
    PERFORM cron.unschedule(j.jobid);
    RAISE NOTICE 'unscheduled one-shot back-office job % (%)', j.jobid, j.jobname;
  END LOOP;
END
$cron$;

DO $post$
DECLARE
  t regclass := 'public.engine_tournament_leases'::regclass;
  hb_col smallint;
  n int;
BEGIN
  SELECT attnum INTO hb_col FROM pg_attribute WHERE attrelid = t AND attname = 'heartbeat_at' AND NOT attisdropped;
  -- No index (key, INCLUDE, expression or predicate) touches heartbeat_at, so a heartbeat is HOT-eligible.
  SELECT count(*) INTO n
    FROM pg_index i
   WHERE i.indrelid = t
     AND (hb_col = ANY(i.indkey::smallint[])
          OR pg_get_expr(i.indexprs, i.indrelid) ILIKE '%heartbeat_at%'
          OR pg_get_expr(i.indpred, i.indrelid) ILIKE '%heartbeat_at%');
  IF n <> 0 THEN
    RAISE EXCEPTION 'lease_hot_postimage: % index(es) still cover heartbeat_at', n;
  END IF;
  SELECT count(*) INTO n FROM pg_index WHERE indrelid = t;
  IF n <> 1 OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid = t AND indisprimary
                             AND indexrelid = 'public.engine_tournament_leases_pkey'::regclass) THEN
    RAISE EXCEPTION 'lease_hot_postimage: expected exactly the primary key index, found %', n;
  END IF;
  IF NOT COALESCE((SELECT reloptions FROM pg_class WHERE oid = t) @> ARRAY['fillfactor=50'], false) THEN
    RAISE EXCEPTION 'lease_hot_postimage: fillfactor 50 not set';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname LIKE 'midway-0921-close-once-%') THEN
    RAISE EXCEPTION 'lease_hot_postimage: a midway one-shot close job is still scheduled';
  END IF;
  -- Grants on the table are unchanged by this migration (re-asserted, not re-granted).
  IF (SELECT relacl::text FROM pg_class WHERE oid = t)
     <> '{postgres=arwdDxtm/postgres,anon=rxt/postgres,authenticated=rxt/postgres,service_role=arwdDxtm/postgres}' THEN
    RAISE EXCEPTION 'lease_hot_postimage: engine_tournament_leases ACL changed';
  END IF;
END
$post$;

COMMIT;
