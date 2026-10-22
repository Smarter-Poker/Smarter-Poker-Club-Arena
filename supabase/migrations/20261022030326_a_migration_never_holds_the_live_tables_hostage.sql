-- A MIGRATION NEVER HOLDS THE LIVE TABLES HOSTAGE (2026-10-22).
--
-- Incident: 02:34-02:49 UTC, 2026-10-22, "Engine Restart Storm" (32 engine
-- kills in 15 minutes on 30 tables, all authoritative_hand_unreachable).
-- The Midway 2.5 BB rake-cap migration (20261021174448) was applied twice, at
-- 02:34:15 and 02:48:49. Each run looped for up to 300 s on
--   LOCK TABLE clubs, tables, hand_history IN ACCESS EXCLUSIVE MODE
-- with 200 ms tries. Every queued ACCESS EXCLUSIVE request blocks every new
-- reader and writer behind it, so for minutes the hand commit path spent about
-- half its time frozen. Postgres logged 1,540 statement timeouts that hour
-- (about 25 in a normal hour); hand_history inserts exhausted the engine's 13
-- identical attempts and each table generation correctly killed itself.
--
-- The rule this enforces at runtime, whoever runs the DDL (an agent, the MCP,
-- psql, a workflow): a direct database session whose transaction is older
-- than 15 seconds may not keep live writers waiting on a table lock. Every
-- 5 seconds fn_ca_writer_lock_sentinel finds any such session that holds or is
-- queued for a writer-blocking relation lock (Share, ShareRowExclusive,
-- Exclusive, AccessExclusive) on a public table, and that is either queued for
-- it or is actually blocking another backend, and cancels it. The cancelled
-- transaction rolls back whole; nothing half-applies. Each cancel is recorded
-- and raised as a warning naming the session and the table.
--
-- Never targeted: PostgREST traffic (authenticator, which carries the engine
-- and every app request), background workers and autovacuum, and the sentinel
-- itself. No scheduled job takes these lock modes (checked 2026-10-22).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.ca_writer_lock_sentinel_cancels (
  id               bigserial PRIMARY KEY,
  cancelled_at     timestamptz NOT NULL DEFAULT now(),
  pid              integer NOT NULL,
  usename          text,
  application_name text,
  lock_mode        text NOT NULL,
  relation         text NOT NULL,
  xact_age         interval,
  waiting          boolean NOT NULL,
  blocked          integer NOT NULL,
  cancelled        boolean NOT NULL,
  query            text
);
COMMENT ON TABLE public.ca_writer_lock_sentinel_cancels IS
  'Every session fn_ca_writer_lock_sentinel cancelled for holding the live tables behind a writer-blocking lock (incident 2026-10-22 02:34 UTC).';
ALTER TABLE public.ca_writer_lock_sentinel_cancels ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_writer_lock_sentinel_cancels FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.ca_writer_lock_sentinel_cancels FROM service_role;
GRANT SELECT ON public.ca_writer_lock_sentinel_cancels TO service_role;

CREATE FUNCTION public.fn_ca_writer_lock_sentinel(p_max_xact_seconds integer DEFAULT 15)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_catalog, pg_temp
SET statement_timeout TO '4s'
SET lock_timeout TO '1s'
AS $fn$
DECLARE
  v_max  interval := make_interval(secs => GREATEST(COALESCE(p_max_xact_seconds, 15), 5));
  r      record;
  v_blk  integer;
  v_ok   boolean;
  v_n    integer := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (a.pid)
           a.pid, a.usename::text AS usename, a.application_name,
           l.mode, format('%I.%I', n.nspname, c.relname) AS rel,
           now() - a.xact_start AS age, NOT l.granted AS waiting,
           left(a.query, 500) AS query
      FROM pg_catalog.pg_locks l
      JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
      JOIN pg_catalog.pg_class c ON c.oid = l.relation
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE l.locktype = 'relation'
       AND l.mode IN ('ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')
       AND n.nspname = 'public'
       AND c.relpersistence = 'p'
       AND a.backend_type = 'client backend'
       AND a.pid <> pg_backend_pid()
       AND a.usename IS DISTINCT FROM 'authenticator'
       AND a.xact_start < now() - v_max
     ORDER BY a.pid, (NOT l.granted) DESC, l.mode DESC
  LOOP
    SELECT count(*) INTO v_blk
      FROM pg_catalog.pg_stat_activity b
     WHERE b.wait_event_type = 'Lock'
       AND b.pid <> r.pid
       AND r.pid = ANY (pg_catalog.pg_blocking_pids(b.pid));

    CONTINUE WHEN NOT r.waiting AND v_blk = 0;

    BEGIN
      v_ok := pg_catalog.pg_cancel_backend(r.pid);
    EXCEPTION WHEN OTHERS THEN
      v_ok := false;
    END;

    INSERT INTO public.ca_writer_lock_sentinel_cancels
      (pid, usename, application_name, lock_mode, relation, xact_age, waiting, blocked, cancelled, query)
    VALUES (r.pid, r.usename, r.application_name, r.mode, r.rel, r.age, r.waiting, v_blk, COALESCE(v_ok, false), r.query);

    INSERT INTO public.financial_alerts (severity, source, message, context)
    VALUES ('warning', 'fn_ca_writer_lock_sentinel',
            format('A %s session (pid %s, %s, transaction open %s) was %s for %s on %s while %s live request(s) waited behind it. '
                   || 'A migration may not hold the live tables: apply it again outside the :50-:03 break, after its lock can be taken in one short try.',
                   COALESCE(NULLIF(r.application_name, ''), 'database'), r.pid, COALESCE(r.usename, '?'),
                   date_trunc('second', r.age),
                   CASE WHEN COALESCE(v_ok, false) THEN 'cancelled' ELSE 'NOT cancelled (signal refused)' END,
                   CASE WHEN r.waiting THEN 'queueing ' ELSE 'holding ' END || r.mode, r.rel, v_blk),
            jsonb_build_object('pid', r.pid, 'usename', r.usename, 'application_name', r.application_name,
                               'lock_mode', r.mode, 'relation', r.rel, 'xact_age_s', extract(epoch FROM r.age)::int,
                               'waiting', r.waiting, 'blocked', v_blk, 'cancelled', COALESCE(v_ok, false)));
    v_n := v_n + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'checked_at', now(), 'cancelled', v_n);
END;
$fn$;
REVOKE ALL ON FUNCTION public.fn_ca_writer_lock_sentinel(integer) FROM PUBLIC, anon, authenticated;

-- periodic-work: a migration or manual session that queues or holds a writer-blocking lock on a live table must be cancelled within seconds, before engine hand commits time out (incident 2026-10-22 02:34 UTC).
SELECT cron.schedule('ca-writer-lock-sentinel-5s', '5 seconds',
  $job$SELECT public.fn_ca_writer_lock_sentinel(15)$job$);

COMMIT;
