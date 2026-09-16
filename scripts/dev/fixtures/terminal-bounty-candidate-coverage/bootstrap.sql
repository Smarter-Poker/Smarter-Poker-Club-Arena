-- Captured table/function shapes and synthetic builders, never production rows.
\ir ../causal-pko-predecessors/bootstrap.sql
\ir ../../../../supabase/migrations/20260914133503_pko_heads_follow_accepted_knockout_dependencies.sql
\ir ../../../../supabase/migrations/20260914135834_preserve_explicit_private_pko_claim_and_collector_grants.sql
\ir ../causal-pko-predecessors/helpers.sql
\ir current-functions.sql
\ir support-functions.sql
REVOKE ALL ON FUNCTION public.fn_ca_lock_settlement_lane_global(),public.fn_exact_tournament_knockout_claimants(uuid,uuid,uuid),public.fn_bounty_obligation_has_complete_marker(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_lock_settlement_lane_global(),public.fn_exact_tournament_knockout_claimants(uuid,uuid,uuid),public.fn_bounty_obligation_has_complete_marker(uuid) TO service_role;
-- Restore the captured production grants on fresh local function creation.
REVOKE ALL ON FUNCTION public.fn_finalize_bounty_pool(uuid,uuid),public.fn_mystery_bounty_settle(uuid,uuid),public.fn_tournament_has_unsettled_bounties(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_finalize_bounty_pool(uuid,uuid),public.fn_mystery_bounty_settle(uuid,uuid),public.fn_tournament_has_unsettled_bounties(uuid) TO service_role;
\ir helpers.sql
