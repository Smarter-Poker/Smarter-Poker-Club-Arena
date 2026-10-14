-- 20260928155739_engine_break_recoveries_follow_their_fault.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ENGINE BREAK RECOVERIES FOLLOW THEIR FAULT.
--
-- WHY. The hourly break scorecard (pg_cron job ca-break-scorecard at :12,
-- which calls fn_ca_record_break_scorecard() with no argument) sends
-- engine_break_failed to every active incident recipient when an hour's break
-- fails, through fn_ca_break_scorecard_push. When a later hour passes it sends
-- nothing: the recorder's only notification branch is IF v_verdict = 'fail'.
-- For the owner account each of those notices is captured for the Production
-- Alerts task (20260916111614) as a firing receipt in operational_alert_events,
-- and a receipt is recorded resolved only for a recovery (a type ending in
-- _recovered; the classifier already routes engine_break_recovered). None was
-- ever sent. Read from production 2026-09-28, read-only: 34 engine_break_failed
-- receipts (source owner-operational-notifications, ids 39201-88376), all
-- firing, 0 engine_break_recovered notifications anywhere, the last fault the
-- 2026-09-18 19:00 break, and all 168 hours of the last seven days passed.
--
-- WHAT CHANGES.
--   1. fn_ca_break_scorecard_recovered (NEW). A recovery is owed to a fault
--      NOTICE, not to a verdict history, so no re-score can hide one: every
--      engine_break_failed notice sent on or after 2026-09-28 00:00 UTC, for
--      an earlier hour than the pass, that no recovery on its route names yet.
--      Per route (the recipient the fault was delivered to: a personal inbox,
--      or for the owner account the Production Alerts task, where the capture
--      records the receipt resolved) it sends ONE engine_break_recovered, key
--      'break-recovered:<UTC hour>', data.resolves = the fault keys,
--      data.resolves_notification_ids = their notices (the owner account's
--      firing receipts' event keys). For the owner account only a resolved
--      receipt addressed to the task recovers a fault: a recovery in his
--      personal inbox does not, and one the classifier would not file with the
--      task is not written at all. The 34 notices sent before 2026-09-28 stay
--      with the Production Alerts task. It acts only on a pass the scorecard
--      recorded, and no role but its owner may call it.
--   2. fn_ca_record_break_scorecard is production's body (md5 0d9eb4d6 below)
--      with four changes. ELSIF v_verdict = 'pass' AND p_end IS NULL calls the
--      recovery: the hourly job is the only caller that passes no p_end, and
--      an explicit re-score never sends one. The call sits in its own
--      exception handler and the pass row keeps the account in
--      detail->'recovery' (a re-score keeps it). Every error on the recovery
--      path is caught, and every lock wait on it gives up after 5 s
--      (lock_timeout, 55P03, caught), long before the hourly job's statement
--      timeout (2 min for its role). A timeout or cancel of the whole call
--      (57014, which no handler catches) can still lose the hour, exactly as
--      it could before; the recovery path no longer provokes one. And the
--      recorder runs in UTC (SET TimeZone), so the push it calls keys every
--      fault in UTC whatever the caller's session. The verdict CASE is
--      byte-for-byte unchanged; tests/the-break-clocks-agree.law.test.ts reads
--      it from this file now.
--   3. INVARIANT. When a live pass commits, every owned fault notice of an
--      earlier hour is accounted for in the same transaction: named by a
--      recovery on its route (for the owner account, a resolved receipt
--      addressed to the task), or listed in the pass row's account with the
--      reason it is still open (not sent, delivery error, discarded, receipt
--      not recorded, reached the owner account's personal inbox) and held by
--      ONE firing NotifiedFaultWithoutRecovery for the task.
--   4. DETECTION, twice. In the same transaction, that firing record (source
--      break-scorecard-recovery-guard, warning, payload.target_task_id
--      01a09b86-5ba8-7290-8657-1041f13dd3ca, the open faults and why); once
--      nothing is open it gets its recovery, on the same key. And independently
--      of this code, scripts/ci/check-engine-break-recoveries.mjs, after each
--      hourly Production Integrity Audit (no new schedule, CLAUDE.md 10.85 and
--      10.12), reads production for an owned fault the task still sees open
--      after a later pass of the hourly job - a pass recorded during a run
--      pg_cron logged as succeeded for the job calling the recorder - and
--      records its own NotifiedFaultWithoutRecovery (and its recovery). It
--      also sees what this code cannot: a recorder replaced without the
--      branch, a job passing p_end or scoring an earlier hour, a store that
--      refused the record. The classifier is held to keep
--      engine_break_recovered by the held classifier change's own law
--      (tests/the-owner-classifier-keeps-its-operational-kinds.law.test.ts,
--      20260928171444); if it ever stops, nothing reaches his inbox and both
--      readers report the fault.
--
-- WHAT DOES NOT CHANGE. fn_ca_break_scorecard_push: 20260927235053 pins it in
-- its @live-proof and the held cleanup 20260928000622 re-checks it, so it is
-- read, never replaced (it keys in UTC because its caller now does). The
-- verdict and every measurement; every table, policy and schedule. No existing
-- row is touched, and the 34 firing receipts stay with the task.
--
-- ORDER. 20260927235053 (store-only delivery), then the held cleanup
-- 20260928000622, then this, outside :50-:03 UTC (the database refuses DDL in
-- that window). This refuses to install unless store-only delivery is
-- installed COMPLETELY - every @live-proof expression of 20260927235053,
-- re-checked verbatim, as 20260928000622 does - because before it a recovery
-- addressed to the owner account would be written into his personal inbox. It
-- also refuses unless the classifier routes engine_break_recovered for the
-- owner account and for no other account, the recorder is production's (md5,
-- owner, ACL, settings), no function by the new name exists, and an active
-- pg_cron job calls the recorder with no argument (the live path). The cleanup
-- touches none of these objects. One transaction, one PostgREST schema reload
-- (~28 s). The install proves itself in rolled-back subtransactions.
--
-- ROLLBACK. A new migration restores the recorder's pre-image (md5
-- 0d9eb4d63244cfc69879f87596439c99, the body of 20260910132747) and drops
-- fn_ca_break_scorecard_recovered.
--
-- Regression proof: scripts/dev/probe-engine-break-recovery.sh (red before,
-- green after, a throwaway UTF8 PostgreSQL built from pinned production state;
-- it then applies every later migration that names the recorder, the push or
-- the recovery outside a comment, and proves the recovery still follows),
-- run by .github/workflows/engine-break-recovery.yml on every pull request
-- that changes a migration naming any of them, in any case. The newest
-- definition of each is held to this contract by
-- tests/a-break-recovery-follows-its-fault.law.test.ts. What no reader of the
-- text can see - a migration that builds one of those names at run time -
-- the hourly audit sees in production at the next pass.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_record_break_scorecard(timestamp with time zone)'::regprocedure))='2d4be3ca3149d4ee69adc7286ed9a82c')
-- @live-proof: (SELECT coalesce(md5(pg_get_functiondef(to_regprocedure('public.fn_ca_break_scorecard_recovered(public.ca_break_scorecards)')))='d5079242515f836f8d07b7f7158c77f0', false))
-- @live-proof: (SELECT coalesce(NOT has_function_privilege('service_role', to_regprocedure('public.fn_ca_break_scorecard_recovered(public.ca_break_scorecards)'), 'EXECUTE'), false))

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';
-- The hourly job runs in UTC and every key is rendered in UTC; the install
-- proof below runs in UTC too, whatever the installer's session says.
SET LOCAL TimeZone = 'UTC';

