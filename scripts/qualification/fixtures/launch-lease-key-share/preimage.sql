-- Captured installed pg_get_functiondef of the six launch overloads, production
-- 2026-10-25 20:05 UTC, before 20261025200555 (begin x3 MD5s 4d8cd831ec6b85fd,
-- c0ce5801145ef931, 0f362f2b4a55f82d; complete x3 faeb38ce1a2e975d,
-- d300cf2470354e57, ab0d03139203d89e). Fixture bootstrap for
-- scripts/ci/test-launch-lease-key-share-postgres.py only: every FOR UPDATE on
-- engine_tournament_leases below is the defect, not a pattern to copy.
CREATE OR REPLACE FUNCTION public.fn_begin_tournament_launch_atomic(p_tournament_id uuid, p_launch_id uuid, p_started_at timestamp with time zone, p_lease_generation uuid, p_expected_format text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_format text;
  v_current_generation uuid;
  v_protocol_version integer;
  v_heartbeat_at timestamptz;
  v_receipt_generation uuid;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  PERFORM public.fn_ca_lock_mtt_admission_contract();

  IF p_tournament_id IS NULL OR p_launch_id IS NULL OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_launch_request');
  END IF;

  SELECT l.lease_generation, l.protocol_version, l.heartbeat_at
    INTO v_current_generation, v_protocol_version, v_heartbeat_at
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_protocol_version IS DISTINCT FROM 2
     OR v_current_generation IS DISTINCT FROM p_lease_generation
     OR v_heartbeat_at < clock_timestamp() - interval '30 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_lease_lost');
  END IF;

  v_format := public.fn_ca_tournament_recorded_format(p_tournament_id);
  IF p_expected_format IS DISTINCT FROM v_format THEN
    RETURN jsonb_build_object('ok',false,'reason','launch_format_mismatch','format_contract',v_format);
  END IF;

  v_result := public.fn_begin_tournament_launch_before_lease_generation(
    p_tournament_id,
    p_launch_id,
    p_started_at
  );

  IF COALESCE((v_result ->> 'ok')::boolean, false)
     AND NOT COALESCE((v_result ->> 'completed')::boolean, false) THEN
    SELECT r.lease_generation INTO STRICT v_receipt_generation
      FROM public.tournament_launch_receipts r
     WHERE r.tournament_id = p_tournament_id
     FOR UPDATE;
    IF v_receipt_generation IS DISTINCT FROM p_lease_generation THEN
      PERFORM set_config(
        'app.atomic_tournament_launch_lease_adoption',
        p_tournament_id::text || ':' || v_receipt_generation::text || ':' || p_lease_generation::text,
        true
      );
      UPDATE public.tournament_launch_receipts r
         SET lease_generation = p_lease_generation
       WHERE r.tournament_id = p_tournament_id
         AND r.completed_at IS NULL
         AND r.lease_generation = v_receipt_generation;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'tournament launch receipt changed during lease adoption'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;

  RETURN v_result || jsonb_build_object('lease_generation', p_lease_generation,
    'format_contract', v_format);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_begin_tournament_launch_atomic(p_tournament_id uuid, p_launch_id uuid, p_started_at timestamp with time zone, p_lease_generation uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_format text;
  v_current_generation uuid;
  v_protocol_version integer;
  v_heartbeat_at timestamptz;
  v_receipt_generation uuid;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  PERFORM public.fn_ca_lock_mtt_admission_contract();

  IF p_tournament_id IS NULL OR p_launch_id IS NULL OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_launch_request');
  END IF;

  SELECT l.lease_generation, l.protocol_version, l.heartbeat_at
    INTO v_current_generation, v_protocol_version, v_heartbeat_at
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_protocol_version IS DISTINCT FROM 2
     OR v_current_generation IS DISTINCT FROM p_lease_generation
     OR v_heartbeat_at < clock_timestamp() - interval '30 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_lease_lost');
  END IF;

  v_format := public.fn_ca_tournament_recorded_format(p_tournament_id);
  IF v_format='mtt-v2' THEN
    RETURN jsonb_build_object('ok',false,'reason','launch_format_argument_required','format_contract',v_format);
  END IF;

  v_result := public.fn_begin_tournament_launch_before_lease_generation(
    p_tournament_id,
    p_launch_id,
    p_started_at
  );

  IF COALESCE((v_result ->> 'ok')::boolean, false)
     AND NOT COALESCE((v_result ->> 'completed')::boolean, false) THEN
    SELECT r.lease_generation INTO STRICT v_receipt_generation
      FROM public.tournament_launch_receipts r
     WHERE r.tournament_id = p_tournament_id
     FOR UPDATE;
    IF v_receipt_generation IS DISTINCT FROM p_lease_generation THEN
      PERFORM set_config(
        'app.atomic_tournament_launch_lease_adoption',
        p_tournament_id::text || ':' || v_receipt_generation::text || ':' || p_lease_generation::text,
        true
      );
      UPDATE public.tournament_launch_receipts r
         SET lease_generation = p_lease_generation
       WHERE r.tournament_id = p_tournament_id
         AND r.completed_at IS NULL
         AND r.lease_generation = v_receipt_generation;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'tournament launch receipt changed during lease adoption'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;

  RETURN v_result || jsonb_build_object('lease_generation', p_lease_generation,
    'format_contract', v_format);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_begin_tournament_launch_atomic(p_tournament_id uuid, p_launch_id uuid, p_started_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_format text;
  v_protocol_version integer;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  SELECT l.protocol_version INTO v_protocol_version
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND OR v_protocol_version >= 2 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'legacy_launch_protocol_closed');
  END IF;
  v_format := public.fn_ca_tournament_recorded_format(p_tournament_id);
  IF v_format='mtt-v2' THEN
    RETURN jsonb_build_object('ok',false,'reason','launch_format_argument_required','format_contract',v_format);
  END IF;

  RETURN (public.fn_begin_tournament_launch_before_lease_generation(
    p_tournament_id,
    p_launch_id,
    p_started_at
  )) || jsonb_build_object('format_contract',v_format);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_complete_tournament_launch_atomic(p_tournament_id uuid, p_launch_id uuid, p_lease_generation uuid, p_expected_format text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_format text;
  v_current_generation uuid;
  v_protocol_version integer;
  v_heartbeat_at timestamptz;
  v_receipt_generation uuid;
  v_receipt_launch_id uuid;
  v_result jsonb;
BEGIN
  IF p_tournament_id IS NULL OR p_launch_id IS NULL OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_launch_request');
  END IF;

  SELECT l.lease_generation, l.protocol_version, l.heartbeat_at
    INTO v_current_generation, v_protocol_version, v_heartbeat_at
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_protocol_version IS DISTINCT FROM 2
     OR v_current_generation IS DISTINCT FROM p_lease_generation
     OR v_heartbeat_at < clock_timestamp() - interval '30 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_lease_lost');
  END IF;

  SELECT r.launch_id, r.lease_generation
    INTO v_receipt_launch_id, v_receipt_generation
    FROM public.tournament_launch_receipts r
   WHERE r.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_receipt_launch_id IS DISTINCT FROM p_launch_id
     OR v_receipt_generation IS DISTINCT FROM p_lease_generation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_mismatch');
  END IF;

  v_format := public.fn_ca_tournament_recorded_format(p_tournament_id);
  IF p_expected_format IS DISTINCT FROM v_format THEN
    RETURN jsonb_build_object('ok',false,'reason','launch_format_mismatch','format_contract',v_format);
  END IF;

  v_result := public.fn_complete_tournament_launch_before_lease_generation(
    p_tournament_id,
    p_launch_id
  );
  RETURN v_result || jsonb_build_object('lease_generation', p_lease_generation,
    'format_contract', v_format);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_complete_tournament_launch_atomic(p_tournament_id uuid, p_launch_id uuid, p_lease_generation uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_format text;
  v_current_generation uuid;
  v_protocol_version integer;
  v_heartbeat_at timestamptz;
  v_receipt_generation uuid;
  v_receipt_launch_id uuid;
  v_result jsonb;
BEGIN
  IF p_tournament_id IS NULL OR p_launch_id IS NULL OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_launch_request');
  END IF;

  SELECT l.lease_generation, l.protocol_version, l.heartbeat_at
    INTO v_current_generation, v_protocol_version, v_heartbeat_at
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_protocol_version IS DISTINCT FROM 2
     OR v_current_generation IS DISTINCT FROM p_lease_generation
     OR v_heartbeat_at < clock_timestamp() - interval '30 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_lease_lost');
  END IF;

  SELECT r.launch_id, r.lease_generation
    INTO v_receipt_launch_id, v_receipt_generation
    FROM public.tournament_launch_receipts r
   WHERE r.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_receipt_launch_id IS DISTINCT FROM p_launch_id
     OR v_receipt_generation IS DISTINCT FROM p_lease_generation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_mismatch');
  END IF;

  v_format := public.fn_ca_tournament_recorded_format(p_tournament_id);
  IF v_format='mtt-v2' THEN
    RETURN jsonb_build_object('ok',false,'reason','launch_format_argument_required','format_contract',v_format);
  END IF;

  v_result := public.fn_complete_tournament_launch_before_lease_generation(
    p_tournament_id,
    p_launch_id
  );
  RETURN v_result || jsonb_build_object('lease_generation', p_lease_generation,
    'format_contract', v_format);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_complete_tournament_launch_atomic(p_tournament_id uuid, p_launch_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_format text;
  v_protocol_version integer;
BEGIN
  SELECT l.protocol_version INTO v_protocol_version
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND OR v_protocol_version >= 2 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'legacy_launch_protocol_closed');
  END IF;
  v_format := public.fn_ca_tournament_recorded_format(p_tournament_id);
  IF v_format='mtt-v2' THEN
    RETURN jsonb_build_object('ok',false,'reason','launch_format_argument_required','format_contract',v_format);
  END IF;

  RETURN (public.fn_complete_tournament_launch_before_lease_generation(
    p_tournament_id,
    p_launch_id
  )) || jsonb_build_object('format_contract',v_format);
END;
$function$;
