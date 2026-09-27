-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819003828 "bbj_selftest_reserve_rules_full"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 13289225b317277a6a16a84bac8a056d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Self-test for the COMPLETE reserve rule (2026-08-18).
-- Three properties, checked against the real payer in rolled-back subtransactions:
--   1. A payout is never funded by the reserve: paid <= main_before.
--   2. Chips are conserved: (main+backup) falls by exactly the amount paid.
--   3. The reserve does its job: when a hit takes 100% of main, the backup is
--      TRANSFERRED into main (main = old backup, backup = 0) so the jackpot
--      does not restart at zero — and when the hit is partial, the reserve is
--      not touched at all.
-- Property 3 is what distinguishes a reseed from a payout source, so it is
-- asserted in both directions.

CREATE OR REPLACE FUNCTION public.fn_bbj_selftest_payout_conservation()
RETURNS TABLE (ok boolean, detail text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pool uuid; err text := ''; r record;
  m_full numeric; b_full numeric; paid_full numeric;
  m_part numeric; b_part numeric; paid_part numeric;
  v_u1 uuid; v_u2 uuid;
BEGIN
  SELECT id INTO v_pool FROM bbj_pools WHERE status='active' ORDER BY main_balance DESC LIMIT 1;
  IF v_pool IS NULL THEN
    RETURN QUERY SELECT true, 'skipped: no active pool'; RETURN;
  END IF;
  SELECT id INTO v_u1 FROM profiles LIMIT 1;
  SELECT id INTO v_u2 FROM profiles OFFSET 1 LIMIT 1;

  BEGIN
    -- FULL hit: 100% of main, reserve funded and must reseed.
    UPDATE bbj_pools SET main_balance = 800, backup_balance = 5000 WHERE id = v_pool;
    SELECT * INTO r FROM bbj_atomic_payout_v2(v_pool, gen_random_uuid(), 999999881::bigint,
      100::numeric, v_u1, v_u2, ARRAY[]::uuid[], ARRAY[]::uuid[], '{"selftest":true}'::jsonb);
    paid_full := COALESCE(r.total_payout,0);
    SELECT main_balance, COALESCE(backup_balance,0) INTO m_full, b_full FROM bbj_pools WHERE id=v_pool;

    -- PARTIAL hit: 85% of main, reserve must not move.
    UPDATE bbj_pools SET main_balance = 1000, backup_balance = 5000 WHERE id = v_pool;
    SELECT * INTO r FROM bbj_atomic_payout_v2(v_pool, gen_random_uuid(), 999999882::bigint,
      85::numeric, v_u1, v_u2, ARRAY[]::uuid[], ARRAY[]::uuid[], '{"selftest":true}'::jsonb);
    paid_part := COALESCE(r.total_payout,0);
    SELECT main_balance, COALESCE(backup_balance,0) INTO m_part, b_part FROM bbj_pools WHERE id=v_pool;

    RAISE EXCEPTION 'SELFTEST-ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'SELFTEST-ROLLBACK' THEN GET STACKED DIAGNOSTICS err = MESSAGE_TEXT; END IF;
  END;

  IF err <> '' THEN
    RETURN QUERY SELECT false, 'selftest errored: ' || err;
  ELSIF paid_full > 800.005 THEN
    RETURN QUERY SELECT false, format('RESERVE FUNDED A PAYOUT: paid %s from a main of 800', paid_full);
  ELSIF ABS((m_full + b_full) - (5800 - paid_full)) > 0.005 THEN
    RETURN QUERY SELECT false, format('NOT CONSERVED on full hit: pool is %s, expected %s',
                                      m_full + b_full, 5800 - paid_full);
  ELSIF ABS(m_full - 5000) > 0.005 OR ABS(b_full) > 0.005 THEN
    RETURN QUERY SELECT false, format('RESEED FAILED: after a 100%% hit main=%s backup=%s, expected main=5000 backup=0',
                                      m_full, b_full);
  ELSIF ABS(b_part - 5000) > 0.005 THEN
    RETURN QUERY SELECT false, format('RESERVE MOVED ON A PARTIAL HIT: backup=%s, expected 5000', b_part);
  ELSIF ABS(m_part - 150) > 0.005 THEN
    RETURN QUERY SELECT false, format('MAIN WRONG after partial hit: main=%s, expected 150', m_part);
  ELSE
    RETURN QUERY SELECT true, format(
      'full hit: paid %s, reserve reseeded main to %s; partial hit: paid %s, reserve untouched',
      paid_full, m_full, paid_part);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_bbj_selftest_payout_conservation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_selftest_payout_conservation() TO service_role;
