-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815153935 "allow_bounty_categories_and_backfill_missing_bounty_ledger"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c1695a5c153318d55c2d36958e60cf66 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- LIVE E2E TOURNAMENT SWEEP 2026-08-15 — bounty ledger blackout
-- The engine credits knockout bounties via credit_player_wallet (money DOES
-- reach the player — wallet_credit_idempotency proves it) and then writes the
-- player-facing ledger row via log_wallet_transaction with category 'bounty'.
-- 'bounty' was never added to wallet_transactions_category_check, so EVERY
-- bounty ledger insert has thrown 23514 since the feature shipped: 1,825
-- bounties totalling 21,949.87 chips paid with no transaction history.
-- 'addon_refund' (server/src/tournament/*) is rejected by the same whitelist.

ALTER TABLE public.wallet_transactions DROP CONSTRAINT wallet_transactions_category_check;

ALTER TABLE public.wallet_transactions ADD CONSTRAINT wallet_transactions_category_check
CHECK (category = ANY (ARRAY[
  'buyin','cashout','promo','rake','transfer','tournament_buyin','tournament_winnings',
  'tournament_cashout','horse_refill','deposit','withdrawal','refund','bbj','bonus','mint',
  'settlement','commission','TIP','INSURANCE','prize','rebuy','addon','funding','promotion',
  'rakeback',
  -- 2026-08-15 additions: categories the engine already emits.
  'bounty','addon_refund','bounty_own','prize_reversal'
]::text[]));

-- Backfill the missing ledger rows from the authoritative tournament_bounties
-- table. balance_after is left NULL rather than stamped with today's balance —
-- a reconstructed row must not assert a historical snapshot it cannot know.
DO $$
DECLARE
  v_before bigint;
  v_after bigint;
  v_expected bigint;
BEGIN
  SELECT count(*) INTO v_before FROM wallet_transactions WHERE category='bounty';

  INSERT INTO wallet_transactions
    (user_id, wallet_type, amount, type, category, description, related_entity_id, created_at, balance_after)
  SELECT tb.collector_player_id, 'PLAYER', tb.bounty_amount, 'credit', 'bounty',
         'Bounty collected from eliminated player (ledger backfill 2026-08-15 — credit was applied at the time, ledger row was rejected by a category constraint)',
         tb.tournament_id, tb.created_at, NULL
  FROM tournament_bounties tb
  WHERE tb.collector_player_id IS NOT NULL
    AND tb.bounty_amount > 0
    AND NOT EXISTS (
      SELECT 1 FROM wallet_transactions w
      WHERE w.user_id = tb.collector_player_id
        AND w.related_entity_id = tb.tournament_id
        AND w.category = 'bounty'
        AND w.created_at = tb.created_at
    );

  SELECT count(*) INTO v_after FROM wallet_transactions WHERE category='bounty';
  SELECT count(*) INTO v_expected FROM tournament_bounties
    WHERE collector_player_id IS NOT NULL AND bounty_amount > 0;

  IF v_after < v_expected THEN
    RAISE EXCEPTION 'BACKFILL INCOMPLETE: % bounty ledger rows for % bounty records', v_after, v_expected;
  END IF;

  RAISE NOTICE 'bounty ledger: % -> % rows (expected >= %)', v_before, v_after, v_expected;
END $$;
