-- 20260927144455_the_rakeback_settler_reads_only_what_every_writer_has_commit.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  THE RAKEBACK SETTLER READS ONLY WHAT EVERY WRITER HAS COMMITTED
-- ===========================================================================
--
-- WHAT WAS WRONG, MEASURED 2026-09-27 (production, read-only)
--
--   Fifty-one positive cash rake_records sit below the rakeback settler's
--   durable cursor (daemon_state.rakeback_settler, 2026-09-27 14:53:53) with
--   no accounting_cash_accrual_batches row, no accounting_cash_rake_sources
--   row, no accounting_cash_source_receipts row and no
--   accounting_cash_source_work row. The settler never submitted them. They
--   were stamped from 2026-09-26 13:38:12 to 2026-09-27 13:18:14, in clusters
--   (13:38, 18:03-18:22, 03:15-03:25, 04:17, 04:46, 05:10, 07:46, ...). Eleven
--   belong to the union's cash tables and forty to a club outside any union;
--   in the same window 75,470 of 75,521 cash rake_records of those two clubs
--   were accrued normally, so the fifty-one are not a class of row the settler
--   refuses. Nothing alerted on the forty: the only signal was the union's
--   certified plan, fn_union_rake_basis_refresh, which since 20260926042119
--   bounds its snapshot by the settler cursor and refused the open union week
--   with union_cash_sources_do_not_match_bank:2 (2026-09-26 21:35), then :11.
--
--   Why the settler never saw them. RakebackSettlerService pages rake_records
--   by the keyset (created_at, id) and saves the last row it read as its
--   cursor. rake_records.created_at defaults to now(), the WRITER'S
--   TRANSACTION START, not its commit. A hand whose transaction starts at T
--   and commits at T+6s is invisible to a page read at T+3s, which can read
--   later-started, already-committed rows and move the cursor past T. When the
--   hand commits, its row is below the cursor and no later page can reach it.
--
--   Proved on one of them. rake_record 4648f9a0 has created_at
--   04:46:01.270691 and xmin 617358720. postgres_logs, 2026-09-27:
--     04:46:02.928  process 2984720 still waiting for ShareLock on
--                   transaction 617358720 after 1000.222 ms
--     04:46:07.379  process 2984720 acquired ShareLock on transaction
--                   617358720 after 5451.954 ms
--   so its writer committed at about 04:46:07.38, six seconds after the
--   instant it is stamped with, during a lock queue in which four more of the
--   stranded rows were written (04:46:01 .. 04:46:05).
--
--   It began when the settler caught up. Until 2026-09-26 13:19 the settler
--   read days behind the head (20260926133201 records the backlog clearing),
--   and nothing commits days late. The first stranded row is stamped
--   2026-09-26 13:38:12, nineteen minutes later.
--
--   What it costs. Those rake_records have no accrued earning source, so the
--   players' rakeback and the agents' commissions on them are not computed,
--   and fn_accounting_union_earned_plan (the certified weekly plan) refuses
--   the whole union week 2026-09-21 .. 2026-09-28.
--
-- WHAT THIS CHANGES
--
--   1. public.fn_rakeback_settler_read_horizon() answers an instant below
--      which every rake_records row that will ever exist is already committed:
--      LEAST(now(), the start of the oldest transaction still open in THIS
--      database) minus a safety margin. A row's created_at is its own
--      transaction's start (the column default now()); no writer stamps it
--      explicitly today (every INSERT INTO rake_records in pg_proc leaves it
--      to the default, and the preimage below refuses if the default
--      changes). So a row stamped below the horizon belongs to a transaction
--      that started before the oldest open one, which has therefore finished:
--      the row is visible now or will never exist. The settler reads
--      created_at < horizon, so its cursor can never pass a row still in
--      flight. Nothing is skipped and nothing is guessed: a long transaction
--      only makes the settler wait for it (the settler runs every 30 minutes).
--
--      The margin (60 seconds). PostgreSQL stamps a transaction's start from
--      the statement start and publishes it in pg_stat_activity inside
--      StartTransaction, a few instructions later. A horizon read in between
--      could not see a transaction whose stamp is already older than now().
--      The margin is many orders of magnitude wider than that gap and costs
--      the settler at most one minute of latency on rows it reads next cycle.
--
--      Only this database. rake_records can be written only by a backend
--      connected to this database, so a transaction open in another database
--      (or a background process with no database) cannot hold a row back and
--      must not hold the settler back either.
--
--      Backends that cannot write a table (autovacuum, WAL, checkpointer,
--      archiver, launchers) are left out. A parallel worker is left out
--      because its leader, a client backend, carries the same transaction
--      start. Two-phase commit would hide a prepared transaction from
--      pg_stat_activity; the preimage refuses to install while
--      max_prepared_transactions is not 0, and the function answers no horizon
--      if it ever finds a prepared transaction. Reading every backend's
--      xact_start needs pg_read_all_stats, which the owner (postgres) holds;
--      the preimage checks it, because without it other roles' xact_start
--      reads as NULL and the horizon would be silently wrong.
--
--      Liveness. A session left idle inside an open transaction holds the
--      horizon at its start for as long as it stays open (postgres has no
--      idle_in_transaction_session_timeout here). The settler then holds, it
--      does not skip. The answer names the backend that holds it, and the
--      detector below raises that as an operational alert after 20 minutes,
--      before fn_settler_lag_check's 45-minute stall incident.
--
--   2. public.fn_rakeback_settler_stranded_source_check() is the net that
--      would have caught all fifty-one. Every positive cash rake_record in the
--      four hours below the settler cursor must have been submitted (the
--      settler saves its cursor only after fn_credit_agent_commissions_batch
--      returned for the page, and that call writes an accrual batch, a source
--      receipt or retry work for every item). One that has none of those was
--      passed over: it is recorded into public.operational_alert_events
--      (source rakeback-settler-stranded-sources, one event per rake_record,
--      payload.target_task_id set), whatever club or union it belongs to.
--      The window is four hours so the check stays an index range (about
--      1.7 s measured on production for four hours of rows) and every row is
--      examined by at least three hourly runs. It writes nothing but the
--      alert: it does not submit, repair or re-drive anything.
--      Scheduled hourly at :28, a minute no other hourly job uses and outside
--      the :50-:03 maintenance window. It is its own job rather than a new
--      section of fn_ca_settlement_correctness_check (the precedent of
--      20260921160000) because that function's live definition no longer
--      matches the one recorded on main (md5 331dfe59... live, dbaa8f09...
--      from 20260927042748), and re-declaring it here would overwrite a
--      change this migration cannot see.
--
-- NOT DONE HERE: the fifty-one rake_records already below the cursor.
-- Submitting them to fn_credit_agent_commissions_batch is a money write
-- (commissions, player stats, period recompute) and is the owner's decision;
-- this change stops the next one and makes any that still happen visible.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preimage$
BEGIN
  IF current_setting('max_prepared_transactions')::int <> 0 THEN
    RAISE EXCEPTION 'HORIZON_PREPARED_TRANSACTIONS: max_prepared_transactions is %, and a prepared transaction is invisible to pg_stat_activity',
      current_setting('max_prepared_transactions');
  END IF;
  IF NOT pg_has_role('postgres', 'pg_read_all_stats', 'member') THEN
    RAISE EXCEPTION 'HORIZON_STATS_UNREADABLE: postgres cannot read every backend''s xact_start';
  END IF;
  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'rake_records' AND column_name = 'created_at')
     IS DISTINCT FROM 'now()' THEN
    RAISE EXCEPTION 'HORIZON_STAMP_CHANGED: rake_records.created_at is no longer the writer''s transaction start';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.daemon_state WHERE daemon = 'rakeback_settler') THEN
    RAISE EXCEPTION 'SETTLER_CURSOR_MISSING: daemon_state has no rakeback_settler row';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'rake_record_id'
         AND table_name IN ('accounting_cash_accrual_batches', 'accounting_cash_rake_sources',
                            'accounting_cash_source_receipts', 'accounting_cash_source_work')) <> 4 THEN
    RAISE EXCEPTION 'STRANDED_CHECK_EVIDENCE_MISSING: a cash source evidence table has no rake_record_id';
  END IF;
  IF to_regprocedure('public.fn_record_operational_alert(text,text,text,text,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'STRANDED_CHECK_INTAKE_MISSING: fn_record_operational_alert is not installed';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rakeback-settler-stranded-source-check-hourly') THEN
    RAISE EXCEPTION 'STRANDED_CHECK_ALREADY_SCHEDULED: the job exists already';
  END IF;
