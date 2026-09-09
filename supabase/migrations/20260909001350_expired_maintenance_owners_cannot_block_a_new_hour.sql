-- An expired break from an unreadable boot must not reject every later hour.
-- Active rows still belong exclusively to their token. Only a fresh last-hand
-- announcement may replace a different token after BOTH its adoption window
-- and its recorded end have passed, under the existing exclusive boundary.
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_save_engine_maintenance_break(
  p_phase text,
  p_announced_at timestamptz,
  p_break_started_at timestamptz,
  p_break_ends_at timestamptz,
  p_reason text,
  p_declared_by text,
  p_ownership_token uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '45s'
SET lock_timeout = '40s'
AS $function$
DECLARE
  v_rows integer;
  v_now timestamptz;
BEGIN
  IF p_ownership_token IS NULL THEN
    RAISE EXCEPTION 'MAINTENANCE_OWNERSHIP_TOKEN_REQUIRED'
      USING ERRCODE = '22004';
  END IF;
  PERFORM pg_advisory_xact_lock(530090, 1);
  -- Sample after acquiring the same lock as every maintenance-row writer.
  v_now := clock_timestamp();
  INSERT INTO public.engine_maintenance_break (
    id, phase, announced_at, break_started_at, enforce_freeze,
    break_ends_at, reason, declared_by, ownership_token, updated_at
  ) VALUES (
    true, p_phase, p_announced_at, p_break_started_at, true,
    p_break_ends_at, p_reason, p_declared_by, p_ownership_token, v_now
  )
  ON CONFLICT (id) DO UPDATE SET
    phase = EXCLUDED.phase,
    announced_at = EXCLUDED.announced_at,
    break_started_at = EXCLUDED.break_started_at,
    enforce_freeze = EXCLUDED.enforce_freeze,
    break_ends_at = EXCLUDED.break_ends_at,
    reason = EXCLUDED.reason,
    declared_by = EXCLUDED.declared_by,
    ownership_token = EXCLUDED.ownership_token,
    updated_at = EXCLUDED.updated_at
  WHERE public.engine_maintenance_break.ownership_token = EXCLUDED.ownership_token
     OR (
       -- A delayed countdown/save from the old process is never a new hour.
       EXCLUDED.phase = 'last_hand'
       AND EXCLUDED.break_started_at IS NULL
       AND EXCLUDED.break_ends_at IS NULL
       AND EXCLUDED.announced_at >= v_now - INTERVAL '2 minutes'
       AND EXCLUDED.announced_at <= v_now + INTERVAL '5 seconds'
       AND public.engine_maintenance_break.announced_at < EXCLUDED.announced_at
       -- Match the engine's eight-minute maximum adoption age. Keep an
       -- explicitly later countdown end protected even if its announcement
       -- is older, so renewal cannot shorten a currently recorded break.
       AND public.engine_maintenance_break.announced_at < v_now - INTERVAL '8 minutes'
       AND COALESCE(
         public.engine_maintenance_break.break_ends_at,
         public.engine_maintenance_break.announced_at + INTERVAL '7 minutes'
       ) <= v_now
     );
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'MAINTENANCE_OWNERSHIP_LOST: save refused'
      USING ERRCODE = '40001';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_save_engine_maintenance_break(
  text, timestamptz, timestamptz, timestamptz, text, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_save_engine_maintenance_break(
  text, timestamptz, timestamptz, timestamptz, text, text, uuid
) TO service_role;

COMMIT;
