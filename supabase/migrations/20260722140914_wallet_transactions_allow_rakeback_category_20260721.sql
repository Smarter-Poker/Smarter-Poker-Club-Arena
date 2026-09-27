-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260722140914 "wallet_transactions_allow_rakeback_category_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d0b157c2f56c1265e6e74755af1ad152 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- 'rakeback' is a legitimate wallet_transactions category (rakeback payouts write it),
-- but it was missing from the CHECK — the insert only ever fired now that the payout
-- path is actually reaching it. Add 'rakeback' (pure widening; no existing row affected).
ALTER TABLE public.wallet_transactions DROP CONSTRAINT wallet_transactions_category_check;
ALTER TABLE public.wallet_transactions ADD CONSTRAINT wallet_transactions_category_check
  CHECK (category = ANY (ARRAY[
    'buyin','cashout','promo','rake','transfer','tournament_buyin','tournament_winnings',
    'tournament_cashout','horse_refill','deposit','withdrawal','refund','bbj','bonus','mint',
    'settlement','commission','TIP','INSURANCE','prize','rebuy','addon','funding','promotion',
    'rakeback'
  ]));
