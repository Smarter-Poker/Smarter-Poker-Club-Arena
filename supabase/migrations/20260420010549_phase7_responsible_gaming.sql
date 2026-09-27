-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420010549 "phase7_responsible_gaming"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 50eac8966935537f8f64548fa8263e36 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 7.1.5 — Responsible-Gaming limits + sessions
-- ═══════════════════════════════════════════════════════════════════════════
-- Limits (per-user): daily/weekly/monthly deposit caps, daily loss cap,
-- session time limit, reality-check interval, self-exclusion window,
-- cooling-off window. Sessions (per-login play segment): start/end + array
-- of reality-check show times.
--
-- Design invariants:
--   • User can LOWER a limit instantly.
--   • User can RAISE a limit only after a 24h cooling-off period.
--   • self_excluded_until and cooling_off_until are monotonic: setting a
--     later value is allowed, setting an earlier value is NOT.
--   • RLS: users read/write own; admins read all.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.responsible_gaming_limits (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  daily_deposit_limit     NUMERIC CHECK (daily_deposit_limit   IS NULL OR daily_deposit_limit   >= 0),
  weekly_deposit_limit    NUMERIC CHECK (weekly_deposit_limit  IS NULL OR weekly_deposit_limit  >= 0),
  monthly_deposit_limit   NUMERIC CHECK (monthly_deposit_limit IS NULL OR monthly_deposit_limit >= 0),
  daily_loss_limit        NUMERIC CHECK (daily_loss_limit      IS NULL OR daily_loss_limit      >= 0),
  session_time_limit_minutes INT CHECK (session_time_limit_minutes IS NULL OR session_time_limit_minutes BETWEEN 15 AND 1440),
  reality_check_interval_minutes INT NOT NULL DEFAULT 30
    CHECK (reality_check_interval_minutes BETWEEN 5 AND 240),
  self_excluded_until     TIMESTAMPTZ,
  cooling_off_until       TIMESTAMPTZ,
  -- Tracks when user may next INCREASE a limit (LOWERING is always allowed)
  limit_increase_available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rg_limits_self_excluded ON public.responsible_gaming_limits (self_excluded_until)
  WHERE self_excluded_until IS NOT NULL;

ALTER TABLE public.responsible_gaming_limits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rg_limits_service_all ON public.responsible_gaming_limits;
CREATE POLICY rg_limits_service_all ON public.responsible_gaming_limits
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rg_limits_user_select_own ON public.responsible_gaming_limits;
CREATE POLICY rg_limits_user_select_own ON public.responsible_gaming_limits
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS rg_limits_admin_select_all ON public.responsible_gaming_limits;
CREATE POLICY rg_limits_admin_select_all ON public.responsible_gaming_limits
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.role IN ('admin','owner','super_agent')
  ));

COMMENT ON TABLE public.responsible_gaming_limits IS
  'Phase 7.1.5: per-user deposit/loss/time caps, self-exclusion, cooling-off.';

-- Sessions table
CREATE TABLE IF NOT EXISTS public.responsible_gaming_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at   TIMESTAMPTZ,
  reality_check_shown_at TIMESTAMPTZ[] NOT NULL DEFAULT ARRAY[]::TIMESTAMPTZ[],
  force_closed_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rg_sessions_user_open
  ON public.responsible_gaming_sessions (user_id)
  WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rg_sessions_user_started
  ON public.responsible_gaming_sessions (user_id, started_at DESC);

ALTER TABLE public.responsible_gaming_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rg_sessions_service_all ON public.responsible_gaming_sessions;
CREATE POLICY rg_sessions_service_all ON public.responsible_gaming_sessions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rg_sessions_user_select_own ON public.responsible_gaming_sessions;
CREATE POLICY rg_sessions_user_select_own ON public.responsible_gaming_sessions
  FOR SELECT TO authenticated USING (user_id = auth.uid());

COMMENT ON TABLE public.responsible_gaming_sessions IS
  'Phase 7.1.5: play-session segments with reality-check timestamps for time-on-device enforcement.';

