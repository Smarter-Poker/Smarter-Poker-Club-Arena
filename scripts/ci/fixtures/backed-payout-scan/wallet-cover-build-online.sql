-- One top-level concurrent statement on the maintained native TLS session.
-- The partial predicate bounds included type/category text to these exact labels.
-- UUID and numeric(15,2) are fixed-width/bounded; no metadata or arbitrary text.
-- Inspect durable state after uncertainty; no transaction wrapper or blind retry.
CREATE INDEX CONCURRENTLY idx_wallet_tx_tournament_receipts_cover
 ON public.wallet_transactions USING btree (related_entity_id) INCLUDE (type, category, amount)
 WHERE related_entity_id IS NOT NULL AND ((type = 'debit' AND category IN ('tournament_buyin','rebuy','addon')) OR (type = 'credit' AND category IN ('refund','prize','bounty')));
