-- The seven indexes scripts/ops/union-pnl-evidence-indexes.sql builds
-- CONCURRENTLY in production (same names, same definitions).
CREATE INDEX IF NOT EXISTS union_pnl_cash_outcomes_unaccepted ON public.union_pnl_cash_outcomes (((game_scope->>'game_union_id')),recognized_at)
 WHERE (evidence->>'status' IS DISTINCT FROM 'ready' OR evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
  OR evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR evidence->'game_scope' IS DISTINCT FROM game_scope);
CREATE INDEX IF NOT EXISTS union_pnl_cash_outcomes_scope_missing ON public.union_pnl_cash_outcomes (recognized_at)
 WHERE NOT game_scope ?& ARRAY['game_union_id','host_club_id','tournament_id','is_private','asset','unit_scale'];
CREATE INDEX IF NOT EXISTS union_pnl_original_flows_scope_missing ON public.union_pnl_original_flows (recognized_at)
 WHERE NOT game_scope ?& ARRAY['game_union_id','host_club_id','tournament_id','is_private','asset','unit_scale'];
CREATE INDEX IF NOT EXISTS cash_hand_provenance_untransacted ON public.cash_hand_provenance_receipts (accepted_at) WHERE transaction_id IS NULL;
CREATE INDEX IF NOT EXISTS cash_participant_funding_buyin_table ON public.cash_participant_funding_receipts (table_id,account_entity_id) WHERE operation_kind='buyin';
CREATE INDEX IF NOT EXISTS tournament_accounting_credit_receipts_tournament ON public.tournament_accounting_credit_receipts (tournament_id);
CREATE INDEX IF NOT EXISTS union_pnl_inventory_events_players_observed ON public.union_pnl_inventory_events (observed_at) WHERE source_name='tournament_players';
CREATE INDEX IF NOT EXISTS tournament_participant_funding_receipts_registration ON public.tournament_participant_funding_receipts (registration_id);