-- RPC: set/update limits (LOWERING is instant; RAISING requires limit_increase_available_at <= now)
CREATE OR REPLACE FUNCTION public.fn_rg_set_limits(
  p_user_id UUID,
  p_daily_deposit_limit NUMERIC DEFAULT NULL,
  p_weekly_deposit_limit NUMERIC DEFAULT NULL,
  p_monthly_deposit_limit NUMERIC DEFAULT NULL,
  p_daily_loss_limit NUMERIC DEFAULT NULL,
  p_session_time_limit_minutes INT DEFAULT NULL,
  p_reality_check_interval_minutes INT DEFAULT NULL,
  p_is_increase BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_existing public.responsible_gaming_limits%ROWTYPE;
  v_lock_hours INT := 24; -- cooling-off before the next increase takes effect
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'p_user_id required'; END IF;

  SELECT * INTO v_existing FROM public.responsible_gaming_limits WHERE user_id = p_user_id;

  -- If user is trying to INCREASE and they're still locked, reject
  IF p_is_increase AND v_existing.user_id IS NOT NULL
     AND v_now < v_existing.limit_increase_available_at THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'cooling_off',
      'increase_available_at', v_existing.limit_increase_available_at
    );
  END IF;

  INSERT INTO public.responsible_gaming_limits AS rgl (
    user_id,
    daily_deposit_limit,  weekly_deposit_limit, monthly_deposit_limit,
    daily_loss_limit,     session_time_limit_minutes,
    reality_check_interval_minutes,
    limit_increase_available_at,
    updated_at
  ) VALUES (
    p_user_id,
    p_daily_deposit_limit, p_weekly_deposit_limit, p_monthly_deposit_limit,
    p_daily_loss_limit,    p_session_time_limit_minutes,
    COALESCE(p_reality_check_interval_minutes, 30),
    CASE WHEN p_is_increase THEN v_now + (v_lock_hours || ' hours')::interval
         ELSE v_now
    END,
    v_now
  )
  ON CONFLICT (user_id) DO UPDATE SET
    daily_deposit_limit            = COALESCE(EXCLUDED.daily_deposit_limit, rgl.daily_deposit_limit),
    weekly_deposit_limit           = COALESCE(EXCLUDED.weekly_deposit_limit, rgl.weekly_deposit_limit),
    monthly_deposit_limit          = COALESCE(EXCLUDED.monthly_deposit_limit, rgl.monthly_deposit_limit),
    daily_loss_limit               = COALESCE(EXCLUDED.daily_loss_limit, rgl.daily_loss_limit),
    session_time_limit_minutes     = COALESCE(EXCLUDED.session_time_limit_minutes, rgl.session_time_limit_minutes),
    reality_check_interval_minutes = COALESCE(EXCLUDED.reality_check_interval_minutes, rgl.reality_check_interval_minutes),
    limit_increase_available_at    = CASE WHEN p_is_increase
                                          THEN v_now + (v_lock_hours || ' hours')::interval
                                          ELSE rgl.limit_increase_available_at END,
    updated_at                     = v_now;

  RETURN jsonb_build_object('ok', true, 'updated_at', v_now);
END;
$$;

-- RPC: self-exclude (monotonic — can only extend)
CREATE OR REPLACE FUNCTION public.fn_rg_self_exclude(
  p_user_id UUID,
  p_duration_hours INT           -- 0 or NULL = indefinite/permanent
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_until TIMESTAMPTZ;
  v_existing TIMESTAMPTZ;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'p_user_id required'; END IF;

  v_until := CASE
    WHEN p_duration_hours IS NULL OR p_duration_hours <= 0 THEN 'infinity'::timestamptz
    ELSE v_now + (p_duration_hours || ' hours')::interval
  END;

  SELECT self_excluded_until INTO v_existing
    FROM public.responsible_gaming_limits WHERE user_id = p_user_id;

  IF v_existing IS NOT NULL AND v_existing > v_until THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'cannot_shorten_exclusion',
      'self_excluded_until', v_existing
    );
  END IF;

  INSERT INTO public.responsible_gaming_limits (user_id, self_excluded_until, updated_at)
  VALUES (p_user_id, v_until, v_now)
  ON CONFLICT (user_id) DO UPDATE SET
    self_excluded_until = v_until,
    updated_at = v_now;

  -- Close any open session
  UPDATE public.responsible_gaming_sessions
     SET ended_at = v_now, force_closed_reason = 'self_exclusion'
   WHERE user_id = p_user_id AND ended_at IS NULL;

  RETURN jsonb_build_object('ok', true, 'self_excluded_until', v_until);
END;
$$;

