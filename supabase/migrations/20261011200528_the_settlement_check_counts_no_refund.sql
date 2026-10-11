-- the_settlement_check_counts_no_refund
--
-- A REFUND IS NOT A PRIZE (2026-10-11). Full account:
-- docs/changelog/2026-10-11-the-settlement-check-counts-no-refund.md.
--
-- fn_ca_tournament_settlement_mismatch summed every non-bounty wallet credit
-- on a tournament as "paid". A registration refund (a buy-in handed back
-- before it ever became prize money: "Bot retirement drain", "Tournament
-- unregistration refund", "Deep Stack Society disabled by owner 2026-10-04")
-- is a credit too, so every completed event that refunded one entry read as
-- "overpaid" by exactly that refund. Over 30 days it listed 22 events, each
-- over by 5 to 480 chips; in all 22 the excess equals the event's refund
-- credits to the cent, the prize credits equal the pool to the cent, and
-- entries collected = prize + bounty + rake + refunds. Nobody was overpaid,
-- from the house or from anyone else.
--
-- The sibling reader fn_ca_prize_overpay_unexplained learned this on
-- 2026-10-05 (category NOT IN ('bounty', 'refund')), which is why the prize
-- overpay ratchet read 0 while this one did not. This reader feeds the
-- CRITICAL ratchet tournament_underpaid_48h, so the same refund could also
-- have hidden a real underpayment of up to its own size. Re-measured with
-- the fix, read-only, over 178,870 completed events in 30 days: 0 underpaid,
-- 0 overpaid.
--
-- A read-only check function changes; no data and no money moves.
--
-- @live-proof: (SELECT position('A REFUND IS NOT A PRIZE' IN pg_get_functiondef('public.fn_ca_tournament_settlement_mismatch(interval)'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION pg_temp.ca_swap_once(p_src text, p_anchor text, p_new text, p_what text)
RETURNS text LANGUAGE plpgsql AS $swap$
DECLARE v_n integer;
BEGIN
  v_n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / length(p_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'REFUND_NOT_PRIZE_ANCHOR_CHANGED: % found % times', p_what, v_n;
  END IF;
  RETURN replace(p_src, p_anchor, p_new);
END
$swap$;

DO $patch_mismatch$
DECLARE
  v_src text := pg_get_functiondef('public.fn_ca_tournament_settlement_mismatch(interval)'::regprocedure);
BEGIN
  IF position('A REFUND IS NOT A PRIZE' IN v_src) > 0 THEN
    RAISE NOTICE 'REFUND_NOT_PRIZE already applied';
    RETURN;
  END IF;
  IF md5(v_src) IS DISTINCT FROM '8e30a5098eb727214bdac957f2e6a824' THEN
    RAISE EXCEPTION 'REFUND_NOT_PRIZE_PREIMAGE_CHANGED: settlement mismatch';
  END IF;
  v_src := pg_temp.ca_swap_once(v_src,
$a$                        AND COALESCE(w.category, '') <> 'bounty'), 0)
$a$,
$a$                        -- A REFUND IS NOT A PRIZE (2026-10-11). A
                        -- registration refund hands back a buy-in that never
                        -- became prize money; counting it read 22 events in
                        -- 30 days as overpaid by exactly their refunds, and
                        -- could hide an underpayment of the same size.
                        AND COALESCE(w.category, '') NOT IN ('bounty', 'refund')), 0)
$a$, 'mismatch paid');
  EXECUTE v_src;
END
$patch_mismatch$;

DO $prove$
DECLARE v_bad integer;
BEGIN
  IF position('A REFUND IS NOT A PRIZE' IN pg_get_functiondef('public.fn_ca_tournament_settlement_mismatch(interval)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'REFUND_NOT_PRIZE_RESULT_CHANGED: not live';
  END IF;
  SELECT count(*) INTO v_bad
    FROM public.fn_ca_tournament_settlement_mismatch('30 days'::interval);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'REFUND_NOT_PRIZE_RESULT_CHANGED: % events still mismatched in 30 days', v_bad;
  END IF;
END
$prove$;

COMMIT;
