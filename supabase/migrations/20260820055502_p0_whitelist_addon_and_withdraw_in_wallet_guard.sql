-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820055502 "p0_whitelist_addon_and_withdraw_in_wallet_guard"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 140a138c722c5c38f96f07ba7ee1db87 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- P0 LIVE FEATURE OUTAGE: Add Chips and Withdraw Chips do not work at all.
--
-- guard_wallet_balance_write() rejects any wallets.balance mutation whose call
-- stack does not name a whitelisted function. Its whitelist contains
-- atomic_table_buyin, atomic_table_cashout and atomic_table_rebuy -- but NOT
-- atomic_table_addon or atomic_table_withdraw. Both were whitelisted once; a
-- later rewrite of this trigger (the entries marked "added 2026-08-15 with the
-- chip-removal authority policy") restated the array and dropped them.
--
-- Consequence: every add-on and every partial cash-out raises
-- "Direct balance mutation on public.wallets is forbidden" and fails. The
-- evidence is unambiguous -- wallet_transactions has ZERO rows in category
-- 'addon' and ZERO in 'withdraw', for all time, while 'buyin' recorded 40,532
-- and 'cashout' 3,591 in the last 7 days alone. Two shipped features have been
-- silently dead.
--
-- Found while testing an unrelated idempotency change to atomic_table_addon:
-- the rolled-back test could not debit a wallet at all.
--
-- Patched by text substitution against the live definition, with an anchor
-- check, so nothing else in this security-critical trigger can drift.
DO $mig$
DECLARE
  v_src text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'guard_wallet_balance_write';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'guard_wallet_balance_write not found';
  END IF;

  IF v_src LIKE '%atomic_table_addon%' THEN
    RAISE NOTICE 'already whitelisted - nothing to do';
    RETURN;
  END IF;

  v_new := replace(
    v_src,
    '''atomic_table_rebuy'',''atomic_seat_horse''',
    '''atomic_table_rebuy'',''atomic_table_addon'',''atomic_table_withdraw'',''atomic_seat_horse'''
  );

  IF v_new = v_src THEN
    -- fall back to the spaced form emitted by pg_get_functiondef
    v_new := replace(
      v_src,
      '''atomic_table_rebuy'',''atomic_seat_horse'',''player_leave_table''',
      '''atomic_table_rebuy'',''atomic_table_addon'',''atomic_table_withdraw'',''atomic_seat_horse'',''player_leave_table'''
    );
  END IF;

  IF v_new = v_src THEN
    RAISE EXCEPTION 'whitelist anchor not found - refusing to patch blindly';
  END IF;

  EXECUTE v_new;
END
$mig$;
