-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820055557 "p0_atomic_table_addon_positive_amount"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cb3a37523f504137173f1e95b6c431af of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Second live defect in the same dead feature.
--
-- With the wallet-guard whitelist restored, atomic_table_addon got one
-- statement further and then hit:
--   new row for relation "wallet_transactions" violates check constraint
--   "wallet_transactions_amount_non_negative"
--
-- It logs `'debit', -p_amount`. Every other money function in this schema logs a
-- POSITIVE amount and carries the direction in `type`: atomic_table_buyin uses
-- ('debit', p_amount), atomic_table_withdraw uses ('credit', p_amount), and the
-- last two days of wallet_transactions contain no negative amount at all
-- (buyin 4.00-5000.00, tournament_buyin 1.10-50.00, all positive). addon was
-- the only one with the sign flipped, so it could never have inserted a row.
--
-- Two independent breakages stacked on the same code path is why nobody
-- noticed: fixing either one alone still leaves Add Chips failing.
DO $mig$
DECLARE
  v_src text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'atomic_table_addon';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'atomic_table_addon not found';
  END IF;

  v_new := replace(
    v_src,
    '''debit'', -p_amount, ''addon''',
    '''debit'', p_amount, ''addon'''
  );

  IF v_new = v_src THEN
    RAISE EXCEPTION 'addon amount-sign anchor not found - refusing to patch blindly';
  END IF;

  EXECUTE v_new;
END
$mig$;
