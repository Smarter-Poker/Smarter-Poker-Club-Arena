-- 20260927160533_operational_alert_redelivery_addresses_an_unaddressed_row
--
-- Version reserved by scripts/reserve-migration-version.sh on 2026-09-27
-- 16:05:33 UTC (first drafted as 20260927144925; re-reserved before release
-- so it is not older than migrations already merged to main).
--
-- Operational alert redelivery addresses a row recorded before its writer did.
--
-- HELD: install by the owner, outside the :50-:03 break window, once.
--
-- ROOT CAUSE (measured 2026-09-27). public.fn_record_operational_alert's
-- ON CONFLICT branch only bumps last_received_at and delivery_count. A row is
-- keyed by (source, event_key) and its payload is fixed by the FIRST delivery.
-- Alertmanager rows first recorded on 2026-09-17 (ids 54934 and 56211, before
-- the World Hub writer added payload.target_task_id) were re-delivered 39 and
-- 59 times with a payload that does name the fleet, and the stored row still
-- named nobody. workers.deploy-error-poll row 114454 (first recorded
-- 2026-09-23, before workers #144) is the same shape: 44 deliveries, no
-- target_task_id. production-integrity-audit's
-- OperationalAlertMissingTargetTaskId (rows 146682, 157688) fires on exactly
-- these rows; every row first recorded after the writers were fixed carries
-- the destination.
--
-- SCOPE OF THE PROOF. World Hub #2001 (new Alertmanager episode identity) and
-- smarter-poker-workers #150 (no re-report of a superseded ERROR) stop the
-- re-deliveries of 54934, 56211 and 114454 themselves, so those three rows
-- will not be re-addressed by this function and nobody may claim they were.
-- What this migration fixes is the recorder rule: from install onward, any
-- row recorded unaddressed is addressed by its next addressed delivery. It is
-- proven live by schema_migrations plus the recorder md5 below, never by a
-- detector recovery (the detector only looks back 2 hours and also recovers
-- when re-deliveries simply stop).
--
-- FIX. A repeat delivery that names a destination adds it to a stored payload
-- that names none. Nothing else about the stored row changes: evidence is never
-- rewritten, and a destination a row already names is never replaced.
-- Postimage md5(pg_get_functiondef(recorder)) = 4bab2581b3dff1e09b22d0df46c68df8.
--
-- LIVE DEPENDENT PIN (the only one; pg_proc.prosrc search 2026-09-27 finds no
-- other function and pg_views no view containing the old md5).
-- fn_ca_cash_failed_run_intake() (trigger on cron.job_run_details) refuses to
-- deliver unless the recorder's full definition md5 is the old
-- 36601e205494e8768f5a1dce09f4a186. It is rebuilt here, in the same
-- transaction, from its own live definition with only that literal changed;
-- the migration proves the result is byte-for-byte that replacement and that
-- owner, SECURITY DEFINER, settings and ACL are unchanged. Its receipts
-- already carry target_task_id, so the new branch never touches a payload it
-- compares.
--
-- OTHER CALLERS THAT COMPARE A RECEIPT. fn_cash_pot_conservation_check,
-- fn_try_record_owner_notification (checks payload->>'target_task_id' after
-- recording) and operational_source_intake.record_strict (requires
-- target_task_id and an exact receipt row) call the recorder and always send
-- target_task_id. For them the new branch can only turn a former receipt
-- mismatch on an unaddressed stored row into success; measured 2026-09-27:
-- zero owner-notification rows lack target_task_id and zero destinations are
-- in an error state. fn_record_operational_alerts is a thin batch wrapper.
--
-- EVERY FILE THAT PINS THE OLD RECORDER MD5 36601e20 (git grep, 2026-09-27).
-- None is read by production at runtime. Each is one of:
--
--  (A) One-shot install / re-install scripts, already installed. Their guard
--      asserts the old md5 and will REFUSE (fail closed, never silently) if
--      re-run after this migration; a re-install must first be re-reviewed
--      against the new pin 4bab2581b3dff1e09b22d0df46c68df8.
--      Club Arena:
--        supabase/components/cash-failed-run-intake.sql
--        supabase/components/cash-failed-run-intake.rollback.sql
--        supabase/components/cash-pot-check-evidence.sql
--        supabase/components/cash-pot-check-evidence.rollback.sql
--        supabase/components/direct-operational-source-intake.authority.sql
--          (included by direct-operational-source-intake.sql and its rollback)
--        scripts/operational-alerts/cash-pot-failed-run-intake.sql
--        supabase/accounting/weekly-v3/components/20260915140000_correction_writer_retains_exact_request_and_journal_intent.sql
--        supabase/accounting/correction-writer-v1/guard-function-sources.json
--      World Hub (Smarter-Poker-World-Hub):
--        supabase/components/owner-operational-notification-destination.sql
--          (its $guard$ block: 'operational inbox authority changed;
--          re-review required'; installed in production:
--          fn_is_owner_operational_notification exists)
--        scripts/qualification/owner-operational-notification-destination.sql
--          ('actual recorder authority drift' admission assert)
--      These are deliberately NOT edited here or in a companion PR: each is
--      qualified in CI only on an isolated PostgreSQL built from captured
--      fixtures whose recorder is the old preimage (World Hub
--      scripts/ci/test-owner-operational-notification-postgres.py with
--      scripts/ci/probes/owner-operational-notification/, whose manifest
--      pins the component and qualifier by hash), so changing the literal
--      now would break those green checks and could only be re-proven from a
--      fixture recaptured after this install.
--  (B) Captured-preimage CI fixtures and probe inputs. They describe the
--      2026-09-16/17 production state they were captured from and install
--      their own recorder on an isolated cluster, so they stay correct:
--      Club Arena scripts/ci/probes/production-alert-core/inputs/owner-notification-component.sql,
--      .../inputs/owner-notification-qualification.sql,
--      .../notification/inputs/owner-notification-catalog-postimage.sql,
--      .../notification/provider-check.sql,
--      scripts/ci/probes/spin-expiry/provider-check.sql,
--      scripts/qualification/fixtures/cash-pot-failed-run-intake/reader-source.sql,
--      scripts/qualification/fixtures/direct-operational-source-intake/authority.json,
--      tests/fixtures/union-provider-preimages-20260917/ (captured-authority.json,
--      direct-intake-authority.raw.txt, direct-intake-current-function-guards.json,
--      direct-intake-installation-receipt.raw.txt, direct-intake-installed.sql,
--      direct-intake-prerequisites.sql, owner-notification-coexistence.sql);
--      World Hub scripts/ci/probes/owner-operational-notification/provider-check.sql,
--      scripts/ci/probes/owner-operational-notification/inputs/owner-notification-catalog-postimage.sql.
--      Added to Club Arena main after this header was first written (#5675,
--      re-checked 2026-10-01): tests/sql/diamond-concurrency-doors.sql (the
--      fn_record_operational_alert @@PIN block and its line in the proof list
--      at the foot) and tests/sql/diamond-concurrency-doors.manifest.json. They
--      load their own captured recorder on an isolated cluster and stay green;
--      after this install their REFRESH step (read every pin against
--      production) must re-transport the recorder door to 4bab2581.
--  (C) Qualification records and applied migrations (history, immutable):
--      scripts/qualification/cash-pot-check-evidence.manifest.json,
--      scripts/qualification/cash-pot-check-evidence.md,
--      scripts/qualification/direct-operational-source-intake.md,
--      supabase/migrations/20260916111614_owner_operational_notification_destination.sql,
--      supabase/migrations/20260917054616_cash_pot_check_evidence_and_failed_run_intake.sql,
--      supabase/migrations/20260917062322_direct_operational_source_intake.sql.
--
-- LIVE PROOF AFTER INSTALL (closure criteria):
--   SELECT 1 FROM supabase_migrations.schema_migrations
--    WHERE version = '20260927160533'
--       OR name LIKE '%operational_alert_redelivery_addresses_an_unaddressed_row';
--   md5(pg_get_functiondef('public.fn_record_operational_alert(text,text,text,text,text,jsonb)'::regprocedure))
--     = '4bab2581b3dff1e09b22d0df46c68df8'
--   md5(pg_get_functiondef('public.fn_ca_cash_failed_run_intake()'::regprocedure))
--     = '3ef722e8990b508b8741ee2e558f19c1' (the one-literal replacement of the
--     live b1b3aa4e preimage, computed 2026-09-27).
--
-- Regression test: scripts/ci/test-operational-alert-redelivery-addressing.py
-- (isolated PostgreSQL; fails on the preimage recorder, passes after this).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $preimage$
DECLARE
  v_recorder constant text := 'public.fn_record_operational_alert(text,text,text,text,text,jsonb)';
BEGIN
  IF md5(pg_get_functiondef(v_recorder::regprocedure)) IS DISTINCT FROM '36601e205494e8768f5a1dce09f4a186' THEN
    RAISE EXCEPTION 'operational alert recorder is not the expected preimage';
  END IF;
  IF md5(pg_get_functiondef('public.fn_ca_cash_failed_run_intake()'::regprocedure))
       IS DISTINCT FROM 'b1b3aa4e571504d1fa68b1baab72e8ba' THEN
    RAISE EXCEPTION 'cash failed-run intake is not the expected preimage';
  END IF;
END
$preimage$;

CREATE OR REPLACE FUNCTION public.fn_record_operational_alert(p_source text, p_event_key text, p_alertname text, p_status text, p_severity text, p_payload jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_id bigint;
BEGIN
  -- A repeat delivery bumps the receipt. It never rewrites evidence, and it
  -- never changes a destination the row already names. The one thing it adds
  -- is the destination a row recorded before its writer addressed alerts:
  -- without it, a long-running alert first recorded unaddressed stays out of
  -- the owning lane for as long as it keeps firing.
  INSERT INTO public.operational_alert_events(source,event_key,alertname,status,severity,payload)
  VALUES(p_source,p_event_key,p_alertname,p_status,p_severity,p_payload)
  ON CONFLICT (source,event_key) DO UPDATE
  SET last_received_at=clock_timestamp(), delivery_count=operational_alert_events.delivery_count+1,
      payload=CASE
        WHEN jsonb_typeof(operational_alert_events.payload)='object'
         AND NOT (operational_alert_events.payload ? 'target_task_id')
         AND jsonb_typeof(EXCLUDED.payload->'target_task_id')='string'
        THEN operational_alert_events.payload
             || jsonb_build_object('target_task_id',EXCLUDED.payload->'target_task_id')
        ELSE operational_alert_events.payload END
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

DO $repin$
DECLARE
  v_old constant text := '36601e205494e8768f5a1dce09f4a186';
  v_new constant text := '4bab2581b3dff1e09b22d0df46c68df8';
  v_intake constant regprocedure := 'public.fn_ca_cash_failed_run_intake()'::regprocedure;
  v_before text := pg_get_functiondef(v_intake);
  v_expected text;
  v_meta_before jsonb;
  v_meta_after jsonb;
BEGIN
  IF md5(pg_get_functiondef('public.fn_record_operational_alert(text,text,text,text,text,jsonb)'::regprocedure))
       IS DISTINCT FROM v_new THEN
    RAISE EXCEPTION 'operational alert recorder postimage differs from the reviewed definition';
  END IF;
  IF (length(v_before) - length(replace(v_before, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'cash failed-run intake must pin the recorder exactly once';
  END IF;
  SELECT jsonb_build_object('owner', pg_get_userbyid(proowner), 'secdef', prosecdef,
           'config', proconfig, 'acl', proacl::text)
    INTO v_meta_before FROM pg_proc WHERE oid = v_intake;
  v_expected := replace(v_before, v_old, v_new);
  EXECUTE v_expected;
  IF pg_get_functiondef(v_intake) IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'cash failed-run intake postimage is not the one-literal replacement';
  END IF;
  SELECT jsonb_build_object('owner', pg_get_userbyid(proowner), 'secdef', prosecdef,
           'config', proconfig, 'acl', proacl::text)
    INTO v_meta_after FROM pg_proc WHERE oid = v_intake;
  IF v_meta_after IS DISTINCT FROM v_meta_before THEN
    RAISE EXCEPTION 'cash failed-run intake authority changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
      WHERE p.oid = 'public.fn_record_operational_alert(text,text,text,text,text,jsonb)'::regprocedure
        AND pg_get_userbyid(p.proowner) = 'postgres' AND NOT p.prosecdef
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
        AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'operational alert recorder authority changed';
  END IF;
END
$repin$;

COMMIT;
