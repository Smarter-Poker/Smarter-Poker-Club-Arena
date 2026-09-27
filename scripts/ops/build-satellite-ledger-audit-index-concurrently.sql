-- One finite online build through the maintained session connection.
-- Preserve DDL/maintenance guards and require absence/ownership plus full runway.
-- Allow ordinary existing transactions to complete with the qualified session
-- lock timeout. Read durable operation state after an unknown acknowledgement;
-- never blindly repeat CREATE, DROP, or replace a known invalid index.
-- UUID key only: variable-length idempotency text stays in the heap, so the
-- index adds no new text tuple-size rejection to future financial receipts.
CREATE INDEX CONCURRENTLY idx_chip_ledger_satellite_pool_from
  ON public.chip_ledger USING btree (from_entity_id)
  WHERE from_type = 'prize_liability' AND category = 'tournament_buyin';
