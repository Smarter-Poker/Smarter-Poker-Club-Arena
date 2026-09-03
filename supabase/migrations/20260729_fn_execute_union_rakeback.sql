-- On-demand union cross-club rakeback, executed fully server-side (SECURITY
-- DEFINER) so it does NOT depend on the caller's RLS to read rake/wallets, and
-- so the wallet writes (via the whitelisted atomic_wallet_transfer) are allowed
-- by the guard_wallet_balance_write trigger. Atomic + idempotent:
--   * only the union owner may trigger it (auth.uid() check)
--   * a FOR UPDATE lock on the union row serialises concurrent triggers
--   * union_rakeback_log unique(union_id,period_start,period_end) is the backstop
--   * any failed transfer RAISEs -> whole txn rolls back (no partial payout)
--
-- Replaces the dead, RLS-fragile client-side SettlementService.executeUnionRakeBack
-- path (which called SECURITY-INVOKER atomic_wallet_transfer directly and depended
-- on the browser being able to read every club's rake/wallets).
--
-- Applied to production via Supabase MCP on 2026-07-29; committed here to keep the
-- migration history and the phantom-ref CI manifest in sync.

CREATE OR REPLACE FUNCTION public.fn_execute_union_rakeback(
  p_union_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller        uuid := auth.uid();
  v_owner         uuid;
  v_settings      jsonb;
  v_share         numeric;
  v_ratio         numeric;
  v_total         numeric := 0;
  v_owner_balance numeric;
  v_clubs_paid    integer := 0;
  v_club          record;
  v_ok            boolean;
BEGIN
  IF p_union_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'missing_params');
  END IF;

  SELECT owner_id, settings INTO v_owner, v_settings
  FROM unions WHERE id = p_union_id FOR UPDATE;
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union_not_found');
  END IF;

  IF v_caller IS NULL OR v_caller <> v_owner THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;

  IF EXISTS (
    SELECT 1 FROM union_rakeback_log
    WHERE union_id = p_union_id
      AND period_start = p_period_start
      AND period_end = p_period_end
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_executed');
  END IF;

  v_share := COALESCE(NULLIF(v_settings->>'revenueSharePercent', '')::numeric, 10);
  IF v_share < 0 OR v_share > 100 THEN v_share := 10; END IF;
  v_ratio := (100 - v_share) / 100.0;

  CREATE TEMP TABLE _ur_payouts ON COMMIT DROP AS
  SELECT c.id AS club_id,
         c.owner_id AS club_owner,
         trunc(COALESCE(SUM(rr.rake_amount), 0) * v_ratio * 100) / 100 AS rakeback
  FROM clubs c
  LEFT JOIN rake_records rr
         ON rr.club_id = c.id
        AND rr.created_at >= p_period_start
        AND rr.created_at <  p_period_end
  WHERE c.union_id = p_union_id
  GROUP BY c.id, c.owner_id;

  SELECT COALESCE(SUM(rakeback), 0) INTO v_total FROM _ur_payouts WHERE rakeback > 0;

  IF v_total <= 0 THEN
    RETURN jsonb_build_object('success', true, 'clubs_paid', 0,
      'total_rakeback', 0, 'union_retained', 0, 'note', 'no_rake');
  END IF;

  SELECT balance INTO v_owner_balance
  FROM wallets WHERE user_id = v_owner AND wallet_type = 'PLAYER';
  IF COALESCE(v_owner_balance, 0) < v_total THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_balance',
      'required', v_total, 'balance', COALESCE(v_owner_balance, 0));
  END IF;

  FOR v_club IN SELECT club_id, club_owner, rakeback FROM _ur_payouts WHERE rakeback > 0 LOOP
    IF v_club.club_owner IS NULL THEN
      RAISE EXCEPTION 'club % has no owner', v_club.club_id;
    END IF;
    v_ok := atomic_wallet_transfer(
      v_owner, v_club.club_owner, v_club.rakeback,
      'settlement', 'Union rakeback', 'Union rakeback', p_union_id
    );
    IF NOT v_ok THEN
      RAISE EXCEPTION 'union rakeback transfer failed for club %', v_club.club_id;
    END IF;
    v_clubs_paid := v_clubs_paid + 1;
  END LOOP;

  INSERT INTO union_rakeback_log (union_id, period_start, period_end, total_rakeback, executed_at)
  VALUES (p_union_id, p_period_start, p_period_end, v_total, now());

  RETURN jsonb_build_object('success', true,
    'clubs_paid', v_clubs_paid, 'total_rakeback', v_total, 'union_retained', 0);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_execute_union_rakeback(uuid, timestamptz, timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_execute_union_rakeback(uuid, timestamptz, timestamptz) TO authenticated, service_role;
