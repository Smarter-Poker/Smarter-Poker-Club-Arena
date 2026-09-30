-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819002748 "bbj_selftest_backup_untouched_by_payouts"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e63ea220b40d15feab5f8ef12eddf0d7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- The self-test now enforces the RULE, not just conservation (2026-08-18).
-- Conservation alone would still pass if a payout drained the reserve, which
-- is exactly what Dan ruled out: the backup jackpot never funds or pays a BBJ.
-- Asserts three things against the REAL payer in a rolled-back subtransaction:
--   1. backup_balance is completely UNCHANGED by a payout
--   2. main falls by exactly the amount paid (no minting, no over-draw)
--   3. a payout can never exceed the main balance it was computed from

CREATE OR REPLACE FUNCTION public.fn_bbj_selftest_payout_conservation()
RETURNS TABLE (ok boolean, detail text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pool uuid; m0 numeric; b0 numeric; m1 numeric; b1 numeric;
  paid numeric := 0; err text := ''; r record;
  v_main_delta numeric; v_backup_delta numeric;
BEGIN
  SELECT id, main_balance, COALESCE(backup_balance,0)
    INTO v_pool, m0, b0
    FROM bbj_pools WHERE status='active' AND main_balance > 10
    ORDER BY main_balance DESC LIMIT 1;

  IF v_pool IS NULL THEN
    RETURN QUERY SELECT true, 'skipped: no funded active pool to test against';
    RETURN;
  END IF;

  BEGIN
    -- 100% of main is the harshest case: if the reserve were ever reachable,
    -- this is the call that would reach it.
    SELECT * INTO r FROM bbj_atomic_payout_v2(
      v_pool, gen_random_uuid(), 999999999::bigint, 100::numeric,
      (SELECT id FROM profiles LIMIT 1),
      (SELECT id FROM profiles OFFSET 1 LIMIT 1),
      ARRAY[]::uuid[], ARRAY[]::uuid[], '{"selftest":true}'::jsonb
    );
    paid := COALESCE(r.total_payout, 0);
    SELECT main_balance, COALESCE(backup_balance,0) INTO m1, b1 FROM bbj_pools WHERE id = v_pool;
    v_main_delta   := m0 - m1;
    v_backup_delta := b0 - b1;
    RAISE EXCEPTION 'SELFTEST-ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'SELFTEST-ROLLBACK' THEN
      GET STACKED DIAGNOSTICS err = MESSAGE_TEXT;
    END IF;
  END;

  IF err <> '' THEN
    RETURN QUERY SELECT false, 'selftest errored: ' || err;
  ELSIF ABS(COALESCE(v_backup_delta, 0)) > 0.005 THEN
    RETURN QUERY SELECT false, format(
      'BACKUP JACKPOT WAS SPENT: payout of %s moved the reserve by %s. The backup is a reserve and must never fund a payout.',
      paid, v_backup_delta);
  ELSIF ABS(COALESCE(v_main_delta, 0) - paid) > 0.005 THEN
    RETURN QUERY SELECT false, format(
      'MAIN POOL MISMATCH: paid %s but main moved by %s (difference %s)',
      paid, v_main_delta, v_main_delta - paid);
  ELSIF paid > m0 + 0.005 THEN
    RETURN QUERY SELECT false, format('PAYOUT EXCEEDED MAIN: paid %s from a main of %s', paid, m0);
  ELSE
    RETURN QUERY SELECT true, format(
      'main -%s, backup untouched (%s), payout within main', paid, b0);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_bbj_selftest_payout_conservation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_selftest_payout_conservation() TO service_role;

COMMENT ON FUNCTION public.fn_bbj_selftest_payout_conservation() IS
  'Runs the real BBJ payer at 100% of main in a rolled-back subtransaction and asserts: the backup reserve is untouched, main falls by exactly the amount paid, and the payout never exceeds main.';
