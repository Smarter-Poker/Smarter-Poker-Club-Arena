-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260415121023 as "fix_agent_commission_credit_bug009_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- BUG 009 FIX — Agent Commission Never Credited
-- (renamed credit_agent_commission to credit_agent_commission_from_rake to avoid
--  collision with existing single-arg credit_agent_commission(uuid,numeric,text))

CREATE OR REPLACE FUNCTION public.increment_agent_rake(p_agent_id uuid, p_amount numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_commission_rate NUMERIC;
  v_commission NUMERIC;
BEGIN
  SELECT commission_rate INTO v_commission_rate FROM agents WHERE id = p_agent_id;
  IF v_commission_rate IS NULL THEN
    RETURN;
  END IF;
  v_commission := ROUND(p_amount * v_commission_rate, 2);
  UPDATE agents SET
    weekly_rake_generated  = COALESCE(weekly_rake_generated, 0)  + p_amount,
    lifetime_rake_generated = COALESCE(lifetime_rake_generated, 0) + p_amount,
    pending_commission     = COALESCE(pending_commission, 0)     + v_commission,
    last_active_at         = NOW(),
    updated_at             = NOW()
  WHERE id = p_agent_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.credit_agent_commission_from_rake(
  p_agent_user_id uuid,
  p_club_id uuid,
  p_rake_credit numeric,
  p_source_type text DEFAULT 'rake_settlement',
  p_source_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent_id UUID;
  v_commission_rate NUMERIC;
  v_commission NUMERIC;
BEGIN
  SELECT id, commission_rate INTO v_agent_id, v_commission_rate
  FROM agents WHERE user_id = p_agent_user_id AND club_id = p_club_id AND status = 'active'
  LIMIT 1;
  IF v_agent_id IS NULL THEN RETURN; END IF;
  v_commission := ROUND(p_rake_credit * COALESCE(v_commission_rate, 0), 2);
  IF v_commission <= 0 THEN RETURN; END IF;
  UPDATE agents SET
    weekly_rake_generated  = COALESCE(weekly_rake_generated, 0)  + p_rake_credit,
    lifetime_rake_generated = COALESCE(lifetime_rake_generated, 0) + p_rake_credit,
    pending_commission     = COALESCE(pending_commission, 0)     + v_commission,
    last_active_at         = NOW(),
    updated_at             = NOW()
  WHERE id = v_agent_id;
  INSERT INTO agent_commissions (
    club_id, user_id, amount, commission_rate, source_type, source_id, notes
  ) VALUES (
    p_club_id, p_agent_user_id, v_commission, v_commission_rate, p_source_type, p_source_id, p_notes
  );
END;
$$;

COMMENT ON FUNCTION public.increment_agent_rake(uuid, numeric) IS 'BUG 009 FIX 2026-04-15 — credits agent rake/commission to agents table (was broken targeting profiles.rake_generated)';
COMMENT ON FUNCTION public.credit_agent_commission_from_rake IS 'BUG 009 FIX 2026-04-15 — credits commission and writes agent_commissions audit row';
