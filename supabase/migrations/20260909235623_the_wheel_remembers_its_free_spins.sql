-- ═══════════════════════════════════════════════════════════════════════════
--  THE WHEEL REMEMBERS ITS FREE SPINS
--
--  Follows 20260909234101 (the free spin a day). Two reads, no money:
--
--  1. fn_wheel_free_history: the player's own free spins at this host, newest
--     first, in the same shape fn_wheel_history hands back a paid spin. A
--     player who has just won ten diamonds on the house and finds no trace of
--     it in History would rightly call the page broken.
--
--  2. fn_wheel_free_state gains spins_today: how many free spins the host has
--     given today (certification accounts excluded, as they are excluded from
--     the pot). The operator console prints it beside the pot; a player never
--     needed it and is not hurt by it.
--
--  Nothing else changes. The function body below is 20260909234101's with the
--  one field added.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. the player's free spins, newest first ──────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_wheel_free_history(p_club_id uuid, p_limit integer DEFAULT 25)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(public.fn_wheel_free_spin_result(s) ORDER BY s.created_at DESC), '[]'::jsonb)
    FROM (SELECT * FROM public.wheel_free_spins f
           WHERE f.user_id = auth.uid()
             AND f.host_id = (SELECT h.host_id FROM public.fn_wheel_host(p_club_id) h)
           ORDER BY f.created_at DESC
           LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100)) s;
$function$;
REVOKE ALL ON FUNCTION public.fn_wheel_free_history(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_free_history(uuid, integer) TO authenticated, service_role;

-- ── 2. the state counts the day's free spins ──────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_wheel_free_state(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.wheel_configs%ROWTYPE;
  v_day date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_used boolean := false;
  v_paid_today integer := 0;
  v_spins_today integer := 0;
  v_segments jsonb;
  v_reason text := NULL;
  v_member boolean := false;
BEGIN
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = v_host;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('ord', g.ord, 'label', g.label, 'kind', 'diamonds',
                                               'amount', g.amount, 'weight', g.weight,
                                               'value_chips', round(g.amount::numeric / public.fn_ca_bridge_rate(), 4),
                                               'probability', round(g.weight::numeric / t.total, 6),
                                               'locked', false)
                            ORDER BY g.ord), '[]'::jsonb)
    INTO v_segments
    FROM public.wheel_free_segments g, (SELECT sum(weight) AS total FROM public.wheel_free_segments) t;

  IF cfg.host_id IS NULL OR NOT cfg.enabled OR NOT cfg.free_spin_enabled THEN
    v_reason := 'closed';
  END IF;
  IF v_user IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM public.wheel_free_spins f
                    WHERE f.host_id = v_host AND f.user_id = v_user AND f.day = v_day) INTO v_used;
    SELECT EXISTS (SELECT 1 FROM public.club_members m
                    WHERE m.club_id = p_club_id AND m.user_id = v_user
                      AND COALESCE(m.status, 'active') IN ('active', 'approved')) INTO v_member;
  END IF;
  SELECT COALESCE(sum(f.outcome_amount), 0)::integer, count(*)::integer INTO v_paid_today, v_spins_today
    FROM public.wheel_free_spins f WHERE f.host_id = v_host AND f.day = v_day AND NOT f.is_fixture;
  IF v_reason IS NULL AND v_used THEN v_reason := 'used'; END IF;
  IF v_reason IS NULL AND v_paid_today >= COALESCE(cfg.free_spin_daily_budget_diamonds, 0) THEN v_reason := 'pot_empty'; END IF;
  IF v_reason IS NULL AND v_user IS NOT NULL AND NOT v_member THEN v_reason := 'not_member'; END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'enabled', COALESCE(cfg.free_spin_enabled, false) AND COALESCE(cfg.enabled, false),
    'available', v_user IS NOT NULL AND v_reason IS NULL,
    'reason', v_reason,
    'used_today', v_used,
    'pot_diamonds', COALESCE(cfg.free_spin_daily_budget_diamonds, 0),
    'pot_paid_today', v_paid_today,
    'spins_today', v_spins_today,
    'segments', v_segments,
    'day', v_day);
END $function$;
REVOKE ALL ON FUNCTION public.fn_wheel_free_state(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_free_state(uuid) TO authenticated, service_role;

-- ── 3. a caller with no account gets an empty history and no free spin ────
DO $$
DECLARE v_res jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v_res := public.fn_wheel_free_history('00000000-0000-0000-0000-000000000000'::uuid, 5);
  IF v_res <> '[]'::jsonb THEN
    RAISE EXCEPTION 'free history: answered a caller with no account: %', v_res;
  END IF;
  v_res := public.fn_wheel_free_state('a0000000-0000-0000-0000-000000000001'::uuid);
  IF (v_res->>'available')::boolean OR NOT (v_res ? 'spins_today') THEN
    RAISE EXCEPTION 'free state: %', v_res;
  END IF;
END $$;

COMMIT;
