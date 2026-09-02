-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826032355; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- chip_transactions.balance_after DOES NOT MEAN THE SAME THING IN EVERY ROW,
-- and nothing said so.
--
-- Both cashier paths write transaction_type = 'peer_transfer', and they store
-- DIFFERENT PARTIES' balances in the same column:
--
--   fn_cashier_send_chips       -> v_to_after   = the RECIPIENT's balance
--   fn_issue_tournament_ticket  -> v_after      = the ISSUER's balance
--
-- So a statement, reconciliation or audit that reads balance_after across
-- peer_transfer rows is averaging two different quantities without knowing it.
--
-- NOT CHANGING THE STORED VALUES. Verified first that this is latent rather than
-- live: no client reads this column. The two components that render a
-- `balance_after` to a user read OTHER tables - UnionWalletModal reads
-- union_wallet_transactions, DiamondWalletModal reads wallet_transactions and
-- diamond_transactions - and 50 migrations touch chip_transactions, so
-- redefining the column's meaning now would be a large blast radius for no
-- present benefit.
--
-- What the column CANNOT tell you, the metadata already can, unambiguously:
--   send   -> metadata->>'from_balance_after' and metadata->>'to_balance_after'
--   ticket -> metadata->>'issuer_balance_after'
-- (both populated since 20260825300000, on rows written with an idempotency key)
--
-- So the fix is to stop the inconsistency being invisible. The next person to
-- build a statement on this column will read this before they trust it.
COMMENT ON COLUMN public.chip_transactions.balance_after IS
  'NOT COMPARABLE ACROSS ROWS. Whose balance this is depends on which RPC wrote the row: fn_cashier_send_chips stores the RECIPIENT''s balance, fn_issue_tournament_ticket stores the ISSUER''s - and both write transaction_type = ''peer_transfer'', so the type does not disambiguate it either. Do not aggregate this column. For an unambiguous value read metadata->>''from_balance_after'' / ''to_balance_after'' (send) or metadata->>''issuer_balance_after'' (ticket).';

DO $$
BEGIN
  IF (SELECT col_description('public.chip_transactions'::regclass,
        (SELECT attnum FROM pg_attribute
          WHERE attrelid='public.chip_transactions'::regclass AND attname='balance_after'))) IS NULL THEN
    RAISE EXCEPTION 'the balance_after comment did not land';
  END IF;
END $$;
