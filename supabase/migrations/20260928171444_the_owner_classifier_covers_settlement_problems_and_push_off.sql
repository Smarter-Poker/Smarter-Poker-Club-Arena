-- 20260928171444_the_owner_classifier_covers_settlement_problems_and_push_off.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE OWNER CLASSIFIER COVERS THE SETTLEMENT PROBLEM AND PUSH-OFF NOTICES.
--
-- WHY. public.fn_is_owner_operational_notification is the database's answer
-- to "is this notification to the owner account operational". Every layer of
-- store-only delivery (20260927235053) asks it: the capture that delivers such
-- a row to the Production Alerts task and writes no personal row, the
-- authority trigger that refuses anon and authenticated writers of one, the
-- push mirror's WHEN clause that never pushes one, and the detector that
-- records one reaching the inbox anyway. Two operational notices are not in
-- it, so every one of those layers lets them through to the owner's inbox and
-- phone:
--   1. smarter-poker-workers' weekly auto-settlement problem notices, type
--      'settlement', titled 'Weekly player P&L needs review', 'Weekly player
--      P&L failed' or 'Union rule violation detected' (src/routes/
--      auto-settlement.ts, notifyUnionSettlementProblem). The owner account
--      holds 3 (2026-08-24, 2026-09-07, 2026-09-14); 2 were pushed to his
--      phone. The workers pull request stops that route addressing the owner;
--      this makes the database refuse the same outcome from any writer.
--   2. World Hub push-health's staff notice, type 'system', titled 'Push
--      Notifications Are Off' (pages/api/cron/push-health.js). The owner
--      account holds 1 (2026-08-19). The World Hub pull request stops
--      push-health addressing the owner.
-- Read-only, production, 2026-09-28: those 4 rows are the only rows
-- platform-wide this change newly classifies, none has a destination, and no
-- other settlement notice exists. The classifier stays owner-only: the 8 'Push
-- Notifications Are Off' rows of 2 other staff accounts are untouched.
--
-- WHAT CHANGES.
--   1. CLASSIFIER. For the owner account only:
--        * type 'settlement' whose title, ASCII case and whitespace folded, is
--          one of the three problem titles, or whose data carries the route's
--          marker: component 'workers.auto-settlement' and alertname
--          'UnionPlayerPnlNeedsReview', 'UnionPlayerPnlFailed' or
--          'UnionRuleViolation';
--        * type 'system' whose title, folded the same way, is 'push
--          notifications are off'.
--      Nothing else moves: the route's business notices (Commission
--      Received, Settlement Complete) carry neither title nor marker, Club
--      Arena's 'Cash-Out Request' and every other settlement notice stay
--      personal, the two system titles classified before stay exact, and no
--      other recipient is ever classified. The settlement clause is the one
--      definition the route itself uses (src/lib/unionSettlementAlerts.ts:
--      SETTLEMENT_PROBLEM_CLASSIFIER, normalizeTitle), and World Hub's mirror
--      takes the same fold: a copy edit of a title's case or spacing, or any
--      new title the marker still carries, stays classified, and the 3
--      production rows, written before the marker existed, match by title.
--      Folding is ASCII-only (translate, not lower()), so SQL and JavaScript
--      fold every string identically whatever the collation. The whitespace
--      class is written E'[\\t\\n\\v\\f\\r ]+': a SQL function body is lexed in
--      the calling session, and a session with standard_conforming_strings off
--      reads the plain '[\t\n\v\f\r ]+' with \v as a letter v, so 'review' and
--      'violation' would no longer match.
--   2. EXISTING ROWS. Once classified, the owner's rows of these kinds already
--      in his inbox are operational originals with no store copy. Each is
--      preserved exactly as the capture would have recorded it, by the
--      existing bounded history intake fn_capture_owner_notification_history
--      (20260916111614): a destination holding the complete original,
--      rendered in UTC like every captured original, and its receipt in
--      operational_alert_events through fn_try_record_owner_notification,
--      addressed to the fleet task. Every one is then proven preserved the way
--      the held cleanup 20260928000622 will prove it, and one unproven row
--      aborts the migration. No notification row is modified or deleted. The
--      intake also records the receipt of any destination still pending (0
--      measured), which is what it is for.
--      The install first takes SHARE on notifications. That waits for every
--      transaction already writing a notification and holds off every new
--      writer until COMMIT, so a notice written by a transaction still open
--      when the install starts is committed before the rows are read here and
--      is preserved with them, and one written after the install meets the new
--      classifier and is delivered store-only. Without the lock that notice
--      would keep its personal row with no destination (the probe reproduces
--      it). Every notification write waits for the install; a lock it cannot
--      take within 3 s refuses the install with nothing changed.
--   3. The install proves itself in rolled-back subtransactions: each new kind
--      written to the owner (the three titles, a folded title, the marker
--      under another title, the push-off notice as written and folded) writes
--      no personal row and one receipted destination; anon writing one is
--      refused with row-level security's error by
--      zz_authorize_owner_operational_original; business titles, a near miss
--      of each kind, a foreign marker, a non-ASCII case fold, the same titles
--      under another type and another recipient are not classified, and the
--      kinds classified before still are.
--
-- DETECTION. zz_owner_operational_original_reached_personal_inbox
-- (20260927235053) fires on this classifier, so it now records either kind
-- reaching the personal inbox for the fleet task; the push mirror's WHEN
-- never pushes one. Unchanged, both cover the new kinds. Installed after the
-- cleanup (ORDER), this records the owner-operational rows left in his inbox
-- as OwnerOperationalOriginalsLeftAfterCleanup for the fleet task.
--
-- WHAT DOES NOT CHANGE. No table, column, policy, view, trigger, grant or
-- schedule, and no notification, push_outbox or financial row. The classifier
-- keeps its owner, ACL, settings, IMMUTABLE and PARALLEL SAFE.
--
-- ORDER. The cleanup 20260928000622 removes whatever this classifier says is
-- operational when it runs, and refuses any such row with no destination;
-- this migration gives every row it newly classifies its destination and
-- receipt. The documented order:
--   1. 20260927235053, store-only delivery, installed COMPLETELY: each of its
--      @live-proof expressions is re-checked verbatim below. Before it, a
--      classified row still gets a personal row.
--   2. This migration, outside :50-:03 UTC.
--   3. The cleanup, although its version is lower. It then proves and removes
--      these rows with the rest.
-- Installed the other way round, the cleanup removes the owner's operational
-- originals it knows and never runs again. This migration still installs and
-- preserves every row it newly classifies, but nothing is left to remove
-- them: they stay in public.notifications. It then records them for the
-- fleet task (DETECTION) and @live-proof 3 stays false until a held migration
-- removes them, each once proven preserved, as the cleanup does.
-- World Hub's mirror of the predicate
-- (src/lib/notifications/ownerOperationalClassifier.mjs) follows once this is
-- installed.
--
-- LIVE PROOF. 1: the post-image is installed. 2: every owner row it
-- classifies has its destination and its task receipt. 3: false while the
-- cleanup's removal record exists and an owner row it classifies is still in
-- public.notifications - installed after the cleanup, until a held migration
-- removes them. In the documented order 3 is true before and after the
-- cleanup.
--
-- ROLLBACK. A new migration restores the pre-image (md5 below, the
-- 20260916111614 text). The destinations and receipts recorded here stay: they
-- are the preserved originals.
--
-- Regression proof: scripts/dev/probe-owner-classifier-settlement-problems.sh
-- (red before, green after, throwaway PostgreSQL built from production), run by
-- .github/workflows/owner-classifier-settlement-problems.yml; the newest
-- definition's clauses by tests/the-owner-classifier-keeps-its-operational-kinds.law.test.ts.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_is_owner_operational_notification(uuid,text,text,jsonb)'::regprocedure))='30553a82783e28037aa884c85f203808')
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.user_id='47965354-0e56-43ef-931c-ddaab82af765' AND public.fn_is_owner_operational_notification(n.user_id,n.type,n.title,n.data) AND NOT EXISTS (SELECT 1 FROM public.operational_notification_destinations d JOIN public.operational_alert_events e ON e.id=d.inbox_event_id WHERE d.notification_id=n.id AND e.source='owner-operational-notifications' AND e.event_key=n.id::text AND e.payload->>'target_task_id'='01a09b86-5ba8-7290-8657-1041f13dd3ca')))
-- @live-proof: (SELECT to_regclass('public.owner_inbox_operational_removals') IS NULL OR NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.user_id='47965354-0e56-43ef-931c-ddaab82af765' AND public.fn_is_owner_operational_notification(n.user_id,n.type,n.title,n.data)))

BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
-- to_jsonb renders a timestamptz in the session's time zone. Every captured
-- original was rendered in UTC and the cleanup proves them in UTC, so the
-- originals preserved here are rendered in UTC whatever the installer's session.
SET LOCAL TimeZone='UTC';
-- Every literal below reads the same whatever the installer's session (with
-- it off, the install proof's U&'' literal would be refused).
SET LOCAL standard_conforming_strings = on;
-- EXISTING ROWS (header 2): until COMMIT no notification is written, changed
-- or removed, so the rows preserved and proven below are the rows that stand.
LOCK TABLE public.notifications IN SHARE MODE;

DO $guard$
DECLARE
  v_missing text[] := '{}'; v_stored text;
BEGIN
  -- Store-only delivery must be installed completely. Each condition is one
  -- of 20260927235053's @live-proof expressions, verbatim.
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
    RAISE EXCEPTION 'OWNER_CLASSIFIER_NEEDS_STORE_ONLY_DELIVERY: % missing',
      array_to_string(v_missing, ', ') USING ERRCODE='55000';
  END IF;

  -- The classifier this was written against: the 20260916111614 text, with
  -- its owner, ACL, settings, volatility and parallel safety.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
      WHERE p.oid='public.fn_is_owner_operational_notification(uuid,text,text,jsonb)'::regprocedure
        AND md5(pg_get_functiondef(p.oid))='8c2c62359d92dcbd3b3621a762b981ca'
        AND p.proowner='postgres'::regrole::oid
        AND p.proacl::text='{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
        AND p.proconfig=ARRAY['search_path=pg_catalog, public']::text[]
        AND p.provolatile='i' AND p.proparallel='s' AND NOT p.prosecdef) THEN
    RAISE EXCEPTION 'OWNER_CLASSIFIER_SOURCE_OR_AUTHORITY_CHANGED' USING ERRCODE='55000';
  END IF;

  -- The intake the existing rows are preserved through, and the receipt it
  -- writes, are the ones the cleanup's proof was written against.
  IF md5(pg_get_functiondef('public.fn_capture_owner_notification_history(integer)'::regprocedure))
       IS DISTINCT FROM 'cc71da2cd06381b3b460f9213f6e46bf'
    OR md5(pg_get_functiondef('public.fn_try_record_owner_notification(uuid)'::regprocedure))
       IS DISTINCT FROM 'bbc44eb76b74576906f55e9ae370a508'
    OR md5(pg_get_functiondef('public.fn_record_operational_alert(text,text,text,text,text,jsonb)'::regprocedure))
       IS DISTINCT FROM '36601e205494e8768f5a1dce09f4a186' THEN
    RAISE EXCEPTION 'OWNER_NOTIFICATION_INTAKE_CHANGED' USING ERRCODE='55000';
  END IF;

  -- The classifier is IMMUTABLE: an index, constraint, column default,
  -- statistics object or materialized view holding one of its answers would
  -- silently keep the old answer (a partial index on it would stop finding
  -- the rows this classifies). A trigger WHEN clause, a policy and a plain
  -- view ask again each time and may depend on it.
  SELECT string_agg(pg_describe_object(d.classid, d.objid, d.objsubid), ', ' ORDER BY 1) INTO v_stored
    FROM pg_depend d
   WHERE d.refclassid='pg_proc'::regclass
     AND d.refobjid='public.fn_is_owner_operational_notification(uuid,text,text,jsonb)'::regprocedure
     AND d.classid NOT IN ('pg_trigger'::regclass, 'pg_policy'::regclass)
     AND NOT (d.classid='pg_rewrite'::regclass AND EXISTS (
           SELECT 1 FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class
            WHERE r.oid=d.objid AND c.relkind='v'));
  IF v_stored IS NOT NULL THEN
    RAISE EXCEPTION 'OWNER_CLASSIFIER_HAS_STORED_DEPENDENTS: %', v_stored USING ERRCODE='55000';
  END IF;
