-- SECURITY FIX + feature: fn_bbj_promo_payout_atomic (SECURITY DEFINER, drains the
-- promo pool to caller-supplied recipients) had EXECUTE granted to `authenticated`
-- with NO authorization check — any logged-in user could drain a club's promo pool.
-- Lock it to service_role + the authorized wrapper below. The promo pool is funded
-- on every hand but was never payable (executePromoPayout had no caller).
-- Applied to production via Supabase MCP on 2026-07-29.
REVOKE EXECUTE ON FUNCTION public.fn_bbj_promo_payout_atomic(uuid, numeric, uuid[], text, text) FROM authenticated, anon, public;

CREATE OR REPLACE FUNCTION public.fn_bbj_promo_rain(
  p_pool_id uuid, p_amount numeric, p_reason text DEFAULT 'Promo rain'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_club_id uuid; v_union_id uuid; v_owner uuid; v_is_admin boolean;
  v_recipients uuid[]; v_res jsonb;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
  END IF;
  SELECT club_id, union_id INTO v_club_id, v_union_id FROM bbj_pools WHERE id = p_pool_id;
  IF v_club_id IS NULL AND v_union_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'pool_not_found');
  END IF;
  IF v_union_id IS NOT NULL THEN
    SELECT owner_id INTO v_owner FROM unions WHERE id = v_union_id;
  ELSE
    SELECT owner_id INTO v_owner FROM clubs WHERE id = v_club_id;
  END IF;
  SELECT EXISTS(SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('god','admin')) INTO v_is_admin;
  IF auth.uid() IS NULL OR (auth.uid() <> COALESCE(v_owner,'00000000-0000-0000-0000-000000000000') AND NOT v_is_admin) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  SELECT array_agg(DISTINCT ts.user_id) INTO v_recipients
  FROM table_seats ts JOIN tables t ON t.id = ts.table_id
  WHERE ts.left_at IS NULL AND COALESCE(ts.is_away,false)=false
    AND lower(COALESCE(t.status,'')) NOT IN ('closed','completed','cancelled','finished')
    AND ((v_union_id IS NOT NULL AND t.club_id IN (SELECT id FROM clubs WHERE union_id = v_union_id))
         OR (v_union_id IS NULL AND t.club_id = v_club_id));
  IF v_recipients IS NULL OR array_length(v_recipients,1) IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_active_players');
  END IF;
  v_res := public.fn_bbj_promo_payout_atomic(p_pool_id, p_amount, v_recipients, p_reason, 'rain');
  RETURN v_res;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_bbj_promo_rain(uuid, numeric, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_promo_rain(uuid, numeric, text) TO authenticated, service_role;
