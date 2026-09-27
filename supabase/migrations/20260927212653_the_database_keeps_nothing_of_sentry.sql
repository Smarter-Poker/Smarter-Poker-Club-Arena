-- 20260927212653_the_database_keeps_nothing_of_sentry.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  THE DATABASE KEEPS NOTHING OF SENTRY
-- ===========================================================================
--
-- Dan closed and deleted the Sentry account on 2026-09-27 and ordered every
-- trace removed. The engine and both apps stopped sending on 2026-09-15/16
-- (#4718, 397fe26e58) and 20260917000322 moved the telemetry tables into an
-- archive schema. What production still held, read 2026-09-27 21:30 UTC:
--
--   * schema retired_error_telemetry_20260916: the archived error log,
--     event budget and fingerprint tables (0 rows each) and their sequence;
--   * ca_archive.autofix_attempts: the retired Sentry-to-Claude autofix
--     audit (1868 archived rows). Nothing in either repository reads it;
--   * public.signup_errors.forwarded_to_sentry and its partial index
--     signup_errors_pending_forward_idx, and
--     public.signup_errors_archive.forwarded_to_sentry. The only writer, the
--     World Hub /api/cron/sentry-signup-bridge, is gone from World Hub
--     origin/main; the last write was 2026-09-14 13:00 UTC;
--   * public.archive_signup_errors copied that column into the archive. It is
--     recreated byte-identical except that the column leaves both lists
--     (the World Hub archive-signup-errors cron keeps calling it unchanged);
--   * public.orb1_buyin_transaction: a deprecated stub whose only statement
--     is RAISE EXCEPTION; one comment line named Sentry. Only that line
--     changes. It moves no money and never did;
--   * public.fn_ca_stranded_completing_tournaments: one literal in its detail
--     text and its COMMENT named Sentry. Only those words change;
--   * the COMMENT on public.client_crash_log named Sentry.
--
-- Every recreated function is guarded on its exact production pre-image
-- (prosrc md5, owner, ACL, proconfig, SECURITY DEFINER, volatility) and its
-- post-image is asserted, so this refuses to run against a tree nobody read.
-- No cron job, vault secret, trigger, view, policy, pg_net request or edge
-- function mentions Sentry (checked the same day); none needs changing.
--
-- Law: tests/the-database-keeps-nothing-of-sentry.law.test.ts
--
-- @live-proof: to_regnamespace('retired_error_telemetry_20260916') IS NULL
-- @live-proof: to_regclass('ca_archive.autofix_attempts') IS NULL
-- @live-proof: NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid IN ('public.signup_errors'::regclass, 'public.signup_errors_archive'::regclass) AND attname = 'forwarded_to_sentry' AND NOT attisdropped)
-- @live-proof: NOT EXISTS (SELECT 1 FROM pg_proc WHERE prosrc ILIKE '%sentry%')

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
DECLARE
  v_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.orb1_buyin_transaction(uuid,uuid,uuid,numeric,text)'::regprocedure
       AND md5(p.prosrc) = '0ad2f87690f8582a991fc9ed4fd349e5'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{search_path=public}'
       AND NOT p.prosecdef
       AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'PREIMAGE: orb1_buyin_transaction is not the definition read 2026-09-27';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_stranded_completing_tournaments(integer)'::regprocedure
       AND md5(p.prosrc) = '5573dc0a1189f790e2dd0389b52dc4df'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{search_path=public}'
       AND p.prosecdef
       AND p.provolatile = 's') THEN
    RAISE EXCEPTION 'PREIMAGE: fn_ca_stranded_completing_tournaments is not the definition read 2026-09-27';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.archive_signup_errors(integer)'::regprocedure
       AND md5(p.prosrc) = '97dfc291e85719410a9a42e8b2f8571b'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{search_path=public}'
       AND p.prosecdef
       AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'PREIMAGE: archive_signup_errors is not the definition read 2026-09-27';
  END IF;

  -- The archive schema holds exactly the three retired tables, their
  -- sequence and their indexes, and nothing outside it depends on them.
  SELECT count(*) INTO v_count FROM pg_class
   WHERE relnamespace = 'retired_error_telemetry_20260916'::regnamespace;
  IF v_count <> 8
     OR to_regclass('retired_error_telemetry_20260916.sentry_error_log') IS NULL
     OR to_regclass('retired_error_telemetry_20260916.sentry_event_budget') IS NULL
     OR to_regclass('retired_error_telemetry_20260916.sentry_event_fingerprints') IS NULL
     OR to_regclass('retired_error_telemetry_20260916.sentry_error_log_id_seq') IS NULL
     OR EXISTS (SELECT 1 FROM pg_proc
                 WHERE pronamespace = 'retired_error_telemetry_20260916'::regnamespace) THEN
    RAISE EXCEPTION 'PREIMAGE: retired_error_telemetry_20260916 is not the schema read 2026-09-27';
  END IF;
  IF to_regclass('ca_archive.autofix_attempts') IS NULL
     OR EXISTS (SELECT 1 FROM pg_constraint
                 WHERE confrelid = 'ca_archive.autofix_attempts'::regclass) THEN
    RAISE EXCEPTION 'PREIMAGE: ca_archive.autofix_attempts is not the table read 2026-09-27';
  END IF;
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid IN ('public.signup_errors'::regclass, 'public.signup_errors_archive'::regclass)
         AND attname = 'forwarded_to_sentry' AND NOT attisdropped) <> 2
     OR to_regclass('public.signup_errors_pending_forward_idx') IS NULL THEN
    RAISE EXCEPTION 'PREIMAGE: the signup_errors forwarding columns are not the ones read 2026-09-27';
  END IF;