END;
$guard$;

-- CLASSIFIER (header 1): the 20260916111614 text with the two kinds added.
CREATE OR REPLACE FUNCTION public.fn_is_owner_operational_notification(
  p_user uuid, p_type text, p_title text, p_data jsonb
) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, public AS $body$
  SELECT COALESCE(p_user='47965354-0e56-43ef-931c-ddaab82af765'::uuid AND (
    p_type IN ('financial_incident','financial_incident_resolved','financial_attestation',
      'engine_break_failed','engine_break_recovered','guarantee_bank_short',
      'guarantee_bank_recovered','estate_digest')
    OR (p_type='system' AND (
      p_title IN ('Push Health Alert','Notifications May Not Be Reaching This Device')
      OR p_title ~ '^Horse Fleet (Alert|Recovered): '
      OR (jsonb_typeof(p_data)='object' AND p_data->>'component'='club-arena-engine'
        AND jsonb_typeof(p_data->'alertname')='string' AND NULLIF(p_data->>'alertname','') IS NOT NULL)
      -- World Hub push-health's staff notice, its title ASCII case and
      -- whitespace folded as below (2026-09-28, 20260928171444).
      OR btrim(regexp_replace(translate(p_title,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),
          E'[\\t\\n\\v\\f\\r ]+',' ','g'),' ') = 'push notifications are off'
    ))
    -- smarter-poker-workers' weekly auto-settlement problem notices: a problem
    -- title, ASCII case and whitespace folded, or the route's marker in the
    -- data. Its business notices (Commission Received, Settlement Complete)
    -- carry neither. One definition with the route's
    -- SETTLEMENT_PROBLEM_CLASSIFIER and World Hub's mirror (2026-09-28,
    -- 20260928171444).
    OR (p_type='settlement' AND (
      btrim(regexp_replace(translate(p_title,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),
          E'[\\t\\n\\v\\f\\r ]+',' ','g'),' ')
        IN ('weekly player p&l needs review','weekly player p&l failed','union rule violation detected')
      OR (jsonb_typeof(p_data)='object' AND p_data->>'component'='workers.auto-settlement'
        AND p_data->>'alertname' IN ('UnionPlayerPnlNeedsReview','UnionPlayerPnlFailed','UnionRuleViolation'))))
  ),false);
