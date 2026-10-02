-- Tournament lease heartbeats are HOT updates, and no long back-office job
-- runs during play.
--
-- WHAT HAPPENED (2026-10-01). Ad hoc one-shot pg_cron jobs 381 and 387
-- (`midway-0921-close-once-20261001a/c`, SELECT fn_union_settlement_cascade_due()
-- under a 2700-6600 s statement_timeout) each held ONE transaction for 38-45
-- minutes, at 15:07Z and 17:17Z. A transaction that long pins the xmin
-- horizon, so vacuum can remove no dead tuple anywhere. On
-- public.engine_tournament_leases (a few hundred live rows) that was fatal:
-- every heartbeat is an UPDATE ... SET heartbeat_at = clock_timestamp(), and
-- heartbeat_at is indexed by idx_engine_tournament_leases_heartbeat, so not
-- one of 19.4M updates was HOT (pg_stat_user_tables n_tup_hot_upd = 0). Each
-- heartbeat wrote a new heap tuple plus a new entry in BOTH indexes; the pkey
-- index grew one dead entry per heartbeat; ~142k dead tuples piled up that
-- vacuum could not reclaim; heartbeat_tournament_leases_v4 reached 8 s, and
-- about 1,650 tournament leases expired at the 20 s proof window. Tournaments
-- stalled.
--
-- THE FIX, STRUCTURAL HALF. A heartbeat must change no indexed column, so the
-- update is HOT: one heap version on the same page, no index entry, and the
-- old version is pruned by the next page visit once the horizon allows.
--   * idx_engine_tournament_leases_heartbeat is dropped. Every reader of
--     heartbeat_at checked on 2026-10-01 (heartbeat v2/v3/v4, claim v1/v2,
--     f06_authority, fn_multi_day_lease_is_current, launch begin/complete,
--     fn_close_empty_tournament_table, fn_spin_draw_and_settle_atomic, the
--     f06 custody functions) reaches the row by its tournament_id primary
--     key and only compares heartbeat_at afterwards. The only range readers,
--     reap_dead_engine_leases and fn_ca_orphaned_running_tournaments, scan a
--     table of a few hundred rows; the index had 84 scans against 143M pkey
--     scans. No engine query filters the table on heartbeat_at.
--   * fillfactor 50 leaves room on each page for the new version, so the HOT
--     chain stays on its page even while a long transaction holds the
--     horizon and pruning has to wait.
-- The heartbeat function itself is not changed; it is guarded below because
-- the HOT argument depends on it setting heartbeat_at and nothing else.
--
-- THE FIX, OPERATIONAL HALF. The spent one-shots 381 and 387 are gone from
-- cron.job already; 388 (`midway-0921-close-once-20261001d`, 6600 s) is still
-- scheduled into play. Every `midway-0921-close-once-%` job is unscheduled
-- here (a `M H D Mon *` schedule fires again every year on that date). The
-- union close is a back-office job: it runs from its own reviewed schedule,
-- not as a 110-minute single transaction during live tournaments.
--
-- @live-proof: to_regclass('public.idx_engine_tournament_leases_heartbeat') IS NULL
-- @live-proof: COALESCE((SELECT reloptions FROM pg_class WHERE oid = 'public.engine_tournament_leases'::regclass), '{}'::text[]) @> ARRAY['fillfactor=50']
-- @live-proof: NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname LIKE 'midway-0921-close-once-%')
BEGIN;
-- DROP INDEX takes ACCESS EXCLUSIVE on the lease table. Every heartbeat queues
-- behind a waiting lock, so it may wait at most 2 s, never the 20 s proof window.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

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
