-- One top-level statement on the maintained TLS native session route.
-- PostgreSQL refuses CONCURRENTLY inside BEGIN. Preserve real DDL/freeze
-- admission and inspect durable index/progress/session state after uncertainty.
-- Only UUID identity and bounded numeric(15,2) amount enter the index tuple.
-- JSON, labels and arbitrary text stay outside it. No financial rows change.
CREATE INDEX CONCURRENTLY idx_chip_ledger_reviewed_overlay_returns
  ON public.chip_ledger USING btree (tournament_id) INCLUDE (amount)
  WHERE tournament_id IS NOT NULL AND category = 'reversal'
    AND from_type = 'prize_liability' AND from_entity_id = tournament_id
    AND metadata->>'kind' = 'reviewed_void_overlay_return';