END
$preimage$;

CREATE OR REPLACE FUNCTION public.fn_rakeback_settler_read_horizon()
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  -- Wider than the gap between a transaction's stamp and its appearance in
  -- pg_stat_activity (a few instructions inside StartTransaction).
  c_margin   constant interval := interval '60 seconds';
  v_now      timestamptz := now();
  v_db       oid;
  v_oldest   timestamptz;
  v_pid      integer;
  v_type     text;
  v_state    text;
  v_app      text;
  v_prepared bigint;
BEGIN
  SELECT count(*) INTO v_prepared FROM pg_catalog.pg_prepared_xacts;
  IF v_prepared > 0 THEN
    -- A prepared transaction's rows are invisible and its start is not in
    -- pg_stat_activity. There is no safe instant to name, so name none.
    RETURN jsonb_build_object('horizon', NULL, 'reason', 'prepared_transaction_open',
                              'prepared', v_prepared, 'read_at', v_now);
  END IF;

  SELECT d.oid INTO STRICT v_db FROM pg_catalog.pg_database d
   WHERE d.datname = pg_catalog.current_database();

  SELECT a.xact_start, a.pid, a.backend_type, a.state, a.application_name
    INTO v_oldest, v_pid, v_type, v_state, v_app
    FROM pg_catalog.pg_stat_activity a
   WHERE a.xact_start IS NOT NULL
     AND a.datid = v_db
     AND a.pid <> pg_catalog.pg_backend_pid()
     AND a.backend_type NOT IN ('autovacuum launcher', 'autovacuum worker', 'walsender',
                                'walreceiver', 'walwriter', 'background writer', 'checkpointer',
                                'archiver', 'startup', 'logical replication launcher',
                                'pg_cron launcher', 'parallel worker')
   ORDER BY a.xact_start
   LIMIT 1;

  RETURN jsonb_build_object(
    'horizon', LEAST(v_now, COALESCE(v_oldest, v_now)) - c_margin,
    'margin_seconds', EXTRACT(epoch FROM c_margin),
    'oldest_open_since', v_oldest,
    'oldest_pid', v_pid,
    'oldest_backend_type', v_type,
    'oldest_state', v_state,
    'oldest_application', left(v_app, 64),
    'read_at', v_now);