-- RPC: deposit pre-check
CREATE OR REPLACE FUNCTION public.fn_rg_check_deposit(
  p_user_id UUID,
  p_amount NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limits public.responsible_gaming_limits%ROWTYPE;
  v_now TIMESTAMPTZ := now();
  v_deposited_today NUMERIC;
  v_deposited_week NUMERIC;
  v_deposited_month NUMERIC;
BEGIN
  IF p_user_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_args');
  END IF;

  SELECT * INTO v_limits FROM public.responsible_gaming_limits WHERE user_id = p_user_id;

  -- No limits → allow
  IF v_limits.user_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'no_limits_set');
  END IF;

  -- Self-exclusion
  IF v_limits.self_excluded_until IS NOT NULL AND v_limits.self_excluded_until > v_now THEN
    RETURN jsonb_build_object('ok', false, 'error', 'self_excluded',
      'self_excluded_until', v_limits.self_excluded_until);
  END IF;

  -- Cooling-off (hard block during cooldown)
  IF v_limits.cooling_off_until IS NOT NULL AND v_limits.cooling_off_until > v_now THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cooling_off',
      'cooling_off_until', v_limits.cooling_off_until);
  END IF;

  -- Sum ledger deposit-category rows (category IN ('deposit','deposit_topup','diamond_purchase_bonus'))
  SELECT COALESCE(SUM(amount), 0) INTO v_deposited_today
    FROM public.chip_ledger
   WHERE to_entity_id = p_user_id AND to_type = 'player_wallet'
     AND category IN ('deposit','deposit_topup')
     AND created_at >= date_trunc('day', v_now);
  SELECT COALESCE(SUM(amount), 0) INTO v_deposited_week
    FROM public.chip_ledger
   WHERE to_entity_id = p_user_id AND to_type = 'player_wallet'
     AND category IN ('deposit','deposit_topup')
     AND created_at >= date_trunc('week', v_now);
  SELECT COALESCE(SUM(amount), 0) INTO v_deposited_month
    FROM public.chip_ledger
   WHERE to_entity_id = p_user_id AND to_type = 'player_wallet'
     AND category IN ('deposit','deposit_topup')
     AND created_at >= date_trunc('month', v_now);

  IF v_limits.daily_deposit_limit IS NOT NULL
     AND v_deposited_today + p_amount > v_limits.daily_deposit_limit THEN
    RETURN jsonb_build_object('ok', false, 'error', 'daily_deposit_limit_exceeded',
      'limit', v_limits.daily_deposit_limit, 'already', v_deposited_today, 'attempted', p_amount);
  END IF;
  IF v_limits.weekly_deposit_limit IS NOT NULL
     AND v_deposited_week + p_amount > v_limits.weekly_deposit_limit THEN
    RETURN jsonb_build_object('ok', false, 'error', 'weekly_deposit_limit_exceeded',
      'limit', v_limits.weekly_deposit_limit, 'already', v_deposited_week, 'attempted', p_amount);
  END IF;
  IF v_limits.monthly_deposit_limit IS NOT NULL
     AND v_deposited_month + p_amount > v_limits.monthly_deposit_limit THEN
    RETURN jsonb_build_object('ok', false, 'error', 'monthly_deposit_limit_exceeded',
      'limit', v_limits.monthly_deposit_limit, 'already', v_deposited_month, 'attempted', p_amount);
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- RPC: check not self-excluded / cooling-off (called on seat attempt)
CREATE OR REPLACE FUNCTION public.fn_rg_require_not_excluded(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limits public.responsible_gaming_limits%ROWTYPE;
  v_now TIMESTAMPTZ := now();
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'p_user_id required'; END IF;

  SELECT * INTO v_limits FROM public.responsible_gaming_limits WHERE user_id = p_user_id;

  IF v_limits.user_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'no_limits_set');
  END IF;

  IF v_limits.self_excluded_until IS NOT NULL AND v_limits.self_excluded_until > v_now THEN
    RETURN jsonb_build_object('ok', false, 'error', 'self_excluded',
      'self_excluded_until', v_limits.self_excluded_until);
  END IF;
  IF v_limits.cooling_off_until IS NOT NULL AND v_limits.cooling_off_until > v_now THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cooling_off',
      'cooling_off_until', v_limits.cooling_off_until);
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- RPC: start session (idempotent — returns existing open session if any)
CREATE OR REPLACE FUNCTION public.fn_rg_start_session(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session_id UUID;
  v_started TIMESTAMPTZ;
  v_check JSONB;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'p_user_id required'; END IF;

  v_check := public.fn_rg_require_not_excluded(p_user_id);
  IF (v_check->>'ok')::BOOLEAN IS DISTINCT FROM true THEN
    RETURN v_check;
  END IF;

  SELECT id, started_at INTO v_session_id, v_started
    FROM public.responsible_gaming_sessions
   WHERE user_id = p_user_id AND ended_at IS NULL
   ORDER BY started_at DESC LIMIT 1;

  IF v_session_id IS NULL THEN
    INSERT INTO public.responsible_gaming_sessions (user_id)
      VALUES (p_user_id) RETURNING id, started_at INTO v_session_id, v_started;
  END IF;

  RETURN jsonb_build_object('ok', true, 'session_id', v_session_id, 'started_at', v_started);
END;
$$;

-- RPC: end session
CREATE OR REPLACE FUNCTION public.fn_rg_end_session(p_user_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows INT;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'p_user_id required'; END IF;
  UPDATE public.responsible_gaming_sessions
     SET ended_at = now(), force_closed_reason = p_reason
   WHERE user_id = p_user_id AND ended_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'closed_sessions', v_rows);
END;
$$;

-- RPC: reality-check — returns { show, session_minutes, interval_minutes }
CREATE OR REPLACE FUNCTION public.fn_rg_should_show_reality_check(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_interval INT := 30;
  v_started TIMESTAMPTZ;
  v_session_id UUID;
  v_last_shown TIMESTAMPTZ;
  v_session_minutes NUMERIC;
  v_should_show BOOLEAN := false;
  v_time_limit INT;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'p_user_id required'; END IF;

  SELECT reality_check_interval_minutes, session_time_limit_minutes
    INTO v_interval, v_time_limit
    FROM public.responsible_gaming_limits WHERE user_id = p_user_id;
  v_interval := COALESCE(v_interval, 30);

  SELECT id, started_at,
         (SELECT MAX(t) FROM unnest(reality_check_shown_at) t)
    INTO v_session_id, v_started, v_last_shown
    FROM public.responsible_gaming_sessions
   WHERE user_id = p_user_id AND ended_at IS NULL
   ORDER BY started_at DESC LIMIT 1;

  IF v_session_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'show', false, 'reason', 'no_open_session');
  END IF;

  v_session_minutes := EXTRACT(EPOCH FROM (now() - v_started)) / 60.0;

  -- Hard-cap: session exceeded time limit → force end + show
  IF v_time_limit IS NOT NULL AND v_session_minutes >= v_time_limit THEN
    UPDATE public.responsible_gaming_sessions
       SET ended_at = now(), force_closed_reason = 'session_time_limit'
     WHERE id = v_session_id;
    RETURN jsonb_build_object('ok', true, 'show', true, 'force_logout', true,
      'reason', 'session_time_limit', 'session_minutes', v_session_minutes,
      'limit_minutes', v_time_limit);
  END IF;

  -- Reality-check interval
  IF v_last_shown IS NULL THEN
    v_should_show := v_session_minutes >= v_interval;
  ELSE
    v_should_show := EXTRACT(EPOCH FROM (now() - v_last_shown)) / 60.0 >= v_interval;
  END IF;

  IF v_should_show THEN
    UPDATE public.responsible_gaming_sessions
       SET reality_check_shown_at = reality_check_shown_at || now()
     WHERE id = v_session_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'show', v_should_show,
    'session_id', v_session_id,
    'session_minutes', round(v_session_minutes::numeric, 2),
    'interval_minutes', v_interval,
    'force_logout', false
  );
END;
$$;

-- Verification
DO $$
DECLARE v_tables INT; v_fns INT;
BEGIN
  SELECT COUNT(*) INTO v_tables FROM information_schema.tables
    WHERE table_schema='public' AND table_name IN ('responsible_gaming_limits','responsible_gaming_sessions');
  IF v_tables <> 2 THEN RAISE EXCEPTION 'RG tables: expected 2, found %', v_tables; END IF;

  SELECT COUNT(*) INTO v_fns FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN (
      'fn_rg_set_limits','fn_rg_self_exclude','fn_rg_check_deposit',
      'fn_rg_require_not_excluded','fn_rg_start_session','fn_rg_end_session',
      'fn_rg_should_show_reality_check'
    );
  IF v_fns <> 7 THEN RAISE EXCEPTION 'RG functions: expected 7, found %', v_fns; END IF;

  RAISE NOTICE 'Phase 7.1.5 RG installed: tables=% fns=%', v_tables, v_fns;
END
$$;
