-- Only after a terminal interrupted exact original build, no active builder,
-- unchanged source/DDL admission, and verified invalid durable definition.
REINDEX INDEX CONCURRENTLY public.idx_wallet_tx_tournament_receipts_cover;