DO $guard$
DECLARE
  v_missing text[] := '{}';
  v_src text; v_acl aclitem[]; v_owner oid; v_config text[]; v_secdef boolean;
BEGIN
  -- Store-only delivery must be installed completely. Each condition is one of
  -- 20260927235053's @live-proof expressions, verbatim.
  IF (SELECT md5(pg_get_functiondef('public.fn_capture_owner_notification_destination()'::regprocedure))='32a9105ef11b28dceac0fce11d71148f') IS NOT TRUE THEN
    v_missing := v_missing || 'capture'::text;
  END IF;
  IF (SELECT md5(pg_get_functiondef('public.fn_ca_break_scorecard_push(public.ca_break_scorecards)'::regprocedure))='1c240cddb84994e906a4eb09d7ca3323') IS NOT TRUE THEN
    v_missing := v_missing || 'break scorecard reader'::text;
  END IF;
  IF (SELECT md5(pg_get_functiondef('public.fn_notify_guarantee_bank_short(uuid)'::regprocedure))='71d3444dfb4ed7906cfefe5267de5b81') IS NOT TRUE THEN
    v_missing := v_missing || 'guarantee bank reader'::text;
  END IF;
  IF (SELECT md5(pg_get_functiondef('public.fn_ca_alarm_drill()'::regprocedure))='8bd6f37a4038209adaec7e2bbbdfd5e9') IS NOT TRUE THEN
    v_missing := v_missing || 'alarm drill reader'::text;
  END IF;
  IF (SELECT count(*)=1 FROM pg_trigger t WHERE t.tgrelid='public.notifications'::regclass AND t.tgname='zz_capture_owner_notification_destination' AND t.tgenabled='O' AND t.tgtype=7 AND t.tgqual IS NULL AND t.tgfoid='public.fn_capture_owner_notification_destination()'::regprocedure) IS NOT TRUE THEN
    v_missing := v_missing || 'capture trigger'::text;
  END IF;
  IF (SELECT count(*)=1 FROM pg_trigger t WHERE t.tgrelid='public.notifications'::regclass AND t.tgname='zz_authorize_owner_operational_original' AND t.tgenabled='O' AND md5(pg_get_triggerdef(t.oid))='7f4ecd63db81d72271f9e25c09a8e69d' AND md5(pg_get_functiondef(t.tgfoid))='7777ab6e22847595881843ebfacdcaad') IS NOT TRUE THEN
    v_missing := v_missing || 'authority trigger'::text;
  END IF;
  IF (SELECT count(*)=1 FROM pg_trigger t WHERE t.tgrelid='public.notifications'::regclass AND t.tgname='zz_owner_operational_original_reached_personal_inbox' AND t.tgenabled='O' AND md5(pg_get_triggerdef(t.oid))='2d1ee8300c484364c83db0496360b897' AND md5(pg_get_functiondef(t.tgfoid))='d648da8eb87a98e8074e91c8aca7c660') IS NOT TRUE THEN
    v_missing := v_missing || 'detector trigger'::text;
  END IF;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'ENGINE_BREAK_RECOVERY_NEEDS_STORE_ONLY_DELIVERY: % missing',
      array_to_string(v_missing, ', ') USING ERRCODE = '55000';
  END IF;

  -- The owner account's recovery is operational, so the capture routes it to
  -- the task and records its receipt resolved; nobody else's is.
  IF public.fn_is_owner_operational_notification('47965354-0e56-43ef-931c-ddaab82af765'::uuid,
       'engine_break_recovered', 'Engine Break Recovered', '{}'::jsonb) IS NOT TRUE
    OR public.fn_is_owner_operational_notification(gen_random_uuid(),
       'engine_break_recovered', 'Engine Break Recovered', '{}'::jsonb) IS NOT FALSE THEN
    RAISE EXCEPTION 'ENGINE_BREAK_RECOVERY_NOT_ROUTED_TO_THE_TASK' USING ERRCODE = '55000';
  END IF;

  -- The recorder is replaced in full below, so it must be exactly the one
  -- production runs (20260910132747's body).
  SELECT pg_get_functiondef(p.oid), p.proacl, p.proowner, p.proconfig, p.prosecdef
    INTO v_src, v_acl, v_owner, v_config, v_secdef
    FROM pg_proc p WHERE p.oid = 'public.fn_ca_record_break_scorecard(timestamp with time zone)'::regprocedure;
  IF md5(v_src) IS DISTINCT FROM '0d9eb4d63244cfc69879f87596439c99'
    OR v_acl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
    OR v_owner IS DISTINCT FROM 'postgres'::regrole::oid
    OR v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
    OR v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'BREAK_SCORECARD_RECORDER_SOURCE_OR_AUTHORITY_CHANGED' USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('public.fn_ca_break_scorecard_recovered(public.ca_break_scorecards)') IS NOT NULL THEN
    RAISE EXCEPTION 'BREAK_SCORECARD_RECOVERY_ALREADY_EXISTS' USING ERRCODE = '55000';
  END IF;

  -- The live path: a recovery is sent only when the recorder is called with
  -- no p_end, which is what the hourly job does.
  IF to_regclass('cron.job') IS NULL OR NOT EXISTS (
       SELECT 1 FROM cron.job j
        WHERE j.active
          AND j.command ~* '^\s*select\s+public\.fn_ca_record_break_scorecard\s*\(\s*\)\s*;?\s*$') THEN
    RAISE EXCEPTION 'BREAK_SCORECARD_HOURLY_JOB_NOT_THE_LIVE_PATH' USING ERRCODE = '55000';
  END IF;
END;
$guard$;

-- ===========================================================================
-- 1. THE RECOVERY
-- ===========================================================================
CREATE FUNCTION public.fn_ca_break_scorecard_recovered(p_row public.ca_break_scorecards)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET lock_timeout TO '5s'
AS $function$
DECLARE
  c_task  CONSTANT TEXT := '01a09b86-5ba8-7290-8657-1041f13dd3ca';
  -- The owner account. Its route is the Production Alerts task, never his
  -- personal inbox (store-only delivery, 20260927235053): only a resolved
  -- receipt addressed to the task recovers one of his faults.
  c_owner CONSTANT UUID := '47965354-0e56-43ef-931c-ddaab82af765';
  c_guard CONSTANT TEXT := 'break-scorecard-recovery-guard';
  c_alert CONSTANT TEXT := 'NotifiedFaultWithoutRecovery';
  -- OWNERSHIP. Every engine_break_failed notice sent from this instant on is
  -- followed by its recovery, however its hour was scored or re-scored: the
  -- notice is what is owed a recovery, not the verdict history. The 34
  -- notices production held when this was written (the last sent on
  -- 2026-09-18 at 19:12 UTC) stay with the Production Alerts task.
  -- scripts/ci/check-engine-break-recoveries.mjs holds the same instant.
  c_owned_from CONSTANT TIMESTAMPTZ := '2026-09-28 00:00:00+00';
  -- 'break-failed:<UTC hour>', the key fn_ca_break_scorecard_push writes.
  c_shape CONSTANT TEXT := '^break-failed:[0-9]{8}T[0-9]{4}$';
  -- This pass's hour in UTC, the zone every fault key is written in.
  v_hour TEXT := to_char(p_row.break_ended_at AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MI');
  v_key  TEXT := 'break-recovered:' || to_char(p_row.break_ended_at AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MI');
  v_route_key TEXT; v_when TEXT; v_n INTEGER; v_data JSONB;
  v_written INTEGER := 0;
  -- route -> why its recovery could not be delivered by this pass
  v_failed JSONB := '{}';
  v_open JSONB := '[]';
  v_error TEXT; v_record_error TEXT; v_recorded TEXT;
  v_prev_key TEXT; v_prev_status TEXT; v_prev_closed BOOLEAN;
  r RECORD;
BEGIN
  -- Only a pass the scorecard recorded ends an episode: a row a caller made up
  -- closes nothing.
  IF NOT EXISTS (SELECT 1 FROM public.ca_break_scorecards s
                  WHERE s.break_ended_at = p_row.break_ended_at AND s.verdict = 'pass') THEN
    RAISE EXCEPTION 'fn_ca_break_scorecard_recovered takes a pass the scorecard recorded; % is not one',
      p_row.break_ended_at USING ERRCODE = '22023';
  END IF;

  -- 1. SEND. Per route (the recipient each fault was delivered to: a personal
  -- inbox, or for the owner account the Production Alerts task), ONE recovery
  -- naming every owned fault of an earlier hour that no recovery on that
  -- route names yet. It is written the way the push writes a fault. A
  -- delivery error rolls back that route's recovery only, never the pass: the
  -- fault stays open, and 2 records why. Every lock wait here gives up after
  -- lock_timeout (above) with 55P03, which the handlers catch, long before the
  -- hourly job's statement timeout could cancel the whole call.
  BEGIN
    FOR r IN
      SELECT f.route,
             array_agg(DISTINCT f.fault_key ORDER BY f.fault_key) AS keys,
             array_agg(DISTINCT f.notification_id ORDER BY f.notification_id) AS ids
        FROM (SELECT n.user_id AS route, n.id AS notification_id, n.data->>'key' AS fault_key
                FROM public.notifications n
               WHERE n.type = 'engine_break_failed' AND n.created_at >= c_owned_from
              UNION
              SELECT d.recipient_user_id, d.notification_id, d.original_notification->'data'->>'key'
                FROM public.operational_notification_destinations d
               WHERE d.original_notification->>'type' = 'engine_break_failed'
                 AND d.captured_at >= c_owned_from) f
       WHERE f.fault_key ~ c_shape
         AND substr(f.fault_key, 14) < v_hour
         AND NOT EXISTS (SELECT 1 FROM public.notifications x
                          WHERE x.type = 'engine_break_recovered' AND x.user_id = f.route
                            AND x.data->'resolves' ? f.fault_key)
         AND NOT EXISTS (SELECT 1 FROM public.operational_notification_destinations x
                          WHERE x.original_notification->>'type' = 'engine_break_recovered'
                            AND x.recipient_user_id = f.route
                            AND x.original_notification->'data'->'resolves' ? f.fault_key)
       GROUP BY f.route
       ORDER BY f.route
    LOOP
      -- One key per route and hour. A second recovery in the same hour (for
      -- a fault notified since the first) is numbered, never a duplicate.
      SELECT count(*) INTO v_n
        FROM (SELECT 1 FROM public.notifications x
               WHERE x.type = 'engine_break_recovered' AND x.user_id = r.route
                 AND (x.data->>'key' = v_key OR x.data->>'key' LIKE v_key || ':%')
              UNION ALL
              SELECT 1 FROM public.operational_notification_destinations x
               WHERE x.original_notification->>'type' = 'engine_break_recovered'
                 AND x.recipient_user_id = r.route
                 AND (x.original_notification->'data'->>'key' = v_key
                      OR x.original_notification->'data'->>'key' LIKE v_key || ':%')) y;
      v_route_key := CASE WHEN v_n = 0 THEN v_key ELSE v_key || ':' || (v_n + 1) END;
      -- The failed hours, read from the keys themselves.
      SELECT string_agg(substr(k, 14, 4) || '-' || substr(k, 18, 2) || '-' || substr(k, 20, 2)
                        || ' ' || substr(k, 23, 2) || ':' || substr(k, 25, 2), ', ' ORDER BY k)
        INTO v_when FROM unnest(r.keys) AS k;
      v_data := jsonb_build_object('key', v_route_key,
                                   'break_ended_at', p_row.break_ended_at,
                                   'resolves', to_jsonb(r.keys),
                                   'resolves_notification_ids', to_jsonb(r.ids));
      -- The owner account's recovery is written only when the classifier files
      -- it with the task. Otherwise it would land in his personal inbox and on
      -- his phone; it is not written, and 2 records why.
      IF r.route = c_owner
         AND public.fn_is_owner_operational_notification(r.route, 'engine_break_recovered',
               'Engine Break Recovered', v_data) IS NOT TRUE THEN
        v_failed := v_failed || jsonb_build_object(r.route::text,
                      'not sent: the classifier does not file engine_break_recovered with the task for the owner account');
        CONTINUE;
      END IF;
      BEGIN
        -- For the owner account the capture delivers this to the Production
        -- Alerts task only and records its receipt 'resolved' (the type ends
        -- in _recovered).
        INSERT INTO public.notifications (user_id, type, title, message, data)
        VALUES (r.route, 'engine_break_recovered', 'Engine Break Recovered',
                left('Maintenance Break At ' || to_char(p_row.break_ended_at AT TIME ZONE 'UTC', 'HH24:MI')
                     || ' Passed. It Resolves ' || cardinality(r.keys)
                     || CASE WHEN cardinality(r.keys) = 1 THEN ' Earlier Failed Break: '
                             ELSE ' Earlier Failed Breaks: ' END
                     || v_when || '.', 500),
                v_data);
        v_written := v_written + 1;
      EXCEPTION WHEN OTHERS THEN
        v_failed := v_failed || jsonb_build_object(r.route::text,
                      'delivery failed: ' || SQLSTATE || ': ' || left(SQLERRM, 300));
      END;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLSTATE || ': ' || left(SQLERRM, 300);
  END;

  -- 2. ACCOUNT AND RECORD. What the task can see after this pass: every owned
  -- fault of an earlier hour still open on its route - for the owner account,
  -- without a resolved receipt addressed to the task naming it (a recovery in
  -- his personal inbox is NOT one); for anyone else, without a recovery in
  -- their inbox naming it - and why. While any is open the task holds ONE
  -- firing NotifiedFaultWithoutRecovery (the same identity until it recovers
  -- or the task closes it); once none is, that record gets its recovery, on
  -- the same key. This records; it never repairs, retries or deletes.
  BEGIN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'route', o.route, 'unresolved', to_jsonb(o.keys),
             'why', COALESCE(v_failed->>(o.route::text),
                             'recovery not sent: ' || v_error,
                             o.why)) ORDER BY o.route), '[]'::jsonb)
      INTO v_open
      FROM (SELECT f.route,
                   array_agg(DISTINCT f.fault_key ORDER BY f.fault_key) AS keys,
                   CASE WHEN f.route = c_owner AND bool_or(f.in_inbox)
                        THEN 'its recovery reached the owner account''s personal inbox, not the task'
                        WHEN bool_or(f.at_task)
                        THEN 'its recovery reached the task''s destination but no resolved receipt was recorded'
                        ELSE 'the recovery written for this route reached neither notifications nor operational_notification_destinations'
                   END AS why
              FROM (SELECT f0.route, f0.fault_key,
                           EXISTS (SELECT 1 FROM public.notifications x
                                    WHERE x.type = 'engine_break_recovered' AND x.user_id = f0.route
                                      AND x.data->'resolves' ? f0.fault_key) AS in_inbox,
                           EXISTS (SELECT 1 FROM public.operational_notification_destinations x
                                    WHERE x.original_notification->>'type' = 'engine_break_recovered'
                                      AND x.recipient_user_id = f0.route
                                      AND x.original_notification->'data'->'resolves' ? f0.fault_key) AS at_task
                      FROM (SELECT n.user_id AS route, n.data->>'key' AS fault_key
                              FROM public.notifications n
                             WHERE n.type = 'engine_break_failed' AND n.created_at >= c_owned_from
                            UNION
                            SELECT d.recipient_user_id, d.original_notification->'data'->>'key'
                              FROM public.operational_notification_destinations d
                             WHERE d.original_notification->>'type' = 'engine_break_failed'
                               AND d.captured_at >= c_owned_from) f0
                     WHERE f0.fault_key ~ c_shape
                       AND substr(f0.fault_key, 14) < v_hour
                       AND NOT CASE WHEN f0.route = c_owner
                         THEN EXISTS (SELECT 1 FROM public.operational_notification_destinations x
                                        JOIN public.operational_alert_events e ON e.id = x.inbox_event_id
                                       WHERE x.original_notification->>'type' = 'engine_break_recovered'
                                         AND x.recipient_user_id = f0.route
                                         AND x.original_notification->'data'->'resolves' ? f0.fault_key
                                         AND e.status = 'resolved'
                                         AND e.payload->>'target_task_id' = c_task)
                         ELSE EXISTS (SELECT 1 FROM public.notifications x
                                       WHERE x.type = 'engine_break_recovered' AND x.user_id = f0.route
                                         AND x.data->'resolves' ? f0.fault_key) END) f
             GROUP BY f.route) o;

    SELECT e.event_key, e.status, e.investigation_status IN ('verified_fixed', 'historical')
      INTO v_prev_key, v_prev_status, v_prev_closed
      FROM public.operational_alert_events e
     WHERE e.source = c_guard AND e.alertname = c_alert
     ORDER BY e.last_received_at DESC, e.id DESC
     LIMIT 1;
    IF jsonb_array_length(v_open) > 0 THEN
      v_recorded := CASE WHEN v_prev_status = 'firing' AND NOT v_prev_closed THEN v_prev_key
                         ELSE 'open:' || v_hour || ':' || left(replace(gen_random_uuid()::text, '-', ''), 12) END;
      PERFORM public.fn_record_operational_alert(c_guard, v_recorded, c_alert, 'firing', 'warning',
        jsonb_build_object('target_task_id', c_task, 'break_ended_at', p_row.break_ended_at,
                           'recovery_key', v_key, 'open', v_open));
      IF NOT EXISTS (SELECT 1 FROM public.operational_alert_events e
                      WHERE e.source = c_guard AND e.event_key = v_recorded
                        AND e.payload->>'target_task_id' = c_task) THEN
        v_record_error := 'the store did not keep ' || v_recorded;
      END IF;
      v_recorded := 'firing:' || v_recorded;
    ELSIF v_prev_status = 'firing' AND NOT v_prev_closed THEN
      PERFORM public.fn_record_operational_alert(c_guard, v_prev_key || ':resolved', c_alert, 'resolved', 'info',
        jsonb_build_object('target_task_id', c_task, 'resolves', v_prev_key,
                           'break_ended_at', p_row.break_ended_at));
      IF NOT EXISTS (SELECT 1 FROM public.operational_alert_events e
                      WHERE e.source = c_guard AND e.event_key = v_prev_key || ':resolved'
                        AND e.payload->>'target_task_id' = c_task) THEN
        v_record_error := 'the store did not keep ' || v_prev_key || ':resolved';
      END IF;
      v_recorded := 'resolved:' || v_prev_key;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_record_error := SQLSTATE || ': ' || left(SQLERRM, 300);
  END;
  -- What this cannot record: the task's own store refusing the record. The
  -- pass row keeps this account in detail->'recovery', and the hourly audit
  -- (scripts/ci/check-engine-break-recoveries.mjs) reports the open faults
  -- through its own connection.
  IF v_record_error IS NOT NULL THEN
    RAISE WARNING 'engine break recovery at %: % route(s) with open faults not recorded for the task (%)',
      p_row.break_ended_at, jsonb_array_length(v_open), v_record_error;
  END IF;
  RETURN jsonb_build_object('key', v_key, 'written', v_written, 'open', v_open, 'recorded', v_recorded,
                            'error', v_error, 'record_error', v_record_error);
