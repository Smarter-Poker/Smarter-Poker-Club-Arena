-- =============================================================================
-- chip_ledger_chain_seq_needs_an_index
-- STAGED 2026-09-01 -- NOT YET APPLIED TO PRODUCTION. The session's
-- permission layer required a human to authorize this DDL; apply via
-- Supabase MCP or the SQL editor.
--
-- Found when a 448-row balance unwind timed out inside
-- fn_ca_chip_ledger_enrich: its prev_hash lookup
--     SELECT row_hash FROM chip_ledger WHERE chain_seq = NEW.chain_seq - 1
-- has NO INDEX to use. chip_ledger holds 316,420 rows / 196 MB, so every
-- single ledger insert on the platform -- every buy-in, rake row, prize,
-- cash-out -- pays a full-table sequential scan to find the previous row's
-- hash. The enricher fires BEFORE INSERT on every row.
--
-- Unique because chain_seq comes from a sequence and duplicate values would
-- corrupt the forensic chain silently.
-- =============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS chip_ledger_chain_seq_key
  ON public.chip_ledger (chain_seq);
