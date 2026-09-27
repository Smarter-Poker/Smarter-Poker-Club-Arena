-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419214617 "phase32_security_rls_tighten_poker_hands"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7d49667ecec3ec084c767e5114eef335 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════════
-- PHASE 32 — RLS SECURITY TIGHTENING
-- 
-- poker_hands was a ticking bomb: 'Public read access' USING true means
-- when Club Arena online games start writing to it, player hole cards,
-- actions, and winners would be publicly readable.
-- 
-- Pattern match: existing Club Arena tables use service-only access for
-- sensitive game state (hand_state_snapshots). Apply same pattern.
-- 
-- Participant-match can be added later when Arena goes live and the
-- player_snapshots jsonb structure is stable.
-- ══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Public read access" ON poker_hands;

-- Service-only until Arena is production-live with participant logic defined
CREATE POLICY poker_hands_service_only ON poker_hands
  FOR SELECT TO authenticated, anon
  USING (auth.role() = 'service_role');

COMMENT ON POLICY poker_hands_service_only ON poker_hands IS 
  'Phase 32: Replaced dangerously-permissive USING:true public read policy. When Club Arena goes live, this will be tightened to participant-only SELECT based on player_snapshots jsonb structure (see hand_history_authenticated_select pattern).';
