CREATE OR REPLACE FUNCTION public.fn_union_settlement_conservation_assert(p_union_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_r1 jsonb, p_r2 jsonb, p_r3 jsonb)
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
  v_checked  int := 0; v_totals jsonb;
BEGIN
  -- Idempotent Round 1 replies omit totals. Recover its immutable finalized
  -- settlement record for this exact union/period before asserting arithmetic.
  IF (v_rake IS NULL OR v_paid IS NULL OR v_retained IS NULL)
     AND p_r1->>'error'='already_executed' THEN
    SELECT c.totals INTO v_totals FROM public.ca_settlements c
    WHERE c.settlement_type='union_rakeback_close' AND c.union_id=p_union_id AND c.state='final'
      AND c.external_ref=p_union_id::text || ':'
        || to_char(p_from at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') || '..'
        || to_char(p_to at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"');
    v_rake := (v_totals->>'period_rake')::numeric;
    v_paid := (v_totals->>'payout_total')::numeric;
    v_retained := (v_totals->>'retained')::numeric;
  END IF;
  IF v_rake IS NULL OR v_paid IS NULL OR v_retained IS NULL OR v_r2_amt IS NULL OR v_r3_amt IS NULL THEN
    RAISE EXCEPTION 'CONSERVATION_UNVERIFIED: settlement totals are missing';
  END IF;
  IF EXISTS(SELECT 1 FROM unnest(ARRAY[v_rake,v_paid,v_retained,v_r2_amt,v_r3_amt]) n
    WHERE n::text IN ('NaN','Infinity','-Infinity') OR n<0 OR n<>round(n,2)) THEN
    RAISE EXCEPTION 'CONSERVATION_BREACH: settlement totals must be finite nonnegative whole cents';
  END IF;
  IF v_rake <> v_paid+v_retained THEN
    RAISE EXCEPTION 'CONSERVATION_BREACH round1_arithmetic: rake % <> paid % + retained %',v_rake,v_paid,v_retained;
  END IF;
  IF v_paid>v_rake THEN RAISE EXCEPTION 'CONSERVATION_BREACH round1_overpay'; END IF;
  v_checked := v_checked+2;

  -- 6. Rounds 2 and 3 never move a negative amount.
  IF COALESCE(v_r2_amt, 0) < 0 THEN
    RAISE EXCEPTION 'CONSERVATION_BREACH round2_negative_amount: %', v_r2_amt;
  END IF;
  IF COALESCE(v_r3_amt, 0) < 0 THEN
    RAISE EXCEPTION 'CONSERVATION_BREACH round3_negative_amount: %', v_r3_amt;
  END IF;
  v_checked := v_checked + 2;

  -- 3 + 4 + 5. Nothing this union touches may be negative afterwards.
  SELECT string_agg(x.pool || ' = ' || COALESCE(x.amt::text,'NULL'), '; ') INTO v_neg
    FROM (
      SELECT 'union chip wallet' AS pool, w.chip_balance AS amt
        FROM union_wallets w
       WHERE w.union_id = p_union_id AND (w.chip_balance < 0 OR w.chip_balance IS NULL)
      UNION ALL
      SELECT 'union rake wallet', w.rake_wallet
        FROM union_wallets w
       WHERE w.union_id = p_union_id AND (w.rake_wallet < 0 OR w.rake_wallet IS NULL)
      UNION ALL
      SELECT 'club treasury ' || c.name, c.chip_treasury
        FROM clubs c
        JOIN union_clubs uc ON uc.club_id = c.id
       WHERE uc.union_id = p_union_id AND (c.chip_treasury < 0 OR c.chip_treasury IS NULL)
      UNION ALL
      SELECT 'member wallet ' || cm.user_id::text, cm.chip_balance
        FROM club_members cm
        JOIN union_clubs uc ON uc.club_id = cm.club_id
       WHERE uc.union_id = p_union_id AND (cm.chip_balance < 0 OR cm.chip_balance IS NULL)
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
