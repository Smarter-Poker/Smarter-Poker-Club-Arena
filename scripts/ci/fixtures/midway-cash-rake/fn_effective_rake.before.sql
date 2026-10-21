CREATE OR REPLACE FUNCTION public.fn_effective_rake(p_bb numeric, p_pot numeric, p_players_dealt integer, p_saw_flop boolean, p_sb numeric DEFAULT NULL::numeric, p_override_percent numeric DEFAULT NULL::numeric, p_override_cap_bb numeric DEFAULT NULL::numeric, p_seats integer DEFAULT NULL::integer)
 RETURNS TABLE(rake numeric, cap numeric, percent numeric)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  r          public.ca_rake_rules%ROWTYPE;
  v_pct      numeric;
  v_full     numeric;
  v_sched    boolean := false;
  v_cap      numeric;
  v_cap_key  integer;
  v_cap_ovr  boolean := false;
  v_short_ok boolean;
BEGIN
  SELECT * INTO r FROM public.ca_rake_rules WHERE id = 1;

  SELECT p.rake_percent, p.rake_cap, p.scheduled INTO v_pct, v_full, v_sched
    FROM public.fn_rake_stake_price(p_bb, p_sb) p;
  IF v_pct IS NULL THEN
    SELECT t.rake_percent, t.rake_cap INTO v_pct, v_full FROM public.fn_rake_tier_price(p_bb) t;
    v_sched := false;
  END IF;

  IF p_override_percent IS NOT NULL AND p_override_percent >= 0 THEN
    v_pct := LEAST(LEAST(GREATEST(p_override_percent, 0), r.max_rake_percent), v_pct);
  END IF;
  IF p_override_cap_bb IS NOT NULL AND p_override_cap_bb >= 0 THEN
    v_full := LEAST(round(LEAST(GREATEST(p_override_cap_bb, 0), r.max_rake_cap_bb) * p_bb, 2), v_full);
    v_cap_ovr := true;
  END IF;

  IF COALESCE(p_players_dealt, 0) <= 2 THEN
    v_pct := LEAST(v_pct, r.heads_up_percent);
  END IF;

  v_short_ok := p_seats IS NULL OR p_seats <= 0 OR p_seats >= r.short_handed_min_seats;

  v_cap := NULL;
  IF v_sched AND NOT v_cap_ovr THEN
    v_cap_key := CASE WHEN COALESCE(p_players_dealt, 0) >= r.short_handed_max_players + 1 THEN 4
                      WHEN p_players_dealt >= r.short_handed_max_players THEN (CASE WHEN v_short_ok THEN 3 ELSE 4 END)
                      WHEN p_players_dealt >= 2 THEN 2
                      ELSE 4 END;
    SELECT c.rake_cap INTO v_cap
      FROM public.ca_rake_schedule_caps c
     WHERE abs(c.bb - p_bb) < 0.001 AND c.players_dealt = v_cap_key AND c.source = 'schedule';
  END IF;
  IF v_cap IS NULL THEN
    v_cap := public.fn_rake_cap_for_dealt(v_full, COALESCE(p_players_dealt, 0), p_seats);
  END IF;

  IF r.no_flop_no_drop AND NOT COALESCE(p_saw_flop, false) THEN
    RETURN QUERY SELECT 0::numeric, v_cap, v_pct;
  ELSE
    RETURN QUERY SELECT LEAST(round(COALESCE(p_pot, 0) * v_pct, 0) / 100, v_cap), v_cap, v_pct;
  END IF;
END;
$function$