$body$;

-- EXISTING ROWS (header 2), in either order (ORDER).
DO $preserve$
DECLARE
  c_owner constant uuid := '47965354-0e56-43ef-931c-ddaab82af765';
  c_task constant uuid := '01a09b86-5ba8-7290-8657-1041f13dd3ca';
  c_read_state constant text[] := ARRAY['read','is_read','read_at','updated_at'];
  v_ids uuid[]; v_left uuid[]; v_intake jsonb;
  v_no_destination integer; v_pending integer; v_foreign_receipt integer; v_differs integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
      WHERE p.oid='public.fn_is_owner_operational_notification(uuid,text,text,jsonb)'::regprocedure
        AND md5(pg_get_functiondef(p.oid))='30553a82783e28037aa884c85f203808'
        AND p.proowner='postgres'::regrole::oid
        AND p.proacl::text='{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
        AND p.proconfig=ARRAY['search_path=pg_catalog, public']::text[]
        AND p.provolatile='i' AND p.proparallel='s' AND NOT p.prosecdef) THEN
    RAISE EXCEPTION 'OWNER_CLASSIFIER_POSTIMAGE_CHANGED' USING ERRCODE='55000';
  END IF;

  -- The owner's rows the classifier now answers for and no destination holds:
  -- the rows of the two kinds, since every other owner-operational row was
  -- captured when it was written. The SHARE lock taken at the top keeps each
  -- exactly as it stands until COMMIT.
  SELECT coalesce(array_agg(n.id ORDER BY n.id), '{}') INTO v_ids
    FROM public.notifications n
   WHERE n.user_id=c_owner
     AND public.fn_is_owner_operational_notification(n.user_id,n.type,n.title,n.data)
     AND NOT EXISTS (SELECT 1 FROM public.operational_notification_destinations d
                      WHERE d.notification_id=n.id);

  -- One call of the existing bounded intake: a destination with the complete
  -- original for each, then its receipt through fn_try_record_owner_notification.
  v_intake := public.fn_capture_owner_notification_history(200);

  -- Each row proven the way 20260928000622 proves it: a destination for the
  -- owner and the fleet task, its receipt the row's own task receipt, and both
  -- copies equal to the row but for read state. IS DISTINCT FROM throughout,
  -- so a missing copy or key is a difference, never an unknown.
  SELECT count(*) FILTER (WHERE x.cause='no destination'),
         count(*) FILTER (WHERE x.cause='pending receipt'),
         count(*) FILTER (WHERE x.cause='foreign receipt'),
         count(*) FILTER (WHERE x.cause='content differs')
    INTO v_no_destination, v_pending, v_foreign_receipt, v_differs
    FROM (SELECT CASE
            WHEN d.notification_id IS NULL THEN 'no destination'
            WHEN d.inbox_event_id IS NULL THEN 'pending receipt'
            WHEN e.source IS DISTINCT FROM 'owner-operational-notifications'
              OR e.event_key IS DISTINCT FROM n.id::text
              OR e.payload->>'target_task_id' IS DISTINCT FROM c_task::text THEN 'foreign receipt'
            WHEN (d.original_notification - c_read_state) IS DISTINCT FROM (to_jsonb(n) - c_read_state)
              OR ((e.payload->'original_notification') - c_read_state) IS DISTINCT FROM (to_jsonb(n) - c_read_state)
              THEN 'content differs'
          END AS cause
            FROM public.notifications n
            LEFT JOIN public.operational_notification_destinations d
              ON d.notification_id=n.id AND d.recipient_user_id=n.user_id AND d.target_task_id=c_task
            LEFT JOIN public.operational_alert_events e ON e.id=d.inbox_event_id
           WHERE n.id = ANY(v_ids)) x;
  IF v_no_destination + v_pending + v_foreign_receipt + v_differs > 0
    OR (v_intake->>'uncaptured') IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'OWNER_CLASSIFIER_ROWS_NOT_PRESERVED: % of % owner rows unproven (no destination %, pending receipt %, receipt not the row''s own task receipt %, content differs %); intake %',
      v_no_destination + v_pending + v_foreign_receipt + v_differs, cardinality(v_ids),
      v_no_destination, v_pending, v_foreign_receipt, v_differs, v_intake USING ERRCODE='55000';
  END IF;
  RAISE NOTICE 'owner classifier: % existing owner row(s) of the newly classified kinds preserved, each with its destination and task receipt (intake %)',
    cardinality(v_ids), v_intake;

  -- ORDER: after the held cleanup 20260928000622 (its removal record exists),
  -- which never runs again, nothing is left to remove the owner-operational
  -- rows still in public.notifications. Record them for the fleet task;
  -- @live-proof 3 stays false until a held migration removes them.
  IF to_regclass('public.owner_inbox_operational_removals') IS NOT NULL THEN
    SELECT coalesce(array_agg(n.id ORDER BY n.id), '{}') INTO v_left
      FROM public.notifications n
     WHERE n.user_id=c_owner
       AND public.fn_is_owner_operational_notification(n.user_id,n.type,n.title,n.data);
    IF cardinality(v_left) > 0 THEN
      PERFORM public.fn_record_operational_alert('owner-inbox-routing-guard',
        'owner-classifier-installed-after-cleanup', 'OwnerOperationalOriginalsLeftAfterCleanup',
        'firing', 'warning',
        jsonb_build_object('migration', '20260928171444', 'cleanup', '20260928000622',
          'rows', cardinality(v_left), 'notification_ids', to_jsonb(v_left),
          'remedy', 'a held migration removes them, each once proven preserved, as 20260928000622 does',
          'target_task_id', c_task));
      RAISE WARNING 'owner classifier: installed after the held cleanup 20260928000622, so % owner-operational row(s) stay in public.notifications with nothing to remove them; recorded as OwnerOperationalOriginalsLeftAfterCleanup for the fleet task, and @live-proof 3 is false until a held migration removes them',
        cardinality(v_left);
    END IF;
  END IF;
