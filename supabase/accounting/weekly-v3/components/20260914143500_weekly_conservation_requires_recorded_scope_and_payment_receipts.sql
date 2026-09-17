-- Complete weekly conservation uses the recorded book, including departed
-- clubs, and proves every stage against its durable receipt.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_union_settlement_conservation_assert(uuid,timestamptz,timestamptz,jsonb,jsonb,jsonb)'::regprocedure))<>'e8ccbf772a8122cdf0679183717337cd'
 THEN RAISE EXCEPTION 'weekly conservation preimage changed';END IF;
END $guard$;
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
  IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
  IF p_union_id IS NULL OR p_from IS NULL OR p_to IS NULL OR p_from IS DISTINCT FROM public.fn_union_week_start(p_from)
   OR p_to IS DISTINCT FROM public.fn_union_week_start(p_from+interval '8 days') THEN
   RAISE EXCEPTION 'invalid_conservation_scope' USING ERRCODE='22023'; END IF;
  SELECT c.totals INTO v_totals FROM public.ca_settlements c
   WHERE c.settlement_type='union_rakeback_close' AND c.union_id=p_union_id AND c.state='final'
    AND c.external_ref=p_union_id::text||':'||to_char(p_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
     ||'..'||to_char(p_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"');
  IF v_totals IS NULL OR v_totals->>'accounting_version' IS DISTINCT FROM '3' THEN
    RAISE EXCEPTION 'CONSERVATION_UNVERIFIED: exact recorded earning close is missing'; END IF;
  IF p_r1->>'error'='already_executed' THEN
    v_rake:=(v_totals->>'period_rake')::numeric;
    v_paid:=(v_totals->>'payout_total')::numeric;
    v_retained:=(v_totals->>'retained')::numeric;
  ELSIF p_r1->>'success' IS DISTINCT FROM 'true'
   OR (v_totals->>'period_rake')::numeric IS DISTINCT FROM v_rake
   OR (v_totals->>'payout_total')::numeric IS DISTINCT FROM v_paid
   OR (v_totals->>'retained')::numeric IS DISTINCT FROM v_retained THEN
    RAISE EXCEPTION 'CONSERVATION_UNVERIFIED: Round 1 response differs from its posted close'; END IF;
  IF EXISTS(SELECT 1 FROM (VALUES(2,p_r2),(3,p_r3)) input(round_no,receipt)
    WHERE input.receipt->>'success' IS DISTINCT FROM 'true'
     OR input.receipt->>'routing_version' IS DISTINCT FROM '3'
     OR input.receipt->>'source_version' IS DISTINCT FROM '2'
     OR input.receipt->'shortfalls' IS DISTINCT FROM '0'::jsonb
     OR NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind='union' AND r.scope_id=p_union_id
      AND r.period_start=p_from AND r.period_end=p_to AND r.round_no=input.round_no AND r.result=(input.receipt-'duplicate'))) THEN
    RAISE EXCEPTION 'CONSERVATION_UNVERIFIED: routed payment receipts do not match the exact union week'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.union_wallets w WHERE w.union_id=p_union_id)
   OR EXISTS(SELECT 1 FROM public.fn_accounting_week_clubs(p_union_id,NULL,p_from,p_to) s
    WHERE NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=s.club_id)) THEN
    RAISE EXCEPTION 'CONSERVATION_UNVERIFIED: an accounting wallet is missing'; END IF;
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
       WHERE w.union_id = p_union_id AND (w.chip_balance < 0 OR w.chip_balance IS NULL OR w.chip_balance::text IN('NaN','Infinity','-Infinity') OR w.chip_balance<>round(w.chip_balance,2))
      UNION ALL
      SELECT 'union rake wallet', w.rake_wallet
        FROM union_wallets w
       WHERE w.union_id = p_union_id AND (w.rake_wallet < 0 OR w.rake_wallet IS NULL OR w.rake_wallet::text IN('NaN','Infinity','-Infinity') OR w.rake_wallet<>round(w.rake_wallet,2))
      UNION ALL
      SELECT 'club treasury ' || c.name, c.chip_treasury
        FROM clubs c
        JOIN public.fn_accounting_week_clubs(p_union_id,NULL,p_from,p_to) uc ON uc.club_id = c.id
       WHERE (c.chip_treasury < 0 OR c.chip_treasury IS NULL OR c.chip_treasury::text IN('NaN','Infinity','-Infinity') OR c.chip_treasury<>round(c.chip_treasury,2))
      UNION ALL
      SELECT 'member wallet ' || cm.user_id::text, cm.chip_balance
        FROM club_members cm
        JOIN public.fn_accounting_week_clubs(p_union_id,NULL,p_from,p_to) uc ON uc.club_id = cm.club_id
       WHERE (cm.chip_balance < 0 OR cm.chip_balance IS NULL OR cm.chip_balance::text IN('NaN','Infinity','-Infinity') OR cm.chip_balance<>round(cm.chip_balance,2))
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
REVOKE ALL ON FUNCTION public.fn_union_settlement_conservation_assert(uuid,timestamptz,timestamptz,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
