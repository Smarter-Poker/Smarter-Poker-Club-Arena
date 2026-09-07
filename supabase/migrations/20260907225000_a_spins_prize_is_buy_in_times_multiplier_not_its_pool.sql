-- ============================================================================
--  A SPIN'S PRIZE IS BUY-IN x MULTIPLIER, NOT ITS POOL
--
--  fn_tournament_prize_disbursement_audit compared what a completed event paid
--  in prizes against tournaments.prize_pool. For a Spin, the pool is the
--  buy-ins (3 x 1 = 3) and the prize is buy_in x drawn multiplier (1 x 10 =
--  10), funded from the club's spin reserve by fn_spin_settle_game - so every
--  spin whose multiplier exceeds its seat count "paid out more than its prize
--  pool" and FeeReconciler raised PRIZE_DISBURSEMENT hourly for 24 hours:
--  34 open critical alerts on 2026-09-07, all for one 10x spin (6d688095) that
--  paid exactly what it advertised. For most spins the engine rewrites
--  prize_pool to the drawn prize, which is why only the rare miss trips the
--  audit; the audit should not depend on that write. A spin's expected
--  disbursement is buy_in_amount x spin_multiplier when a multiplier is drawn.
-- ============================================================================
BEGIN;
CREATE OR REPLACE FUNCTION public.fn_tournament_prize_disbursement_audit(p_hours integer DEFAULT 24)
 RETURNS TABLE(tournament_id uuid, name text, variant text, prize_pool numeric, disbursed numeric, acknowledged numeric, excess numeric, ended_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH t AS (
    SELECT x.id, x.name, x.variant,
           -- A Spin promises buy_in x multiplier, paid from the spin reserve;
           -- its prize_pool column is the buy-ins and is not what it owes.
           CASE WHEN x.variant = 'spin' AND COALESCE(x.spin_multiplier, 0) > 0
                THEN GREATEST(x.prize_pool::numeric, round(COALESCE(x.buy_in_amount,0) * x.spin_multiplier, 2))
                ELSE x.prize_pool::numeric END AS pool,
           x.ended_at
      FROM public.tournaments x
     WHERE x.status = 'COMPLETED'
       AND x.ended_at > now() - make_interval(hours => GREATEST(COALESCE(p_hours,24),1))
       AND COALESCE(x.prize_pool,0) > 0
  ), paid AS (
    SELECT w.related_entity_id tid, round(sum(w.amount),2) amt
      FROM public.wallet_transactions w
      JOIN t ON t.id = w.related_entity_id
     WHERE w.type = 'credit' AND w.category = 'prize'
     GROUP BY 1
  )
  SELECT t.id, t.name, t.variant, t.pool,
         COALESCE(p.amt,0),
         COALESCE(b.amount,0),
         round(COALESCE(p.amt,0) - t.pool - COALESCE(b.amount,0), 2),
         t.ended_at
    FROM t
    LEFT JOIN paid p ON p.tid = t.id
    LEFT JOIN public.tournament_conservation_baseline b ON b.tournament_id = t.id
   WHERE round(COALESCE(p.amt,0) - t.pool - COALESCE(b.amount,0), 2) > 0.005;
$function$;
REVOKE ALL ON FUNCTION public.fn_tournament_prize_disbursement_audit(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_prize_disbursement_audit(integer) TO service_role;
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.fn_tournament_prize_disbursement_audit(48) a WHERE a.tournament_id='6d688095-c3c5-4d40-a5a0-952934667732';
  IF v_n <> 0 THEN RAISE EXCEPTION 'the 10x spin that paid what it advertised still reads as an overpay'; END IF;
END $$;
UPDATE public.financial_alerts SET resolved=true, resolved_at=now(), resolved_by='2d1cd6c3-5700-4af9-a271-d4863fdab20d',
       resolution='False positive: a Spin pays buy_in x multiplier from the spin reserve (this one 1 x 10 = 10 on a 3-chip pool); the audit compared against the pool. fn_tournament_prize_disbursement_audit now uses the advertised prize for spins. 2026-09-07.'
 WHERE resolved=false AND source='FeeReconciler.prize_disbursement' AND context->'rows'->0->>'tournament_id'='6d688095-c3c5-4d40-a5a0-952934667732';
COMMIT;