END
$function$;

COMMENT ON FUNCTION public.fn_rakeback_settler_read_horizon() IS
  'The instant below which every rake_records row is already committed: LEAST(now(), the start of the oldest open transaction in this database) minus a 60 s margin. RakebackSettlerService reads created_at < horizon so its keyset cursor never passes a row whose writer has not committed. Read-only. 20260927144455.';

REVOKE ALL ON FUNCTION public.fn_rakeback_settler_read_horizon() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_rakeback_settler_read_horizon() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rakeback_settler_read_horizon() TO service_role;

CREATE OR REPLACE FUNCTION public.fn_rakeback_settler_stranded_source_check()
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  c_task    constant text := '01a09b86-5ba8-7290-8657-1041f13dd3ca';
  c_source  constant text := 'rakeback-settler-stranded-sources';
  c_window  constant interval := interval '4 hours';
  c_hold    constant interval := interval '20 minutes';
  c_limit   constant integer := 500;
  v_cursor  timestamptz;
  v_from    timestamptz;
  v_found   integer := 0;
  v_horizon jsonb;
  v_held    interval;
  r         record;
BEGIN
  SELECT high_water_mark INTO v_cursor
    FROM public.daemon_state WHERE daemon = 'rakeback_settler';
  IF v_cursor IS NULL THEN
    RETURN jsonb_build_object('checked', false, 'reason', 'no settler cursor yet');
  END IF;
  v_from := v_cursor - c_window;

  -- The settler saves its cursor only after the source batch call returned
  -- for every cash row of the page, and that call leaves an accrual batch, a
  -- source receipt or retry work for each item. A positive cash row below the
  -- cursor with none of them was never submitted.
  FOR r IN
    SELECT rr.id, rr.created_at, rr.club_id
      FROM public.rake_records rr
     WHERE rr.created_at >= v_from
       AND rr.created_at <  v_cursor
       AND rr.rake_amount > 0
       AND NOT COALESCE(rr.is_tournament, false)
       AND rr.tournament_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.accounting_cash_accrual_batches b WHERE b.rake_record_id = rr.id)
       AND NOT EXISTS (SELECT 1 FROM public.accounting_cash_source_receipts s WHERE s.rake_record_id = rr.id)
       AND NOT EXISTS (SELECT 1 FROM public.accounting_cash_source_work w WHERE w.rake_record_id = rr.id)
       AND NOT EXISTS (SELECT 1 FROM public.accounting_cash_rake_sources x WHERE x.rake_record_id = rr.id)
     ORDER BY rr.created_at, rr.id
     LIMIT c_limit
  LOOP
    v_found := v_found + 1;
    PERFORM public.fn_record_operational_alert(
      c_source, r.id::text, 'rakeback_settler_stranded_cash_source', 'firing', 'critical',
      jsonb_build_object(
        'target_task_id', c_task,
        'rake_record_id', r.id,
        'club_id', r.club_id,
        'created_at', r.created_at,
        'settler_cursor', v_cursor,
        'detected_at', clock_timestamp(),
        'detector', 'fn_rakeback_settler_stranded_source_check',
        'meaning', 'positive cash rake_record below the settler cursor with no accrual batch, source receipt, source work or earning source: it was never submitted'));
  END LOOP;

  -- The horizon is held by the oldest open transaction. Say so by name long
  -- before the settler's own stall incident would.
  v_horizon := public.fn_rakeback_settler_read_horizon();
  v_held := (v_horizon->>'read_at')::timestamptz - (v_horizon->>'horizon')::timestamptz;
  IF v_horizon->>'horizon' IS NULL OR v_held > c_hold THEN
    PERFORM public.fn_record_operational_alert(
      'rakeback-settler-read-horizon', 'held:' || COALESCE(v_horizon->>'oldest_pid', 'none') || ':'
        || COALESCE(v_horizon->>'oldest_open_since', v_horizon->>'reason', 'unknown'),
      'rakeback_settler_read_horizon_held', 'firing', 'warning',
      v_horizon || jsonb_build_object('target_task_id', c_task, 'held_for', v_held::text,
        'detector', 'fn_rakeback_settler_stranded_source_check',
        'meaning', 'the rakeback settler cannot read past the oldest open transaction in this database; it holds its cursor until that transaction ends'));
  END IF;

  RETURN jsonb_build_object('checked', true, 'window_from', v_from, 'cursor', v_cursor,
                            'stranded', v_found, 'horizon', v_horizon);
