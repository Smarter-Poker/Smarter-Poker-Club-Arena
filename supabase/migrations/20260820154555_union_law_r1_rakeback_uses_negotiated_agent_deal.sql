-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820154555 "union_law_r1_rakeback_uses_negotiated_agent_deal"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 9e3654acb2c7f67d304347585a636078 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- R1 — RAKEBACK FOLLOWS THE AGENT DEAL, NOT A HARDCODED LADDER (2026-08-20)
--
-- fn_rakeback_recompute_periods derived every player's rakeback from a fixed
-- volume ladder (>=10k rake -> 30%, >=2k -> 20%, >=500 -> 15%, >=100 -> 10%,
-- else 5%). It never looked at the agent relationship, so:
--
--   * the 586 negotiated player deals just created were dead data, and
--   * rakeback was a platform giveaway rather than something an agent grants
--     out of their own share — the opposite of the PokerBros model, where
--     "an agent might pass most rakeback to loyal players, taking a thin
--     margin on huge volume".
--
-- Precedence is now: the player's negotiated deal, else their agent's default
-- offer, else the legacy volume ladder for players with no agent (so nobody
-- who was earning rakeback silently stops).
--
-- The resolved rate is capped at the upline's own commission less the
-- ten-point gap, so a settlement run can never pay a player more than the
-- agent funding them actually receives.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_player_rakeback_rate(p_user_id uuid, p_club_id uuid, p_volume numeric DEFAULT 0)
 RETURNS numeric
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_deal numeric; v_agent_default numeric; v_upline_rate numeric; v_rate numeric; v_cap numeric;
BEGIN
  SELECT COALESCE(cm.player_rakeback_pct, 0),
         COALESCE(a.player_rakeback_rate, 0),
         COALESCE(a.commission_rate, 0)
    INTO v_deal, v_agent_default, v_upline_rate
    FROM club_members cm
    LEFT JOIN agents a ON a.user_id = cm.agent_id AND a.club_id = cm.club_id AND a.status = 'active'
   WHERE cm.user_id = p_user_id AND cm.club_id = p_club_id
   LIMIT 1;

  -- 1. the player's own negotiated deal
  IF COALESCE(v_deal,0) > 0 THEN
    v_rate := v_deal;
  -- 2. their agent's standing offer
  ELSIF COALESCE(v_agent_default,0) > 0 THEN
    v_rate := v_agent_default;
  -- 3. legacy volume ladder (players with no agent)
  ELSE
    v_rate := CASE WHEN p_volume >= 10000 THEN 0.30
                   WHEN p_volume >=  2000 THEN 0.20
                   WHEN p_volume >=   500 THEN 0.15
                   WHEN p_volume >=   100 THEN 0.10
                   ELSE 0.05 END;
  END IF;

  -- Never more than the upline receives, less the ten-point gap.
  IF COALESCE(v_upline_rate,0) > 0 THEN
    v_cap := GREATEST(v_upline_rate - 0.10, 0);
    v_rate := LEAST(v_rate, v_cap);
  END IF;

  RETURN GREATEST(ROUND(COALESCE(v_rate,0), 4), 0);
END $function$;

GRANT EXECUTE ON FUNCTION public.fn_player_rakeback_rate(uuid, uuid, numeric) TO authenticated;

CREATE OR REPLACE FUNCTION public.fn_rakeback_recompute_periods(p_club_id uuid, p_period_start date, p_period_end date, p_user_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_written integer := 0;
BEGIN
  IF p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL THEN
    RETURN jsonb_build_object('written', 0, 'error', 'missing params');
  END IF;

  WITH shares AS (
    SELECT (k.key)::uuid AS user_id,
           (round(r.rake_amount * 100)::bigint / c.n)
           + CASE WHEN (SELECT count(*) FROM jsonb_each(r.player_contributions) e2
                         WHERE (e2.value)::numeric > 0 AND e2.key <= k.key)
                       <= (round(r.rake_amount * 100)::bigint % c.n)
                  THEN 1 ELSE 0 END AS cents
      FROM rake_records r
      CROSS JOIN LATERAL (
        SELECT count(*)::bigint AS n
          FROM jsonb_each(r.player_contributions) e
         WHERE (e.value)::numeric > 0
      ) c
      JOIN LATERAL jsonb_each(r.player_contributions) k
        ON (k.value)::numeric > 0
     WHERE r.club_id = p_club_id
       AND r.created_at >= p_period_start::timestamptz
       AND r.created_at <  (p_period_end + 1)::timestamptz
       AND r.rake_amount > 0
       AND r.player_contributions IS NOT NULL
       AND c.n > 0
  ), totals AS (
    SELECT s.user_id, (SUM(s.cents)::numeric / 100) AS total_rake
      FROM shares s
     WHERE p_user_ids IS NULL OR s.user_id = ANY (p_user_ids)
     GROUP BY s.user_id
  ), eligible AS (
    SELECT t.user_id, t.total_rake,
           -- UNION LAW: the agent deal decides the rate, not a fixed ladder.
           public.fn_player_rakeback_rate(t.user_id, p_club_id, t.total_rake) AS rate
      FROM totals t
     WHERE NOT EXISTS (
       SELECT 1 FROM rakeback_periods rp
        WHERE rp.user_id = t.user_id
          AND rp.period_start = p_period_start
          AND rp.club_id <> p_club_id
     )
  ), ins AS (
    INSERT INTO rakeback_periods (
      user_id, club_id, period_start, period_end,
      rake_generated, rakeback_rate, rakeback_earned, rakeback_amount,
      total_rake_paid, status
    )
    SELECT e.user_id, p_club_id, p_period_start, p_period_end,
           round(e.total_rake, 2), e.rate,
           round(e.total_rake * e.rate, 2), round(e.total_rake * e.rate, 2),
           round(e.total_rake, 2), 'pending'
      FROM eligible e
     WHERE e.rate > 0
    ON CONFLICT ON CONSTRAINT rakeback_periods_user_period_unique DO UPDATE
      SET club_id         = EXCLUDED.club_id,
          period_end      = EXCLUDED.period_end,
          rake_generated  = EXCLUDED.rake_generated,
          rakeback_rate   = EXCLUDED.rakeback_rate,
          rakeback_earned = EXCLUDED.rakeback_earned,
          rakeback_amount = EXCLUDED.rakeback_amount,
          total_rake_paid = EXCLUDED.total_rake_paid
      WHERE rakeback_periods.status = 'pending'
    RETURNING 1
  )
  SELECT count(*) INTO v_written FROM ins;

  RETURN jsonb_build_object('written', v_written);
END $function$;

