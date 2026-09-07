-- A SETTLEMENT THAT DOES NOT BALANCE IS NOT COMMITTED
-- =============================================================================
-- PHASE 2 of 8, part 1 of 3.
--
-- fn_settlement_conservation_check has existed all along, returns zero rows,
-- and is called by NOTHING at the moment money moves. It runs on a 30-minute
-- cron and reports afterwards. So a settlement that pays out more than it
-- holds commits first and is noticed second.
--
-- This adds the assertion INSIDE the cascade's transaction. It raises, so the
-- union's subtransaction rolls back, the per-union handler in
-- fn_union_settlement_cascade_all catches it, and the alert names the breach.
-- Nothing half-settled survives.
--
-- WHAT IT ASSERTS, all scoped to the union being settled so an unrelated
-- pre-existing breach elsewhere on the platform can never block it:
--
--   1. Round 1 arithmetic. period_rake = total_rakeback + union_retained,
--      to the cent. True by construction today (retained is the remainder
--      after truncation), which is exactly why it is worth pinning: if a
--      future change makes round 1 pay out more than the period's rake, the
--      settlement stops instead of committing.
--   2. Round 1 never pays out more than the period generated.
--   3. No negative union wallet - chip_balance or rake_wallet.
--   4. No negative club treasury among the union's member clubs.
--   5. No negative member balance among those clubs (1,179 rows today).
--   6. Rounds 2 and 3 never report a negative amount.
--
-- DELIBERATELY NOT ASSERTED: that round 1's reported rake_wallet_after still
-- matches the live wallet. Rake is credited to that wallet continuously -
-- roughly 250,000 credits a week - so the figure is stale within seconds of
-- being taken and the check would fail on healthy settlements. A conservation
-- assertion that cries wolf is worse than none, because it gets removed.
--
-- HONEST SCOPE: this would NOT have prevented the 441,230.51 that moved on a
-- floored week this afternoon. That was a sequencing failure, fixed in
-- 20260907164234, and conservation passed throughout - it still does, zero
-- breaches. This guards the different failure where the numbers themselves do
-- not add up.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_union_settlement_conservation_assert(
  p_union_id uuid,
  p_from     timestamp with time zone,
  p_to       timestamp with time zone,
  p_r1       jsonb,
  p_r2       jsonb,
  p_r3       jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rake     numeric := (p_r1->>'period_rake')::numeric;
  v_paid     numeric := (p_r1->>'total_rakeback')::numeric;
  v_retained numeric := (p_r1->>'union_retained')::numeric;
  v_r2_amt   numeric := (p_r2->>'amount')::numeric;
  v_r3_amt   numeric := (p_r3->>'amount')::numeric;
  v_neg      text;
  v_checked  int := 0;
BEGIN
  IF v_rake IS NOT NULL AND v_paid IS NOT NULL AND v_retained IS NOT NULL THEN
    IF abs(v_rake - (v_paid + v_retained)) > 0.01 THEN
      RAISE EXCEPTION
        'CONSERVATION_BREACH round1_arithmetic: period_rake % <> total_rakeback % + union_retained % (out by %)',
        v_rake, v_paid, v_retained, round(v_rake - (v_paid + v_retained), 4);
    END IF;
    IF v_paid > v_rake + 0.01 THEN
      RAISE EXCEPTION
        'CONSERVATION_BREACH round1_overpay: paid out % against period rake of %',
        v_paid, v_rake;
    END IF;
    v_checked := v_checked + 2;
  END IF;

  IF COALESCE(v_r2_amt, 0) < 0 THEN
    RAISE EXCEPTION 'CONSERVATION_BREACH round2_negative_amount: %', v_r2_amt;
  END IF;
  IF COALESCE(v_r3_amt, 0) < 0 THEN
    RAISE EXCEPTION 'CONSERVATION_BREACH round3_negative_amount: %', v_r3_amt;
  END IF;
  v_checked := v_checked + 2;

  SELECT string_agg(x.pool || ' = ' || x.amt, '; ') INTO v_neg
    FROM (
      SELECT 'union chip wallet' AS pool, w.chip_balance AS amt
        FROM union_wallets w
       WHERE w.union_id = p_union_id AND w.chip_balance < 0
      UNION ALL
      SELECT 'union rake wallet', w.rake_wallet
        FROM union_wallets w
       WHERE w.union_id = p_union_id AND w.rake_wallet < 0
      UNION ALL
      SELECT 'club treasury ' || c.name, c.chip_treasury
        FROM clubs c
        JOIN union_clubs uc ON uc.club_id = c.id
       WHERE uc.union_id = p_union_id AND c.chip_treasury < 0
      UNION ALL
      SELECT 'member wallet ' || cm.user_id::text, cm.chip_balance
        FROM club_members cm
        JOIN union_clubs uc ON uc.club_id = cm.club_id
       WHERE uc.union_id = p_union_id AND cm.chip_balance < 0
    ) x;

  IF v_neg IS NOT NULL THEN
    RAISE EXCEPTION 'CONSERVATION_BREACH negative_pool after settlement: %', left(v_neg, 400);
  END IF;
  v_checked := v_checked + 3;

  RETURN jsonb_build_object(
    'conservation', 'asserted',
    'checks', v_checked,
    'period_start', p_from, 'period_end', p_to,
    'round1_rake', v_rake, 'round1_paid', v_paid, 'round1_retained', v_retained,
    'round2_amount', v_r2_amt, 'round3_amount', v_r3_amt);
END $function$;

COMMENT ON FUNCTION public.fn_union_settlement_conservation_assert(uuid, timestamp with time zone, timestamp with time zone, jsonb, jsonb, jsonb) IS
  'Raises CONSERVATION_BREACH if a union settlement does not balance. Called inside fn_union_settlement_cascade before it commits, so a breach rolls the settlement back rather than reporting it afterwards.';

REVOKE ALL ON FUNCTION public.fn_union_settlement_conservation_assert(uuid, timestamp with time zone, timestamp with time zone, jsonb, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_settlement_conservation_assert(uuid, timestamp with time zone, timestamp with time zone, jsonb, jsonb, jsonb)
  TO service_role;

DO $migrate$
DECLARE
  v_def text; v_new text; v_anchor text; v_replacement text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc WHERE proname='fn_union_settlement_cascade' AND pronamespace='public'::regnamespace;

  v_anchor := E'  IF public.fn_union_eco_enabled(p_union_id) THEN';

  v_replacement := E'  -- CONSERVATION, asserted before anything else is written. Raises on a\n  -- breach, which rolls this union\'s whole settlement back.\n  PERFORM public.fn_union_settlement_conservation_assert(\n            p_union_id, v_from, v_to, v_r1, v_r2, v_r3);\n\n  IF public.fn_union_eco_enabled(p_union_id) THEN';

  IF position(v_anchor in v_def) = 0 THEN
    RAISE EXCEPTION 'the ECO anchor was not found in the cascade';
  END IF;

  v_new := replace(v_def, v_anchor, v_replacement);
  IF v_new = v_def THEN
    RAISE EXCEPTION 'conservation wiring did not take';
  END IF;
  EXECUTE v_new;
END
$migrate$;

DO $assert$
DECLARE
  v_src text; v_ok jsonb; v_raised boolean; v_msg text;
  good1 jsonb := '{"period_rake":1000.00,"total_rakeback":900.00,"union_retained":100.00}'::jsonb;
  bad1  jsonb := '{"period_rake":1000.00,"total_rakeback":950.00,"union_retained":100.00}'::jsonb;
  over1 jsonb := '{"period_rake":100.00,"total_rakeback":900.00,"union_retained":-800.00}'::jsonb;
  r2    jsonb := '{"round":2,"amount":441230.51,"payees":83}'::jsonb;
  r3    jsonb := '{"round":3,"amount":0.00,"payees":0}'::jsonb;
  r2neg jsonb := '{"round":2,"amount":-1.00,"payees":1}'::jsonb;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_union_settlement_cascade' AND pronamespace='public'::regnamespace;
  IF v_src NOT LIKE '%fn_union_settlement_conservation_assert%' THEN
    RAISE EXCEPTION 'the cascade does not call the conservation assertion';
  END IF;
  IF position('fn_union_settlement_conservation_assert' in v_src)
     > position('fn_union_eco_enabled' in v_src) THEN
    RAISE EXCEPTION 'the conservation assertion runs after ECO instead of before it';
  END IF;

  v_ok := public.fn_union_settlement_conservation_assert(
            'fade0000-0000-0000-0000-000000000001',
            '2026-09-07 07:00:00+00','2026-09-14 07:00:00+00', good1, r2, r3);
  IF v_ok->>'conservation' <> 'asserted' OR (v_ok->>'checks')::int <> 7 THEN
    RAISE EXCEPTION 'a healthy settlement did not pass cleanly: %', v_ok::text;
  END IF;

  v_raised := false;
  BEGIN
    PERFORM public.fn_union_settlement_conservation_assert(
              'fade0000-0000-0000-0000-000000000001',
              '2026-09-07 07:00:00+00','2026-09-14 07:00:00+00', bad1, r2, r3);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    v_raised := v_msg LIKE 'CONSERVATION_BREACH round1_arithmetic%';
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'an unbalanced round 1 was not caught'; END IF;

  v_raised := false;
  BEGIN
    PERFORM public.fn_union_settlement_conservation_assert(
              'fade0000-0000-0000-0000-000000000001',
              '2026-09-07 07:00:00+00','2026-09-14 07:00:00+00', over1, r2, r3);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    v_raised := v_msg LIKE 'CONSERVATION_BREACH round1_overpay%';
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'an overpaying round 1 was not caught'; END IF;

  v_raised := false;
  BEGIN
    PERFORM public.fn_union_settlement_conservation_assert(
              'fade0000-0000-0000-0000-000000000001',
              '2026-09-07 07:00:00+00','2026-09-14 07:00:00+00', good1, r2neg, r3);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    v_raised := v_msg LIKE 'CONSERVATION_BREACH round2_negative_amount%';
  END;
  IF NOT v_raised THEN RAISE EXCEPTION 'a negative round 2 amount was not caught'; END IF;

  IF (public.fn_union_settlement_cascade(
        'fade0000-0000-0000-0000-000000000001',
        '2026-08-24 07:00:00+00','2026-08-31 07:00:00+00')->>'error') <> 'before_settlement_floor' THEN
    RAISE EXCEPTION 'the floor guard regressed';
  END IF;
END
$assert$;

COMMIT;
