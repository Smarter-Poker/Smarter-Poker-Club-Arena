-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260501181146 "x86_phasej_hot_path_indexes"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 bfd553c5f7e2e804409fa5b23b6de317 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase J Pass 3 follow-up: add missing indexes on hot foreign-key + filter
-- columns. All identified by walking information_schema.columns vs pg_index
-- for tables with high write+query volume.
--
-- agent_commissions.created_at — dashboard "last 24h" + settler "since" queries
CREATE INDEX IF NOT EXISTS idx_agent_commissions_created_at
  ON public.agent_commissions (created_at DESC);

-- rakeback_periods.created_at — used by settler dedupe + admin reports
CREATE INDEX IF NOT EXISTS idx_rakeback_periods_created_at
  ON public.rakeback_periods (created_at DESC);

-- table_seats.horse_id — horse-fleet stand-up + bankroll queries
CREATE INDEX IF NOT EXISTS idx_table_seats_horse_id
  ON public.table_seats (horse_id) WHERE horse_id IS NOT NULL;

-- table_seats.status — active-seat filter on lobby + table listings
CREATE INDEX IF NOT EXISTS idx_table_seats_status
  ON public.table_seats (status) WHERE left_at IS NULL;

-- wallet_transactions.hand_id — forensic "all txs for this hand" queries
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_hand_id
  ON public.wallet_transactions (hand_id) WHERE hand_id IS NOT NULL;

-- wallet_transactions.table_id — per-table cashflow review
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_table_id
  ON public.wallet_transactions (table_id) WHERE table_id IS NOT NULL;

-- wallet_transactions.related_entity_id — generic entity-link audit lookups
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_related_entity_id
  ON public.wallet_transactions (related_entity_id) WHERE related_entity_id IS NOT NULL;

