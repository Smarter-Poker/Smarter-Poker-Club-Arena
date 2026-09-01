-- One persisted add-on clock, shared by the engine and the money RPC.
ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS addon_period_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS addon_period_ends_at timestamptz;

COMMENT ON COLUMN public.tournaments.addon_period_ends_at IS
  'Exclusive end of the single 60-second add-on offer after the rebuy period.';

-- Preserve the audited money implementation and put the new clock gate in
-- front of it. This avoids duplicating its wallet locks, idempotency, stack
-- update, no-rake calculation, and prize-pool accounting.
ALTER FUNCTION public.process_tournament_rebuy(uuid, uuid, text, numeric, numeric, integer)
  RENAME TO process_tournament_rebuy_before_one_minute_addon;

-- The renamed implementation is an internal primitive. Leaving its inherited
-- authenticated grant in place would let a client bypass the new clock gate.
REVOKE ALL ON FUNCTION public.process_tournament_rebuy_before_one_minute_addon(
  uuid, uuid, text, numeric, numeric, integer
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.process_tournament_rebuy(
  p_tournament_id uuid,
  p_user_id uuid,
  p_rebuy_type text,
  p_cost numeric,
  p_chips numeric,
  p_current_level integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_cutoff integer;
BEGIN
  SELECT * INTO v_t
  FROM public.tournaments
  WHERE id = p_tournament_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;

  v_cutoff := COALESCE(NULLIF(v_t.late_reg_levels, 0), NULLIF(v_t.rebuy_levels, 0), 0);

  IF p_rebuy_type = 'addon' THEN
    IF v_t.addon_period_started_at IS NULL OR v_t.addon_period_ends_at IS NULL THEN
      RAISE EXCEPTION 'Add-on period has not begun';
    END IF;
    IF clock_timestamp() < v_t.addon_period_started_at THEN
      RAISE EXCEPTION 'Add-on period has not begun';
    END IF;
    IF clock_timestamp() >= v_t.addon_period_ends_at THEN
      RAISE EXCEPTION 'Add-on period has closed';
    END IF;
  ELSIF p_rebuy_type IN ('rebuy', 'reentry')
        AND v_cutoff > 0
        AND COALESCE(p_current_level, v_t.current_level, 0) >= v_cutoff THEN
    RAISE EXCEPTION 'Rebuy period has closed';
  END IF;

  RETURN public.process_tournament_rebuy_before_one_minute_addon(
    p_tournament_id, p_user_id, p_rebuy_type, p_cost, p_chips, p_current_level
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.process_tournament_rebuy(uuid, uuid, text, numeric, numeric, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_tournament_rebuy(uuid, uuid, text, numeric, numeric, integer)
  TO authenticated, service_role;
