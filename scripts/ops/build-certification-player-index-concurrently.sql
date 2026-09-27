-- One finite online build through the maintained session route.
-- Preserve DDL/freeze guards, verify absence and full maintenance runway first.
-- Unknown outcomes require durable catalog/build-owner readback, never a blind
-- repeat or DROP. The UUID-only key introduces no variable-text tuple limit.
CREATE INDEX CONCURRENTLY idx_cash_rake_sources_player
  ON public.accounting_cash_rake_sources USING btree (player_id);