END
$function$;

COMMENT ON FUNCTION public.fn_rakeback_settler_stranded_source_check() IS
  'Records every positive cash rake_record in the 4 hours below the rakeback settler cursor that has no accrual batch, source receipt, source work or earning source (never submitted) into operational_alert_events, and a held read horizon. Writes alerts only. 20260927144455.';

REVOKE ALL ON FUNCTION public.fn_rakeback_settler_stranded_source_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_rakeback_settler_stranded_source_check() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rakeback_settler_stranded_source_check() TO service_role;

-- periodic-work: a read-only net that only records alerts; it pays, submits and repairs nothing, and the fix is the read horizon above
SELECT cron.schedule('rakeback-settler-stranded-source-check-hourly', '28 * * * *',
  $job$SELECT public.fn_rakeback_settler_stranded_source_check();$job$);

DO $post$
DECLARE v jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.fn_rakeback_settler_read_horizon()'::regprocedure
                    AND prosecdef AND provolatile = 'v') THEN
    RAISE EXCEPTION 'HORIZON_POSTIMAGE: fn_rakeback_settler_read_horizon is not installed as a volatile SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', 'public.fn_rakeback_settler_read_horizon()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_rakeback_settler_read_horizon()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_rakeback_settler_stranded_source_check()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_rakeback_settler_stranded_source_check()', 'EXECUTE') THEN
    RAISE EXCEPTION 'HORIZON_GRANTS_WIDENED: a browser role can call a settler horizon function';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_rakeback_settler_read_horizon()', 'EXECUTE') THEN
    RAISE EXCEPTION 'HORIZON_GRANT_MISSING: the engine cannot read the settler horizon';
  END IF;
  IF (SELECT count(*) FROM cron.job
       WHERE jobname = 'rakeback-settler-stranded-source-check-hourly' AND schedule = '28 * * * *') <> 1 THEN
    RAISE EXCEPTION 'STRANDED_CHECK_POSTIMAGE: the hourly check is not scheduled exactly once';
  END IF;
  -- This migration's own transaction is open, so the horizon is at least the
  -- margin before now().
  v := public.fn_rakeback_settler_read_horizon();
  IF (v->>'horizon') IS NULL OR (v->>'horizon')::timestamptz > now() - interval '60 seconds' THEN
    RAISE EXCEPTION 'HORIZON_POSTIMAGE: the horizon % is not at least the margin before now()', v;
  END IF;
END
$post$;

COMMIT;
