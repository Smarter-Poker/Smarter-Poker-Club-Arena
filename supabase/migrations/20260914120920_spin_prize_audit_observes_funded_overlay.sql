-- Recognize a Spin correction only against matching posted house funding.
-- Detection only: no wallet, ledger, obligation or historical alert writes.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
DO $preflight$
DECLARE v_hash text;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_tournament_prize_disbursement_audit(integer)'::regprocedure)) INTO v_hash;
  IF v_hash IS NULL OR v_hash NOT IN ('cc459efa33bc115e6c662b644290a014','d62ceae6005e91ab678155a826bc50e5') THEN
    RAISE EXCEPTION 'spin prize audit definition drift: %',v_hash;
  END IF;
END;
$preflight$;

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
                THEN GREATEST(x.prize_pool::numeric,
                  round(COALESCE(x.buy_in_amount,0) * x.spin_multiplier, 2)
                  + CASE
                      WHEN e.overlay_in > 0 AND e.overlay_in < 'Infinity'::numeric
                       AND e.overlay_in = COALESCE((
                         SELECT sum(l.amount) FROM public.chip_ledger l
                          WHERE l.tournament_id = x.id
                            AND l.category = 'overlay'
                            AND l.to_type = 'prize_liability'
                            AND l.to_entity_id = x.id
                            AND l.from_type IN ('union_bank','club_treasury')
                            AND l.status = 'posted'
                            AND l.amount > 0 AND l.amount < 'Infinity'::numeric
                       ), 0)
                      THEN e.overlay_in ELSE 0
                    END)
                ELSE x.prize_pool::numeric END AS pool,
           x.ended_at
      FROM public.tournaments x
      LEFT JOIN public.tournament_escrow e ON e.tournament_id = x.id
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

REVOKE ALL ON FUNCTION public.fn_tournament_prize_disbursement_audit(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_prize_disbursement_audit(integer) TO service_role;
COMMIT;
