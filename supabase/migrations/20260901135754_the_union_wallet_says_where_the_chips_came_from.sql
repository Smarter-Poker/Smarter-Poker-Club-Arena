-- Unclassified flow: what it is, and the first real bite out of it.
--
-- The dashboard's "UNCLASSIFIED FLOW TODAY 53,443,205.48" is not lost chips.
-- fn_ca_autoledger records every watched balance change, and when the caller
-- has not declared a counterparty it books the other side against
-- settlement_suspense - visible and gated, which is the point, but unclassified.
--
-- Measured 2026-09-01:
--
--   * suspense flow exists on exactly two days, 08-31 and 09-01. The
--     autoledger triggers are that new; this is its undeclared backlog, not a
--     leak that has been running.
--   * 81 functions / 172 function-column pairs write an autoledger-watched
--     balance column and never declare a counterparty. Only two functions on
--     the platform called fn_ca_declare_ledger before today.
--   * on a NORMAL day (08-31) the ranked shapes are:
--       union_wallets.rake_wallet     1,021 rows
--       spin_bonus_pools.balance      1,251 rows (both directions)
--       clubs.chip_treasury              99 rows
--       bbj_pools.*                     102 rows
--     Today's 53.4M is those same paths carrying Deep Stack provisioning
--     traffic, which is why the number is large rather than the paths new.
--
-- This migration takes the single biggest daily shape. Every union wallet
-- movement funnels through two core helpers, and both already carry the one
-- fact needed to classify it: p_tx_type. So the mapping lives next to them,
-- and the counterparty is declared for the tx_types actually in use and left
-- undeclared - honestly suspense - for anything else.
--
--   rake                  -> table_stack     category rake
--   bbj_promo_sweep       -> bbj_pool        category promo
--   guarantee_overlay     -> prize_liability category overlay
--   tournament_fee_refund -> prize_liability category reversal
--
-- The declaration is set immediately before the write and cleared immediately
-- after, so it cannot leak onto an unrelated autoledger write later in the
-- same transaction. That is the pattern fn_credit_and_log already uses.
--
-- Probed rolled back first: a 'rake' credit posted
-- table_stack -> union_wallet category=rake, and an unknown tx_type mapped to
-- NULL and stayed on suspense.

CREATE OR REPLACE FUNCTION public.fn_ca_union_wallet_ledger_shape(p_tx_type text)
RETURNS TABLE (category text, counterparty text)
LANGUAGE sql
IMMUTABLE
AS $m$
  SELECT m.cat, m.cp FROM (VALUES
    ('rake',                  'rake',     'table_stack'),
    ('bbj_promo_sweep',       'promo',    'bbj_pool'),
    ('guarantee_overlay',     'overlay',  'prize_liability'),
    ('tournament_fee_refund', 'reversal', 'prize_liability')
  ) AS m(tx, cat, cp)
  WHERE m.tx = lower(coalesce(p_tx_type,''))
$m$;

COMMENT ON FUNCTION public.fn_ca_union_wallet_ledger_shape(text) IS
  'Maps a union_wallet_transactions.tx_type to the ledger category and counterparty '
  'the movement should be booked against. Returns no row for an unrecognised type, '
  'which leaves fn_ca_autoledger on its settlement_suspense default - unclassified '
  'on purpose rather than guessed.';