END $function$;

-- Called only by the recorder, which runs as its owner (postgres). No other
-- role may call it: not a browser role, and not service_role, which can
-- still re-score an hour through the recorder. PUBLIC is named as well,
-- because anon and authenticated inherit EXECUTE from it.
REVOKE ALL ON FUNCTION public.fn_ca_break_scorecard_recovered(public.ca_break_scorecards)
  FROM PUBLIC, anon, authenticated, service_role;

-- ===========================================================================
-- 2. THE RECORDER: production's body and four changes
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.fn_ca_record_break_scorecard(p_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS ca_break_scorecards
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
  v_end   TIMESTAMPTZ := COALESCE(p_end, date_trunc('hour', now()));
  v_start TIMESTAMPTZ := v_end - interval '5 minutes';
  -- The window actually measured. Equal to [v_start, v_end) only when no
  -- break log row can be found.
  v_meas_start TIMESTAMPTZ;
  v_meas_end   TIMESTAMPTZ;
  v_brk   RECORD;
  v_hands INTEGER; v_wtabs INTEGER;
  v_thaw  RECORD; v_kill INTEGER; v_base INTEGER; v_rec INTEGER;
  v_ship  RECORD; v_pre NUMERIC; v_post NUMERIC; v_conserved BOOLEAN; v_delta NUMERIC;
  v_verdict TEXT; v_row public.ca_break_scorecards; m INTEGER;
  v_early_s NUMERIC; v_late_start_s NUMERIC; v_covered BOOLEAN; v_reasons TEXT[] := '{}';
  -- A break that never started, and what the engine said about it. Scalars
  -- rather than a RECORD on purpose: a record that is only ever SELECTed INTO
  -- inside an IF is "not assigned yet" on every hour that takes the other
  -- branch, and the INSERT below reads these on every hour.
  v_never_started BOOLEAN;
  v_fault_stage TEXT; v_fault_outcome TEXT; v_fault_error TEXT;
  -- The tables recovery is measured over: dealing before the break, still open.
  v_base_ids UUID[];
  -- What the hourly job's pass did about the faults notified before it
  -- (20260928155739): kept in this row's detail as 'recovery'.
  v_recovery JSONB;
  c_max_hands CONSTANT INTEGER := 50;
  -- How far the break may miss its :55 -> :00 shape before that is a finding.
  -- The observed healthy breaks start at :55:0x and end at :00:0x-:00:20, so a
  -- 30-second allowance is generous against measured behaviour and still
  -- catches the 71-second early resume that prompted this.
  c_edge_tolerance_s CONSTANT NUMERIC := 30;
BEGIN
  -- THE BREAK THAT ACTUALLY RAN. Read first, because it defines the window
  -- everything else is measured over.
  SELECT break_started_at, break_ended_at, unparked_at_countdown, peak_unparked,
         ready_for_restart_at
    INTO v_brk
    FROM public.engine_maintenance_break_log
   WHERE break_started_at BETWEEN v_start - interval '3 min' AND v_start + interval '3 min'
   ORDER BY recorded_at DESC LIMIT 1;

  IF v_brk.break_started_at IS NOT NULL AND v_brk.break_ended_at IS NOT NULL THEN
    v_meas_start := v_brk.break_started_at;
    v_meas_end   := v_brk.break_ended_at;
    -- Seconds the break finished BEFORE the hour it was counting down to.
    v_early_s := GREATEST(0, EXTRACT(EPOCH FROM (v_end - v_brk.break_ended_at)));
    -- Seconds the break started AFTER :55.
    v_late_start_s := GREATEST(0, EXTRACT(EPOCH FROM (v_brk.break_started_at - v_start)));
    v_covered := (v_early_s <= c_edge_tolerance_s AND v_late_start_s <= c_edge_tolerance_s);
  ELSE
    v_meas_start := v_start;
    v_meas_end   := v_end;
    v_covered := NULL;  -- unknown, not false: we could not find the break
  END IF;

  -- A BREAK THAT NEVER STARTED (correction c). No break-log row means no
  -- engine ran a break for this hour. The engine records why against the :53
  -- announcement, which is v_start - 2 min; [:52, :55] tolerates a clock a
  -- minute out either side. The newest fault wins, because a restarted engine
  -- that also fails to declare the break adds its row after the first one's.
  v_never_started := (v_brk.break_started_at IS NULL);
  IF v_never_started THEN
    SELECT f.stage, f.outcome, f.error
      INTO v_fault_stage, v_fault_outcome, v_fault_error
      FROM public.engine_maintenance_break_faults f
     WHERE f.announced_at BETWEEN v_start - interval '3 min' AND v_start
     ORDER BY f.recorded_at DESC
     LIMIT 1;
  END IF;

  SELECT count(*), count(DISTINCT table_id) INTO v_hands, v_wtabs
    FROM public.hand_history
   WHERE created_at >= v_meas_start AND created_at < v_meas_end;

  SELECT frozen_seconds, thawed_at INTO v_thaw
    FROM public.engine_maintenance_thaws
   WHERE freeze_started_at BETWEEN v_start - interval '3 min' AND v_start + interval '3 min'
   ORDER BY thawed_at DESC LIMIT 1;

  SELECT count(*) INTO v_kill FROM public.engine_recovery_events
   WHERE event = 'watchdog_kill_rebuild'
     AND event_class = 'automatic_recovery'
     AND created_at >= v_end AND created_at < v_end + interval '5 min';

  -- RECOVERY, OVER THE TABLES THAT CAN COME BACK (correction d). The base is
  -- every table that dealt at :48-:53 and is still open; a tournament table
  -- that finished during the break is closed and will never deal again, and
  -- counting it made every hour with a tournament ending read as a slow
  -- recovery. Recovery is the first minute by which 80% of THOSE SAME tables
  -- have dealt a hand after :00. NULL when there was nothing to measure or
  -- the fleet never got there inside ten minutes: unmeasured, not failed.
  SELECT array_agg(DISTINCT h.table_id) INTO v_base_ids
    FROM public.hand_history h
    JOIN public.tables t ON t.id = h.table_id
   WHERE h.created_at >= v_end - interval '12 min'
     AND h.created_at <  v_end - interval '7 min'
     AND t.status <> 'closed';
  v_base := COALESCE(cardinality(v_base_ids), 0);
  v_rec := NULL;
  IF v_base > 0 THEN
    FOR m IN 1..10 LOOP
      IF (SELECT count(DISTINCT h.table_id) FROM public.hand_history h
            WHERE h.table_id = ANY (v_base_ids)
              AND h.created_at >= v_end
              AND h.created_at <  v_end + make_interval(mins => m)) >= ceil(v_base * 0.8) THEN
        v_rec := m * 60; EXIT;
      END IF;
    END LOOP;
  END IF;

  -- THE ATTEMPT THAT SHIPPED, IF ONE DID (correction a). A later no-op in the
  -- same window ("coalesced or already serving this commit") is newer, and
  -- the newest used to win.
  SELECT target_sha, shipped INTO v_ship FROM public.ca_engine_deploy_attempts
   WHERE at >= v_start AND at < v_end + interval '6 min'
   ORDER BY shipped DESC, at DESC LIMIT 1;

  SELECT total INTO v_pre  FROM public.ca_freeze_circulation_marks WHERE window_hour = v_end AND kind='pre';
  SELECT total INTO v_post FROM public.ca_freeze_circulation_marks WHERE window_hour = v_end AND kind='post';
  IF v_pre IS NOT NULL AND v_post IS NOT NULL THEN
    v_delta := v_post - v_pre;
    v_conserved := (abs(v_delta) <= GREATEST(1.0, COALESCE(v_pre, 0) * 1e-7));
  ELSE v_delta := NULL; v_conserved := NULL; END IF;

  -- ── EACH FAILURE UNDER ITS OWN NAME, FOR THE MESSAGE ────────────────────
  -- Collected separately from the verdict below, whose single-CASE shape
  -- tests/the-break-clocks-agree.law.test.ts pins.
  -- array_append()/array_prepend(), never `||`: with an untyped literal on the
  -- right, `||` on a TEXT[] resolves to the array||array operator and fails
  -- at RUNTIME with "malformed array literal".
  IF v_hands IS NOT NULL THEN
    IF v_hands > c_max_hands THEN
      v_reasons := array_append(v_reasons, 'dealt_inside_break');
    END IF;
    IF COALESCE(v_thaw.frozen_seconds, 0) <= 0 THEN
      v_reasons := array_append(v_reasons, 'thaw_did_not_run');
    END IF;
    IF v_covered IS FALSE THEN
      v_reasons := array_append(v_reasons, 'break_missed_its_window');
    END IF;
    -- The cause goes in FRONT of its consequences. A break that never started
    -- deals through its window and has nothing to thaw, so the two reasons
    -- above follow from this one; the message reads them in this order.
    IF v_never_started THEN
      v_reasons := array_prepend('break_never_started'::text, v_reasons);
    END IF;
  END IF;

  -- `v_covered IS NOT FALSE`, deliberately: NULL means "no break log row was
  -- found", which is unmeasured, and unmeasured is not failed. That is the
  -- same rule the recovery-seconds sentinel taught on 2026-09-04.
  v_verdict := CASE
    WHEN v_hands IS NULL THEN 'unknown'
    WHEN v_hands <= c_max_hands
     AND COALESCE(v_thaw.frozen_seconds, 0) > 0
     AND v_covered IS NOT FALSE
    THEN 'pass'
    ELSE 'fail' END;

  INSERT INTO public.ca_break_scorecards AS s (
    break_ended_at, break_started_at, hands_in_window, tables_dealing_in_window,
    thaw_ran, thaw_frozen_seconds, kill_rebuilds_after, recovery_seconds,
    pre_break_tables, shipped_sha, shipped, freeze_conserved, freeze_delta, verdict, detail,
    unparked_at_countdown, peak_unparked, ready_for_restart_at, gate_opened)
  VALUES (
    v_end, v_start, v_hands, v_wtabs,
    (v_thaw.frozen_seconds IS NOT NULL), v_thaw.frozen_seconds, v_kill, v_rec,
    v_base, v_ship.target_sha, COALESCE(v_ship.shipped, FALSE), v_conserved, v_delta, v_verdict,
    jsonb_build_object(
      'pre_total', v_pre,
      'post_total', v_post,
      -- The window the hand count above was actually taken over, so nobody has
      -- to guess again which five minutes a number refers to.
      'measured_from', v_meas_start,
      'measured_to', v_meas_end,
      'measured_actual_break', (v_brk.break_started_at IS NOT NULL),
      'covered_the_hour', v_covered,
      'resumed_early_seconds', v_early_s,
      'started_late_seconds', v_late_start_s,
      'never_started', v_never_started,
      'fault_stage', v_fault_stage,
      'fault_outcome', v_fault_outcome,
      'fault_error', v_fault_error,
      'reasons', to_jsonb(v_reasons)),
    v_brk.unparked_at_countdown, v_brk.peak_unparked, v_brk.ready_for_restart_at,
    -- Correction b: the replacement engine writes a restart hour's log row and
    -- never saw readiness itself; a verified cutover inside the break did.
    CASE WHEN v_brk.unparked_at_countdown IS NULL THEN NULL
         ELSE (v_brk.ready_for_restart_at IS NOT NULL OR COALESCE(v_ship.shipped, false)) END)
  ON CONFLICT (break_ended_at) DO UPDATE SET
    hands_in_window = EXCLUDED.hands_in_window,
    tables_dealing_in_window = EXCLUDED.tables_dealing_in_window,
    thaw_ran = EXCLUDED.thaw_ran, thaw_frozen_seconds = EXCLUDED.thaw_frozen_seconds,
    kill_rebuilds_after = EXCLUDED.kill_rebuilds_after, recovery_seconds = EXCLUDED.recovery_seconds,
    pre_break_tables = EXCLUDED.pre_break_tables, shipped_sha = EXCLUDED.shipped_sha,
    shipped = EXCLUDED.shipped, freeze_conserved = EXCLUDED.freeze_conserved,
    freeze_delta = EXCLUDED.freeze_delta, verdict = EXCLUDED.verdict,
    -- A re-score replaces the measurement and keeps the account of the
    -- recovery the hourly job's pass sent (20260928155739).
    detail = EXCLUDED.detail
             || CASE WHEN s.detail ? 'recovery' THEN jsonb_build_object('recovery', s.detail->'recovery')
                     ELSE '{}'::jsonb END,
    unparked_at_countdown = EXCLUDED.unparked_at_countdown, peak_unparked = EXCLUDED.peak_unparked,
    ready_for_restart_at = EXCLUDED.ready_for_restart_at, gate_opened = EXCLUDED.gate_opened,
    recorded_at = now()
  RETURNING * INTO v_row;

  IF v_verdict = 'fail' THEN
    PERFORM public.fn_ca_break_scorecard_push(v_row);
  ELSIF v_verdict = 'pass' AND p_end IS NULL THEN
    -- A RECOVERY FOLLOWS ITS FAULT (20260928155739). The hourly job is the
    -- only caller that passes no p_end. Its pass is followed by the recovery
    -- of every fault notified before it that no recovery names yet, on the
    -- route the fault took, and this row keeps the account. Nothing on that
    -- path can cost the scorecard this pass: an error there is caught and
    -- kept in the account. An explicit re-score never sends a recovery.
    BEGIN
      v_recovery := public.fn_ca_break_scorecard_recovered(v_row);
    EXCEPTION WHEN OTHERS THEN
      v_recovery := jsonb_build_object('error', SQLSTATE || ': ' || left(SQLERRM, 300));
    END;
    UPDATE public.ca_break_scorecards
       SET detail = detail || jsonb_build_object('recovery', v_recovery)
     WHERE break_ended_at = v_end
    RETURNING * INTO v_row;
  END IF;
  RETURN v_row;
END $function$;

-- Unchanged: CREATE OR REPLACE keeps the ACL; restated so
-- check-definer-authorization reads the truth.
REVOKE ALL ON FUNCTION public.fn_ca_record_break_scorecard(timestamp with time zone)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_record_break_scorecard(timestamp with time zone)
  TO service_role;

-- ===========================================================================
-- 3. PROVE IT HERE, OR COMMIT NOTHING
-- ===========================================================================
DO $verify$
DECLARE
  c_owner CONSTANT uuid := '47965354-0e56-43ef-931c-ddaab82af765';
  c_task  CONSTANT text := '01a09b86-5ba8-7290-8657-1041f13dd3ca';
  v_first jsonb; v_rerun jsonb; v_next jsonb;
  v_summary text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
      WHERE p.oid = 'public.fn_ca_record_break_scorecard(timestamp with time zone)'::regprocedure
        AND md5(pg_get_functiondef(p.oid)) = '2d4be3ca3149d4ee69adc7286ed9a82c'
        AND p.proowner = 'postgres'::regrole::oid AND p.prosecdef
        AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
        AND p.proconfig = ARRAY['search_path=public, pg_temp', 'TimeZone=UTC']::text[]
        -- The verdict CASE is production's, byte for byte.
        AND md5(substring(pg_get_functiondef(p.oid) FROM 'v_verdict := CASE.*?END;'))
            = '2b9980dc57f582738896b811b9373838') THEN
    RAISE EXCEPTION 'BREAK_SCORECARD_RECORDER_POSTIMAGE_CHANGED' USING ERRCODE = '55000';
  END IF;
  -- Its owner (the recorder runs as postgres) is the only role that may call it.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
      WHERE p.oid = 'public.fn_ca_break_scorecard_recovered(public.ca_break_scorecards)'::regprocedure
        AND md5(pg_get_functiondef(p.oid)) = 'd5079242515f836f8d07b7f7158c77f0'
        AND p.proowner = 'postgres'::regrole::oid AND p.prosecdef
        AND p.proacl::text = '{postgres=X/postgres}'
        AND p.proconfig = ARRAY['search_path=public, pg_temp', 'TimeZone=UTC', 'lock_timeout=5s']::text[]) THEN
    RAISE EXCEPTION 'BREAK_SCORECARD_RECOVERY_CHANGED' USING ERRCODE = '55000';
  END IF;

  -- The install proves itself on this database, then rolls the proof back.
  -- A synthetic episode in the year 2000, far from every real hour: faults
  -- for 02:00 and 03:00 notified to the owner account through the real
  -- capture, the pass at 04:00 that answers them (run twice, as a re-run of
  -- the hour would), and a pass at 05:00 with nothing left to answer.
  BEGIN
    INSERT INTO public.ca_break_scorecards (break_ended_at, break_started_at, verdict, detail)
    SELECT h, h - interval '5 minutes', v, '{}'::jsonb
      FROM (VALUES ('2000-01-01 01:00+00'::timestamptz, 'pass'), ('2000-01-01 02:00+00', 'fail'),
                   ('2000-01-01 03:00+00', 'fail'), ('2000-01-01 04:00+00', 'pass'),
                   ('2000-01-01 05:00+00', 'pass')) x(h, v);
    INSERT INTO public.notifications (user_id, type, title, message, data)
    SELECT c_owner, 'engine_break_failed', 'Engine Break Needs A Look', 'install check',
           jsonb_build_object('key', 'break-failed:' || to_char(h AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MI'),
                              'break_ended_at', h)
      FROM (VALUES ('2000-01-01 02:00+00'::timestamptz), ('2000-01-01 03:00+00')) x(h);
    SELECT public.fn_ca_break_scorecard_recovered(s) INTO v_first
      FROM public.ca_break_scorecards s WHERE s.break_ended_at = '2000-01-01 04:00+00';
    SELECT public.fn_ca_break_scorecard_recovered(s) INTO v_rerun
      FROM public.ca_break_scorecards s WHERE s.break_ended_at = '2000-01-01 04:00+00';
    SELECT public.fn_ca_break_scorecard_recovered(s) INTO v_next
      FROM public.ca_break_scorecards s WHERE s.break_ended_at = '2000-01-01 05:00+00';
    SELECT concat_ws(':',
        (SELECT count(*) FROM public.operational_notification_destinations d
          WHERE d.original_notification->>'type' = 'engine_break_recovered'
            AND d.original_notification->'data'->>'key' LIKE 'break-recovered:2000%'),
        (SELECT count(*) FROM public.operational_notification_destinations d
           JOIN public.operational_alert_events e ON e.id = d.inbox_event_id
          WHERE d.original_notification->'data'->>'key' = 'break-recovered:20000101T0400'
            AND e.source = 'owner-operational-notifications' AND e.status = 'resolved'
            AND e.event_key = d.notification_id::text AND e.payload->>'target_task_id' = c_task),
        (SELECT count(*) FROM public.notifications n WHERE n.type = 'engine_break_recovered'
            AND n.data->>'key' LIKE 'break-recovered:2000%'),
        (SELECT count(*) FROM public.operational_alert_events e
          WHERE e.source = 'break-scorecard-recovery-guard'),
        v_first->>'written', v_rerun->>'written', v_next->>'written',
        jsonb_array_length(v_first->'open') + jsonb_array_length(v_rerun->'open')
          + jsonb_array_length(v_next->'open'),
        (SELECT d.original_notification->'data'->>'resolves' FROM public.operational_notification_destinations d
          WHERE d.original_notification->'data'->>'key' = 'break-recovered:20000101T0400'))
      INTO v_summary;
    RAISE EXCEPTION 'ENGINE_BREAK_RECOVERY_INSTALL_CHECK:%', v_summary;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM IS DISTINCT FROM 'ENGINE_BREAK_RECOVERY_INSTALL_CHECK:1:1:0:0:1:0:0:0:["break-failed:20000101T0200", "break-failed:20000101T0300"]' THEN
      RAISE EXCEPTION 'ENGINE_BREAK_RECOVERY_INSTALL_CHECK_FAILED: %', SQLERRM USING ERRCODE = '55000';
    END IF;
  END;
END;
$verify$;

COMMIT;