END
$pre$;

-- These relations live outside the schema manifest's scope (public and
-- smarter_private), so scripts/ci/check-migrations-applied.mjs has no name
-- for them. Each is still dropped by name and without CASCADE: anything else
-- depending on them makes this refuse.
DO $drop$
BEGIN
  EXECUTE 'DROP TABLE retired_error_telemetry_20260916.sentry_error_log, '
       || 'retired_error_telemetry_20260916.sentry_event_budget, '
       || 'retired_error_telemetry_20260916.sentry_event_fingerprints';
  EXECUTE 'DROP SCHEMA retired_error_telemetry_20260916';
  EXECUTE 'DROP TABLE ca_archive.autofix_attempts';
END
$drop$;

-- The archival function stops naming the column before the column goes.

CREATE OR REPLACE FUNCTION public.archive_signup_errors(older_than_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    moved_count int := 0;
    cutoff timestamptz := now() - (older_than_days || ' days')::interval;
BEGIN
    -- Idempotent: skip rows we've already archived
    WITH moved AS (
        INSERT INTO public.signup_errors_archive
            (original_id, user_id, email, trigger_name, error_code, error_msg,
             raw_meta, occurred_at)
        SELECT id, user_id, email, trigger_name, error_code, error_msg,
               raw_meta, occurred_at
        FROM public.signup_errors
        WHERE occurred_at < cutoff
          AND NOT EXISTS (
              SELECT 1 FROM public.signup_errors_archive a
              WHERE a.original_id = signup_errors.id
          )
        RETURNING original_id
    )
    DELETE FROM public.signup_errors WHERE id IN (SELECT original_id FROM moved);

    GET DIAGNOSTICS moved_count = ROW_COUNT;

    RETURN jsonb_build_object(
        'moved', moved_count,
        'cutoff', cutoff,
        'older_than_days', older_than_days
    );
END;
$function$;

DROP INDEX public.signup_errors_pending_forward_idx;
ALTER TABLE public.signup_errors DROP COLUMN forwarded_to_sentry;
ALTER TABLE public.signup_errors_archive DROP COLUMN forwarded_to_sentry;

CREATE OR REPLACE FUNCTION public.orb1_buyin_transaction(p_club_id uuid DEFAULT NULL::uuid, p_user_id uuid DEFAULT NULL::uuid, p_table_id uuid DEFAULT NULL::uuid, p_amount numeric DEFAULT 0, p_type text DEFAULT 'buyin'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Walkthrough Round 2 (2026-04-29): this RPC was a phantom that silently
  -- returned success. Caller /api/club-arena/buyin.js has zero clients (the
  -- canonical sit-flow goes direct to atomic_table_buyin from the browser).
  -- Hard-fail so any regression that re-routes traffic here surfaces loudly
  -- as an error instead of silently swallowing a buy-in.
  RAISE EXCEPTION 'orb1_buyin_transaction is deprecated - use atomic_table_buyin (sit) or fn_atomic_buyin (diamond→chip conversion)';
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_stranded_completing_tournaments(p_dwell_minutes integer DEFAULT 15)
 RETURNS TABLE(tournament_id uuid, tournament_name text, club_id uuid, completing_minutes numeric, prize_pool numeric, prize_held numeric, players integer, detail text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT t.id, t.name, t.club_id,
         round((extract(epoch FROM (now() - COALESCE(t.ended_at, t.updated_at))) / 60.0)::numeric, 1),
         round(COALESCE(t.prize_pool, 0), 2),
         round(COALESCE((SELECT e.prize_balance FROM public.tournament_escrow e
                          WHERE e.tournament_id = t.id), 0), 2),
         t.current_players,
         'status COMPLETING for '
           || round((extract(epoch FROM (now() - COALESCE(t.ended_at, t.updated_at))) / 60.0)::numeric, 1)
           || ' minute(s) with NO row in tournament_terminal_settlements. Every one '
           || 'of 15,869 healthy settlements was written in the same transaction '
           || 'that ended the event (settled_at - ended_at = 0.00s at p50, p95, p99 '
           || 'and max), so this event is not slow, it is refused - and the '
           || round(COALESCE((SELECT e.prize_balance FROM public.tournament_escrow e
                              WHERE e.tournament_id = t.id), 0), 2)
           || ' chips in its escrow are paid to nobody until somebody looks. This '
           || 'is the Breakfast Turbo shape, refused for three days with no alert'
    FROM public.tournaments t
   WHERE t.status = 'COMPLETING'
     AND COALESCE(t.ended_at, t.updated_at)
           < now() - make_interval(mins => GREATEST(p_dwell_minutes, 1))
     AND NOT EXISTS (SELECT 1 FROM public.tournament_terminal_settlements s
                      WHERE s.tournament_id = t.id)
   ORDER BY 4 DESC
$function$;

COMMENT ON FUNCTION public.fn_ca_stranded_completing_tournaments(integer) IS
  'A tournament stuck in COMPLETING with no tournament_terminal_settlements row. Measured healthy dwell in COMPLETING is 0.00s across 15,869 settlements (settled_at = completed_at = ended_at in every one), so any visible COMPLETING row has already committed without its settlement. Breakfast Turbo c1f15c30 sat here for three days with a 180.00 prize pool and raised no alert.';
COMMENT ON TABLE public.client_crash_log IS
  'React error-boundary crashes posted from the browser via /api/client-crash. Service-role only.';

REVOKE ALL ON FUNCTION public.orb1_buyin_transaction(uuid,uuid,uuid,numeric,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orb1_buyin_transaction(uuid,uuid,uuid,numeric,text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_stranded_completing_tournaments(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_stranded_completing_tournaments(integer) TO service_role;
REVOKE ALL ON FUNCTION public.archive_signup_errors(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_signup_errors(integer) TO service_role;

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.orb1_buyin_transaction(uuid,uuid,uuid,numeric,text)'::regprocedure
       AND md5(p.prosrc) = 'a6bea96676ecab034f1d0464c01748d3'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{search_path=public}'
       AND NOT p.prosecdef
       AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'POSTIMAGE: orb1_buyin_transaction is not the reviewed definition';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_stranded_completing_tournaments(integer)'::regprocedure
       AND md5(p.prosrc) = 'fcf298b575c81d03249c74c93030bb2f'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{search_path=public}'
       AND p.prosecdef
       AND p.provolatile = 's') THEN
    RAISE EXCEPTION 'POSTIMAGE: fn_ca_stranded_completing_tournaments is not the reviewed definition';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.archive_signup_errors(integer)'::regprocedure
       AND md5(p.prosrc) = '57f561df4f3f3c932bcc1b72982dd308'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{search_path=public}'
       AND p.prosecdef
       AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'POSTIMAGE: archive_signup_errors is not the reviewed definition';
  END IF;
  IF to_regnamespace('retired_error_telemetry_20260916') IS NOT NULL
     OR to_regclass('ca_archive.autofix_attempts') IS NOT NULL
     OR to_regclass('public.signup_errors_pending_forward_idx') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute
                 WHERE attrelid IN ('public.signup_errors'::regclass, 'public.signup_errors_archive'::regclass)
                   AND attname = 'forwarded_to_sentry' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'POSTIMAGE: a retired Sentry relation or column survives';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname ILIKE '%sentry%')
     OR EXISTS (SELECT 1 FROM pg_class WHERE relname ILIKE '%sentry%')
     OR EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
                 WHERE a.attname ILIKE '%sentry%' AND NOT a.attisdropped
                   AND c.relkind IN ('r','p','v','m','f'))
     OR EXISTS (SELECT 1 FROM pg_proc WHERE proname ILIKE '%sentry%' OR prosrc ILIKE '%sentry%')
     OR EXISTS (SELECT 1 FROM pg_description WHERE description ILIKE '%sentry%') THEN
    RAISE EXCEPTION 'POSTIMAGE: the database still names Sentry';
  END IF;
END
$post$;

COMMIT;
