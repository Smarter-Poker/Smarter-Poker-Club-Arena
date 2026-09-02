-- The single-pass Players query needs columns from both cash and tournament
-- wallet rows. PostgreSQL cannot perform one index-only scan by OR-combining
-- the two narrower partial indexes, so it still paid for hundreds of thousands
-- of heap visits. Cover the exact combined predicate and payload.

CREATE INDEX IF NOT EXISTS idx_wallet_tx_club_data_player_window
  ON public.wallet_transactions (user_id, created_at)
  INCLUDE (category, type, amount, table_id, related_entity_id)
  WHERE (
    category IN ('buyin', 'cashout') AND table_id IS NOT NULL
  ) OR (
    category IN ('tournament_buyin', 'prize', 'bounty')
    AND related_entity_id IS NOT NULL
  );
