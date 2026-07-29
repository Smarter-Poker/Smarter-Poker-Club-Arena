-- On-demand player-rakeback settlement + status for the admin settlement
-- dashboard. Both admin-gated (profiles.role in god/admin) and SECURITY DEFINER.
--
-- The engine daemon (RakebackSettlerService) settles rakeback automatically; the
-- old "Execute Monday Payouts" button was a retired no-op that lied about success.
-- These give the dashboard (a) real backlog status and (b) an on-demand trigger
-- that just drives the EXISTING idempotent settle_club_rakeback per club
-- (status-guard + rakeback_period_payouts receipt), so it can never double-pay and
-- is safe to re-run or race against the daemon.
--
-- Applied to production via Supabase MCP on 2026-07-29; committed for migration
-- history + phantom-ref CI manifest parity.

CREATE OR REPLACE FUNCTION public.fn_rakeback_settlement_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_is_admin boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('god','admin'))
    INTO v_is_admin;
  IF NOT v_is_admin THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'pending_periods', (SELECT count(*) FROM rakeback_periods
                         WHERE status='pending' AND period_end < CURRENT_DATE),
    'pending_clubs', (SELECT count(DISTINCT club_id) FROM rakeback_periods
                       WHERE status='pending' AND period_end < CURRENT_DATE),
    'estimated_owed', (SELECT COALESCE(round(sum(COALESCE(rakeback_amount, rakeback_earned, 0)),2),0)
                        FROM rakeback_periods WHERE status='pending' AND period_end < CURRENT_DATE),
    'last_paid_at', (SELECT max(paid_at) FROM rakeback_periods WHERE status='paid')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_run_pending_rakeback_settlement(p_max_clubs integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_is_admin  boolean;
  v_club      uuid;
  v_res       jsonb;
  v_clubs     integer := 0;
  v_periods   integer := 0;
  v_total     numeric := 0;
  v_remaining integer;
BEGIN
  SELECT EXISTS(SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('god','admin'))
    INTO v_is_admin;
  IF NOT v_is_admin THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;

  IF p_max_clubs IS NULL OR p_max_clubs < 1 THEN p_max_clubs := 100; END IF;
  IF p_max_clubs > 500 THEN p_max_clubs := 500; END IF;

  FOR v_club IN
    SELECT DISTINCT club_id FROM rakeback_periods
     WHERE status='pending' AND period_end < CURRENT_DATE
     ORDER BY club_id
     LIMIT p_max_clubs
  LOOP
    v_res := public.settle_club_rakeback(v_club);
    IF (v_res->>'success')::boolean THEN
      v_clubs   := v_clubs + 1;
      v_periods := v_periods + COALESCE((v_res->>'periods_settled')::integer, 0);
      v_total   := v_total   + COALESCE((v_res->>'total_payout')::numeric, 0);
    END IF;
  END LOOP;

  SELECT count(DISTINCT club_id) INTO v_remaining FROM rakeback_periods
   WHERE status='pending' AND period_end < CURRENT_DATE;

  RETURN jsonb_build_object('success', true,
    'clubs_processed', v_clubs, 'periods_settled', v_periods,
    'total_payout', v_total, 'clubs_remaining', v_remaining);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_rakeback_settlement_status() FROM public, anon;
REVOKE ALL ON FUNCTION public.fn_run_pending_rakeback_settlement(integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_rakeback_settlement_status() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_run_pending_rakeback_settlement(integer) TO authenticated, service_role;
