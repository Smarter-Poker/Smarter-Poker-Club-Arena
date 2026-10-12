-- a_union_join_closure_is_promo_only_for_its_promo
--
-- A UNION JOIN CLOSURE COUNTS AS A PROMO SWEEP ONLY FOR ITS PROMO PART
-- (2026-10-12). Full account:
-- docs/changelog/2026-10-12-a-union-join-closure-is-promo-only-for-its-promo.md.
--
-- At 04:06 UTC Deep Stack Society joined the Midway Union (migration
-- 20261012040553). fn_close_club_wallets_on_union_join closed its BBJ pool
-- into the club main bank as ONE chip_transactions row of type
-- bbj_promo_sweep: 68,795.45 = main 42,734.14 + backup 26,061.31 + promo 0.00
-- (metadata reason union_join, bbj_main, bbj_backup, bbj_promo). It uses that
-- type on purpose, so fn_bbj_conservation_check, which balances the whole
-- pool, counts the closure as an outflow, and that check stays balanced.
--
-- fn_bbj_promo_bank_check balances the PROMO bank alone and read every
-- bbj_promo_sweep row as promo, so from 04:52 it reported 75,500.66 over-swept
-- (64,360.31 unexplained): exactly the 6,705.21 pre-triple-bank gap it already
-- explains plus the 68,795.45 closure. fn_bbj_promo_facts, which shows an
-- operator a pool's promo swept all time, read the same row the same way.
--
-- Both promo readers now count a union_join closure by its own bbj_promo
-- amount; every other sweep row is read exactly as before. No chip moved and
-- nobody is short: the closure is correct, only its promo reading was wrong.
--
-- @live-proof: (SELECT position('A UNION JOIN CLOSURE COUNTS ITS PROMO PART ONLY' IN pg_get_functiondef('public.fn_bbj_promo_bank_check()'::regprocedure)) > 0 AND position('A UNION JOIN CLOSURE COUNTS ITS PROMO PART ONLY' IN pg_get_functiondef('public.fn_bbj_promo_facts(uuid)'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION pg_temp.ca_swap_once(p_src text, p_anchor text, p_new text, p_what text)
RETURNS text LANGUAGE plpgsql AS $swap$
DECLARE v_n integer;
BEGIN
  v_n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / length(p_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'UNION_JOIN_PROMO_ANCHOR_CHANGED: % found % times', p_what, v_n;
  END IF;
  RETURN replace(p_src, p_anchor, p_new);
END
$swap$;

DO $patch$
DECLARE
  v_chk text := pg_get_functiondef('public.fn_bbj_promo_bank_check()'::regprocedure);
  v_fct text := pg_get_functiondef('public.fn_bbj_promo_facts(uuid)'::regprocedure);
BEGIN
  IF position('A UNION JOIN CLOSURE COUNTS ITS PROMO PART ONLY' IN v_chk) > 0
     AND position('A UNION JOIN CLOSURE COUNTS ITS PROMO PART ONLY' IN v_fct) > 0 THEN
    RAISE NOTICE 'UNION_JOIN_PROMO already applied';
    RETURN;
  END IF;
  IF md5(v_chk) IS DISTINCT FROM 'f9d81c25d63969a6cc76a446386e29c9'
     OR md5(v_fct) IS DISTINCT FROM '91d4875621299c2af678081bfa3c84e7' THEN
    RAISE EXCEPTION 'UNION_JOIN_PROMO_PREIMAGE_CHANGED';
  END IF;
  v_chk := pg_temp.ca_swap_once(v_chk,
    $a$(SELECT COALESCE(sum(amount),0) FROM chip_transactions WHERE transaction_type='bbj_promo_sweep')$a$,
    $a$/* A UNION JOIN CLOSURE COUNTS ITS PROMO PART ONLY (2026-10-12): it closes
         main, backup and promo in one bbj_promo_sweep row. */
      (SELECT COALESCE(sum(CASE WHEN metadata->>'reason'='union_join'
                                THEN COALESCE((metadata->>'bbj_promo')::numeric,0) ELSE amount END),0)
         FROM chip_transactions WHERE transaction_type='bbj_promo_sweep')$a$, 'promo bank check');
  EXECUTE v_chk;
  v_fct := pg_temp.ca_swap_once(v_fct,
    $a$+ COALESCE((SELECT sum(t.amount) FROM public.chip_transactions t, pool$a$,
    $a$-- A UNION JOIN CLOSURE COUNTS ITS PROMO PART ONLY (2026-10-12).
      + COALESCE((SELECT sum(CASE WHEN t.metadata->>'reason'='union_join'
                                  THEN COALESCE((t.metadata->>'bbj_promo')::numeric,0) ELSE t.amount END)
                    FROM public.chip_transactions t, pool$a$, 'promo facts');
  EXECUTE v_fct;
END
$patch$;

DO $prove$
DECLARE v_r jsonb := public.fn_bbj_promo_bank_check();
BEGIN
  IF position('A UNION JOIN CLOSURE COUNTS ITS PROMO PART ONLY' IN pg_get_functiondef('public.fn_bbj_promo_bank_check()'::regprocedure)) = 0
     OR position('A UNION JOIN CLOSURE COUNTS ITS PROMO PART ONLY' IN pg_get_functiondef('public.fn_bbj_promo_facts(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'UNION_JOIN_PROMO_RESULT_CHANGED: not live';
  END IF;
  IF (v_r->>'reconciles')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'UNION_JOIN_PROMO_RESULT_CHANGED: promo bank still does not reconcile: %', v_r - 'note';
  END IF;
END
$prove$;

COMMIT;