CREATE OR REPLACE FUNCTION public.fn_union_credit_wallet_zd3core(p_union_id uuid, p_wallet text, p_amount numeric, p_tx_type text, p_club_id uuid, p_period_id uuid, p_notes text, p_created_by uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_wallet_column text;
  v_before numeric;
  v_after numeric;
  v_sql text;
  v_cat text;
  v_cp text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  v_wallet_column := CASE lower(p_wallet)
    WHEN 'chip' THEN 'chip_balance'
    WHEN 'chip_balance' THEN 'chip_balance'
    WHEN 'rake' THEN 'rake_wallet'
    WHEN 'rake_wallet' THEN 'rake_wallet'
    WHEN 'bbj' THEN 'bbj_wallet'
    WHEN 'bbj_wallet' THEN 'bbj_wallet'
    WHEN 'promo' THEN 'promo_wallet'
    WHEN 'promo_wallet' THEN 'promo_wallet'
    WHEN 'insurance' THEN 'insurance_wallet'
    WHEN 'insurance_wallet' THEN 'insurance_wallet'
    ELSE NULL
  END;

  IF v_wallet_column IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown wallet: ' || p_wallet);
  END IF;

  -- Ensure wallet row exists
  INSERT INTO union_wallets (union_id, created_at, updated_at)
  VALUES (p_union_id, NOW(), NOW())
  ON CONFLICT (union_id) DO NOTHING;

  -- Read + lock before
  v_sql := format('SELECT COALESCE(%I,0) FROM union_wallets WHERE union_id = $1 FOR UPDATE', v_wallet_column);
  EXECUTE v_sql INTO v_before USING p_union_id;

  /* SAY WHERE THE CHIPS CAME FROM (2026-09-01). Declared immediately before
     the write and cleared immediately after, so it cannot leak onto an
     unrelated autoledger write later in the same transaction. An unmapped
     tx_type declares nothing and stays on settlement_suspense. */
  SELECT category, counterparty INTO v_cat, v_cp
    FROM public.fn_ca_union_wallet_ledger_shape(p_tx_type);
  IF v_cp IS NOT NULL THEN
    PERFORM public.fn_ca_declare_ledger(v_cat, v_cp);
  END IF;

  -- Update
  v_sql := format('UPDATE union_wallets SET %I = COALESCE(%I,0) + $1, updated_at = NOW() WHERE union_id = $2 RETURNING %I',
                  v_wallet_column, v_wallet_column, v_wallet_column);
  EXECUTE v_sql INTO v_after USING p_amount, p_union_id;

  IF v_cp IS NOT NULL THEN
    PERFORM set_config('app.ledger_counterparty', '', true);
    PERFORM set_config('app.ledger_category', '', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);
  END IF;

  -- Audit
  INSERT INTO union_wallet_transactions (
    id, union_id, wallet, direction, amount, balance_after,
    tx_type, club_id, period_id, notes, created_by, created_at
  ) VALUES (
    gen_random_uuid(), p_union_id, v_wallet_column, 'credit', p_amount, v_after,
    COALESCE(p_tx_type, 'credit'), p_club_id, p_period_id, p_notes, p_created_by, NOW()
  );

  RETURN jsonb_build_object(
    'success', true, 'amount', p_amount,
    'wallet', v_wallet_column,
    'balance_before', v_before, 'balance_after', v_after
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_debit_wallet_zd3core(p_union_id uuid, p_wallet text, p_amount numeric, p_tx_type text, p_club_id uuid, p_period_id uuid, p_notes text, p_created_by uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_wallet_column text;
  v_before numeric;
  v_after numeric;
  v_sql text;
  v_cat text;
  v_cp text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  v_wallet_column := CASE lower(p_wallet)
    WHEN 'chip' THEN 'chip_balance'
    WHEN 'chip_balance' THEN 'chip_balance'
    WHEN 'rake' THEN 'rake_wallet'
    WHEN 'rake_wallet' THEN 'rake_wallet'
    WHEN 'bbj' THEN 'bbj_wallet'
    WHEN 'bbj_wallet' THEN 'bbj_wallet'
    WHEN 'promo' THEN 'promo_wallet'
    WHEN 'promo_wallet' THEN 'promo_wallet'
    WHEN 'insurance' THEN 'insurance_wallet'
    WHEN 'insurance_wallet' THEN 'insurance_wallet'
    ELSE NULL
  END;

  IF v_wallet_column IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown wallet: ' || p_wallet);
  END IF;

  v_sql := format('SELECT COALESCE(%I,0) FROM union_wallets WHERE union_id = $1 FOR UPDATE', v_wallet_column);
  EXECUTE v_sql INTO v_before USING p_union_id;

  IF v_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union wallet not found');
  END IF;

  IF v_before < p_amount THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'insufficient balance',
      'wallet', v_wallet_column, 'balance', v_before, 'requested', p_amount
    );
  END IF;

  SELECT category, counterparty INTO v_cat, v_cp
    FROM public.fn_ca_union_wallet_ledger_shape(p_tx_type);
  IF v_cp IS NOT NULL THEN
    PERFORM public.fn_ca_declare_ledger(v_cat, v_cp);
  END IF;

  v_sql := format('UPDATE union_wallets SET %I = %I - $1, updated_at = NOW() WHERE union_id = $2 RETURNING %I',
                  v_wallet_column, v_wallet_column, v_wallet_column);
  EXECUTE v_sql INTO v_after USING p_amount, p_union_id;

  IF v_cp IS NOT NULL THEN
    PERFORM set_config('app.ledger_counterparty', '', true);
    PERFORM set_config('app.ledger_category', '', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);
  END IF;

  INSERT INTO union_wallet_transactions (
    id, union_id, wallet, direction, amount, balance_after,
    tx_type, club_id, period_id, notes, created_by, created_at
  ) VALUES (
    gen_random_uuid(), p_union_id, v_wallet_column, 'debit', p_amount, v_after,
    COALESCE(p_tx_type, 'debit'), p_club_id, p_period_id, p_notes, p_created_by, NOW()
  );

  RETURN jsonb_build_object(
    'success', true, 'amount', p_amount,
    'wallet', v_wallet_column,
    'balance_before', v_before, 'balance_after', v_after
  );
END;
$function$;

-- The ratchet. Every function that writes a balance column fn_ca_autoledger
-- watches, and never says what the other side of the movement is.
CREATE OR REPLACE FUNCTION public.fn_ca_undeclared_money_paths()
RETURNS TABLE (proname text, tbl text, col text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH watched AS (
    SELECT c.relname::text AS tbl,
           (regexp_matches(pg_get_triggerdef(t.oid), '''([a-z_]+)=([a-z_]+)''', 'g'))[1] AS col
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc  p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal AND p.proname = 'fn_ca_autoledger'
  ), fns AS (
    SELECT p.proname::text AS proname, p.prosrc,
           (p.prosrc ILIKE '%fn_ca_declare_ledger%'
            OR p.prosrc ILIKE '%app.ledger_counterparty%') AS declares
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
  )
  SELECT DISTINCT f.proname, w.tbl, w.col
    FROM fns f
    JOIN watched w
      ON f.prosrc ~* ('UPDATE\s+(public\.)?' || w.tbl || '\y')
     AND f.prosrc ~* ('\y' || w.col || '\y')
   WHERE NOT f.declares
     AND f.proname NOT IN ('fn_ca_autoledger', 'fn_ca_autoledger_delete',
                           'fn_ca_declare_ledger', 'fn_ca_undeclared_money_paths')
   ORDER BY 1, 2, 3
$$;

COMMENT ON FUNCTION public.fn_ca_undeclared_money_paths() IS
  'Functions that move a balance fn_ca_autoledger watches without declaring the '
  'other side, so their movements land on settlement_suspense. This is the '
  'unclassified-flow backlog. 172 function-column pairs across 81 functions when '
  'first measured on 2026-09-01; the number must only ever go down.';

REVOKE ALL ON FUNCTION public.fn_ca_undeclared_money_paths() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_undeclared_money_paths() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_union_wallet_ledger_shape(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_union_wallet_ledger_shape(text) TO service_role;

DO $$
DECLARE v_pairs int; v_fns int;
BEGIN
  IF (SELECT count(*) FROM public.fn_ca_undeclared_money_paths()
       WHERE proname IN ('fn_union_credit_wallet_zd3core','fn_union_debit_wallet_zd3core')) > 0 THEN
    RAISE EXCEPTION 'the union wallet cores still do not declare a counterparty';
  END IF;

  SELECT count(*), count(DISTINCT proname) INTO v_pairs, v_fns
    FROM public.fn_ca_undeclared_money_paths();
  IF v_pairs > 172 THEN
    RAISE EXCEPTION 'undeclared money paths went UP: % pairs across % functions (was 172/81)', v_pairs, v_fns;
  END IF;
  RAISE NOTICE 'undeclared money paths now % pairs across % functions (was 172/81)', v_pairs, v_fns;
END $$;