END;
$preserve$;

-- INSTALL PROOF (header 3), rolled back.
DO $verify$
DECLARE
  c_owner constant uuid := '47965354-0e56-43ef-931c-ddaab82af765';
  c_task constant uuid := '01a09b86-5ba8-7290-8657-1041f13dd3ca';
  c_marker constant jsonb := '{"component": "workers.auto-settlement", "alertname": "UnionPlayerPnlNeedsReview", "severity": "warning"}';
  v_kind text[]; v_id uuid; v_rows integer; v_dest integer; v_msg text; v_ctx text;
BEGIN
  -- Each new kind, written to the owner, reaches the task only ...
  FOREACH v_kind SLICE 1 IN ARRAY ARRAY[
      ['settlement', 'Weekly player P&L needs review', '{}'],
      ['settlement', 'Weekly player P&L failed', '{}'],
      ['settlement', 'Union rule violation detected', '{}'],
      ['settlement', E' WEEKLY  Player P&L\tFailed ', '{}'],
      ['settlement', 'Weekly settlement parked', c_marker::text],
      ['system', 'Push Notifications Are Off', '{}'],
      ['system', E'push  NOTIFICATIONS are\tOFF ', '{}']] LOOP
    v_id := gen_random_uuid();
    BEGIN
      INSERT INTO public.notifications(id, user_id, type, title, message, data)
      VALUES (v_id, c_owner, v_kind[1], v_kind[2], 'classifier install check, rolled back by its migration',
              v_kind[3]::jsonb);
      SELECT count(*) INTO v_rows FROM public.notifications WHERE id=v_id;
      SELECT count(*) INTO v_dest FROM public.operational_notification_destinations d
        JOIN public.operational_alert_events e ON e.id=d.inbox_event_id
       WHERE d.notification_id=v_id AND e.source='owner-operational-notifications'
         AND e.event_key=v_id::text AND e.payload->>'target_task_id'=c_task::text;
      RAISE EXCEPTION 'OWNER_CLASSIFIER_INSTALL_CHECK:%:%', v_rows, v_dest;
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM IS DISTINCT FROM 'OWNER_CLASSIFIER_INSTALL_CHECK:0:1' THEN
        RAISE EXCEPTION 'OWNER_CLASSIFIER_INSTALL_CHECK_FAILED: % %: %', v_kind[1], v_kind[2], SQLERRM
          USING ERRCODE='55000';
      END IF;
    END;
  END LOOP;

  -- ... and anon writing one is refused with row-level security's own error,
  -- by the authority trigger, before anything is captured.
  BEGIN
    PERFORM set_config('role', 'anon', true);
    INSERT INTO public.notifications(user_id, type, title, message, data)
    VALUES (c_owner, 'settlement', 'Weekly player P&L failed', 'refused by its migration', '{}'::jsonb);
    RAISE EXCEPTION 'OWNER_CLASSIFIER_AUTHORITY_CHECK_FAILED: anon was not refused' USING ERRCODE='55000';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_ctx = PG_EXCEPTION_CONTEXT;
    IF v_msg IS DISTINCT FROM 'new row violates row-level security policy for table "notifications"'
      OR strpos(v_ctx, 'fn_authorize_owner_operational_original') = 0 THEN
      RAISE EXCEPTION 'OWNER_CLASSIFIER_AUTHORITY_CHECK_FAILED: anon was refused by "%" (%)', v_msg, v_ctx
        USING ERRCODE='55000';
    END IF;
  END;

  -- Nothing else moved: business titles, a near miss of each kind, a foreign
  -- marker, a non-ASCII case fold, the same titles under another type, and
  -- another recipient are not classified; the kinds classified before still are.
  IF public.fn_is_owner_operational_notification(c_owner, 'settlement', 'Commission Received - Period #1', '{}')
    OR public.fn_is_owner_operational_notification(c_owner, 'settlement', 'Settlement Complete - Club Period #1', '{}')
    OR public.fn_is_owner_operational_notification(c_owner, 'settlement', 'Cash-Out Request', '{}')
    OR public.fn_is_owner_operational_notification(c_owner, 'settlement', 'Weekly player P&L settled', '{}')
    OR public.fn_is_owner_operational_notification(c_owner, 'settlement', 'Settlement Complete - Club Period #1',
         '{"component": "workers.auto-settlement", "alertname": "UnionSettlementComplete"}')
    OR public.fn_is_owner_operational_notification(c_owner, 'settlement', 'Settlement Complete - Club Period #1',
         '{"component": "workers.other", "alertname": "UnionPlayerPnlFailed"}')
    OR public.fn_is_owner_operational_notification(c_owner, 'settlement', U&'WEEKLY PLAYER P&L FA\0130LED', '{}')
    OR public.fn_is_owner_operational_notification(c_owner, 'system', 'Weekly player P&L failed', c_marker)
    OR public.fn_is_owner_operational_notification(c_owner, 'system', 'Push Notifications Are Offline', '{}')
    OR public.fn_is_owner_operational_notification(c_owner, 'settlement', 'Push Notifications Are Off', '{}')
    OR public.fn_is_owner_operational_notification(gen_random_uuid(), 'settlement', 'Weekly player P&L failed', c_marker)
    OR public.fn_is_owner_operational_notification(gen_random_uuid(), 'system', 'Push Notifications Are Off', '{}')
    OR public.fn_is_owner_operational_notification(gen_random_uuid(), 'system', 'push notifications are off', '{}')
    OR NOT public.fn_is_owner_operational_notification(c_owner, 'financial_incident', 'x', '{}')
    OR NOT public.fn_is_owner_operational_notification(c_owner, 'system', 'Push Health Alert', '{}')
    OR NOT public.fn_is_owner_operational_notification(c_owner, 'system', 'Horse Fleet Alert: x', '{}')
    OR NOT public.fn_is_owner_operational_notification(c_owner, 'system', 'x',
         '{"component": "club-arena-engine", "alertname": "X"}') THEN
    RAISE EXCEPTION 'OWNER_CLASSIFIER_PRECISION_CHECK_FAILED' USING ERRCODE='55000';
  END IF;
END;
$verify$;

COMMIT;
