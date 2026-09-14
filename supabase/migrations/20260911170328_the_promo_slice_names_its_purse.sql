-- ═══════════════════════════════════════════════════════════════════════════
--  THE PROMO SLICE NAMES ITS PURSE
--  BBJ programme phase 5 of 5 (2026-09-11)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `fn_bbj_promo_payout_atomic` already says it in its own comment:
--
--     THE PURSE (2026-09-03, Dan's ruling 3): the promo float ... the union's
--     promo_wallet when the pool belongs to a union, otherwise the standalone
--     club's promo_balance. THE POOL IS THE OCCASION, NOT THE PURSE.
--
-- Nothing a person can read said so. `bbj_pools.promo_balance` is a staging
-- slot that `fn_sweep_bbj_promo` empties into the purse continuously - twelve
-- sweeps in the last hour - so it sits near zero by design. Measured
-- 2026-09-11:
--
--   THE PURSE   Midway Union        56,291.01   <- what an owner can actually spend
--               Deep Stack Society  21,246.52
--   THE POOL    union pool              14.61   <- what every surface was showing
--               Deep Stack Society        7.28
--
-- 77,537.53 chips in purses, and the jackpot page displayed 14.61 and 7.28.
--
-- The money is not lost and never was: `fn_bbj_promo_bank_check()` reconciles
-- with `unexplained: 0` - 134,595.44 contributed, 91,291.64 swept to unions,
-- 49,989.50 swept to clubs, 19.51 still staged, and the rest explained by the
-- pre-triple-bank era it deliberately refuses to backfill. This is a reporting
-- defect, not an accounting one, which is why the fix is a read.
--
-- `fn_bbj_promo_facts` answers the question the surfaces were guessing at:
-- where the promo slice went, how big the slice is, and what the purse holds
-- NOW. The rate is OBSERVED from the rows, not taken from a constant, because
-- it has varied by stakes tier and over time - the same reasoning
-- `fn_bbj_promo_bank_check` already uses.
--
-- OPERATOR DATA, so it is gated like the mini's runway (phase 3): the function
-- names its own actor with auth.uid(), pre-login roles hold no EXECUTE, and a
-- caller who is not staff of the pool's club gets NULLs rather than zeros - a
-- purse withheld and an empty purse are different facts.
--
-- Read path only. No balance moves.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_bbj_promo_facts(p_pool_id uuid)
RETURNS TABLE(
  is_operator boolean,
  purse_kind text,
  purse_available numeric,
  pool_staged numeric,
  contributed_all_time numeric,
  swept_all_time numeric,
  observed_rate_pct numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH pool AS (
    SELECT bp.id, bp.club_id, bp.union_id, COALESCE(bp.promo_balance, 0) AS staged
      FROM public.bbj_pools bp WHERE bp.id = p_pool_id
  ),
  caller AS (
    /* Names its own actor. A pool with no club (a union pool) is judged by the
       club the caller is staff of within that union; `fn_is_club_admin_uid`
       is the same gate the mini switch and the reserve floor use. */
    SELECT (auth.uid() IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.clubs c, pool
               WHERE (c.id = pool.club_id
                      OR (pool.union_id IS NOT NULL AND c.union_id = pool.union_id))
                 AND public.fn_is_club_admin_uid(c.id)
            )) AS is_operator
  ),
  purse AS (
    SELECT
      CASE WHEN pool.union_id IS NOT NULL THEN 'union' ELSE 'club' END AS kind,
      CASE WHEN pool.union_id IS NOT NULL
           THEN (SELECT COALESCE(uw.promo_wallet, 0) FROM public.union_wallets uw
                  WHERE uw.union_id = pool.union_id)
           ELSE (SELECT COALESCE(c.promo_balance, 0) FROM public.clubs c
                  WHERE c.id = pool.club_id)
      END AS available
      FROM pool
  ),
  flow AS (
    SELECT
      COALESCE((SELECT sum(x.promo_portion) FROM public.bbj_contributions x
                 WHERE x.pool_id = p_pool_id), 0) AS contributed,
      /* Swept OUT of this pool, both destinations. The club side is journaled
         in chip_transactions and the union side in union_wallet_transactions;
         neither carries a pool id, so both are scoped by the pool's owner. */
      COALESCE((SELECT sum(t.amount) FROM public.union_wallet_transactions t, pool
                 WHERE t.tx_type = 'bbj_promo_sweep'
                   AND pool.union_id IS NOT NULL AND t.union_id = pool.union_id), 0)
      + COALESCE((SELECT sum(t.amount) FROM public.chip_transactions t, pool
                   WHERE t.transaction_type = 'bbj_promo_sweep'
                     AND pool.union_id IS NULL AND t.club_id = pool.club_id), 0) AS swept,
      /* OBSERVED, never a constant: the promo rate has varied by stakes tier
         and over time, and rows from before the triple bank carry NULL
         portions, so only rows that recorded a split can answer this. */
      (SELECT CASE WHEN COALESCE(sum(x.amount), 0) > 0
                   THEN COALESCE(sum(x.promo_portion), 0) / sum(x.amount) * 100
                   ELSE 0 END
         FROM public.bbj_contributions x
        WHERE x.pool_id = p_pool_id AND x.promo_portion IS NOT NULL) AS rate
  )
  SELECT caller.is_operator,
         /* NULL, never zero, for a caller who may not see it: a purse withheld
            and an empty purse are different facts. */
         CASE WHEN caller.is_operator THEN purse.kind END,
         CASE WHEN caller.is_operator THEN ROUND(purse.available, 2) END,
         CASE WHEN caller.is_operator THEN ROUND(pool.staged, 2) END,
         CASE WHEN caller.is_operator THEN ROUND(flow.contributed, 2) END,
         CASE WHEN caller.is_operator THEN ROUND(flow.swept, 2) END,
         CASE WHEN caller.is_operator THEN ROUND(flow.rate, 2) END
    FROM pool, caller, purse, flow;
$function$;

COMMENT ON FUNCTION public.fn_bbj_promo_facts(uuid) IS
  'Where a pool''s promo slice actually goes. `bbj_pools.promo_balance` is a '
  'staging slot that fn_sweep_bbj_promo empties continuously; the PURSE is the '
  'union''s promo_wallet or the standalone club''s promo_balance, which is what '
  'fn_bbj_promo_payout_atomic spends ("the pool is the occasion, not the '
  'purse"). Operator data: the function names its own actor, pre-login roles '
  'hold no EXECUTE, and a non-operator gets NULLs rather than zeros. The rate '
  'is observed from the contribution rows, never a constant, because it has '
  'varied by stakes tier and over time. Phase 5, migration 20260911170328.';

REVOKE ALL ON FUNCTION public.fn_bbj_promo_facts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_promo_facts(uuid) TO authenticated, service_role;

DO $$
DECLARE v_anon boolean; v_asks boolean;
BEGIN
  SELECT has_function_privilege('anon', p.oid, 'EXECUTE') INTO v_anon
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_bbj_promo_facts';
  IF v_anon THEN RAISE EXCEPTION 'anon can execute fn_bbj_promo_facts'; END IF;

  SELECT pg_get_functiondef(p.oid) LIKE '%auth.uid()%' INTO v_asks
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_bbj_promo_facts';
  IF NOT v_asks THEN RAISE EXCEPTION 'fn_bbj_promo_facts must name its own actor'; END IF;
END $$;

COMMIT;
