-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429054832 "x14_fix_fk_target_hand_id_to_hands_2026_04_29"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 da4742d3bd1a3129e64dc25cc5413c8d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 12 — fix Round 11 FK targets that pointed at hand_history but the
-- actual writer (frontend HandHistoryService.saveHandToSupabase + frontend
-- CommissionService.attributeRake) uses hand_id from public.hands.
--
-- Evidence:
--   src/services/HandHistoryService.ts:560-569 — INSERT INTO hands ... RETURNING id
--   src/services/HandHistoryService.ts:594-608 — INSERT INTO hand_actions with that id
--   src/services/CommissionService.ts:241-252 — INSERT INTO rake_attributions with that id
--   information_schema.columns confirms public.hand_players.hand_id already
--     FKs to public.hands(id), not public.hand_history(id) — so my new tables
--     should match that pattern.
--
-- The hands vs hand_history split is a pre-existing architectural divergence
-- (frontend pipeline = normalized hands+hand_players+hand_actions; engine
-- pipeline = denormalized hand_history with JSONB winners/players/actions).
-- Reconciling that is a separate larger project; here we only fix the FK
-- target to match what actually writes.

ALTER TABLE public.hand_actions
  DROP CONSTRAINT IF EXISTS hand_actions_hand_id_fkey;
ALTER TABLE public.hand_actions
  ADD CONSTRAINT hand_actions_hand_id_fkey
      FOREIGN KEY (hand_id) REFERENCES public.hands(id) ON DELETE CASCADE;

ALTER TABLE public.rake_attributions
  DROP CONSTRAINT IF EXISTS rake_attributions_hand_id_fkey;
ALTER TABLE public.rake_attributions
  ADD CONSTRAINT rake_attributions_hand_id_fkey
      FOREIGN KEY (hand_id) REFERENCES public.hands(id) ON DELETE CASCADE;
