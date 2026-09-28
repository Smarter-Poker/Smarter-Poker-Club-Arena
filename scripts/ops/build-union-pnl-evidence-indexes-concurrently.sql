-- STEP 1 of migration 20260928211132_a_union_close_proves_its_pnl_evidence_once_and_fast.sql, as its own script.
-- Run outside any transaction (psql autocommit), not during the :55 break
-- window (platform DDL guard). Each statement commits on its own and never
-- blocks writers; IF NOT EXISTS makes a re-run harmless. An index left
-- INVALID by a cancelled build: DROP INDEX CONCURRENTLY IF EXISTS it, re-run.
-- The migration's STEP 2 refuses to start until all of them are valid.
SET statement_timeout = '15min';
SET lock_timeout = '180s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS union_pnl_cash_outcomes_unaccepted ON public.union_pnl_cash_outcomes (((game_scope->>'game_union_id')),recognized_at)
 WHERE (evidence->>'status' IS DISTINCT FROM 'ready' OR evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
  OR evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR evidence->'game_scope' IS DISTINCT FROM game_scope);
CREATE INDEX CONCURRENTLY IF NOT EXISTS union_pnl_cash_outcomes_scope_missing ON public.union_pnl_cash_outcomes (recognized_at)
 WHERE NOT game_scope ?& ARRAY['game_union_id','host_club_id','tournament_id','is_private','asset','unit_scale'];
CREATE INDEX CONCURRENTLY IF NOT EXISTS union_pnl_original_flows_scope_missing ON public.union_pnl_original_flows (recognized_at)
 WHERE NOT game_scope ?& ARRAY['game_union_id','host_club_id','tournament_id','is_private','asset','unit_scale'];
CREATE INDEX CONCURRENTLY IF NOT EXISTS cash_hand_provenance_untransacted ON public.cash_hand_provenance_receipts (accepted_at) WHERE transaction_id IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS cash_participant_funding_buyin_table ON public.cash_participant_funding_receipts (table_id,account_entity_id) WHERE operation_kind='buyin';
CREATE INDEX CONCURRENTLY IF NOT EXISTS tournament_accounting_credit_receipts_tournament ON public.tournament_accounting_credit_receipts (tournament_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS union_pnl_inventory_events_players_observed ON public.union_pnl_inventory_events (observed_at) WHERE source_name='tournament_players';
CREATE INDEX CONCURRENTLY IF NOT EXISTS tournament_participant_funding_receipts_registration ON public.tournament_participant_funding_receipts (registration_id);
