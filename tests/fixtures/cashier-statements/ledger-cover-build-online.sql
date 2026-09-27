-- One top-level statement on the maintained native session connection.
-- PostgreSQL forbids CONCURRENTLY inside BEGIN. Preserve DDL/freeze admission.
-- Check the same durable operation before any recovery after an unknown result.
-- Only fixed-width identity/amount columns are included; arbitrary text, labels,
-- idempotency keys and JSON remain outside the index tuple. No financial writes.
CREATE INDEX CONCURRENTLY idx_chip_ledger_cashier_totals_cover
  ON public.chip_ledger USING btree (club_id, created_at DESC)
  INCLUDE (id, amount, from_entity_id, to_entity_id)
  WHERE status = 'posted' AND category = ANY (ARRAY[
    'buyin', 'addon', 'rebuy', 'tournament_prize', 'bounty', 'refund',
    'spin_entry', 'spin_prize', 'promo', 'promo_send', 'treasury_transfer',
    'transfer', 'player_funding', 'agent_funding', 'overlay', 'reversal',
    'correction', 'adjustment', 'leaderboard_payout']::text[]);
