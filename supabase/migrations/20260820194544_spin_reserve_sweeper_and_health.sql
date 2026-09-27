-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820194544 "spin_reserve_sweeper_and_health"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a903a981ec10822eed2418fbeee32faf of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- 20260820_spin_reserve_sweeper_and_health.sql
-- TIER: 2  |  AFFECTS: rpcs fn_spin_sweep_unbooked, view v_spin_reserve_health
-- IRREVERSIBLE: no
--
-- WHY:
--   Settlement is best-effort by necessity — the game must run even if the
--   ledger write fails. Retries make that rare, but "rare" is not "never", and
--   an unbooked game is invisible: no row exists to notice the absence of.
--   This is the backstop that turns a silent hole into a self-healing one.
--
--   The health view exists because the failure that actually bit was a THIN
--   POOL, not a broken function. A club whose reserve runs down does not error
--   — its multiplier ladder quietly collapses toward 2x/3x, which players feel
--   long before any exception is raised.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_spin_sweep_unbooked(p_lookback_mins integer DEFAULT 180)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE v_t record; v_n integer := 0; v_fail integer := 0; v_res jsonb;
BEGIN
  FOR v_t IN
    SELECT t.id, t.club_id, t.buy_in_amount, t.current_players, t.spin_multiplier
    FROM public.tournaments t
    WHERE t.variant = 'spin'
      AND t.status IN ('RUNNING','COMPLETED')
      AND COALESCE(t.buy_in_fee, 0) = 0          -- post-cutover pricing only
      AND COALESCE(t.spin_multiplier, 0) > 0
      AND t.club_id IS NOT NULL
      AND COALESCE(t.current_players, 0) > 0
      AND t.started_at > now() - make_interval(mins => p_lookback_mins)
      AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l
                      WHERE l.tournament_id = t.id)
  LOOP
    BEGIN
      v_res := public.fn_spin_settle_game(
        v_t.id, v_t.club_id, v_t.buy_in_amount, v_t.current_players, v_t.spin_multiplier,
        CASE WHEN v_t.buy_in_amount <= 5  THEN 0.08
             WHEN v_t.buy_in_amount <= 10 THEN 0.07
             WHEN v_t.buy_in_amount <= 50 THEN 0.06
             ELSE 0.05 END);
      IF COALESCE((v_res->>'ok')::boolean, false) THEN v_n := v_n + 1;
      ELSE v_fail := v_fail + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      -- One bad row must not stop the sweep.
      v_fail := v_fail + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'settled', v_n, 'failed', v_fail,
                            'lookback_mins', p_lookback_mins);
END; $fn$;

-- Operator health. Deliberately a VIEW rather than a dashboard query so the
-- definition of "thin" lives in one place.
CREATE OR REPLACE VIEW public.v_spin_reserve_health AS
SELECT
  p.club_id,
  c.name AS club_name,
  p.balance,
  p.seeded_amount,
  p.highest_stake,
  p.ceiling_amount,
  p.spin_count,
  p.total_deposited,
  p.total_drawn,
  -- Can the pool cover its own top jackpot at the biggest stake it runs?
  round(p.highest_stake * 500, 2)                      AS top_jackpot,
  round(p.highest_stake * 500 * 2.0, 2)                AS need_for_500x,
  round(p.highest_stake * 100 * 1.5, 2)                AS need_for_100x,
  (p.balance >= p.highest_stake * 500 * 2.0)           AS can_draw_500x,
  (p.balance >= p.highest_stake * 100 * 1.5)           AS can_draw_100x,
  -- A pool that cannot fund a 10x has visibly lost most of its ladder.
  (p.balance < p.highest_stake * 10)                   AS is_thin,
  (SELECT count(*) FROM public.spin_reserve_ledger l
    WHERE l.club_id = p.club_id AND l.kind = 'adjustment')  AS shortfall_events,
  (SELECT count(*) FROM public.tournaments t
    WHERE t.club_id = p.club_id AND t.variant='spin'
      AND t.status IN ('RUNNING','COMPLETED')
      AND COALESCE(t.buy_in_fee,0)=0
      AND t.started_at > now() - interval '24 hours'
      AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l2
                      WHERE l2.tournament_id = t.id))        AS unbooked_24h
FROM public.spin_bonus_pools p
LEFT JOIN public.clubs c ON c.id = p.club_id;

REVOKE ALL ON FUNCTION public.fn_spin_sweep_unbooked(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.v_spin_reserve_health FROM PUBLIC, anon, authenticated;
