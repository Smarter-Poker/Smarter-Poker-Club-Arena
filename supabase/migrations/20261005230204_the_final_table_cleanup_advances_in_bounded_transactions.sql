-- Forward-only continuation of 20261005111523. Its recorded ledger is preserved.
-- Manual data migration only: no scheduled caller, no trigger bypass, no money write.
-- A page visits at most 200 primary-key rows and commits its cursor and request
-- receipt together. The installer sends each page as a separate autocommit query.
-- @live-proof: to_regprocedure('public.fn_advance_final_table_cleanup(uuid)') IS NOT NULL
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public.final_table_cleanup_progress (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_id uuid,
  complete boolean NOT NULL DEFAULT false
);
INSERT INTO public.final_table_cleanup_progress(singleton) VALUES (true);
CREATE TABLE public.final_table_cleanup_receipts (
  request_id uuid PRIMARY KEY,
  result jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.final_table_cleanup_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.final_table_cleanup_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.final_table_cleanup_progress, public.final_table_cleanup_receipts
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.fn_assert_final_table_cleanup_cutover()
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp
AS $guard$
DECLARE
  v_missing text;
  v_client_sha text;
  v_engine_sha text;
  v_sealed_at timestamptz;
  v_heartbeat_at timestamptz;
  v_live_versions bigint;
  v_wrong_versions bigint;
BEGIN
  IF public.fn_platform_frozen() IS DISTINCT FROM false
     OR public.fn_ca_break_window_refuses_migrations(clock_timestamp()) IS NOT NULL THEN
    RAISE EXCEPTION 'final-table cleanup: maintenance refuses this transaction' USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.tournaments') IS NULL THEN
    RAISE EXCEPTION 'final-table format guard: public.tournaments is missing';
  END IF;

  SELECT string_agg(required.column_name, ', ' ORDER BY required.column_name)
    INTO v_missing
    FROM (VALUES ('final_table_triggered'), ('format_contract')) AS required(column_name)
   WHERE NOT EXISTS (
     SELECT 1
       FROM information_schema.columns actual
      WHERE actual.table_schema = 'public'
        AND actual.table_name = 'tournaments'
        AND actual.column_name = required.column_name
   );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'final-table format guard: required columns are missing: %', v_missing;
  END IF;

  IF to_regclass('public.tournament_final_table_transition_receipts') IS NULL
     OR to_regclass('public.tournament_final_table_events') IS NULL
     OR to_regclass('public.phase_one_customization_prerequisite') IS NULL
     OR to_regclass('public.phase_one_customization_cutover_seals') IS NULL
     OR to_regclass('public.ca_engine_deploy_attempts') IS NULL
     OR to_regclass('public.engine_leader') IS NULL
     OR to_regclass('public.engine_table_leases') IS NULL
     OR to_regprocedure('public.fn_set_interface_theme(uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.fn_mark_table_setting_touched(uuid,text[])') IS NULL
     OR to_regprocedure('public.fn_seed_table_studio_preferences(uuid,text[],jsonb)') IS NULL
     OR to_regprocedure(
       'public.fn_mutate_table_studio_preferences(uuid,text,boolean,integer,jsonb)'
     ) IS NULL
     OR to_regprocedure('public.fn_claim_final_table_transition(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_read_final_table_transition(uuid)') IS NULL
     OR to_regprocedure('public.fn_ack_final_table_announcement(uuid,uuid)') IS NULL
     OR to_regprocedure(
       'public.fn_seal_phase_one_customization_cutover(text,text)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'post-cutover guard: install 20261005111453 and release the compatible client and engine first';
  END IF;

  SELECT s.client_sha, s.engine_sha, s.sealed_at
    INTO v_client_sha, v_engine_sha, v_sealed_at
    FROM public.phase_one_customization_cutover_seals s
   WHERE s.contract = 'phase1-customization-v1'
   ORDER BY s.sealed_at DESC
   LIMIT 1;

  IF v_sealed_at IS NULL
     OR v_client_sha !~ '^[0-9a-f]{40}$'
     OR v_engine_sha !~ '^[0-9a-f]{40}$' THEN
    RAISE EXCEPTION
      'post-cutover guard: exact live client and engine identities have not been sealed'
      USING ERRCODE = '55000';
  END IF;

  -- Lease heartbeats store the audited eight-character runtime version. The
  -- seal retains the exact full SHA already proved by its shipped deploy
  -- receipt and live /health read. Fail closed on NULL or any other value.
  WITH live AS (
    SELECT l.engine_version, l.heartbeat_at
      FROM public.engine_leader l
     WHERE l.heartbeat_at > clock_timestamp() - interval '180 seconds'
    UNION ALL
    SELECT l.engine_version, l.heartbeat_at
      FROM public.engine_table_leases l
     WHERE l.heartbeat_at > clock_timestamp() - interval '180 seconds'
  )
  SELECT max(live.heartbeat_at),
         count(DISTINCT coalesce(live.engine_version, '<null>')),
         count(*) FILTER (
           WHERE live.engine_version IS DISTINCT FROM left(v_engine_sha, 8)
         )
    INTO v_heartbeat_at, v_live_versions, v_wrong_versions
    FROM live;

  IF v_heartbeat_at IS NULL OR v_live_versions <> 1 OR v_wrong_versions <> 0 THEN
    RAISE EXCEPTION
      'post-cutover guard: the sealed engine is not the one currently heartbeating'
      USING ERRCODE = '55000';
  END IF;
END;
$guard$;
REVOKE ALL ON FUNCTION public.fn_assert_final_table_cleanup_cutover()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.fn_advance_final_table_cleanup(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp
AS $batch$
DECLARE
  v_progress public.final_table_cleanup_progress%ROWTYPE;
  v_result jsonb;
  v_ids uuid[];
  v_last uuid;
  v_count integer;
  v_updated integer;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'final-table cleanup: request identity required' USING ERRCODE = '22023';
  END IF;
  -- Require the caller's bounded top-level statement. A function-local timeout
  -- alone cannot limit the statement that already entered the function.
  IF current_setting('statement_timeout')::interval <= interval '0'
     OR current_setting('statement_timeout')::interval > interval '5 seconds'
     OR clock_timestamp() - transaction_timestamp() > interval '2 seconds' THEN
    RAISE EXCEPTION 'final-table cleanup: fresh transaction and at most 5s statement timeout required'
      USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('lock_timeout', '500ms', true);
  PERFORM set_config('idle_in_transaction_session_timeout', '5s', true);
  SELECT * INTO STRICT v_progress FROM public.final_table_cleanup_progress
    WHERE singleton FOR UPDATE NOWAIT;
  SELECT result INTO v_result FROM public.final_table_cleanup_receipts WHERE request_id = p_request_id;
  IF FOUND THEN RETURN v_result; END IF;
  PERFORM public.fn_assert_final_table_cleanup_cutover();
  IF v_progress.complete THEN
    v_result := jsonb_build_object('visited',0,'updated',0,'complete',true,'last_id',v_progress.last_id);
  ELSE
    -- Do not SKIP LOCKED: advancing past a locked row would silently lose it.
    SELECT array_agg(page.id ORDER BY page.id), count(*)
      INTO v_ids, v_count
      FROM (SELECT id FROM public.tournaments
            WHERE id >= coalesce(v_progress.last_id, '00000000-0000-0000-0000-000000000000'::uuid)
              AND (v_progress.last_id IS NULL OR id <> v_progress.last_id)
            ORDER BY id LIMIT 200 FOR UPDATE NOWAIT) page;
    v_last := v_ids[array_length(v_ids, 1)];
    UPDATE public.tournaments SET final_table_triggered = false
      WHERE id = ANY(v_ids)
        AND (final_table_triggered IS NULL OR
          (final_table_triggered IS TRUE AND (format_contract IN ('mtt-v1','mtt-v2')) IS NOT TRUE));
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    UPDATE public.final_table_cleanup_progress
      SET last_id = coalesce(v_last, last_id), complete = v_count < 200 WHERE singleton;
    v_result := jsonb_build_object('visited',v_count,'updated',v_updated,
      'complete',v_count < 200,'last_id',coalesce(v_last,v_progress.last_id));
  END IF;
  INSERT INTO public.final_table_cleanup_receipts(request_id,result) VALUES(p_request_id,v_result);
  RETURN v_result;
END;
$batch$;
REVOKE ALL ON FUNCTION public.fn_advance_final_table_cleanup(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
